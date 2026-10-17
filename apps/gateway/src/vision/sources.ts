// Where frames come from: a camera's JPEG snapshot URL polled on an interval, an MJPEG stream,
// any RTSP/RTMP/file input through ffmpeg, a folder of JPEGs (tests, demos), or pushes from code.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';

export interface FrameSource {
  /** Starts delivering JPEG frames. `onFrame` gets the bytes and the capture time. */
  start(onFrame: (jpeg: Uint8Array, at: number) => void, onError: (e: Error) => void): void;
  stop(): void;
  readonly kind: string;
}

export interface HttpAuth {
  username: string;
  password: string;
}

/** HTTP GET with Basic auth, retrying with Digest when the server insists (RFC 7616). */
export function httpGet(url: string, opts: { auth?: HttpAuth; timeoutMs?: number; onResponse?: (res: http.IncomingMessage) => void } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }> {
  const u = new URL(url);
  const once = (authHeader?: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method: 'GET', headers: authHeader ? { authorization: authHeader } : {}, timeout: opts.timeoutMs ?? 5000 }, (res) => {
        if (opts.onResponse) return opts.onResponse(res);
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error('Camera did not answer in time.')));
      req.on('error', reject);
      req.end();
    });
  const basic = opts.auth ? `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString('base64')}` : undefined;
  return once(basic).then((r) => {
    if (r.status === 401 && opts.auth && /^Digest /i.test(String(r.headers['www-authenticate'] ?? ''))) return once(digestAuth(String(r.headers['www-authenticate']), 'GET', u.pathname + u.search, opts.auth));
    return r;
  });
}

function digestAuth(challenge: string, method: string, uri: string, auth: HttpAuth) {
  const p: Record<string, string> = {};
  for (const m of challenge.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1]] = m[2] ?? m[3];
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const nc = '00000001';
  const cnonce = randomBytes(8).toString('hex');
  const ha1 = md5(`${auth.username}:${p.realm ?? ''}:${auth.password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = p.qop?.split(',')[0]?.trim();
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  let h = `Digest username="${auth.username}", realm="${p.realm ?? ''}", nonce="${p.nonce ?? ''}", uri="${uri}", response="${response}"`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (p.opaque) h += `, opaque="${p.opaque}"`;
  return h;
}

/** Polls a JPEG snapshot URL (ONVIF snapshot URI, Hikvision /ISAPI/Streaming/channels/101/picture, …). */
export class SnapshotSource implements FrameSource {
  readonly kind = 'snapshot';
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private readonly fetchJpeg: () => Promise<Uint8Array>,
    private readonly intervalMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}
  static url(url: string, intervalMs = 1000, auth?: HttpAuth, now?: () => number) {
    return new SnapshotSource(
      async () => {
        const r = await httpGet(url, { auth });
        if (r.status >= 400) throw new Error(`Snapshot HTTP ${r.status}`);
        return r.bytes;
      },
      intervalMs,
      now,
    );
  }
  start(onFrame: (jpeg: Uint8Array, at: number) => void, onError: (e: Error) => void) {
    const tick = async () => {
      if (this.busy) return;
      this.busy = true;
      const at = this.now();
      try {
        onFrame(await this.fetchJpeg(), at);
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        this.busy = false;
      }
    };
    this.timer = setInterval(() => void tick(), this.intervalMs);
    void tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Splits a byte stream into JPEG frames by their SOI/EOI markers (MJPEG, ffmpeg image2pipe). */
export class JpegSplitter {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  constructor(
    private readonly onFrame: (jpeg: Buffer) => void,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}
  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const soi = this.buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
      if (soi < 0) {
        // keep the tail: a marker may be split across chunks
        this.buf = this.buf.length > 2 ? this.buf.subarray(this.buf.length - 2) : this.buf;
        return;
      }
      const eoi = this.buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 3);
      if (eoi < 0) {
        if (soi > 0) this.buf = this.buf.subarray(soi);
        if (this.buf.length > this.maxBytes) this.buf = Buffer.alloc(0);
        return;
      }
      this.onFrame(this.buf.subarray(soi, eoi + 2));
      this.buf = this.buf.subarray(eoi + 2);
    }
  }
}

/** An HTTP multipart/x-mixed-replace MJPEG stream (Axis, many cheap cameras, MediaMTX "mjpeg" path). */
export class MjpegSource implements FrameSource {
  readonly kind = 'mjpeg';
  private req?: http.ClientRequest;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  constructor(
    private readonly url: string,
    private readonly auth?: HttpAuth,
    private readonly now: () => number = Date.now,
  ) {}
  start(onFrame: (jpeg: Uint8Array, at: number) => void, onError: (e: Error) => void) {
    const connect = () => {
      if (this.stopped) return;
      const splitter = new JpegSplitter((j) => onFrame(j, this.now()));
      void httpGet(this.url, {
        auth: this.auth,
        timeoutMs: 10_000,
        onResponse: (res) => {
          if ((res.statusCode ?? 0) >= 400) {
            onError(new Error(`MJPEG HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          res.on('data', (c: Buffer) => splitter.push(c));
          res.on('end', () => {
            if (!this.stopped) this.retry = setTimeout(connect, 2000);
          });
          res.on('error', (e) => onError(e));
        },
      }).catch((e) => {
        onError(e instanceof Error ? e : new Error(String(e)));
        if (!this.stopped) this.retry = setTimeout(connect, 3000);
      });
    };
    connect();
  }
  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.req?.destroy();
  }
}

/** Any input ffmpeg can open (RTSP, RTMP, SRT, a file, a V4L2 device) sampled at `fps` as JPEG frames. */
export class FfmpegSource implements FrameSource {
  readonly kind = 'ffmpeg';
  private proc?: ChildProcess;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  constructor(
    private readonly opts: { input: string; fps?: number; width?: number; ffmpegPath?: string; extraArgs?: string[]; rtspTcp?: boolean },
    private readonly now: () => number = Date.now,
  ) {}
  static args(o: FfmpegSource['opts']) {
    const a: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (o.rtspTcp !== false && /^rtsps?:\/\//.test(o.input)) a.push('-rtsp_transport', 'tcp');
    a.push(...(o.extraArgs ?? []), '-i', o.input);
    const vf = [`fps=${o.fps ?? 1}`];
    if (o.width) vf.push(`scale=${o.width}:-2`);
    a.push('-an', '-vf', vf.join(','), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1');
    return a;
  }
  start(onFrame: (jpeg: Uint8Array, at: number) => void, onError: (e: Error) => void) {
    const run = () => {
      if (this.stopped) return;
      const splitter = new JpegSplitter((j) => onFrame(j, this.now()));
      let err = '';
      const proc = spawn(this.opts.ffmpegPath ?? 'ffmpeg', FfmpegSource.args(this.opts), { stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = proc;
      proc.stdout!.on('data', (c: Buffer) => splitter.push(c));
      proc.stderr!.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-400)));
      proc.on('error', (e) => onError(new Error(`ffmpeg: ${e.message}`)));
      proc.on('exit', (code) => {
        if (this.stopped) return;
        if (code !== 0) onError(new Error(`ffmpeg exited with ${code}: ${err.trim()}`));
        this.retry = setTimeout(run, 3000);
      });
    };
    run();
  }
  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.proc?.kill('SIGTERM');
  }
}

/** JPEG files from a folder, in name order, on an interval; loops. For demos and tests. */
export class FolderSource implements FrameSource {
  readonly kind = 'folder';
  private timer?: NodeJS.Timeout;
  private i = 0;
  constructor(
    private readonly dir: string,
    private readonly intervalMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}
  start(onFrame: (jpeg: Uint8Array, at: number) => void, onError: (e: Error) => void) {
    let files: string[];
    try {
      files = readdirSync(this.dir)
        .filter((f) => /\.jpe?g$/i.test(f))
        .sort();
    } catch (e) {
      return onError(e instanceof Error ? e : new Error(String(e)));
    }
    if (!files.length) return onError(new Error(`No JPEG files in ${this.dir}`));
    const tick = () => {
      try {
        onFrame(readFileSync(join(this.dir, files[this.i % files.length])), this.now());
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
      this.i++;
    };
    this.timer = setInterval(tick, this.intervalMs);
    tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

/** Frames pushed from code (tests; adapters that already have the bytes). */
export class PushSource implements FrameSource {
  readonly kind = 'push';
  private onFrame?: (jpeg: Uint8Array, at: number) => void;
  start(onFrame: (jpeg: Uint8Array, at: number) => void) {
    this.onFrame = onFrame;
  }
  push(jpeg: Uint8Array, at: number) {
    this.onFrame?.(jpeg, at);
  }
  stop() {
    this.onFrame = undefined;
  }
}
