// Switching a SIYI camera back to H.264 when it pushes H.265: the SDK exchange against a fake
// camera, and the adapter hook (runs once per interval, can be turned off).
import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { decode, encode } from '../src/real/siyiProtocol';
import { SIYI_CODEC, SIYI_ENC, encodingPayload, forceMainStreamH264, parseEncoding } from '../src/real/siyiCodec';
import { CODEC_FIX_INTERVAL_MS, MavlinkVehicleAdapter } from '../src/real/mavlinkVehicle';
import { fakeCtx } from './helpers';

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** A SIYI camera answering GET/SET encoding; records every command it receives. */
function fakeCamera(main: { codec: number; width: number; height: number; kbps: number }, opts: { refuseSet?: boolean } = {}) {
  const sock = dgram.createSocket('udp4');
  const got: { cmd: number; data: number[] }[] = [];
  sock.on('message', (m, r) => {
    for (const f of decode(m)) {
      got.push({ cmd: f.cmd, data: [...f.data] });
      if (f.cmd === SIYI_ENC.GET) {
        const d = Buffer.alloc(9);
        d[0] = f.data[0];
        d[1] = main.codec;
        d.writeUInt16LE(main.width, 2);
        d.writeUInt16LE(main.height, 4);
        d.writeUInt16LE(main.kbps, 6);
        sock.send(encode(SIYI_ENC.GET, [...d], f.seq, false), r.port, r.address);
      } else if (f.cmd === SIYI_ENC.SET) {
        if (!opts.refuseSet) main.codec = f.data[1];
        sock.send(encode(SIYI_ENC.SET, [f.data[0], opts.refuseSet ? 0 : 1], f.seq, false), r.port, r.address);
      }
    }
  });
  return new Promise<{ port: number; got: typeof got; main: typeof main }>((resolve) =>
    sock.bind(0, '127.0.0.1', () => {
      cleanup.push(() => sock.close());
      resolve({ port: (sock.address() as { port: number }).port, got, main });
    }),
  );
}

describe('SIYI codec fix', () => {
  it('reads the encoding and builds a SET that keeps resolution and bitrate', () => {
    const e = parseEncoding(Buffer.from([1, 2, 0x80, 0x07, 0x38, 0x04, 0xa0, 0x0f]))!;
    expect(e).toEqual({ stream: 1, codec: 2, width: 1920, height: 1080, kbps: 4000 });
    expect(encodingPayload(e, SIYI_CODEC.H264)).toEqual([1, 1, 0x80, 0x07, 0x38, 0x04, 0xa0, 0x0f, 0]);
    expect(parseEncoding(Buffer.from([1, 2]))).toBeUndefined();
  });

  it('switches an H.265 main stream to H.264 and asks the camera to restart', async () => {
    const cam = await fakeCamera({ codec: SIYI_CODEC.H265, width: 1920, height: 1080, kbps: 4000 });
    const r = await forceMainStreamH264({ host: '127.0.0.1', port: cam.port });
    expect(r).toMatchObject({ changed: true, restarted: true });
    expect(r.detail).toMatch(/from H\.265 to H\.264/);
    expect(cam.main.codec).toBe(SIYI_CODEC.H264);
    const set = cam.got.find((g) => g.cmd === SIYI_ENC.SET)!;
    expect(set.data).toEqual([1, 1, 0x80, 0x07, 0x38, 0x04, 0xa0, 0x0f, 0]);
    expect(cam.got.find((g) => g.cmd === SIYI_ENC.REBOOT)?.data).toEqual([1, 0]);
  });

  it('leaves an H.264 camera alone, and reports a camera that refuses or does not answer', async () => {
    const ok = await fakeCamera({ codec: SIYI_CODEC.H264, width: 1280, height: 720, kbps: 2000 });
    expect(await forceMainStreamH264({ host: '127.0.0.1', port: ok.port })).toMatchObject({ changed: false, restarted: false });
    expect(ok.got.map((g) => g.cmd)).toEqual([SIYI_ENC.GET]);

    const refuse = await fakeCamera({ codec: SIYI_CODEC.H265, width: 1280, height: 720, kbps: 2000 }, { refuseSet: true });
    const r = await forceMainStreamH264({ host: '127.0.0.1', port: refuse.port });
    expect(r).toMatchObject({ changed: false, restarted: false });
    expect(r.detail).toMatch(/refused/);
    expect(refuse.got.some((g) => g.cmd === SIYI_ENC.REBOOT)).toBe(false);

    const silent = await forceMainStreamH264({ host: '127.0.0.1', port: 9, timeoutMs: 200 });
    expect(silent).toMatchObject({ changed: false });
    expect(silent.detail).toMatch(/did not answer/);
  });
});

describe('adapter: H.265 from the pushed camera', () => {
  const geo = { originLat: 13.7563, originLon: 100.5018, rotationDeg: 0 };
  function adapter(extra: Partial<ConstructorParameters<typeof MavlinkVehicleAdapter>[0]> = {}) {
    const calls: string[] = [];
    let now = 1_000_000;
    const a = new MavlinkVehicleAdapter({
      deviceId: 'UGV-09',
      kind: 'ugv',
      profile: 'ardupilot-rover',
      link: { mode: 'client', host: '127.0.0.1', port: 9 },
      geo,
      stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true },
      codecFixer: async (o) => {
        calls.push(o.host);
        return { changed: true, restarted: true, detail: 'Switched the camera main stream from H.265 to H.264 and asked the camera to restart' };
      },
      ...extra,
    });
    const { ctx } = fakeCtx();
    ctx.now = () => now;
    a.start(ctx);
    cleanup.push(() => a.stop());
    return { a, calls, advance: (ms: number) => (now += ms) };
  }

  it('fixes the camera once per interval and says so on the camera part', async () => {
    const { a, calls, advance } = adapter();
    a.onMediaState({ status: 'pushing', codec: 'hevc', detail: '' });
    a.onMediaState({ status: 'pushing', codec: 'hevc', detail: '' });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(['192.168.144.25']);
    const cam = a.declaration.components?.find((c) => c.id === 'cam');
    expect(cam).toBeTruthy();
    advance(CODEC_FIX_INTERVAL_MS - 1);
    a.onMediaState({ status: 'pushing', codec: 'hevc', detail: '' });
    expect(calls).toHaveLength(1);
    advance(2);
    a.onMediaState({ status: 'pushing', codec: 'hevc', detail: '' });
    expect(calls).toHaveLength(2);
    // H.264 or not pushing: nothing to fix.
    advance(CODEC_FIX_INTERVAL_MS + 1);
    a.onMediaState({ status: 'pushing', codec: 'h264', detail: '' });
    a.onMediaState({ status: 'retrying', codec: 'hevc', detail: '' });
    expect(calls).toHaveLength(2);
  });

  it('can be turned off per vehicle', async () => {
    const { a, calls } = adapter({ fixCameraCodec: false });
    a.onMediaState({ status: 'pushing', codec: 'hevc', detail: '' });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  });
});
