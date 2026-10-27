import type { GeoAnchor } from './geo';
// Domain model for the prototype. Names follow PRD R1 §4 and §6.
import type { GimbalState, SimGimbal, StreamInfo } from './camera';
import type { Geofence } from './routing';
import type { ChecklistItem, Playbook, SlaStage } from './ops';
import type { Patrol, Detection, DeviceAnalytics } from './protocol';
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

/** Product integration status, separate from online/offline (UXUI S06). Set by an administrator, never by a gateway. */
export type IntegrationStatus = 'verified' | 'testing' | 'simulated';

/**
 * Operational mode of one device (ADR-006). Real devices start in SHADOW and only a supervisor
 * promotes them; the server never promotes on its own. SIMULATION is fixed by the adapter type.
 */
export type OperationalMode = 'SIMULATION' | 'SHADOW' | 'LIVE_MANUAL' | 'LIVE_ASSISTED';

export type DeviceKind = 'cctv' | 'ugv' | 'uav';

export interface Point {
  x: number;
  y: number;
}

export type ComponentStatus = 'ok' | 'warn' | 'fault' | 'offline' | 'pending';
export type ComponentKind = 'flight_controller' | 'computer' | 'camera' | 'gimbal' | 'radio' | 'remote' | 'gnss' | 'lidar' | 'battery' | 'payload' | 'network' | 'other';

/** A piece of equipment on a device (flight controller, camera, radio, …) as the adapter reports it. */
export interface DeviceComponent {
  id: string;
  name: string;
  kind: ComponentKind;
  /** Firmware / hardware version as read from the part, if the adapter can read it. */
  version?: string;
  /** `pending` = the interface to this part has not been exercised yet (verification pending). */
  status: ComponentStatus;
  detail?: string;
  /** Cameras on a vehicle: which way the lens points (each camera gets its own feed tab). */
  facing?: 'front' | 'rear' | 'left' | 'right' | 'down';
  /** Cameras with their own stream on the site media server. */
  stream?: StreamInfo;
}

/** A status change for one component, carried in telemetry. */
export interface ComponentUpdate {
  id: string;
  status?: ComponentStatus;
  version?: string;
  detail?: string;
}

export interface Device {
  id: string;
  kind: DeviceKind;
  model: string;
  adapterVersion: string;
  firmwareTested: string;
  integration: IntegrationStatus;
  /** Configured operational mode (ADR-006). Missing on old records: read through `modeOf()`. */
  mode?: OperationalMode;
  capabilities: string[];
  /** Commands the adapter declares support for (F06). */
  commands: CommandType[];
  limitations: string;
  zone: string;
  pos: Point;
  /**
   * No position fix right now (e.g. GNSS without a 3D fix): `pos` is only the last known or registered
   * one, so maps leave the device off rather than draw it somewhere it may not be.
   */
  noFix?: boolean;
  /** Can be driven live from the console, with these adapter limits (declared by the gateway). */
  teleop?: { maxThrottle: number; maxSteer: number; deadmanMs: number };
  /** User driving it live right now (drive session), if any. */
  drivenBy?: string;
  /** Altitude in metres above site datum (UAV only). */
  alt?: number;
  /** Horizontal accuracy in metres. */
  accuracyM: number;
  battery?: number;
  /** Indoor patrol robot driving its own floor round (no mission), as last reported. */
  floorPatrol?: boolean;
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
  /** Equipment fitted to the device, with interface status (Equipment tab). */
  components?: DeviceComponent[];
  /** Usage counters and service state (vehicles). */
  stats?: DeviceStats;
  /** Analytics watching this camera (edge vision pipeline or camera-side), as last reported. */
  analytics?: DeviceAnalytics;
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
  /** Set when the incident is a scheduled patrol run rather than an alert. */
  patrolId?: string;
  /** Playbook (SOP) chosen for this incident and its checklist state. */
  playbookId?: string;
  checklist?: ChecklistItem[];
  /** SLA stages already reported as breached (so each is raised once). */
  slaBreached?: SlaStage[];
}

/** Odometer, runtime and service counters kept by the platform from telemetry. */
export interface DeviceStats {
  /** Metres driven or flown since registration. */
  odometerM: number;
  /** Seconds in motion since registration. */
  runtimeS: number;
  /** Missions completed. */
  missions: number;
  lastServiceAt?: number;
  /** Odometer and runtime at the last service, to measure wear since then. */
  serviceOdometerM: number;
  serviceRuntimeS: number;
  /** Service interval: metres and hours in motion (0 = not tracked). */
  serviceIntervalM: number;
  serviceIntervalH: number;
  /** Home / charging position on the site grid. */
  dock?: Point;
  /** Set when a vehicle sits at its dock and is not on a mission. */
  docked?: boolean;
}

export interface Mission {
  id: string;
  incidentId: string;
  /** Set when the mission was raised by a patrol schedule. */
  patrolId?: string;
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
  /** Top speed for this vehicle (m/s). Default UGV_SPEED; indoor vehicles are limited lower. */
  maxSpeed?: number;
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
  /** UAV: centre of the current orbit (patrol loop, or over the incident it is watching). */
  orbit?: Point;
  /** UAV: incident it is on station over, once the orbit has arrived. */
  overwatchFor?: string;
  /** Indoor UGV: currently driving its own floor patrol (no mission). */
  floorPatrol?: boolean;
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
  /** Geofences: keep-out, caution and no-fly zones. */
  geofences: boolean;
  /** Points of interest: entrances, fire exits, hydrants. */
  poi: boolean;
  /** Name labels on devices, buildings and zones. */
  labels: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  cctv: true,
  ugv: true,
  uav: true,
  zones: true,
  accuracy: true,
  buildings: true,
  traffic: true,
  routes: true,
  geofences: true,
  poi: false,
  labels: true,
};

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
  /** Keep-out, caution and no-fly zones for this site. */
  geofences: Geofence[];
  /** WGS 84 anchor of the site grid (from the server's site record; the demo anchor offline). */
  geo: GeoAnchor;
  /** Recent AI / sensor detections (newest first, bounded) for feed overlays and lists. */
  detections: Detection[];
  /** Scheduled patrols (server only; empty in the offline demo). */
  patrols: Patrol[];
  /** SOP playbooks with SLA limits (organisation settings; defaults offline). */
  playbooks: Playbook[];
  /** Page-level data label from the server (SIMULATION / MIXED DEMO / LIVE). */
  dataLabel: 'SIMULATION' | 'MIXED DEMO' | 'LIVE' | 'OFFLINE DEMO';
  toasts: Toast[];
  presentation: boolean;
  seq: number;
}
