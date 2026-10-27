// Pushes a camera's RTSP stream into the platform's media server with ffmpeg. The stream is copied,
// not re-encoded, so the edge (a SIYI remote, a laptop, an onboard computer) needs almost no CPU.
// ffmpeg restarts with backoff when the camera, the radio link or the network drops.
// The publish URL carries a credential: it never reaches a log line.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from './sdk';

export type PushStatus = 'starting' | 'pushing' | 'retrying' | 'missing' | 'stopped';

export interface PushState {
  status: PushStatus;
  detail: string;
  /** Video codec ffmpeg found in the camera stream (h264, hevc, …), once known. */
  codec?: string;
}

export interface VideoPushOptions {
  deviceId: string;
  /** Camera on the device network, e.g. rtsp://192.168.144.25:8554/main.264 */
  source: string;
  /** Publish address from the server's welcome, e.g. rtsp://pub:<token>@192.168.20.13:18554/ugv-01 */
  target: string;
  /** ffmpeg executable (default: `ffmpeg` on PATH). */
  ffmpeg?: string;
  /** Arguments placed before ffmpeg's own, e.g. a script path when `ffmpeg` is node (tests). */
  prefixArgs?: string[];
  log: Logger;
  onState?: (s: PushState) => void;
  /** Restart delay: starts at initialMs, doubles up to maxMs. Default 2 s → 30 s. */
  backoff?: { initialMs: number; maxMs: number };
  /** A run at least this long counts as healthy and resets the backoff. Default 30 s. */
  healthyMs?: number;
}

export interface Pusher {
  /** New publish address (the server issues a new credential on every reconnect). Used from the next start. */
  setTarget(url: string): void;
  stop(): void;
  readonly state: PushState;
}

/** The URL with its password replaced, for logs and status text. */
export function redact(text: string) {
  return text.replace(/(rtsps?:\/\/[^:/@\s'"]+:)[^@\s'"]*@/g, '$1***@');
}

/** ffmpeg arguments: read the camera over TCP, copy the video track, publish over RTSP/TCP. */
export function ffmpegArgs(source: string, target: string) {
  return [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'info',
    '-rtsp_transport',
    'tcp',
    '-timeout',
    '10000000', // µs: give up on a silent camera after 10 s
    '-i',
    source,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    '-an',
    '-f',
    'rtsp',
    '-rtsp_transport',
    'tcp',
    target,
  ];
}

/** What a stderr line from ffmpeg tells us. */
export function readFfmpegLine(line: string): { codec?: string; publishing?: boolean; problem?: string } {
  const out: { codec?: string; publishing?: boolean; problem?: string } = {};
  const v = /Stream #\d+:\d+.*?: Video: (\w+)/.exec(line);
  if (v) out.codec = v[1];
  // ffmpeg prints the output header only after the media server accepted the publish.
  if (/^Output #0, rtsp/.test(line)) out.publishing = true;
  if (/error|failed|refused|unauthori[sz]ed|timed out|not found|invalid|no route|unreachable|denied|401|404/i.test(line)) out.problem = redact(line.trim()).slice(0, 200);
  return out;
}

export class VideoPusher implements Pusher {
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delay: number;
  private stopped = false;
  private startedAt = 0;
  private codecWarned = false;
  private current: PushState = { status: 'starting', detail: 'Starting the video push' };

  constructor(private o: VideoPushOptions) {
    this.delay = o.backoff?.initialMs ?? 2_000;
    this.launch();
  }

  get state() {
    return { ...this.current };
  }

  setTarget(url: string) {
    this.o.target = url;
    // A running push keeps going; a waiting retry starts now with the fresh credential.
    if (!this.child && !this.stopped) {
      clearTimeout(this.timer);
      this.launch();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) {
      c.kill('SIGTERM');
      setTimeout(() => c.exitCode === null && c.kill('SIGKILL'), 3_000).unref();
    }
    this.set({ status: 'stopped', detail: 'Video push stopped' });
  }

  private set(s: PushState) {
    const changed = s.status !== this.current.status || s.detail !== this.current.detail || s.codec !== this.current.codec;
    this.current = { ...s, codec: s.codec ?? this.current.codec };
    if (changed) this.o.onState?.(this.state);
  }

  private launch() {
    if (this.stopped) return;
    const { log, deviceId } = this.o;
    const bin = this.o.ffmpeg ?? 'ffmpeg';
    this.startedAt = Date.now();
    let problem = '';
    let child: ChildProcess;
    try {
      child = spawn(bin, [...(this.o.prefixArgs ?? []), ...ffmpegArgs(this.o.source, this.o.target)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e) {
      return this.onExit(null, (e as NodeJS.ErrnoException).code === 'ENOENT', (e as Error).message);
    }
    this.child = child;
    this.set({ status: 'starting', detail: `Connecting to the camera ${this.o.source}` });
    let missing = false;
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (this.child === child) this.child = null;
      this.onExit(code, missing, problem);
    };
    child.on('error', (e: NodeJS.ErrnoException) => {
      missing = e.code === 'ENOENT';
      problem = e.message;
      // A process that never started may not emit 'close'.
      if (child.pid === undefined) finish(null);
    });
    let buf = '';
    let output = false; // after "Output #0" the stream lines describe what was sent, not the camera
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const r = readFfmpegLine(line);
        if (r.publishing) output = true;
        if (r.codec && !output) {
          this.current.codec = r.codec;
          if (r.codec === 'hevc' && !this.codecWarned) {
            this.codecWarned = true;
            log.warn(`${deviceId}: the camera sends H.265; browsers cannot play it. Set the camera's main stream to H.264.`);
          }
        }
        if (r.problem) problem = r.problem;
        if (r.publishing) {
          log.info(`${deviceId}: video pushed to ${redact(this.o.target)} (${this.current.codec ?? 'codec unknown'})`);
          this.set({ status: 'pushing', detail: `Pushing ${this.current.codec ?? 'video'} to the platform media server` });
        }
      }
    });
    child.on('close', (code) => finish(code));
  }

  private onExit(code: number | null, missing: boolean, problem: string) {
    if (this.stopped) return;
    const { log, deviceId } = this.o;
    const max = this.o.backoff?.maxMs ?? 30_000;
    if (Date.now() - this.startedAt >= (this.o.healthyMs ?? 30_000)) this.delay = this.o.backoff?.initialMs ?? 2_000;
    let wait = this.delay;
    if (missing) {
      wait = Math.max(max, 60_000);
      this.set({ status: 'missing', detail: `ffmpeg not found (${this.o.ffmpeg ?? 'ffmpeg'}): install it to push video (Termux: apt install ffmpeg)` });
      log.error(`${deviceId}: ffmpeg not found; video push off (install ffmpeg)`);
    } else {
      const why = problem || `ffmpeg exited (code ${code})`;
      this.set({ status: 'retrying', detail: `${why} · retrying in ${Math.round(wait / 1000)} s` });
      log.warn(`${deviceId}: video push stopped: ${why}; retrying in ${Math.round(wait / 1000)} s`);
      this.delay = Math.min(max, this.delay * 2);
    }
    this.timer = setTimeout(() => this.launch(), wait);
    this.timer.unref?.();
  }
}
