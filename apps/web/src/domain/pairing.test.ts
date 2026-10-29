import { describe, expect, it } from 'vitest';
import { parsePairingLink, pairingLink } from '@13store/shared';
import { parseSiteConfig } from '@13store/gateway';
import { REMOTE_DEFAULTS, formatCode, loopbackOrigin, pairingQr, readDeviceList, remoteDevices, timeLeft, unregistered } from './pairing';

const GEO = { originLat: 13.4367374, originLon: 101.0275798, rotationDeg: -28.5 };

describe('Pair an edge remote (Admin card)', () => {
  it('builds the UniRC 7 Pro device list the gateway accepts, with the camera pushed and console driving on', () => {
    const devices = remoteDevices({ ...REMOTE_DEFAULTS, vehicleId: ' ugv-01 ' });
    expect(() => parseSiteConfig({ geo: GEO, devices })).not.toThrow();
    expect(devices[0]).toMatchObject({
      type: 'mavlink',
      deviceId: 'UGV-01',
      profile: 'ardupilot-rover',
      link: { mode: 'client', host: '192.168.144.20', port: 19856 },
      allowRemoteArm: false,
      teleop: true,
      gcsRelay: true,
      stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true },
    });
  });

  it('leaves video out when no camera address is given', () => {
    expect(remoteDevices({ ...REMOTE_DEFAULTS, cameraRtsp: '  ' })[0]).not.toHaveProperty('stream');
  });

  it('shows the code in two groups and counts down to expiry', () => {
    expect(formatCode('042917')).toBe('042 917');
    expect(timeLeft(10_000 + 9 * 60_000 + 5_000, 10_000)).toBe('9:05');
    expect(timeLeft(10_000, 10_000)).toBeNull();
  });

  it('notices a console opened as localhost, whose address a remote cannot use', () => {
    for (const o of ['http://localhost:8099', 'http://127.0.0.1:8090', 'http://[::1]:8090']) expect(loopbackOrigin(o)).toBe(true);
    for (const o of ['http://192.168.20.13:8090', 'https://console.example.com']) expect(loopbackOrigin(o)).toBe(false);
  });

  it('names devices the server does not know yet', () => {
    expect(unregistered(['UGV-01', 'CAM-09'], ['UGV-01', 'CCTV-01'])).toEqual(['CAM-09']);
  });

  it('reads a hand-written device list, or says what is wrong with it', () => {
    const ok = readDeviceList(JSON.stringify(remoteDevices(REMOTE_DEFAULTS)));
    expect('ids' in ok && ok.ids).toEqual(['UGV-01']);
    expect(readDeviceList('{')).toHaveProperty('error');
    expect(readDeviceList('[]')).toHaveProperty('error');
    expect(readDeviceList('[1]')).toHaveProperty('error');
  });

  it('puts the server address and code in the QR, and the edge reads them back', () => {
    const qr = pairingQr('http://192.168.20.13:8090', '042917');
    expect(qr.text).toBe(pairingLink('http://192.168.20.13:8090', '042917'));
    expect(qr.size).toBeGreaterThanOrEqual(21);
    expect(qr.path).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(parsePairingLink(qr.text)).toEqual({ server: 'http://192.168.20.13:8090', code: '042917' });
  });

  it('accepts typed digits with spaces, refuses anything else', () => {
    expect(parsePairingLink(' 042 917 ')).toEqual({ code: '042917' });
    expect(parsePairingLink('042-917')).toEqual({ code: '042917' });
    for (const bad of ['04291', 'abcdef', 'psedge://pair?code=12', 'psedge://pair?server=javascript:alert(1)&code=123456', 'https://x/pair?code=123456'])
      expect(parsePairingLink(bad)).toBeNull();
  });
});
