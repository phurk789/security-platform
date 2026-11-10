// Admin → "Pair an edge remote" (CLEANUP_PLAN E-3): what the card sends and shows. The server checks
// the device list again (apps/server/src/pairing.ts); these helpers only build and display it.
import qrcode from 'qrcode-generator';
import { pairingLink, type PairingCodeView } from '@13store/shared';
import { RCU_ND_GEARS, noRemoteFor, type RemoteChoice } from './vehicleControl';

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
  /** Raspberry Pi only: still driven with the SIYI remote, or not (the Pi is then its remote). */
  remote?: RemoteChoice;
  /** SIYI remote only: gear buttons on the drive panel for the RCU-ND motor board (UGV-01, RC channel 11). */
  rcuGears?: boolean;
  /** Also run the vehicle's SIYI gimbal camera as its own device, so the platform can turn it (gimbalCamera). */
  gimbal?: boolean;
}

export const REMOTE_DEFAULTS: RemoteForm = {
  label: 'SIYI UniRC 7 Pro',
  gatewayId: 'edge-unirc-01',
  vehicleId: 'UGV-01',
  model: 'Small electric UGV · ArduPilot Rover',
  cameraRtsp: 'rtsp://192.168.144.25:8554/main.264',
  rcuGears: true,
};

/**
 * Console driving limits for a paired vehicle. Full throttle is allowed because the drive panel starts every drive at
 * 30 % and the driver steps up (30 / 60 / 100 %). Travel 450 µs puts 100 % at the remote's own full stick (UGV-01's
 * RC3 runs 1050–1950); steering stays about where the old default had it (0.55 × 450 ≈ 0.6 × 400).
 */
export const PAIRED_TELEOP = { maxThrottle: 1, maxSteer: 0.55, travel: 450 };

/** Name and gateway id offered for each target (kept until the administrator types their own). */
export const TARGET_DEFAULTS: Record<EdgeTarget, Pick<RemoteForm, 'label' | 'gatewayId'>> = {
  remote: { label: REMOTE_DEFAULTS.label, gatewayId: REMOTE_DEFAULTS.gatewayId },
  pi: { label: 'Raspberry Pi on UGV-01', gatewayId: 'edge-pi-ugv-01' },
};

/** UniRC 7 / 7 Pro datalink: the remote is a UDP server at this address on its own network. */
export const UNIRC_DATALINK = { host: '192.168.144.20', port: 19856 };

/** SIYI gimbal SDK (UDP) on the air unit's camera, with the A8 mini's yaw signs measured on the bench (26 Oct). */
export const SIYI_GIMBAL = { host: '192.168.144.25', port: 37260, yawSpeedSign: 1, yawAngleSign: -1 } as const;

/** The camera's address for the gimbal SDK: the host of the RTSP address, or the SIYI default when there is none. */
export function cameraHost(rtsp: string): string {
  const m = /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?([\w.-]+)(?=[:/?#]|$)/i.exec(rtsp.trim());
  return m?.[1] ?? SIYI_GIMBAL.host;
}

/** UGV-01 → UGV-01-CAM: the id the vehicle's gimbal camera is registered under. */
export function gimbalCameraId(vehicleId: string) {
  return `${vehicleId.trim().toUpperCase()}-CAM`;
}

/**
 * The vehicle's SIYI gimbal camera as a device of its own that rides on the vehicle ("follows"): checkpoints and the
 * cockpit turn it. No pos (it is where the vehicle is; the gateway refuses pos beside follows) and no stream (the video
 * stays on the vehicle). The gateway talks to it with the SIYI SDK over the same LAN as the video.
 */
export function gimbalCamera(f: RemoteForm): Record<string, unknown> {
  const vehicle = f.vehicleId.trim().toUpperCase();
  return {
    type: 'siyi-camera',
    deviceId: gimbalCameraId(vehicle),
    model: `SIYI A8 mini on ${vehicle}`,
    follows: vehicle,
    host: cameraHost(f.cameraRtsp),
    port: SIYI_GIMBAL.port,
    yawSpeedSign: SIYI_GIMBAL.yawSpeedSign,
    yawAngleSign: SIYI_GIMBAL.yawAngleSign,
  };
}

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
      // promotes the vehicle to LIVE_MANUAL and an operator starts the drive. With the RCU-ND board the driver's gear
      // buttons take channel 11 from the remote's switch until the drive ends.
      teleop: { ...PAIRED_TELEOP, ...(f.rcuGears ? RCU_ND_GEARS : {}) },
      // UniGCS on the remote runs alongside the gateway: it connects to 127.0.0.1:19857 instead of the datalink (E-5).
      gcsRelay: true,
      ...(camera ? { stream: { rtsp: camera, push: true } } : {}),
    },
    // The remote reaches the camera over the air link, like the video.
    ...(f.gimbal ? [gimbalCamera(f)] : []),
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
      // Gears, if any, belong to the virtual remote (noRemote), which the drive panel's gear buttons also set.
      teleop: { ...PAIRED_TELEOP },
      ...noRemoteFor(f.remote ?? 'remote'),
      ...(camera ? { stream: { rtsp: camera, push: true } } : {}),
    },
    ...(f.gimbal ? [gimbalCamera(f)] : []),
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

/** The device ids a device list names: the vehicle, and its gimbal camera when it is added. */
/**
 * Who holds this gateway id now, when a new code would take it from them. Pairing a gateway id again revokes the key of
 * its previous pairing, so that edge drops off (on 10 Nov a second remote paired as edge-unirc-01 cut UGV-01's remote
 * off). No clash when the new list shares a device with the last pairing (the same vehicle paired again), or when
 * those devices have since been paired under another gateway id (that edge moved on).
 */
export function gatewayClash(
  gatewayId: string,
  ids: string[],
  codes: Pick<PairingCodeView, 'gatewayId' | 'deviceIds' | 'status' | 'label' | 'pairedAt'>[],
): { label: string; deviceIds: string[] } | undefined {
  const gw = gatewayId.trim();
  const paired = codes.filter((c) => c.status === 'paired').sort((a, b) => (b.pairedAt ?? 0) - (a.pairedAt ?? 0));
  const last = paired.find((c) => c.gatewayId === gw);
  if (!gw || !last || last.deviceIds.some((id) => ids.includes(id))) return undefined;
  const movedOn = (id: string) => paired.some((c) => c.gatewayId !== gw && (c.pairedAt ?? 0) > (last.pairedAt ?? 0) && c.deviceIds.includes(id));
  const held = last.deviceIds.filter((id) => !movedOn(id));
  return held.length ? { label: last.label, deviceIds: held } : undefined;
}

/** A gateway id no pairing has used, numbered like the one typed: edge-unirc-01 → edge-unirc-02 (or "-01" added). */
export function freeGatewayId(gatewayId: string, codes: Pick<PairingCodeView, 'gatewayId'>[]): string {
  const used = new Set(codes.map((c) => c.gatewayId));
  const typed = gatewayId.trim();
  const m = /^(.*?)(\d+)$/.exec(typed);
  const base = m ? m[1] : `${typed}-`;
  const width = m ? m[2].length : 2;
  for (let n = 1; n < 1000; n++) {
    const id = `${base}${String(n).padStart(width, '0')}`;
    if (!used.has(id)) return id;
  }
  return `${base}${used.size + 1}`;
}

/**
 * What to register for the devices of a list the server does not know yet, in list order (the vehicle before its
 * camera): its id, the kind the server files it under (a MAVLink or ROS vehicle by its own kind, any camera as CCTV)
 * and its model text. The card's "Register … now" button posts these to /devices.
 */
export function registrationsFor(devices: Record<string, unknown>[], missing: string[]): { id: string; kind: 'ugv' | 'uav' | 'cctv'; model?: string }[] {
  const want = new Set(missing);
  return devices.flatMap((d) => {
    const id = d.deviceId;
    if (typeof id !== 'string' || !want.delete(id)) return [];
    const vehicle = d.type === 'mavlink' || d.type === 'ros2-nav2';
    const kind = vehicle ? (d.kind === 'uav' ? 'uav' : 'ugv') : 'cctv';
    const model = typeof d.model === 'string' && d.model.trim() ? d.model.trim().slice(0, 80) : undefined;
    return [{ id, kind, ...(model ? { model } : {}) }];
  });
}

export function deviceIdsOf(devices: Record<string, unknown>[]) {
  return devices.map((d) => d.deviceId).filter((x): x is string => typeof x === 'string');
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
  return { devices, ids: deviceIdsOf(devices) };
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
