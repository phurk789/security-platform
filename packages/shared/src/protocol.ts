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
  pos: Point;
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
  kind: 'failsafe_stop' | 'route_complete' | 'checkpoint' | 'snapshot' | 'fault' | 'detection' | 'analytics';
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
  /** For start: the approved route. */
  route?: Point[];
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
}

export type ServerToGateway = SrvCommand | SrvDemo | SrvWelcome | SrvCamera;

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
  route: Point[];
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
