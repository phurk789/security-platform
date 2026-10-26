// Camera control (gimbal, zoom, photo, record) — separate from mission commands.
// Mission commands move vehicles and need approval + control ownership; camera control
// does not move a vehicle, but is still permission-checked and audited.

export type CameraAction =
  | { action: 'gimbal_speed'; yaw: number; pitch: number } // −100…100, 0,0 = stop
  | { action: 'gimbal_angle'; yaw: number; pitch: number } // degrees
  | { action: 'center' }
  | { action: 'zoom'; dir: -1 | 0 | 1 }
  | { action: 'zoom_to'; level: number }
  | { action: 'photo' }
  | { action: 'record' }
  // 4-in-1 payload module (loudspeaker, searchlight, warning light, camera)
  | { action: 'spotlight'; on: boolean }
  | { action: 'beacon'; on: boolean }
  | { action: 'announce'; message: string };

export interface GimbalState {
  yaw: number;
  pitch: number;
  roll?: number;
  zoom?: number;
  recording?: boolean;
  /** 4-in-1 module: searchlight on. */
  spotlight?: boolean;
  /** 4-in-1 module: red/blue warning light flashing. */
  beacon?: boolean;
  /** 4-in-1 module: message being played on the loudspeaker right now. */
  announcing?: string;
}

/** Preset loudspeaker messages (English text is what the speaker plays in the demo and what the audit records). */
export const ANNOUNCEMENTS: { id: string; en: string; th: string }[] = [
  { id: 'restricted', en: 'This is a restricted area. Please leave now.', th: 'พื้นที่นี้เป็นเขตหวงห้าม กรุณาออกจากพื้นที่ทันที' },
  { id: 'stay', en: 'Security is on the way. Please stay where you are.', th: 'เจ้าหน้าที่กำลังเดินทางไป กรุณารออยู่ที่เดิม' },
  { id: 'hands_off', en: 'Do not touch this vehicle. It is monitored and recorded.', th: 'ห้ามสัมผัสยานพาหนะนี้ มีการเฝ้าดูและบันทึกภาพ' },
  { id: 'gate_closed', en: 'The service gate is closed. Please use the main entrance.', th: 'ประตูบริการปิดอยู่ กรุณาใช้ทางเข้าหลัก' },
  { id: 'evacuate', en: 'Please move away from this area calmly. Follow staff instructions.', th: 'กรุณาออกจากพื้นที่อย่างสงบ และปฏิบัติตามคำแนะนำของเจ้าหน้าที่' },
];

/** The device capability each camera/payload action needs. */
export function actionCapability(a: CameraAction): string {
  switch (a.action) {
    case 'spotlight':
      return 'spotlight';
    case 'beacon':
      return 'beacon';
    case 'announce':
      return 'speaker';
    case 'zoom':
    case 'zoom_to':
      return 'zoom';
    case 'photo':
      return 'photo';
    case 'record':
      return 'record';
    default:
      return 'gimbal';
  }
}

/** Loudspeaker, searchlight and warning light act on people at the scene: a separate permission. */
export const isPayloadAction = (a: CameraAction) => a.action === 'spotlight' || a.action === 'beacon' || a.action === 'announce';

/**
 * Does this request move the camera or switch an actuator on? Those need a LIVE mode on a real
 * device (ADR-006). Stops (pan/tilt 0,0, zoom stop), switching a light off, photo and record do
 * not: a SHADOW device may still be stopped and may still be observed.
 */
export function cameraActionMoves(a: CameraAction): boolean {
  switch (a.action) {
    case 'gimbal_speed':
      return a.yaw !== 0 || a.pitch !== 0;
    case 'zoom':
      return a.dir !== 0;
    case 'gimbal_angle':
    case 'center':
    case 'zoom_to':
    case 'announce':
      return true;
    case 'spotlight':
    case 'beacon':
      return a.on;
    case 'photo':
    case 'record':
      return false;
  }
}

/** Server → gateway. */
export type SrvCamera = { t: 'camera'; requestId: string; deviceId: string } & CameraAction;

/** Gateway → server. `confirmed` is true only when the camera itself answered. */
export interface GwCameraResult {
  t: 'camera_result';
  requestId: string;
  deviceId: string;
  ok: boolean;
  confirmed: boolean;
  detail?: string;
}

/** Live video published by the gateway's media server (e.g. MediaMTX re-streaming RTSP). */
export interface StreamInfo {
  /** Source on the device network, e.g. rtsp://192.168.144.25:8554/main.264 */
  rtsp?: string;
  /** Browser-playable WebRTC endpoint (WHEP), e.g. https://edge.example/cam1/whep */
  whep?: string;
  /** HLS fallback, e.g. https://edge.example/cam1/index.m3u8 */
  hls?: string;
  /** Low-resolution sub-stream for small views and slow links (same forms as above). */
  rtspSub?: string;
  whepSub?: string;
  hlsSub?: string;
  /** Media server playback (recordings) base URL, e.g. https://edge.example:9996 (MediaMTX playback server). */
  playback?: string;
}

export const CAMERA_ACTIONS: CameraAction['action'][] = ['gimbal_speed', 'gimbal_angle', 'center', 'zoom', 'zoom_to', 'photo', 'record'];

// ---------------------------------------------------------------------------
// Validation and a simulated gimbal (used by the simulated gateway and the offline demo)
// ---------------------------------------------------------------------------

/** Mechanical range of a typical SIYI gimbal (ZT30 / ZR30): yaw ±135°, pitch −90…+25°. */
export const GIMBAL_LIMITS = { yaw: 135, pitchMin: -90, pitchMax: 25, zoomMax: 30 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Checks and clamps a camera action from an untrusted client. Returns null if malformed. */
export function sanitizeCameraAction(raw: unknown): CameraAction | null {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return null;
  switch (a.action) {
    case 'gimbal_speed':
      return finite(a.yaw) && finite(a.pitch) ? { action: 'gimbal_speed', yaw: Math.round(clamp(a.yaw, -100, 100)), pitch: Math.round(clamp(a.pitch, -100, 100)) } : null;
    case 'gimbal_angle':
      return finite(a.yaw) && finite(a.pitch)
        ? { action: 'gimbal_angle', yaw: clamp(a.yaw, -GIMBAL_LIMITS.yaw, GIMBAL_LIMITS.yaw), pitch: clamp(a.pitch, GIMBAL_LIMITS.pitchMin, GIMBAL_LIMITS.pitchMax) }
        : null;
    case 'zoom':
      return a.dir === -1 || a.dir === 0 || a.dir === 1 ? { action: 'zoom', dir: a.dir } : null;
    case 'zoom_to':
      return finite(a.level) ? { action: 'zoom_to', level: clamp(Math.round(a.level * 10) / 10, 1, GIMBAL_LIMITS.zoomMax) } : null;
    case 'center':
    case 'photo':
    case 'record':
      return { action: a.action };
    case 'spotlight':
    case 'beacon':
      return typeof a.on === 'boolean' ? { action: a.action, on: a.on } : null;
    case 'announce': {
      const preset = ANNOUNCEMENTS.find((m) => m.id === a.message);
      const text = preset
        ? preset.en
        : typeof a.message === 'string'
          ? a.message
              .replace(/[\u0000-\u001f]/g, ' ')
              .trim()
              .slice(0, 160)
          : '';
      return text ? { action: 'announce', message: text } : null;
    }
    default:
      return null;
  }
}

export interface SimGimbal {
  state: Required<Omit<GimbalState, 'roll' | 'announcing'>> & { roll: number; announcing?: string; announceUntil?: number };
  /** Simulated seconds since start (for timed effects such as announcements). */
  clock: number;
  yawRate: number; // deg/s
  pitchRate: number;
  zoomRate: number; // x per second
  target?: { yaw: number; pitch: number };
  zoomTarget?: number;
  photos: number;
}

export function newSimGimbal(pitch = -10): SimGimbal {
  return { state: { yaw: 0, pitch, roll: 0, zoom: 1, recording: false, spotlight: false, beacon: false }, clock: 0, yawRate: 0, pitchRate: 0, zoomRate: 0, photos: 0 };
}

/** Applies an action to a simulated gimbal. Returns the camera's answer. */
export function applyCameraAction(g: SimGimbal, a: CameraAction): string {
  switch (a.action) {
    case 'gimbal_speed':
      g.target = undefined;
      g.yawRate = a.yaw * 0.6; // 100 → 60°/s
      g.pitchRate = a.pitch * 0.6;
      return a.yaw || a.pitch ? 'Gimbal moving.' : 'Gimbal stopped.';
    case 'gimbal_angle':
      g.yawRate = g.pitchRate = 0;
      g.target = { yaw: a.yaw, pitch: a.pitch };
      return `Turning to yaw ${a.yaw.toFixed(0)}°, pitch ${a.pitch.toFixed(0)}°.`;
    case 'center':
      g.yawRate = g.pitchRate = 0;
      g.target = { yaw: 0, pitch: 0 };
      return 'Centring.';
    case 'zoom':
      g.zoomTarget = undefined;
      g.zoomRate = a.dir * 4;
      return a.dir ? (a.dir > 0 ? 'Zooming in.' : 'Zooming out.') : 'Zoom stopped.';
    case 'zoom_to':
      g.zoomRate = 0;
      g.zoomTarget = a.level;
      return `Zooming to ${a.level}×.`;
    case 'photo':
      g.photos++;
      return 'Photo taken.';
    case 'record':
      g.state.recording = !g.state.recording;
      return g.state.recording ? 'Recording started.' : 'Recording stopped.';
    case 'spotlight':
      g.state.spotlight = a.on;
      return a.on ? 'Searchlight on.' : 'Searchlight off.';
    case 'beacon':
      g.state.beacon = a.on;
      return a.on ? 'Warning light on.' : 'Warning light off.';
    case 'announce':
      g.state.announcing = a.message;
      // roughly speaking time: 14 characters a second, at least 3 s
      g.state.announceUntil = g.clock + Math.max(3, a.message.length / 14);
      return 'Announcement playing.';
  }
}

/** Advances a simulated gimbal by dt seconds. */
export function stepSimGimbal(g: SimGimbal, dt: number) {
  const s = g.state;
  g.clock += dt;
  if (s.announceUntil !== undefined && g.clock >= s.announceUntil) {
    s.announcing = undefined;
    s.announceUntil = undefined;
  }
  if (g.target) {
    const step = 90 * dt;
    const dy = g.target.yaw - s.yaw;
    const dp = g.target.pitch - s.pitch;
    s.yaw += clamp(dy, -step, step);
    s.pitch += clamp(dp, -step, step);
    if (Math.abs(dy) <= step && Math.abs(dp) <= step) g.target = undefined;
  } else {
    s.yaw += g.yawRate * dt;
    s.pitch += g.pitchRate * dt;
  }
  s.yaw = clamp(s.yaw, -GIMBAL_LIMITS.yaw, GIMBAL_LIMITS.yaw);
  s.pitch = clamp(s.pitch, GIMBAL_LIMITS.pitchMin, GIMBAL_LIMITS.pitchMax);
  if (g.zoomTarget !== undefined) {
    const step = 8 * dt;
    const dz = g.zoomTarget - s.zoom;
    s.zoom += clamp(dz, -step, step);
    if (Math.abs(dz) <= step) g.zoomTarget = undefined;
  } else s.zoom *= Math.pow(1 + Math.abs(g.zoomRate) / 4, Math.sign(g.zoomRate) * dt);
  s.zoom = clamp(s.zoom, 1, GIMBAL_LIMITS.zoomMax);
}

/** Rounded copy for telemetry. */
export function gimbalSample(g: SimGimbal): GimbalState {
  const s = g.state;
  return {
    yaw: Math.round(s.yaw * 10) / 10,
    pitch: Math.round(s.pitch * 10) / 10,
    roll: 0,
    zoom: Math.round(s.zoom * 10) / 10,
    recording: s.recording,
    spotlight: s.spotlight,
    beacon: s.beacon,
    announcing: s.announcing,
  };
}

/** Short English description for audit entries and status lines. */
export function describeCameraAction(a: CameraAction) {
  switch (a.action) {
    case 'gimbal_speed':
      return a.yaw || a.pitch ? `pan/tilt speed yaw ${a.yaw} pitch ${a.pitch}` : 'pan/tilt stop';
    case 'gimbal_angle':
      return `point to yaw ${a.yaw.toFixed(1)}° pitch ${a.pitch.toFixed(1)}°`;
    case 'center':
      return 'centre gimbal';
    case 'zoom':
      return a.dir ? (a.dir > 0 ? 'zoom in' : 'zoom out') : 'zoom stop';
    case 'zoom_to':
      return `zoom to ${a.level}×`;
    case 'photo':
      return 'take photo';
    case 'record':
      return 'toggle recording';
    case 'spotlight':
      return a.on ? 'searchlight on' : 'searchlight off';
    case 'beacon':
      return a.on ? 'warning light on' : 'warning light off';
    case 'announce':
      return `announce "${a.message}"`;
  }
}
