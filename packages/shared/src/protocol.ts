// Wire contracts between the Edge Gateway, the server and the clients.
// Gateway protocol version — bump on any breaking change.
import type {
  ComponentUpdate,
  DeviceComponent,
  IndoorState,
  Assignment,
  AuditEvent,
  Command,
  CommandStatus,
  CommandType,
  Device,
  DeviceKind,
  Evidence,
  Incident,
  IntegrationStatus,
  Mission,
  Point,
  Role,
  TimelineEvent,
  User,
  DeviceStats,
} from './types';
import type { GeoAnchor } from './geo';
import type { RoutePoint } from './route';
import type { SiteGeometry } from './site';
import type { GimbalState, GwCameraResult, SrvCamera, StreamInfo } from './camera';
import type { Geofence } from './routing';
import { DEFAULT_PLAYBOOKS, type NotificationChannel, type Playbook } from './ops';
import type { CameraMount } from './aim';

export const GATEWAY_PROTOCOL = 'ps-gw/1';

// ---------------------------------------------------------------------------
// Adapter capability contract (PRD §7): what each adapter must declare.
// ---------------------------------------------------------------------------

export interface AdapterDeclaration {
  deviceId: string;
  kind: DeviceKind;
  model: string;
  adapterVersion: string;
  /** Adapter ↔ device protocol (e.g. vendor SDK version). */
  protocolVersion: string;
  firmwareTested: string;
  integration: IntegrationStatus;
  capabilities: string[];
  /** Commands the adapter can execute. The server never sends anything else (F06). */
  commands: CommandType[];
  units: { position: 'site-m'; altitude?: 'm-site-datum'; speed: 'm/s'; battery: 'percent' };
  /** Nominal telemetry interval in ms (used for staleness). */
  rateMs: number;
  limitations: string;
  /** What the device does on its own when the link drops (tested per device, PRD §8). */
  linkLossBehavior: string;
  /** For cameras: which simulated view to render. */
  view?: Device['view'];
  /** Live video published through the site media server. */
  stream?: StreamInfo;
  /** Gimbal camera mounting (bearing of yaw zero, height, field of view). */
  mount?: CameraMount;
  /** Catalogue vehicle model and fitted payload modules. */
  catalogId?: string;
  payloads?: string[];
  /** Indoor device: building, floor and positioning source. */
  indoor?: IndoorState;
  /** Equipment on the device. Status starts `pending` until the adapter has talked to the part. */
  components?: DeviceComponent[];
  /** The device can be driven live from the console (ground vehicles); limits applied by the adapter. */
  teleop?: TeleopLimits;
}

/** Live driving from the console: the adapter's own caps (fractions of full stick, 0–1). */
export interface TeleopLimits {
  maxThrottle: number;
  maxSteer: number;
  /** The vehicle stops when no stick update arrived for this long (ms). */
  deadmanMs: number;
}

// ---------------------------------------------------------------------------
// Gateway → server
// ---------------------------------------------------------------------------

export interface GwHello {
  t: 'hello';
  protocol: string;
  gatewayId: string;
  adapters: AdapterDeclaration[];
  /** WGS 84 anchor the gateway converts device positions with; the server warns when it differs from the site's. */
  geo?: GeoAnchor;
}

export interface GwTelemetry {
  t: 'telemetry';
  deviceId: string;
  seq: number;
  /** Time measured at the device/adapter. */
  sourceTime: number;
  /**
   * Position on the site grid. Missing when the device has no position fix (GNSS without a 3D fix):
   * the sample still proves the device is alive; the server keeps the last position and sets `noFix`.
   */
  pos?: Point;
  alt?: number;
  accuracyM: number;
  battery?: number;
  speed: number;
  quality: 'good' | 'degraded';
  /** Index of the next checkpoint for an active route. */
  nextCp?: number;
  /** Indoor patrol robot is driving its own floor round (no mission from the platform). */
  floorPatrol?: boolean;
  /** Degrees, 0 = north (−y), clockwise. */
  heading?: number;
  /** Radio link quality 0–100 as measured by the device. */
  signal?: number;
  satellites?: number;
  /** Armed, and the autopilot mode by name (AUTO, HOLD, MANUAL…). */
  armed?: boolean;
  mode?: string;
  /** Speed the vehicle drives routes at (m/s), read from the autopilot (ArduPilot WP_SPEED). */
  routeSpeed?: number;
  temperatureC?: number;
  /** Gimbal camera attitude/zoom (SIYI and similar). */
  gimbal?: GimbalState;
  /** Indoor vehicles: floor the position refers to (building from the declaration). */
  level?: number;
  /** Equipment status changes since the last sample (merged by component id). */
  components?: ComponentUpdate[];
}

export interface GwCommandUpdate {
  t: 'cmd';
  commandId: string;
  status: Extract<CommandStatus, 'acknowledged' | 'executing' | 'succeeded' | 'rejected' | 'failed'>;
  at: number;
  detail?: string;
}

export interface GwDeviceEvent {
  t: 'event';
  deviceId: string;
  at: number;
  /**
   * route_interrupted: the vehicle left AUTO or was disarmed during a route without the platform
   * asking (remote switch, vehicle failsafe). route_resumed: it went back to AUTO the same way.
   */
  kind: 'failsafe_stop' | 'route_complete' | 'route_interrupted' | 'route_resumed' | 'checkpoint' | 'snapshot' | 'fault' | 'detection' | 'analytics';
  detail?: string;
  /** For snapshot: base64 SVG/JPEG frame. */
  frame?: { mime: string; base64: string };
  checkpoint?: number;
  /** For detection: what the camera's analytics saw (device id and time come from the event). */
  detection?: Omit<DetectionInput, 'deviceId' | 'at'>;
  /** For analytics: health of the vision pipeline watching this camera. */
  analytics?: DeviceAnalytics;
}

/** State of the analytics (edge vision or camera-side) attached to a camera, shown in the console. */
export interface DeviceAnalytics {
  /** "edge-vision" (gateway pipeline), "camera" (ONVIF/vendor analytics), "nvr", … */
  provider: string;
  running: boolean;
  /** Frame source kind: snapshot, mjpeg, ffmpeg, folder, events. */
  source?: string;
  fps?: number;
  frames?: number;
  lastFrameAt?: number;
  detections?: number;
  lastDetectionAt?: number;
  /** Detector names and their state (e.g. onnx model, thermal threshold). */
  detectors?: Record<string, Record<string, unknown>>;
  model?: string;
  errors?: number;
  lastError?: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// AI / sensor detections (video analytics, thermal cameras, NVR events)
// ---------------------------------------------------------------------------

export type DetectionType = 'person' | 'vehicle' | 'intrusion' | 'loitering' | 'crowd' | 'fire' | 'smoke' | 'thermal_hotspot' | 'motion' | 'lpr' | 'other';
export const DETECTION_TYPES: DetectionType[] = ['person', 'vehicle', 'intrusion', 'loitering', 'crowd', 'fire', 'smoke', 'thermal_hotspot', 'motion', 'lpr', 'other'];
export const DETECTION_LABEL: Record<DetectionType, string> = {
  person: 'Person',
  vehicle: 'Vehicle',
  intrusion: 'Intrusion',
  loitering: 'Loitering',
  crowd: 'Crowd',
  fire: 'Fire',
  smoke: 'Smoke',
  thermal_hotspot: 'Thermal hotspot',
  motion: 'Motion',
  lpr: 'Licence plate',
  other: 'Detection',
};

/** One detection as an analytics system, NVR or camera reports it. */
export interface DetectionInput {
  type: DetectionType;
  /** 0–1. Missing = 1 (a plain sensor contact). */
  confidence?: number;
  /** When it happened at the source (ms). Missing = now. */
  at?: number;
  /** Camera or sensor device on the platform that saw it. */
  deviceId?: string;
  /** Analytics system or model name, e.g. "Hikvision DeepinView", "Thermal NVR". */
  source?: string;
  zone?: string;
  place?: string;
  pos?: Point;
  /** Normalised box in the frame: x, y, width, height (0–1). */
  bbox?: [number, number, number, number];
  attributes?: { temperatureC?: number; plate?: string; count?: number; label?: string };
  /** Frame at the moment of detection; stored as evidence when an incident is raised. */
  snapshot?: { mime: string; base64: string };
  /** The sender's own id for this detection; repeats are answered with the first outcome. */
  externalId?: string;
}

export type DetectionOutcome = 'incident' | 'merged' | 'logged' | 'ignored' | 'duplicate';

export interface Detection {
  id: string;
  at: number;
  receivedAt: number;
  type: DetectionType;
  confidence: number;
  source: string;
  deviceId?: string;
  zone?: string;
  place?: string;
  pos?: Point;
  attributes?: DetectionInput['attributes'];
  /** Normalised box in the frame when the analytics gave one (drawn over the live feed). */
  bbox?: [number, number, number, number];
  outcome: DetectionOutcome;
  incidentId?: string;
  ruleId?: string;
  snapshotEvidenceId?: string;
}

/** A per-organisation rule deciding what a detection becomes. Rules are tried in order; the first match wins. */
export interface DetectionRule {
  id: string;
  name: string;
  enabled: boolean;
  types: DetectionType[];
  /** 0–1; detections below it do not match this rule. */
  minConfidence: number;
  /** Thermal hotspots only: ignore readings below this temperature. */
  minTemperatureC?: number;
  /** Only these zones (empty = anywhere). */
  zones?: string[];
  /** Only between these local times, HH:MM; may wrap midnight (e.g. 22:00–06:00). */
  hours?: { from: string; to: string };
  action: 'incident' | 'log' | 'ignore';
  severity: 'low' | 'medium' | 'high';
  /** Another detection of the same type from the same device within this window joins the open incident instead of raising a new one. */
  cooldownS: number;
}

export const DEFAULT_DETECTION_RULES: DetectionRule[] = [
  {
    id: 'intrusion',
    name: 'Person or intrusion in a protected area',
    enabled: true,
    types: ['intrusion', 'person', 'loitering'],
    minConfidence: 0.6,
    action: 'incident',
    severity: 'medium',
    cooldownS: 300,
  },
  {
    id: 'fire',
    name: 'Fire, smoke or thermal hotspot',
    enabled: true,
    types: ['fire', 'smoke', 'thermal_hotspot'],
    minConfidence: 0.5,
    minTemperatureC: 60,
    action: 'incident',
    severity: 'high',
    cooldownS: 600,
  },
  { id: 'crowd', name: 'Crowd forming', enabled: true, types: ['crowd'], minConfidence: 0.6, action: 'incident', severity: 'low', cooldownS: 900 },
  { id: 'vehicles', name: 'Vehicles and licence plates (log only)', enabled: true, types: ['vehicle', 'lpr'], minConfidence: 0.5, action: 'log', severity: 'low', cooldownS: 0 },
  { id: 'motion', name: 'Plain motion (ignored)', enabled: true, types: ['motion'], minConfidence: 0, action: 'ignore', severity: 'low', cooldownS: 0 },
];

export type GatewayToServer = GwHello | GwTelemetry | GwCommandUpdate | GwDeviceEvent | GwCameraResult;

// ---------------------------------------------------------------------------
// Server → gateway
// ---------------------------------------------------------------------------

export interface SrvCommand {
  t: 'command';
  commandId: string;
  idempotencyKey: string;
  deviceId: string;
  type: CommandType;
  expiresAt: number;
  /** For start: the approved route, with what to do at each checkpoint. */
  route?: RoutePoint[];
  missionId: string;
}

export interface SrvDemo {
  t: 'demo';
  /** A device id, or '*' for every adapter on the gateway. */
  deviceId: string;
  action: 'cut_link' | 'restore_link' | 'reset' | 'overwatch';
  /** `overwatch`: where a simulated UAV should orbit (null = back to its patrol loop). */
  target?: Point | null;
}

export interface SrvWelcome {
  t: 'welcome';
  serverTime: number;
  /** Device ids this gateway is registered for. Unknown devices are ignored. */
  accepted: string[];
  rejected: { deviceId: string; reason: string }[];
  /**
   * Push mode: where each accepted device that declared `stream.push` publishes its camera
   * (RTSP URL with a publish credential). Missing when the server has no media server for pushes.
   */
  media?: MediaPublish[];
}

export interface MediaPublish {
  deviceId: string;
  /** e.g. rtsp://pub:<token>@media.site:18554/ugv-01 — the credential is valid only while this gateway holds the device. */
  publish: string;
}

/**
 * Live driving: one stick sample from the operator who holds the drive session. Sent about ten
 * times a second; the adapter stops the vehicle when they stop coming (dead-man), never replays
 * old ones, and hands the sticks back to the remote on `release`.
 */
export interface SrvDrive {
  t: 'drive';
  deviceId: string;
  seq: number;
  /** −1 (full reverse) … 1 (full forward), before the adapter's own cap. */
  throttle: number;
  /** −1 (full left) … 1 (full right), before the adapter's own cap. */
  steer: number;
  /** Server time when it was forwarded (ms). */
  at: number;
  /** Stop now and give control back to the remote control. */
  release?: boolean;
}

export type ServerToGateway = SrvCommand | SrvDemo | SrvWelcome | SrvCamera | SrvDrive;

// ---------------------------------------------------------------------------
// Client API
// ---------------------------------------------------------------------------

export type EnvMode = 'demo' | 'pilot';

export interface Meta {
  env: EnvMode;
  version: string;
  serverTime: number;
  /** Page-level data label (UXUI §7). */
  dataLabel: 'SIMULATION' | 'MIXED DEMO' | 'LIVE';
  /** Single sign-on, when the server is configured for it. */
  sso?: { name: string; startUrl: string };
  /** License state for the console banner. */
  license?: Pick<LicenseStatus, 'state' | 'customer' | 'daysLeft'>;
}

export interface LicenseStatus {
  state: 'valid' | 'expiring' | 'grace' | 'expired' | 'evaluation';
  customer: string;
  org: string;
  appliesToOrg: boolean;
  expiresAt?: number;
  daysLeft?: number;
  limits: { sites: number; devices: number; users: number };
  usage: { sites: number; devices: number; users: number };
  features: string[];
  problem?: string;
}

/** Per-organisation settings an administrator can change (stored as JSON on the org). */
export interface OrgSettings {
  retention: {
    /** Days to keep telemetry samples (0 = keep). */
    telemetryDays: number;
    /** Days after closing to delete an incident with its missions, commands, timeline and evidence (0 = keep). */
    closedIncidentDays: number;
    /** Days to keep evidence files regardless of incident state (0 = keep). */
    evidenceDays: number;
    /** Days to keep logged detections that did not become incidents (0 = keep). */
    detectionDays: number;
  };
  detection: {
    rules: DetectionRule[];
    /** IANA time zone the rules' hours are read in. */
    timezone: string;
  };
  /** Standard operating procedures with SLA limits, matched to incidents by type and severity. */
  playbooks: Playbook[];
  /** Outbound notification channels (webhook, LINE, SMS). */
  notifications: { channels: NotificationChannel[] };
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  retention: { telemetryDays: 90, closedIncidentDays: 0, evidenceDays: 0, detectionDays: 90 },
  detection: { rules: DEFAULT_DETECTION_RULES, timezone: 'Asia/Bangkok' },
  playbooks: DEFAULT_PLAYBOOKS,
  notifications: { channels: [] },
};

export interface SessionUser extends User {
  orgId: string;
  orgName: string;
  siteIds: string[];
  stepUpUntil?: number;
}

export interface LoginResponse {
  token: string;
  expiresAt: number;
  user: SessionUser;
}

export interface SiteInfo {
  id: string;
  name: string;
  geometry: SiteGeometry;
}

/** Everything a console needs to render a site. */
export interface Snapshot {
  serverTime: number;
  meta: Meta;
  site: SiteInfo;
  users: User[];
  incidents: Incident[];
  devices: Device[];
  missions: Mission[];
  commands: Command[];
  timeline: TimelineEvent[];
  evidence: Evidence[];
  assignments: Assignment[];
  geofences: Geofence[];
  patrols: Patrol[];
  playbooks: Playbook[];
}

// ---------------------------------------------------------------------------
// Scheduled patrols
// ---------------------------------------------------------------------------

/**
 * A recurring patrol: at each time on the listed weekdays the platform raises a patrol incident
 * and a mission with a standing approval from the supervisor who created the schedule. The
 * operator accepts and starts it, or, with autoStart, the platform starts it when the vehicle is
 * ready and the operator is on shift.
 */
export interface Patrol {
  id: string;
  name: string;
  deviceId: string;
  operatorId: string;
  route: RoutePoint[];
  /** 0 = Sunday … 6 = Saturday, in the organisation's time zone. */
  days: number[];
  /** HH:MM local times. */
  times: string[];
  enabled: boolean;
  autoStart: boolean;
  createdBy: string;
  createdAt: number;
  lastRunAt?: number;
  lastMissionId?: string;
  lastOutcome?: 'started' | 'approved' | 'skipped';
  nextRunAt?: number;
  note?: string;
}

export interface ApiError {
  error: string;
  code: 'unauthenticated' | 'forbidden' | 'step_up_required' | 'not_found' | 'invalid' | 'conflict' | 'replay_mode' | 'stale_telemetry' | 'control_held' | 'license';
}

// ---------------------------------------------------------------------------
// Server → console (WebSocket /api/v1/ws)
// ---------------------------------------------------------------------------

export type ConsoleEvent =
  | { type: 'incident'; incident: Incident }
  | { type: 'mission'; mission: Mission }
  | { type: 'command'; command: Command }
  | { type: 'device'; device: Device }
  | {
      type: 'telemetry';
      deviceId: string;
      at: number;
      pos: Point;
      alt?: number;
      battery?: number;
      speed: number;
      accuracyM: number;
      lastSeen: number;
      heading?: number;
      signal?: number;
      latencyMs?: number;
      satellites?: number;
      temperatureC?: number;
      gimbal?: GimbalState;
      stats?: DeviceStats;
      /** The device reports no position fix: `pos` is the last known one (or the registered default). */
      noFix?: boolean;
      /** Equipment status, sent when it changed (flight mode, GNSS fix, camera push…). */
      components?: DeviceComponent[];
    }
  | { type: 'geofence'; geofence: Geofence; deleted?: boolean }
  | { type: 'site'; site: SiteInfo }
  | { type: 'detection'; detection: Detection }
  | { type: 'patrol'; patrol: Patrol; deleted?: boolean }
  | { type: 'timeline'; event: TimelineEvent }
  | { type: 'evidence'; evidence: Evidence }
  | { type: 'assignment'; assignment: Assignment }
  | { type: 'audit'; audit: AuditEvent }
  | { type: 'notice'; tone: 'info' | 'warn' | 'error' | 'ok'; text: string }
  /** Data was reset or restored; clients should reload the snapshot. */
  | { type: 'resync' };

export interface ConsoleHello {
  type: 'hello';
  serverTime: number;
  user: SessionUser;
}

export type ConsoleMessage = ConsoleEvent | ConsoleHello;

/** Console → server over the same WebSocket: one stick sample while driving (see SrvDrive). */
export interface ConsoleDrive {
  type: 'drive';
  deviceId: string;
  seq: number;
  throttle: number;
  steer: number;
}

export interface UserAdminView extends User {
  username: string;
  siteIds: string[];
  active: boolean;
  role: Role;
}

export interface ApiKeyView {
  id: string;
  label: string;
  kind: 'integration' | 'gateway';
  env: 'sandbox' | 'pilot' | 'demo';
  prefix: string;
  createdAt: number;
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Edge pairing (CLEANUP_PLAN E-3): an administrator creates a one-time code, the edge app sends it
// to POST /api/v1/edge/pair and receives its gateway key and site configuration. No one types or sees the key.
// ---------------------------------------------------------------------------

/** Minutes a pairing code stays valid. */
export const PAIRING_CODE_TTL_MIN = 10;

export interface PairingCodeView {
  id: string;
  label: string;
  gatewayId: string;
  siteId: string;
  /** Device ids in the configuration the edge receives. */
  deviceIds: string[];
  createdAt: number;
  createdBy: string;
  expiresAt: number;
  status: 'waiting' | 'paired' | 'expired' | 'cancelled';
  pairedAt?: number;
  /** What the edge said about itself when it paired (app version, phone or remote model). */
  pairedBy?: string;
  /** The 6 digits: only in the response that created the code. */
  code?: string;
}

export interface CreatePairingCode {
  label?: string;
  gatewayId: string;
  siteId?: string;
  /** Gateway device list, as in a site.json (apps/gateway/src/real/config.ts DeviceConfig). */
  devices: unknown[];
}

export interface EdgePairRequest {
  code: string;
  /** Free text about the edge, for the audit log (e.g. "Edge app 0.1.0 · SIYI UniRC 7 Pro · Android 13"). */
  client?: string;
}

/** What the edge receives once. Everything a site.json holds, the key included. */
export interface EdgePairResponse {
  gatewayId: string;
  key: string;
  /** ws:// or wss:// address of this server as the edge reached it. */
  serverUrl: string;
  site: { id: string; name: string };
  geo: GeoAnchor;
  devices: unknown[];
}

/** Package name of the edge Android app (apps/edge-android). */
export const EDGE_APP_PACKAGE = 'com.store13.edge';

/**
 * An edge app build offered for in-app updates. apps/edge-android/tools/build-apk.sh writes these fields next to the
 * APK (<apk>.json); the administrator publishes both, and the server checks the file's SHA-256 against it.
 */
export interface EdgeAppRelease {
  packageName: string;
  versionCode: number;
  versionName: string;
  sha256: string;
  size: number;
  publishedAt?: number;
  publishedBy?: string;
}

/** QR text for a pairing code: the edge app reads the server address and the code from it. */
export function pairingLink(serverOrigin: string, code: string) {
  return `psedge://pair?server=${encodeURIComponent(serverOrigin)}&code=${code}`;
}

/** Server address and code from a scanned QR text or what a person typed; null when it is neither. */
export function parsePairingLink(text: string): { server?: string; code: string } | null {
  const t = text.trim();
  const digits = t.replace(/[\s-]/g, '');
  if (/^\d{6}$/.test(digits)) return { code: digits };
  const m = /^psedge:\/\/pair\?(.*)$/i.exec(t);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const code = (q.get('code') ?? '').replace(/[\s-]/g, '');
  const server = q.get('server') ?? undefined;
  if (!/^\d{6}$/.test(code) || (server !== undefined && !/^https?:\/\/[^\s/]+$/i.test(server))) return null;
  return { server, code };
}
