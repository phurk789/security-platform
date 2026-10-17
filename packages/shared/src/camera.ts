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
  | { action: 'record' };

export interface GimbalState {
  yaw: number;
  pitch: number;
  roll?: number;
  zoom?: number;
  recording?: boolean;
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
}

export const CAMERA_ACTIONS: CameraAction['action'][] = ['gimbal_speed', 'gimbal_angle', 'center', 'zoom', 'zoom_to', 'photo', 'record'];
