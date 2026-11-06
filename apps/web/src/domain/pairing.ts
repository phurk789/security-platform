// Admin → "Pair an edge remote" (CLEANUP_PLAN E-3): what the card sends and shows. The server checks
// the device list again (apps/server/src/pairing.ts); these helpers only build and display it.
import qrcode from 'qrcode-generator';
import { pairingLink } from '@13store/shared';

/** Where the gateway runs: the edge app on the SIYI remote, or a Raspberry Pi on the vehicle (deploy/pi). */
export type EdgeTarget = 'remote' | 'pi';

/**
 * How a Pi reaches the flight controller: TELEM1 wired to the GPIO UART (pins 8/10), TELEM1 on the Pi 5's own 3-pin
 * UART connector (JST-SH, locks better on a shaking vehicle), or a USB cable.
 */
export type PiPort = 'uart' | 'pi5' | 'usb';

/** Serial settings per cable. TELEM1 runs at SERIAL1_BAUD = 115 (deploy/pi/README_TH.md); USB ignores the speed. */
export const PI_PORTS: Record<PiPort, { path: string; baud: number }> = {
  uart: { path: '/dev/ttyAMA0', baud: 115200 },
  pi5: { path: '/dev/ttyAMA10', baud: 115200 },
  usb: { path: '/dev/ttyACM0', baud: 115200 },
};

/** Equipment tab text for each cable. */
const PI_RADIO: Record<PiPort, string> = {
  uart: 'Raspberry Pi on the vehicle (TELEM1)',
  pi5: 'Raspberry Pi on the vehicle (TELEM1, Pi 5 UART connector)',
  usb: 'Raspberry Pi on the vehicle (USB)',
};

/** The SIYI UniRC 7 Pro setup: vehicle on the remote's datalink, camera pushed to the platform. */
export interface RemoteForm {
  label: string;
  gatewayId: string;
  vehicleId: string;
  /** Model text shown on the vehicle's Equipment tab. */
  model: string;
  /** Empty: no video. */
  cameraRtsp: string;
  /** Raspberry Pi only. */
  piPort?: PiPort;
}

export const REMOTE_DEFAULTS: RemoteForm = {
  label: 'SIYI UniRC 7 Pro',
  gatewayId: 'edge-unirc-01',
  vehicleId: 'UGV-01',
  model: 'Small electric UGV · ArduPilot Rover',
  cameraRtsp: 'rtsp://192.168.144.25:8554/main.264',
};

/** Name and gateway id offered for each target (kept until the administrator types their own). */
export const TARGET_DEFAULTS: Record<EdgeTarget, Pick<RemoteForm, 'label' | 'gatewayId'>> = {
  remote: { label: REMOTE_DEFAULTS.label, gatewayId: REMOTE_DEFAULTS.gatewayId },
  pi: { label: 'Raspberry Pi on UGV-01', gatewayId: 'edge-pi-ugv-01' },
};

/** UniRC 7 / 7 Pro datalink: the remote is a UDP server at this address on its own network. */
export const UNIRC_DATALINK = { host: '192.168.144.20', port: 19856 };

/** The gateway device list for a UGV driven through the remote (same shape as deploy/remote/site.*.json). */
export function remoteDevices(f: RemoteForm): Record<string, unknown>[] {
  const camera = f.cameraRtsp.trim();
  return [
    {
      type: 'mavlink',
      deviceId: f.vehicleId.trim().toUpperCase(),
      kind: 'ugv',
      profile: 'ardupilot-rover',
      model: f.model.trim() || REMOTE_DEFAULTS.model,
      radio: 'SIYI UniRC 7 Pro datalink',
      link: { mode: 'client', ...UNIRC_DATALINK },
      allowRemoteArm: false,
      // Driving from the console (RC override, dead-man, gateway caps). Still gated by the platform: a supervisor
      // promotes the vehicle to LIVE_MANUAL and an operator starts the drive.
      teleop: true,
      // UniGCS on the remote runs alongside the gateway: it connects to 127.0.0.1:19857 instead of the datalink (E-5).
      gcsRelay: true,
      ...(camera ? { stream: { rtsp: camera, push: true } } : {}),
    },
  ];
}

/**
 * The gateway device list for a Raspberry Pi on the vehicle: the flight controller on a serial port, the camera on the
 * air unit's LAN pushed to the platform. No UniGCS relay (nothing runs a ground station on the Pi).
 */
export function piDevices(f: RemoteForm): Record<string, unknown>[] {
  const camera = f.cameraRtsp.trim();
  const port = f.piPort ?? 'uart';
  return [
    {
      type: 'mavlink',
      deviceId: f.vehicleId.trim().toUpperCase(),
      kind: 'ugv',
      profile: 'ardupilot-rover',
      model: f.model.trim() || REMOTE_DEFAULTS.model,
      radio: PI_RADIO[port],
      link: { mode: 'serial', ...PI_PORTS[port] },
      allowRemoteArm: false,
      teleop: true,
      ...(camera ? { stream: { rtsp: camera, push: true } } : {}),
    },
  ];
}

export function edgeDevices(target: EdgeTarget, f: RemoteForm) {
  return target === 'pi' ? piDevices(f) : remoteDevices(f);
}

/** What to type on the Pi (over SSH) for a code: the kit's helper asks the server for its settings. */
export function piPairCommand(serverOrigin: string, code: string) {
  return `sudo 13store-edge pair ${serverOrigin} ${code}`;
}

/** The QR carries the console's own address: useless to a remote when the console was opened as localhost. */
export function loopbackOrigin(origin: string) {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\./.test(h);
  } catch {
    return false;
  }
}

/** "123456" → "123 456", easier to read out over a radio. */
export function formatCode(code: string) {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Time left on a code as m:ss, or null once it has expired. */
export function timeLeft(expiresAt: number, now: number): string | null {
  const s = Math.ceil((expiresAt - now) / 1000);
  if (s <= 0) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Device ids in the list that the server does not know yet: their gateway would be refused. */
export function unregistered(deviceIds: string[], registered: string[]) {
  const known = new Set(registered);
  return deviceIds.filter((id) => !known.has(id));
}

/** Device ids a JSON device list names (for the warning above), or an error text. */
export function readDeviceList(json: string): { devices: Record<string, unknown>[]; ids: string[] } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!Array.isArray(v) || !v.length || v.some((d) => !d || typeof d !== 'object')) return { error: 'a JSON list of devices, e.g. [{ "type": "mavlink", … }]' };
  const devices = v as Record<string, unknown>[];
  return { devices, ids: devices.map((d) => d.deviceId).filter((x): x is string => typeof x === 'string') };
}

/** QR for the edge app (server address + code) as one SVG path of unit squares, plus its size. */
export function pairingQr(serverOrigin: string, code: string): { size: number; path: string; text: string } {
  const text = pairingLink(serverOrigin, code);
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
  return { size: n, path, text };
}
