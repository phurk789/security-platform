// SIYI cameras sometimes switch their main stream back to H.265 by themselves (seen on 27 and
// 28 Oct 2026, for example after camera settings were changed from UniGCS). Browsers cannot play
// H.265, so when a pushed stream turns out to be H.265 the gateway switches the main stream back to
// H.264 and asks the camera to restart, which is when the new codec takes effect.
import dgram from 'node:dgram';
import { SIYI_DEFAULT, decode, encode } from './siyiProtocol';

/** SIYI SDK commands for stream encoding and restart. */
export const SIYI_ENC = {
  GET: 0x20,
  SET: 0x21,
  /** Soft reboot: data [camera (1 = restart), gimbal (1 = reset)]. Older firmware may ignore it. */
  REBOOT: 0x80,
} as const;
export const SIYI_STREAM = { RECORD: 0, MAIN: 1, SUB: 2 } as const;
export const SIYI_CODEC = { H264: 1, H265: 2 } as const;

export interface StreamEncoding {
  stream: number;
  codec: number;
  width: number;
  height: number;
  kbps: number;
}

/** Reply to GET (0x20): stream, codec, width, height, bitrate (u16 LE each for the last three). */
export function parseEncoding(d: Buffer): StreamEncoding | undefined {
  if (d.length < 8) return undefined;
  return { stream: d[0], codec: d[1], width: d.readUInt16LE(2), height: d.readUInt16LE(4), kbps: d.readUInt16LE(6) };
}

/** SET (0x21) payload that keeps the stream's resolution and bitrate and only changes the codec. */
export function encodingPayload(e: StreamEncoding, codec: number): number[] {
  const p = Buffer.alloc(9);
  p[0] = e.stream;
  p[1] = codec;
  p.writeUInt16LE(e.width, 2);
  p.writeUInt16LE(e.height, 4);
  p.writeUInt16LE(e.kbps, 6);
  return [...p];
}

export const codecName = (c: number) => (c === SIYI_CODEC.H264 ? 'H.264' : c === SIYI_CODEC.H265 ? 'H.265' : `codec ${c}`);

export interface CodecFixResult {
  /** The camera's main stream was set to H.264 by this call. */
  changed: boolean;
  /** A restart was requested (the camera drops video for a few seconds). */
  restarted: boolean;
  detail: string;
}

/**
 * Make the camera's main stream H.264. Reads the current encoding first; only writes when it is
 * something else, and only then asks the camera to restart.
 */
export async function forceMainStreamH264(o: { host: string; port?: number; timeoutMs?: number; restart?: boolean }): Promise<CodecFixResult> {
  const port = o.port ?? SIYI_DEFAULT.port;
  const timeoutMs = o.timeoutMs ?? 1500;
  const sock = dgram.createSocket('udp4');
  let seq = 0;
  const ask = (cmd: number, data: number[]) =>
    new Promise<Buffer | null>((resolve) => {
      const onMsg = (m: Buffer) => {
        const f = decode(m).find((x) => x.cmd === cmd);
        if (!f) return;
        clearTimeout(t);
        sock.off('message', onMsg);
        resolve(f.data);
      };
      const t = setTimeout(() => {
        sock.off('message', onMsg);
        resolve(null);
      }, timeoutMs);
      sock.on('message', onMsg);
      sock.send(encode(cmd, data, seq++), port, o.host);
    });
  try {
    await new Promise<void>((r) => sock.bind(0, () => r()));
    const before = await ask(SIYI_ENC.GET, [SIYI_STREAM.MAIN]);
    const e = before && parseEncoding(before);
    if (!e) return { changed: false, restarted: false, detail: `The camera at ${o.host} did not answer the SIYI codec query` };
    if (e.codec === SIYI_CODEC.H264) return { changed: false, restarted: false, detail: 'The camera main stream is already H.264' };
    const r = await ask(SIYI_ENC.SET, encodingPayload(e, SIYI_CODEC.H264));
    if (!r || r[1] !== 1) return { changed: false, restarted: false, detail: `The camera refused to switch its main stream from ${codecName(e.codec)} to H.264` };
    if (o.restart === false) return { changed: true, restarted: false, detail: `Switched the camera main stream from ${codecName(e.codec)} to H.264; restart the camera to apply` };
    // Fire and forget: the camera reboots instead of answering on some firmware.
    sock.send(encode(SIYI_ENC.REBOOT, [1, 0], seq++), port, o.host);
    await new Promise((r2) => setTimeout(r2, 100));
    return { changed: true, restarted: true, detail: `Switched the camera main stream from ${codecName(e.codec)} to H.264 and asked the camera to restart` };
  } catch (err) {
    return { changed: false, restarted: false, detail: `Codec fix failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    sock.close();
  }
}
