// The Raspberry Pi kit's helper (deploy/pi: `13store-edge pair | status | ports`).
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayStatus } from '../src/gateway';
import { formatStatus, listPorts, missingPorts, normalizeServer, pair, writeSiteFile, type SiteFile } from '../src/onboard/tool';

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

const PAIRED = {
  gatewayId: 'edge-pi-ugv-01',
  key: 'gw_secret_key_value',
  serverUrl: 'ws://192.168.20.13:8090',
  site: { id: 'SITE-1', name: 'Office' },
  geo: { originLat: 13.75, originLon: 100.5, rotationDeg: 0 },
  devices: [{ type: 'mavlink', deviceId: 'UGV-01', kind: 'ugv', profile: 'ardupilot-rover', link: { mode: 'serial', path: '/dev/ttyAMA0', baud: 115200 } }],
};

describe('server address', () => {
  it('takes what people type and keeps only the origin', () => {
    expect(normalizeServer('192.168.20.13:8090')).toBe('http://192.168.20.13:8090');
    expect(normalizeServer(' http://192.168.20.13:8090/admin ')).toBe('http://192.168.20.13:8090');
    expect(normalizeServer('https://ops.example.com')).toBe('https://ops.example.com');
    expect(normalizeServer('ftp://x')).toBeNull();
    expect(normalizeServer('')).toBeNull();
  });
});

describe('pairing with a code', () => {
  it('posts the code to the server and returns the settings, never the key in the message', async () => {
    const seen: { url: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body });
        const ok = JSON.parse(body).code === '123456';
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? PAIRED : { code: 'invalid_code', message: 'Unknown or expired code.' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => server.close());
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const ok = await pair(origin, '123456', 'Pi edge kit test');
    expect(ok.ok).toBe(true);
    expect(ok.site).toMatchObject({ gatewayId: 'edge-pi-ugv-01', key: 'gw_secret_key_value', serverUrl: 'ws://192.168.20.13:8090', site: { name: 'Office' } });
    expect(ok.message).toContain('edge-pi-ugv-01');
    expect(ok.message).not.toContain('gw_secret');
    expect(seen[0]).toEqual({ url: '/api/v1/edge/pair', body: JSON.stringify({ code: '123456', client: 'Pi edge kit test' }) });

    const wrong = await pair(origin, '000000', 'x');
    expect(wrong).toMatchObject({ ok: false });
    expect(wrong.message).toMatch(/สร้างรหัสใหม่/);
  });

  it('says plainly when the server cannot be reached or refuses for too many tries', async () => {
    const down = await pair('http://127.0.0.1:9', '123456', 'x', () => Promise.reject(new Error('connect ECONNREFUSED')));
    expect(down.message).toMatch(/ติดต่อเซิร์ฟเวอร์ .* ไม่ได้ \(connect ECONNREFUSED\)/);
    const busy = await pair('http://x', '123456', 'x', async () => ({ status: 429, json: { code: 'rate_limited', message: 'Too many requests. Try again in 60 s.' } }));
    expect(busy.message).toMatch(/รอสักครู่/);
  });

  it.skipIf(process.platform === 'win32')('writes the settings readable by their owner only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-site-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'etc', 'site.json');
    writeSiteFile(path, PAIRED as SiteFile);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).key).toBe('gw_secret_key_value');
  });

  it('names serial ports the settings use that this computer lacks', () => {
    expect(missingPorts(PAIRED as SiteFile, (p) => p === '/dev/ttyACM0')).toEqual(['/dev/ttyAMA0']);
    expect(missingPorts(PAIRED as SiteFile, () => true)).toEqual([]);
  });
});

describe('status', () => {
  const now = 1_800_000_000_000;
  const base: GatewayStatus = {
    at: now - 500,
    gatewayId: 'edge-pi-ugv-01',
    server: { url: 'ws://192.168.20.13:8090', connected: true, refused: false, since: now - 60_000 },
    devices: [{ deviceId: 'UGV-01', kind: 'ugv', accepted: true, lastTelemetryAt: now - 400, video: { status: 'pushing', detail: '', codec: 'h264' } }],
    dropped: {} as GatewayStatus['dropped'],
  };

  it('is fine when the server, the vehicle and the video all work', () => {
    const r = formatStatus(base, now);
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toMatch(/เชื่อมต่อแล้ว[\s\S]*UGV-01\s+รถส่งข้อมูลอยู่ \(ล่าสุด 0\.4 วินาที\) · วิดีโอ กำลังส่ง \(h264\)/);
  });

  it('points at the cause: no network, a refused key, a silent vehicle, a stopped gateway', () => {
    expect(formatStatus({ ...base, server: { ...base.server, connected: false } }, now).lines[1]).toMatch(/4G/);
    expect(formatStatus({ ...base, server: { ...base.server, connected: false, refused: true } }, now).lines[1]).toMatch(/จับคู่ใหม่/);
    const silent = formatStatus({ ...base, devices: [{ ...base.devices[0], lastTelemetryAt: now - 9000 }] }, now);
    expect(silent.ok).toBe(false);
    expect(silent.lines[2]).toMatch(/TELEM1/);
    expect(formatStatus({ ...base, at: now - 30_000 }, now).lines[0]).toMatch(/ไม่ได้ทำงาน/);
    expect(formatStatus(null, now).ok).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('serial ports', () => {
  it('lists the GPIO UART first, its aliases, USB boards by id and plain USB ports', () => {
    const dev = mkdtempSync(join(tmpdir(), 'pi-dev-'));
    cleanup.push(() => rmSync(dev, { recursive: true, force: true }));
    for (const f of ['ttyAMA0', 'ttyACM0', 'ttyUSB2', 'tty1']) writeFileSync(join(dev, f), '');
    symlinkSync('ttyAMA0', join(dev, 'serial0'));
    mkdirSync(join(dev, 'serial', 'by-id'), { recursive: true });
    symlinkSync('../../ttyACM0', join(dev, 'serial', 'by-id', 'usb-ArduPilot_UniFC6Pico_3E00-if00'));
    const ports = listPorts(dev);
    expect(ports.map((p) => p.path.slice(dev.length))).toEqual(['/ttyAMA0', '/serial0', '/serial/by-id/usb-ArduPilot_UniFC6Pico_3E00-if00', '/ttyACM0', '/ttyUSB2']);
    expect(ports[0].note).toMatch(/TELEM1/);
    expect(ports[1]).toMatchObject({ target: join(dev, 'ttyAMA0') });
    expect(ports[2].note).toMatch(/บอร์ดควบคุม/);
  });
});
