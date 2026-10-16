// Domain model for the prototype. Names follow PRD R1 §4 and §6.

export type Role = 'dispatcher' | 'supervisor' | 'operator' | 'auditor';

export interface User {
  id: string;
  name: string;
  role: Role;
  title: string;
}

export type IncidentStatus =
  | 'new'
  | 'triaging'
  | 'confirmed'
  | 'responding'
  | 'resolved'
  | 'closed'
  | 'duplicate'
  | 'dismissed';

export type MissionStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'assigned'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'failed';

export type CommandType = 'start' | 'pause' | 'resume' | 'stop';

export type CommandStatus =
  | 'requested'
  | 'authorized'
  | 'sent'
  | 'acknowledged'
  | 'executing'
  | 'succeeded'
  | 'rejected'
  | 'failed'
  | 'timed_out'
  | 'unknown';

/** How fresh a feed or telemetry stream is (UXUI §7). */
export type Freshness = 'live' | 'stale' | 'offline';

/** Product integration status, separate from online/offline (UXUI S06). */
export type IntegrationStatus = 'verified' | 'testing' | 'simulated';

export type DeviceKind = 'cctv' | 'ugv' | 'uav';

export interface Point {
  x: number;
  y: number;
}

export interface Device {
  id: string;
  kind: DeviceKind;
  model: string;
  adapterVersion: string;
  firmwareTested: string;
  integration: IntegrationStatus;
  capabilities: string[];
  /** Commands the adapter declares support for (F06). */
  commands: CommandType[];
  limitations: string;
  zone: string;
  pos: Point;
  /** Altitude in metres above site datum (UAV only). */
  alt?: number;
  /** Horizontal accuracy in metres. */
  accuracyM: number;
  battery?: number;
  /** Sim time (ms) of the last telemetry received. */
  lastSeen: number;
  /** User id that holds control, if any (F08). */
  controlOwner?: string;
  /** Telemetry rate in ms (for staleness checks). */
  rateMs: number;
  /** Ground speed in m/s as last reported. */
  speed: number;
  /** For CCTV: the camera view variant to render. */
  view?: 'gate' | 'plaza' | 'lot' | 'path';
}

export interface Incident {
  id: string;
  title: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  status: IncidentStatus;
  zone: string;
  place: string;
  pos: Point;
  source: string;
  createdAt: number;
  owner?: string;
  cameraId?: string;
  duplicateOf?: string;
  outcome?: string;
  thumb: 'gate' | 'path' | 'equipment' | 'lot';
}

export interface Mission {
  id: string;
  incidentId: string;
  deviceId: string;
  operatorId: string;
  checkpoints: Point[];
  planVersion: number;
  approvedVersion?: number;
  approvedBy?: string;
  status: MissionStatus;
  /** Index of the next checkpoint the vehicle is heading to. */
  nextCp: number;
  createdAt: number;
  note?: string;
}

export interface Command {
  id: string;
  idempotencyKey: string;
  missionId: string;
  deviceId: string;
  type: CommandType;
  issuer: string;
  issuedAt: number;
  expiresAt: number;
  status: CommandStatus;
  /** Status history with sim timestamps. */
  history: { status: CommandStatus; at: number }[];
  /** True once the device actually received it. Expired commands are never delivered. */
  delivered: boolean;
  detail?: string;
}

export interface TimelineEvent {
  id: string;
  incidentId: string;
  /** Source timestamp (when it happened at the source). */
  at: number;
  /** When the platform received it. */
  receivedAt: number;
  actor: string;
  title: string;
  detail?: string;
  tone?: 'info' | 'warn' | 'alert' | 'ok';
}

export interface Evidence {
  id: string;
  incidentId: string;
  kind: 'snapshot' | 'note' | 'clip';
  title: string;
  source: string;
  capturedAt: number;
  recordedBy: string;
  checksum?: string;
  simulated: boolean;
}

export interface AuditEvent {
  id: string;
  at: number;
  actor: string;
  role: Role;
  action: string;
  object: string;
  result: 'ok' | 'denied' | 'error';
  detail?: string;
}

export interface TelemetrySample {
  deviceId: string;
  at: number;
  x: number;
  y: number;
}

export interface Toast {
  id: string;
  tone: 'info' | 'warn' | 'error' | 'ok';
  text: string;
  at: number;
}

export type View = 'overview' | 'incidents' | 'missions' | 'devices' | 'evidence' | 'reports';

export interface Layers {
  cctv: boolean;
  ugv: boolean;
  uav: boolean;
  zones: boolean;
  accuracy: boolean;
}

export interface AppState {
  now: number;
  userId: string;
  users: User[];
  view: View;
  mapMode: '2d' | '3d';
  layers: Layers;
  selectedIncidentId: string | null;
  selectedDeviceId: string | null;
  incidents: Incident[];
  devices: Record<string, Device>;
  missions: Mission[];
  commands: Command[];
  timeline: TimelineEvent[];
  evidence: Evidence[];
  audit: AuditEvent[];
  telemetry: TelemetrySample[];
  /** Devices whose network link the presenter has cut (demo control). */
  linkCut: Record<string, boolean>;
  /** Sim time at which a device last reported a link-loss failsafe stop. */
  failsafeAt: Record<string, number | undefined>;
  replay: { active: boolean; at: number };
  toasts: Toast[];
  presentation: boolean;
  seq: number;
}
