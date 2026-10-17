// Domain model for the prototype. Names follow PRD R1 §4 and §6.
import type { GimbalState, SimGimbal, StreamInfo } from './camera';
import type { CameraMount } from './aim';

export type Role = 'dispatcher' | 'supervisor' | 'operator' | 'responder' | 'auditor' | 'admin';

export interface User {
  id: string;
  name: string;
  role: Role;
  title: string;
  username?: string;
  /** Sites this user may see. Empty = all sites in the org. */
  siteIds?: string[];
}

/** Field responder task on an incident (PRD F14). */
export type AssignmentStatus = 'assigned' | 'accepted' | 'on_scene' | 'reported' | 'cancelled';

export interface Assignment {
  id: string;
  incidentId: string;
  responderId: string;
  status: AssignmentStatus;
  createdAt: number;
  updatedAt: number;
  note?: string;
  /** Copied from the incident so a phone can render the task without another request. */
  incidentTitle?: string;
  place?: string;
  zone?: string;
}

export type IncidentStatus = 'new' | 'triaging' | 'confirmed' | 'responding' | 'resolved' | 'closed' | 'duplicate' | 'dismissed';

export type MissionStatus = 'draft' | 'pending_approval' | 'approved' | 'assigned' | 'executing' | 'paused' | 'completed' | 'rejected' | 'cancelled' | 'failed';

export type CommandType = 'start' | 'pause' | 'resume' | 'stop';

export type CommandStatus = 'requested' | 'authorized' | 'sent' | 'acknowledged' | 'executing' | 'succeeded' | 'rejected' | 'failed' | 'timed_out' | 'unknown';

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
  /** Heading in degrees: 0 = north (−y on the site grid), clockwise. */
  heading?: number;
  /** Radio link quality, 0–100. */
  signal?: number;
  /** Delay between the device measuring and the platform receiving the last sample (ms). */
  latencyMs?: number;
  /** GNSS satellites in use (UGV/UAV). */
  satellites?: number;
  /** Motor / airframe temperature in °C. */
  temperatureC?: number;
  /** For CCTV: the camera view variant to render. */
  view?: 'gate' | 'plaza' | 'lot' | 'path';
  /** Gimbal camera attitude and zoom as last reported (devices with the `gimbal` capability). */
  gimbal?: GimbalState;
  /** Live video from the site media server (real devices). */
  stream?: StreamInfo;
  /** How a gimbal camera is mounted (for pointing it at a place). */
  mount?: CameraMount;
  /** Catalogue model (VEHICLE_CATALOG) and fitted payload modules (PAYLOAD_CATALOG). */
  catalogId?: string;
  payloads?: string[];
  /** Device operating inside a building: which floor it is on and how it is positioned (no GNSS). */
  indoor?: IndoorState;
}

export interface IndoorState {
  buildingId: string;
  level: number;
  positioning?: 'slam' | 'uwb' | 'vision' | 'fixed';
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
  kind: 'snapshot' | 'note' | 'clip' | 'photo' | 'file';
  title: string;
  source: string;
  capturedAt: number;
  recordedBy: string;
  checksum?: string;
  simulated: boolean;
  mime?: string;
  size?: number;
  retentionClass?: string;
  receivedAt?: number;
}

export interface AuditEvent {
  id: string;
  at: number;
  actor: string;
  role: Role | 'integration' | 'gateway' | 'system';
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
  speed?: number;
  battery?: number;
  signal?: number;
  heading?: number;
}

/** Motion state of a simulated ground vehicle (true state, not what telemetry reports). */
export interface VehicleMotion {
  x: number;
  y: number;
  speed: number;
  heading: number;
  route: Point[] | null;
  nextCp: number;
  /** drive = follow the route; hold = brake to a stop. */
  intent: 'drive' | 'hold';
  brake: 'normal' | 'hard';
  done: boolean;
}

/** Slowly drifting sensor state of a simulated device. */
export interface SensorState {
  /** Random-walk offsets around the site-dependent baseline. */
  acc: number;
  sig: number;
  sat: number;
  wind: Point;
  tempC: number;
  battery: number;
}

/** Offline-demo vehicle simulation (vehicle side; the platform only sees telemetry). */
export interface VehicleSim {
  motion: VehicleMotion;
  sensors: SensorState;
  linkLostAt?: number;
  failsafeAt?: number;
  /** Simulated SIYI-style gimbal (devices with the `gimbal` capability). */
  gimbal?: SimGimbal;
  /** When an operator last moved this camera (auto-aim waits a minute after). */
  cameraManualAt?: number;
}

export interface Toast {
  id: string;
  tone: 'info' | 'warn' | 'error' | 'ok';
  text: string;
  at: number;
}

export type View = 'overview' | 'command' | 'incidents' | 'missions' | 'devices' | 'evidence' | 'reports' | 'admin';

export interface Layers {
  cctv: boolean;
  ugv: boolean;
  uav: boolean;
  zones: boolean;
  accuracy: boolean;
  /** Building models (off: outlines only, so devices behind them stay visible). */
  buildings: boolean;
  /** Ambient road traffic and parked cars. */
  traffic: boolean;
  /** Mission routes and checkpoints. */
  routes: boolean;
  /** Points of interest: entrances, fire exits, hydrants. */
  poi: boolean;
  /** Name labels on devices, buildings and zones. */
  labels: boolean;
}

export const DEFAULT_LAYERS: Layers = { cctv: true, ugv: true, uav: true, zones: true, accuracy: true, buildings: true, traffic: true, routes: true, poi: false, labels: true };

export interface AppState {
  now: number;
  userId: string;
  users: User[];
  view: View;
  mapMode: '2d' | '3d';
  layers: Layers;
  selectedIncidentId: string | null;
  selectedDeviceId: string | null;
  /** Building whose BIM panel is open (map click). */
  selectedBuildingId?: string | null;
  /** Floor plan shown on the map (indoor view). */
  indoorView?: { buildingId: string; level: number } | null;
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
  /** Offline demo only: vehicle-side simulation state. */
  sim?: Record<string, VehicleSim>;
  replay: { active: boolean; at: number };
  /** Field responder tasks. */
  assignments: Assignment[];
  /** Page-level data label from the server (SIMULATION / MIXED DEMO / LIVE). */
  dataLabel: 'SIMULATION' | 'MIXED DEMO' | 'LIVE' | 'OFFLINE DEMO';
  toasts: Toast[];
  presentation: boolean;
  seq: number;
}
