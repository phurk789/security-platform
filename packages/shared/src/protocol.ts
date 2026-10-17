// Wire contracts between the Edge Gateway, the server and the clients.
// Gateway protocol version — bump on any breaking change.
import type {
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
} from './types';
import type { SiteGeometry } from './site';
import type { GimbalState, GwCameraResult, SrvCamera, StreamInfo } from './camera';

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
}

// ---------------------------------------------------------------------------
// Gateway → server
// ---------------------------------------------------------------------------

export interface GwHello {
  t: 'hello';
  protocol: string;
  gatewayId: string;
  adapters: AdapterDeclaration[];
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
  /** Degrees, 0 = north (−y), clockwise. */
  heading?: number;
  /** Radio link quality 0–100 as measured by the device. */
  signal?: number;
  satellites?: number;
  temperatureC?: number;
  /** Gimbal camera attitude/zoom (SIYI and similar). */
  gimbal?: GimbalState;
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
  kind: 'failsafe_stop' | 'route_complete' | 'checkpoint' | 'snapshot' | 'fault';
  detail?: string;
  /** For snapshot: base64 SVG/JPEG frame. */
  frame?: { mime: string; base64: string };
  checkpoint?: number;
}

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
  action: 'cut_link' | 'restore_link' | 'reset';
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
}

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
}

export interface ApiError {
  error: string;
  code:
    | 'unauthenticated'
    | 'forbidden'
    | 'step_up_required'
    | 'not_found'
    | 'invalid'
    | 'conflict'
    | 'replay_mode'
    | 'stale_telemetry'
    | 'control_held';
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
    }
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
