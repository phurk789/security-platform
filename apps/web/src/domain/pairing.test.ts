import { describe, expect, it } from 'vitest';
import { parsePairingLink, pairingLink } from '@13store/shared';
import { parseSiteConfig } from '@13store/gateway';
import {
  REMOTE_DEFAULTS,
  TARGET_DEFAULTS,
  cameraHost,
  deviceIdsOf,
  edgeDevices,
  formatCode,
  gimbalCamera,
  loopbackOrigin,
  pairingQr,
  piDevices,
  piPairCommand,
  readDeviceList,
  registrationsFor,
  remoteDevices,
  timeLeft,
  unregistered,
} from './pairing';

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
      // Up to full throttle (the drive panel starts at 30 %), and UGV-01's RCU-ND gears on channel 11.
      teleop: { maxThrottle: 1, maxSteer: 0.55, travel: 450, gearChannel: 11, gears: [1100, 1500, 1900] },
      gcsRelay: true,
      stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true },
    });
    const plain = remoteDevices({ ...REMOTE_DEFAULTS, rcuGears: false });
    expect(() => parseSiteConfig({ geo: GEO, devices: plain })).not.toThrow();
    expect(plain[0].teleop).toEqual({ maxThrottle: 1, maxSteer: 0.55, travel: 450 });
  });

  it('leaves video out when no camera address is given', () => {
    expect(remoteDevices({ ...REMOTE_DEFAULTS, cameraRtsp: '  ' })[0]).not.toHaveProperty('stream');
  });

  it('builds the Raspberry Pi device list: the board on a serial port, no UniGCS relay', () => {
    const uart = piDevices({ ...REMOTE_DEFAULTS, vehicleId: 'ugv-02' });
    expect(() => parseSiteConfig({ geo: GEO, devices: uart })).not.toThrow();
    expect(uart[0]).toMatchObject({
      deviceId: 'UGV-02',
      link: { mode: 'serial', path: '/dev/ttyAMA0', baud: 115200 },
      radio: 'Raspberry Pi on the vehicle (TELEM1)',
      allowRemoteArm: false,
      teleop: { maxThrottle: 1, maxSteer: 0.55, travel: 450 },
      stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true },
    });
    expect(uart[0]).not.toHaveProperty('gcsRelay');
    const usb = edgeDevices('pi', { ...REMOTE_DEFAULTS, piPort: 'usb' });
    expect(() => parseSiteConfig({ geo: GEO, devices: usb })).not.toThrow();
    expect(usb[0]).toMatchObject({ link: { mode: 'serial', path: '/dev/ttyACM0' } });
    const pi5 = edgeDevices('pi', { ...REMOTE_DEFAULTS, piPort: 'pi5' });
    expect(() => parseSiteConfig({ geo: GEO, devices: pi5 })).not.toThrow();
    expect(pi5[0]).toMatchObject({ link: { mode: 'serial', path: '/dev/ttyAMA10', baud: 115200 }, radio: 'Raspberry Pi on the vehicle (TELEM1, Pi 5 UART connector)' });
    expect(edgeDevices('remote', REMOTE_DEFAULTS)).toEqual(remoteDevices(REMOTE_DEFAULTS));
    expect(TARGET_DEFAULTS.pi.gatewayId).toBe('edge-pi-ugv-01');
  });

  it("adds the vehicle's SIYI gimbal camera when ticked: it rides on the vehicle, no pos, no video of its own", () => {
    const camera = {
      type: 'siyi-camera',
      deviceId: 'UGV-01-CAM',
      model: 'SIYI A8 mini on UGV-01',
      follows: 'UGV-01',
      host: '192.168.144.25',
      port: 37260,
      yawSpeedSign: 1,
      yawAngleSign: -1,
    };
    for (const target of ['pi', 'remote'] as const) {
      const devices = edgeDevices(target, { ...REMOTE_DEFAULTS, vehicleId: ' ugv-01 ', gimbal: true, remote: target === 'pi' ? 'none-rcu' : undefined });
      // The same check the server runs on the list before it makes a code.
      expect(() => parseSiteConfig({ geo: GEO, devices })).not.toThrow();
      expect(devices).toHaveLength(2);
      expect(devices[0]).toMatchObject({ type: 'mavlink', deviceId: 'UGV-01', stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true } });
      expect(devices[1]).toEqual(camera);
      // The card's "Register … first" warning names the camera too.
      expect(unregistered(deviceIdsOf(devices), ['UGV-01'])).toEqual(['UGV-01-CAM']);
    }
    // Off unless ticked.
    expect(piDevices(REMOTE_DEFAULTS)).toHaveLength(1);
    expect(remoteDevices({ ...REMOTE_DEFAULTS, gimbal: false })).toHaveLength(1);
  });

  it("talks to the gimbal at the camera's RTSP host, or the SIYI default without one", () => {
    expect(gimbalCamera({ ...REMOTE_DEFAULTS, vehicleId: 'ugv-02', cameraRtsp: ' rtsp://admin:pw@192.168.144.26:8554/main.264 ' })).toMatchObject({
      deviceId: 'UGV-02-CAM',
      model: 'SIYI A8 mini on UGV-02',
      follows: 'UGV-02',
      host: '192.168.144.26',
    });
    expect(cameraHost('rtsp://192.168.144.25/main.264')).toBe('192.168.144.25');
    expect(cameraHost('rtsp://a8.local:8554/main.264')).toBe('a8.local');
    for (const none of ['', '  ', 'main.264', 'rtsp://[fe80::1]:8554/x']) expect(cameraHost(none)).toBe('192.168.144.25');
    // Still valid with no video: the camera is turned, the vehicle just shows no picture.
    const blind = piDevices({ ...REMOTE_DEFAULTS, cameraRtsp: '', gimbal: true });
    expect(() => parseSiteConfig({ geo: GEO, devices: blind })).not.toThrow();
    expect(blind[0]).not.toHaveProperty('stream');
    expect(blind[1]).toMatchObject({ host: '192.168.144.25' });
  });

  it('gives the Pi one command to type, with the console address and the code', () => {
    expect(piPairCommand('http://192.168.20.13:8090', '042917')).toBe('sudo 13store-edge pair http://192.168.20.13:8090 042917');
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

  it('says what to register for the unknown devices: vehicles by their kind, cameras as CCTV, in list order', () => {
    const devices = remoteDevices({ ...REMOTE_DEFAULTS, vehicleId: 'UGV-02', model: 'Tracked UGV', gimbal: true });
    expect(registrationsFor(devices, ['UGV-02-CAM', 'UGV-02'])).toEqual([
      { id: 'UGV-02', kind: 'ugv', model: 'Tracked UGV' },
      { id: 'UGV-02-CAM', kind: 'cctv', model: 'SIYI A8 mini on UGV-02' },
    ]);
    // Only the missing ones; an air vehicle as UAV; no model text → none sent; ids are matched as written.
    expect(registrationsFor(devices, ['UGV-02-CAM'])).toEqual([{ id: 'UGV-02-CAM', kind: 'cctv', model: 'SIYI A8 mini on UGV-02' }]);
    expect(registrationsFor([{ type: 'mavlink', deviceId: 'UAV-01', kind: 'uav', model: ' ' }, { type: 'onvif', deviceId: 'CAM-07' }], ['UAV-01', 'CAM-07'])).toEqual([
      { id: 'UAV-01', kind: 'uav' },
      { id: 'CAM-07', kind: 'cctv' },
    ]);
    expect(registrationsFor(devices, [])).toEqual([]);
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
