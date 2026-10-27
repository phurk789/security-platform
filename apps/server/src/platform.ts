// The platform's business rules. Every mutating call takes an Actor and is checked here
// (role, org/site scope, state machine, control ownership, freshness, replay) — PRD §3–§5, §11.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSIGNMENT_FLOW,
  COMMAND_ACK_TIMEOUT_MS,
  COMMAND_FLOW,
  COMMAND_TTL_MS,
  INCIDENT_FLOW,
  MISSION_FLOW,
  STEP_UP_ACTIONS,
  can,
  canMove,
  constraintChecksAt,
  fmtDate,
  fmtTime,
  freshnessAt,
  isReadyAt,
  isTerminalCommand,
  type Action,
  type AdapterDeclaration,
  type MediaPublish,
  type Assignment,
  type AuditEvent,
  type Command,
  type CommandStatus,
  type CommandType,
  type ConsoleEvent,
  type Device,
  type Evidence,
  type Freshness,
  type GwCommandUpdate,
  type GwDeviceEvent,
  type GwTelemetry,
  type Incident,
  type IncidentStatus,
  type Meta,
  type Mission,
  type MissionStatus,
  type Point,
  type Role,
  type SessionUser,
  type SiteGeometry,
  type Snapshot,
  type SrvCommand,
  type SrvDemo,
  type SrvCamera,
  type SrvDrive,
  type GwCameraResult,
  sanitizeCameraAction,
  describeCameraAction,
  actionCapability,
  isPayloadAction,
  cameraActionMoves,
  modeAllowsMotion,
  modeOf,
  type OperationalMode,
  type StreamInfo,
  type IntegrationStatus,
  VEHICLE_CATALOG,
  PAYLOAD_CATALOG,
  COMPONENT_KINDS,
  COMPONENT_STATUSES,
  applyComponentUpdates,
  aimAt,
  lineOfSight,
  mountOf,
  pickCamera,
  type Aim,
  type Building,
  type CameraAction,
  type LicenseStatus,
  type OrgSettings,
  type Detection,
  type DetectionOutcome,
  type Geofence,
  type Patrol,
  type DeviceStats,
  DEFAULT_GEOFENCES,
  GEOFENCE_KIND_LABEL,
  fencesAt,
  planRoute,
  rankUnits,
  routeViolations,
  insideDemoArea,
  type Playbook,
  type SlaStage,
  type NotificationChannel,
  SLA_STAGE_LABEL,
  computeKpi,
  kpiMarkdown,
  pickPlaybook,
  slaStages,
  type ComponentKind,
  type ComponentStatus,
  type ComponentUpdate,
  type DeviceComponent,
  type TimelineEvent,
  type User,
  GEO_LAYERS,
  geofencesFromGeoJson,
  siteGeoJson,
  siteToGeo,
  type GeoAnchor,
  type GeoLayer,
  SITE,
  type SiteInfo,
  planFor,
  indoorRouteChecks,
} from '@13store/shared';
import { appendAudit } from './audit';
import { createBackup, pruneBackups } from './backup';
import { License } from './license';
import { getOrgSettings, maskChannels, privacyErase, privacyExport, purgeExpired, setOrgSettings } from './retention';
import { detectionDetail, detectionTitle, matchRule, sanitizeDetection, detectionLabel } from './detections';
import { Notifier, type Outbound } from './notify';
import type { PushPayload } from './push';
import type { Config } from './config';
import { nextNumber, tx, type DB } from './db';
import { EDGE_STREAM_KEYS, edgeGet, parseEdgeOrigin, vetStream, type EdgeGet } from './edgeOrigins';
import { hmac, safeEqual, sha256 } from './security';

// ---------------------------------------------------------------------------
// Actors and errors
// ---------------------------------------------------------------------------

export type ActorRole = Role | 'integration' | 'gateway' | 'system';

export interface Actor {
  kind: 'user' | 'apikey' | 'system';
  orgId: string;
  /** Empty = every site in the org. */
  siteIds: string[];
  userId?: string;
  name: string;
  role: ActorRole;
  stepUpUntil?: number;
  requestId?: string;
  consoleMode?: 'live' | 'replay';
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const fail = (status: number, code: string, msg: string): never => {
  throw new ApiError(status, code, msg);
};

export interface BusMessage {
  orgId: string;
  siteId?: string;
  /** For responder filtering. */
  incidentId?: string;
  event: ConsoleEvent;
}

/** Transport to edge gateways, implemented by the gateway hub. */
export interface GatewayLink {
  send(orgId: string, deviceId: string, msg: SrvCommand | SrvDemo | SrvCamera | SrvDrive): boolean;
  /** Gateways connected right now and the devices each holds. */
  connected?(orgId: string): { gatewayId: string; devices: string[] }[];
}

/** Stick samples closer together than this are dropped (25 per second at most). */
export const DRIVE_MIN_INTERVAL_MS = 40;

/** A gateway's credential to publish one device's video into the platform's media server. */
export const MEDIA_PUBLISH_TTL_MS = 7 * 24 * 3600_000;

/** A gateway's declared drive limits, kept only when they make sense (caps 0–1, dead-man 100 ms–3 s). */
export function sanitizeTeleop(raw: unknown): Device['teleop'] {
  const t = raw as { maxThrottle?: unknown; maxSteer?: unknown; deadmanMs?: unknown } | undefined;
  if (!t || typeof t !== 'object') return undefined;
  const frac = (v: unknown) => (typeof v === 'number' && v > 0 && v <= 1 ? v : undefined);
  const maxThrottle = frac(t.maxThrottle);
  const maxSteer = frac(t.maxSteer);
  const deadmanMs = typeof t.deadmanMs === 'number' && t.deadmanMs >= 100 && t.deadmanMs <= 3000 ? t.deadmanMs : undefined;
  return maxThrottle && maxSteer && deadmanMs ? { maxThrottle, maxSteer, deadmanMs } : undefined;
}

/** Path of a device's pushed stream on the platform's media server: UGV-01 → ugv-01. */
export function pushPath(deviceId: string) {
  return deviceId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/** How long to wait for the gateway to answer a camera request. */
export const CAMERA_REPLY_TIMEOUT_MS = 3_000;
/** Auto-aim leaves a camera alone this long after an operator used it. */
export const MANUAL_CAMERA_HOLD_MS = 60_000;
/** Media tokens for the site media server (MediaMTX) are valid this long. */
export const MEDIA_TOKEN_TTL_MS = 60_000;

export interface CameraResult {
  ok: boolean;
  /** True only when the camera itself answered. */
  confirmed: boolean;
  detail: string;
}

const INTEGRATION_ACTIONS: Action[] = ['incident.create'];

/** Order of operational modes for promote / demote. SIMULATION sits outside the ladder. */
const MODE_RANK: Record<OperationalMode, number> = { SIMULATION: -1, SHADOW: 0, LIVE_MANUAL: 1, LIVE_ASSISTED: 2 };

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export class Platform {
  readonly bus = new EventEmitter();
  gateways: GatewayLink = { send: () => false };
  private devices = new Map<string, Device & { orgId: string; siteId: string }>();
  private lastFresh = new Map<string, Freshness>();
  private lastSeq = new Map<string, number>();
  /** Live drive sessions by device id (memory only: a restart ends them). */
  private driving = new Map<string, { userId: string; orgId: string; since: number; seq: number; lastAt: number; ownedBefore: boolean }>();
  /** Geofences per site (loaded on first use; defaults seeded for a new site). */
  private fenceCache = new Map<string, Geofence[]>();
  /** Fence ids each vehicle is currently inside of. */
  private insideFences = new Map<string, Set<string>>();
  /** Last telemetry position per vehicle, for odometer and runtime. */
  private lastFix = new Map<string, { pos: Point; at: number }>();
  private lastStatsSave = new Map<string, number>();
  private patrolTimer?: NodeJS.Timeout;
  /** Outbound notifications (webhook / LINE / SMS). Tests may replace it with one that has fast retries. */
  notifier: Notifier;
  /** Web Push to users' phones (set by buildApp; absent in bare unit tests). */
  push?: { toUsers(orgId: string, userIds: string[], payload: PushPayload): void; toRoles(orgId: string, roles: string[], siteId: string | undefined, payload: PushPayload): void };
  /** When an operator last moved each camera; auto-aim leaves it alone for a while after. */
  private manualCamera = new Map<string, number>();
  private cameraWaits = new Map<string, { orgId: string; deviceId: string; done: (r: CameraResult) => void }>();
  private sweepTimer?: NodeJS.Timeout;
  private purgeTimer?: NodeJS.Timeout;
  private backupTimer?: NodeJS.Timeout;
  readonly license: License;
  now: () => number = () => Date.now();
  /** Server-side GET to an edge media server (DNS-checked, no redirects). Tests may replace the transport. */
  edgeGet: EdgeGet = edgeGet;

  constructor(
    readonly db: DB,
    readonly cfg: Config,
  ) {
    this.bus.setMaxListeners(500);
    this.notifier = new Notifier(db, { now: () => this.now() });
    this.notifier.onDelivery = (d, orgId) => this.bus.emit('notification', { orgId, delivery: d });
    this.license = new License({ file: cfg.licenseFile, publicKeyPem: cfg.licensePublicKey, env: cfg.env });
    this.loadDevices();
  }

  start() {
    this.sweepTimer = setInterval(() => this.sweep(), 250);
    this.sweepTimer.unref?.();
    if (this.cfg.purgeIntervalMs > 0) {
      this.purgeTimer = setInterval(() => {
        try {
          this.runPurge();
        } catch (e) {
          console.error('[retention]', e instanceof Error ? e.message : e);
        }
      }, this.cfg.purgeIntervalMs);
      this.purgeTimer.unref?.();
    }
    if (this.cfg.backupIntervalH > 0) {
      this.backupTimer = setInterval(() => this.runScheduledBackup(), this.cfg.backupIntervalH * 3600_000);
      this.backupTimer.unref?.();
    }
    this.patrolTimer = setInterval(() => {
      try {
        this.runPatrols();
      } catch (e) {
        console.error('[patrols]', e instanceof Error ? e.message : e);
      }
      try {
        this.checkSla();
      } catch (e) {
        console.error('[sla]', e instanceof Error ? e.message : e);
      }
    }, 10_000);
    this.patrolTimer.unref?.();
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.patrolTimer) clearInterval(this.patrolTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);
  }

  // ---- organisation settings, retention, privacy, license -------------------

  orgSettings(a: Actor): OrgSettings {
    this.require(a, 'admin.settings', 'settings', { mutating: false });
    const st = getOrgSettings(this.db, a.orgId);
    return { ...st, notifications: { channels: maskChannels(st.notifications.channels) } };
  }

  updateOrgSettings(a: Actor, patch: Partial<OrgSettings>): OrgSettings {
    this.require(a, 'admin.settings', 'settings');
    let next: OrgSettings;
    try {
      next = setOrgSettings(this.db, a.orgId, patch);
    } catch (e) {
      return fail(400, 'invalid', (e as Error).message);
    }
    this.audit(
      a,
      'admin.settings_update',
      'settings',
      'ok',
      [patch.retention && 'retention', patch.detection && 'detection', patch.playbooks && 'playbooks', patch.notifications && 'notifications'].filter(Boolean).join(', ') ||
        'no change',
    );
    return { ...next, notifications: { channels: maskChannels(next.notifications.channels) } };
  }

  /** Applies every organisation's retention policy. Audited when something was removed. */
  runPurge(now = this.now()) {
    const orgs = this.db.prepare('SELECT id FROM orgs').all() as { id: string }[];
    const out: Record<string, { telemetry: number; incidents: number; evidence: number; detections: number }> = {};
    for (const o of orgs) {
      const r = purgeExpired(this.db, o.id, this.cfg.dataDir, now);
      out[o.id] = r;
      if (r.telemetry + r.incidents + r.evidence + (r.detections ?? 0) > 0)
        this.audit(
          this.systemActor(o.id, 'system', 'Retention'),
          'retention.purge',
          o.id,
          'ok',
          `telemetry ${r.telemetry}, incidents ${r.incidents}, evidence ${r.evidence}, detections ${r.detections ?? 0}`,
        );
    }
    return out;
  }

  runScheduledBackup() {
    try {
      const m = createBackup(this.db, this.cfg.dataDir, 'scheduler', this.now());
      const dropped = pruneBackups(this.cfg.dataDir, this.cfg.backupKeep);
      for (const o of this.db.prepare('SELECT id FROM orgs').all() as { id: string }[])
        this.audit(this.systemActor(o.id, 'system', 'Backup scheduler'), 'admin.backup_create', m.id, 'ok', dropped.length ? `pruned ${dropped.join(', ')}` : undefined);
      return m;
    } catch (e) {
      console.error('[server] scheduled backup failed', e);
      return null;
    }
  }

  privacySearch(a: Actor, q: string) {
    this.require(a, 'admin.privacy', 'privacy', { mutating: false });
    try {
      const matches = privacyExport(this.db, a.orgId, q);
      this.audit(a, 'privacy.search', q, 'ok', `${matches.length} matches`);
      return matches;
    } catch (e) {
      return fail(400, 'invalid', (e as Error).message);
    }
  }

  privacyErase(a: Actor, q: string, reason: string) {
    this.require(a, 'admin.privacy', 'privacy');
    if (!reason?.trim()) fail(400, 'invalid', 'A reason is required (request reference, legal basis).');
    try {
      const r = privacyErase(this.db, a.orgId, q);
      this.audit(a, 'privacy.erase', q, 'ok', `${r.changed} fields in ${r.ids.join(', ') || 'nothing'} — ${reason.trim()}`);
      for (const id of r.ids) if (id.startsWith('INC-')) this.publishIncident(a.orgId, id);
      return r;
    } catch (e) {
      return fail(400, 'invalid', (e as Error).message);
    }
  }

  private publishIncident(orgId: string, id: string) {
    const row = this.db.prepare('SELECT site_id, data FROM incidents WHERE id = ? AND org_id = ?').get(id, orgId) as { site_id: string; data: string } | undefined;
    if (row) this.publish({ orgId, siteId: row.site_id, incidentId: id, event: { type: 'incident', incident: JSON.parse(row.data) as Incident } });
  }

  licenseUsage(orgId: string): LicenseStatus['usage'] {
    const n = (sql: string) => (this.db.prepare(sql).get(orgId) as { n: number }).n;
    return {
      sites: n('SELECT COUNT(*) AS n FROM sites WHERE org_id = ?'),
      devices: [...this.devices.values()].filter((d) => d.orgId === orgId).length,
      users: n('SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND active = 1'),
    };
  }

  licenseStatus(orgId: string): LicenseStatus {
    return this.license.status(this.now(), this.licenseUsage(orgId), orgId);
  }

  /** Devices by freshness for monitoring. */
  deviceCounts(): Record<Freshness, number> {
    const out: Record<Freshness, number> = { live: 0, stale: 0, offline: 0 };
    const now = this.now();
    for (const d of this.devices.values()) out[freshnessAt(now, d)]++;
    return out;
  }

  loadDevices() {
    this.devices.clear();
    this.lastSeq.clear();
    this.lastFresh.clear();
    const rows = this.db.prepare('SELECT org_id, site_id, data FROM devices').all() as { org_id: string; site_id: string; data: string }[];
    for (const r of rows) {
      const d = JSON.parse(r.data) as Device;
      // A restart never raises a mode: a missing or unknown value reads as SHADOW (ADR-006 §5).
      // Nobody drives a vehicle across a restart: drive sessions live in memory only.
      const { drivenBy: _drivenBy, ...rest } = d;
      this.devices.set(d.id, { ...rest, mode: modeOf(d), orgId: r.org_id, siteId: r.site_id });
    }
  }

  // ---- helpers -------------------------------------------------------------

  publish(m: BusMessage) {
    this.bus.emit('event', m);
  }

  audit(a: Actor, action: string, object: string, result: 'ok' | 'denied' | 'error' = 'ok', detail?: string): AuditEvent {
    const ev = appendAudit(this.db, {
      orgId: a.orgId,
      actorId: a.userId,
      actor: a.name,
      role: a.role,
      action,
      object,
      result,
      detail,
      requestId: a.requestId,
      at: this.now(),
    });
    this.publish({ orgId: a.orgId, event: { type: 'audit', audit: ev } });
    return ev;
  }

  /** Role check + step-up + replay guard. Denials are audited. */
  require(a: Actor, action: Action, object: string, opts: { mutating?: boolean } = { mutating: true }) {
    const allowed = a.role === 'integration' ? INTEGRATION_ACTIONS.includes(action) : a.role === 'system' || (a.role !== 'gateway' && can(a.role, action));
    if (!allowed) {
      this.audit(a, action, object, 'denied', `role ${a.role} lacks ${action}`);
      fail(403, 'forbidden', `Your role (${a.role}) cannot do this: ${action}.`);
    }
    if (opts.mutating !== false && a.consoleMode === 'replay') {
      this.audit(a, action, object, 'denied', 'replay mode');
      fail(409, 'replay_mode', 'You are viewing replay. Device control and changes are off.');
    }
    if (a.kind === 'user' && STEP_UP_ACTIONS.includes(action) && (a.stepUpUntil ?? 0) < this.now()) {
      fail(401, 'step_up_required', 'Confirm your password to continue.');
    }
  }

  /** SQL fragment restricting a query to the actor's sites (binds a.siteIds after the other params). */
  private siteClause(a: Actor) {
    return a.siteIds.length ? ` AND site_id IN (${a.siteIds.map(() => '?').join(',')})` : '';
  }

  private inScope(a: Actor, orgId: string, siteId: string) {
    return a.orgId === orgId && (a.siteIds.length === 0 || a.siteIds.includes(siteId));
  }

  private event(a: Actor | null, orgId: string, siteId: string, incidentId: string, title: string, opts: Partial<TimelineEvent> = {}) {
    const n = nextNumber(this.db, orgId, 'evt');
    const ev: TimelineEvent = {
      id: `EVT-${n}`,
      incidentId,
      at: opts.at ?? this.now(),
      receivedAt: opts.receivedAt ?? this.now(),
      actor: opts.actor ?? a?.name ?? 'System',
      title,
      detail: opts.detail,
      tone: opts.tone,
    };
    this.db
      .prepare('INSERT INTO timeline (id, org_id, incident_id, at, received_at, data) VALUES (?,?,?,?,?,?)')
      .run(`${orgId}:${ev.id}`, orgId, incidentId, ev.at, ev.receivedAt, JSON.stringify(ev));
    this.publish({ orgId, siteId, incidentId, event: { type: 'timeline', event: ev } });
    return ev;
  }

  private prefix(orgId: string) {
    return (this.db.prepare('SELECT id_prefix FROM orgs WHERE id = ?').get(orgId) as { id_prefix: string } | undefined)?.id_prefix ?? '';
  }

  private userName(orgId: string, id?: string) {
    if (!id) return '—';
    const r = this.db.prepare('SELECT name FROM users WHERE id = ? AND org_id = ?').get(id, orgId) as { name: string } | undefined;
    return r?.name ?? id;
  }

  // ---- incidents ----------------------------------------------------------

  private incRow(id: string) {
    return this.db.prepare('SELECT org_id, site_id, data FROM incidents WHERE id = ?').get(id) as { org_id: string; site_id: string; data: string } | undefined;
  }

  /** Load an incident the actor may see; 404 otherwise (no existence leak across orgs/sites). */
  getIncident(a: Actor, id: string): Incident & { siteId: string } {
    const r = this.incRow(id);
    if (!r || !this.inScope(a, r.org_id, r.site_id)) return fail(404, 'not_found', `Incident ${id} not found.`);
    const inc = JSON.parse(r.data) as Incident;
    if (a.role === 'admin') return fail(403, 'forbidden', 'Administrators manage the system but do not see incident data.');
    if (a.role === 'responder' && !this.hasAssignment(a, id)) return fail(404, 'not_found', `Incident ${id} not found.`);
    return { ...inc, siteId: r.site_id };
  }

  private saveIncident(orgId: string, siteId: string, inc: Incident) {
    const { siteId: _s, ...clean } = inc as Incident & { siteId?: string };
    this.db
      .prepare(
        'INSERT INTO incidents (id, org_id, site_id, status, created_at, data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data',
      )
      .run(clean.id, orgId, siteId, clean.status, clean.createdAt, JSON.stringify(clean));
    this.publish({ orgId, siteId, incidentId: clean.id, event: { type: 'incident', incident: clean } });
    this.syncOverwatch(orgId, siteId);
  }

  /** Last overwatch target sent to each simulated UAV (incident id or 'none'), so we only send changes. */
  private lastOverwatch = new Map<string, string>();

  /**
   * Simulated UAVs with the `overwatch` capability orbit over a verified incident (one with a live
   * mission first, else the newest) and return to their patrol loop when none is open. A demo
   * message to the gateway; real aircraft are never tasked this way.
   */
  private syncOverwatch(orgId: string, siteId: string) {
    const rows = this.db.prepare('SELECT data FROM incidents WHERE org_id = ? AND site_id = ?').all(orgId, siteId) as { data: string }[];
    const open = rows.map((r) => JSON.parse(r.data) as Incident).filter((i) => i.status === 'confirmed' || i.status === 'responding');
    const pick = open.find((i) => this.missionsFor(i.id).some((m) => ['assigned', 'executing', 'paused'].includes(m.status))) ?? open.sort((a, b) => b.createdAt - a.createdAt)[0];
    const key = pick ? pick.id : 'none';
    for (const d of this.devices.values()) {
      if (d.orgId !== orgId || d.siteId !== siteId || d.kind !== 'uav' || d.integration !== 'simulated' || !d.capabilities.includes('overwatch')) continue;
      if (this.lastOverwatch.get(d.id) === key) continue;
      if (this.gateways.send(orgId, d.id, { t: 'demo', deviceId: d.id, action: 'overwatch', target: pick ? { x: pick.pos.x, y: pick.pos.y } : null }))
        this.lastOverwatch.set(d.id, key);
    }
  }

  private moveIncident(_a: Actor, inc: Incident & { siteId: string }, to: IncidentStatus) {
    if (!canMove(INCIDENT_FLOW, inc.status, to)) fail(409, 'conflict', `Incident is ${inc.status}; it cannot become ${to}.`);
    inc.status = to;
  }

  listIncidents(a: Actor, f: { siteId?: string; status?: string; zone?: string; from?: number; to?: number; q?: string; deviceId?: string; limit?: number } = {}): Incident[] {
    if (a.role === 'admin') fail(403, 'forbidden', 'Administrators manage the system but do not see incident data.');
    const rows = this.db
      .prepare('SELECT site_id, data FROM incidents WHERE org_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT ?')
      .all(a.orgId, f.from ?? 0, f.to ?? Number.MAX_SAFE_INTEGER, Math.min(f.limit ?? 500, 20000)) as { site_id: string; data: string }[];
    const q = f.q?.toLowerCase();
    return rows
      .filter((r) => this.inScope(a, a.orgId, r.site_id) && (!f.siteId || r.site_id === f.siteId))
      .map((r) => JSON.parse(r.data) as Incident)
      .filter((i) => a.role !== 'responder' || this.hasAssignment(a, i.id))
      .filter((i) => !f.status || f.status.split(',').includes(i.status))
      .filter((i) => !f.zone || i.zone === f.zone)
      .filter((i) => !q || `${i.id} ${i.title} ${i.place} ${i.type} ${i.source}`.toLowerCase().includes(q))
      .filter((i) => !f.deviceId || i.cameraId === f.deviceId || this.missionsFor(i.id).some((m) => m.deviceId === f.deviceId));
  }

  createIncident(
    a: Actor,
    input: {
      siteId?: string;
      title: string;
      type?: string;
      severity?: Incident['severity'];
      zone?: string;
      place?: string;
      pos?: Point;
      source?: string;
      cameraId?: string;
      at?: number;
      /** Skip pointing a camera at the position (e.g. the position is the camera itself). */
      noAutoAim?: boolean;
    },
  ) {
    this.require(a, 'incident.create', 'incident');
    const siteId = input.siteId ?? this.defaultSite(a);
    if (!this.inScope(a, a.orgId, siteId)) fail(404, 'not_found', 'Site not found.');
    if (!input.title?.trim()) fail(400, 'invalid', 'Title is required.');
    const n = nextNumber(this.db, a.orgId, 'incident', 1);
    const inc: Incident = {
      id: `${this.prefix(a.orgId)}INC-${String(n).padStart(3, '0')}`,
      title: input.title.trim().slice(0, 120),
      type: input.type ?? (a.role === 'integration' ? 'Sensor alert' : 'Report'),
      severity: input.severity ?? 'medium',
      status: 'new',
      zone: input.zone ?? 'Zone B',
      place: input.place ?? 'Unspecified',
      pos: input.pos ?? { x: 210, y: 140 },
      source: input.source ?? a.name,
      createdAt: input.at ?? this.now(),
      cameraId: input.cameraId,
      thumb: input.cameraId === 'CCTV-02' ? 'gate' : 'lot',
    };
    const book = pickPlaybook(getOrgSettings(this.db, a.orgId).playbooks, inc);
    if (book) {
      inc.playbookId = book.id;
      inc.checklist = book.steps.map((st) => ({ id: st.id, title: st.title, detail: st.detail, role: st.role }));
    }
    tx(this.db, () => {
      this.saveIncident(a.orgId, siteId, inc);
      this.event(a, a.orgId, siteId, inc.id, 'Alert received', { actor: inc.source, tone: 'alert', at: inc.createdAt, detail: input.type ? `${input.type} reported.` : undefined });
      this.audit(a, 'incident.create', inc.id);
    });
    // Hint at likely duplicates: same place within 10 minutes.
    const dupe = this.listIncidents({ ...a, role: a.role === 'integration' ? 'dispatcher' : a.role, kind: 'system' }, { siteId, from: inc.createdAt - 10 * 60_000 }).find(
      (i) => i.id !== inc.id && i.place === inc.place && !['closed', 'duplicate', 'dismissed'].includes(i.status),
    );
    if (dupe) this.event(null, a.orgId, siteId, inc.id, `Possible duplicate of ${dupe.id}`, { tone: 'warn', detail: 'Same place within 10 minutes. Review before acting.' });
    if (input.pos && !input.noAutoAim) void this.autoAim(a.orgId, siteId, inc).catch((e) => console.error('[auto-aim]', e));
    this.notify(a.orgId, {
      event: 'incident.new',
      title: `${inc.id} ${inc.title}`,
      text: `${inc.type} · ${inc.severity} · ${inc.zone} · ${inc.place} · source ${inc.source}${book ? ` · playbook ${book.name}` : ''}`,
      severity: inc.severity,
      incidentId: inc.id,
      data: { type: inc.type, zone: inc.zone, place: inc.place, pos: inc.pos, cameraId: inc.cameraId },
    });
    if (inc.severity === 'high')
      this.push?.toRoles(a.orgId, ['dispatcher', 'supervisor'], siteId, {
        title: `High severity: ${inc.id}`,
        body: `${inc.title} · ${inc.place}`,
        url: '/',
        tag: `inc-${inc.id}`,
        incidentId: inc.id,
      });
    return inc;
  }

  private defaultSite(a: Actor) {
    if (a.siteIds.length) return a.siteIds[0];
    const r = this.db.prepare('SELECT id FROM sites WHERE org_id = ? ORDER BY id LIMIT 1').get(a.orgId) as { id: string } | undefined;
    return r?.id ?? fail(404, 'not_found', 'No site configured.');
  }

  triage(a: Actor, id: string) {
    this.require(a, 'incident.triage', id);
    const inc = this.getIncident(a, id);
    if (inc.status !== 'new') return inc;
    tx(this.db, () => {
      this.moveIncident(a, inc, 'triaging');
      inc.owner = a.name;
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, id, 'Camera opened', { detail: `${inc.cameraId ?? 'Camera'} stream available for review.` });
      this.event(a, a.orgId, inc.siteId, id, 'Operator reviewing', { detail: 'Monitoring feed and verifying the situation.' });
      this.audit(a, 'incident.triage', id);
    });
    return inc;
  }

  confirm(a: Actor, id: string) {
    this.require(a, 'incident.verify', id);
    const inc = this.getIncident(a, id);
    if (!['new', 'triaging'].includes(inc.status)) fail(409, 'conflict', 'Incident is not awaiting verification.');
    tx(this.db, () => {
      this.moveIncident(a, inc, 'confirmed');
      inc.owner = a.name;
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, id, 'Verified — action required', { tone: 'ok', detail: 'Verified by operator from camera review.' });
      this.audit(a, 'incident.confirm', id);
    });
    this.notify(a.orgId, {
      event: 'incident.confirmed',
      title: `${inc.id} confirmed: ${inc.title}`,
      text: `${inc.severity} · ${inc.zone} · ${inc.place} · verified by ${a.name}`,
      severity: inc.severity,
      incidentId: inc.id,
    });
    return inc;
  }

  dismiss(a: Actor, id: string, reason: string) {
    this.require(a, 'incident.verify', id);
    if (!reason?.trim()) fail(400, 'invalid', 'A reason is required.');
    const inc = this.getIncident(a, id);
    tx(this.db, () => {
      this.moveIncident(a, inc, 'dismissed');
      inc.outcome = reason.trim();
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, id, 'Dismissed as false alarm', { detail: reason.trim() });
      this.audit(a, 'incident.dismiss', id, 'ok', reason.trim());
    });
    return inc;
  }

  merge(a: Actor, id: string, intoId: string, reason: string) {
    this.require(a, 'incident.verify', id);
    if (!reason?.trim()) fail(400, 'invalid', 'A reason is required.');
    if (id === intoId) fail(400, 'invalid', 'Cannot merge an incident into itself.');
    const inc = this.getIncident(a, id);
    const into = this.getIncident(a, intoId);
    if (['duplicate', 'closed', 'dismissed'].includes(into.status)) fail(409, 'conflict', `${intoId} is ${into.status}.`);
    tx(this.db, () => {
      this.moveIncident(a, inc, 'duplicate');
      inc.duplicateOf = intoId;
      inc.outcome = reason.trim();
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, id, `Merged into ${intoId}`, { detail: reason.trim() });
      this.event(a, a.orgId, into.siteId, intoId, `${id} merged into this incident`, { detail: `Original evidence retained under ${id}. ${reason.trim()}` });
      this.audit(a, 'incident.merge', id, 'ok', `into ${intoId}`);
    });
    return inc;
  }

  editIncident(a: Actor, id: string, patch: { type?: string; severity?: Incident['severity']; title?: string }) {
    this.require(a, 'incident.edit', id);
    const inc = this.getIncident(a, id);
    const before = `${inc.type}/${inc.severity}`;
    if (patch.type) inc.type = patch.type.slice(0, 60);
    if (patch.severity && ['low', 'medium', 'high'].includes(patch.severity)) inc.severity = patch.severity;
    if (patch.title?.trim()) inc.title = patch.title.trim().slice(0, 120);
    tx(this.db, () => {
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, id, 'Incident details changed', { detail: `${before} → ${inc.type}/${inc.severity}` });
      this.audit(a, 'incident.edit', id, 'ok', `${before} → ${inc.type}/${inc.severity}`);
    });
    return inc;
  }

  resolve(a: Actor, id: string, outcome: string) {
    this.require(a, 'incident.resolve', id);
    if (!outcome?.trim()) fail(400, 'invalid', 'Outcome is required.');
    const inc = this.getIncident(a, id);
    const active = this.missionsFor(id).find((m) => ['executing', 'paused'].includes(m.status));
    if (active) fail(409, 'conflict', `Mission ${active.id} is still active. End it first.`);
    tx(this.db, () => {
      this.moveIncident(a, inc, 'resolved');
      inc.outcome = outcome.trim();
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, id, 'Resolved', { tone: 'ok', detail: outcome.trim() });
      this.audit(a, 'incident.resolve', id, 'ok', outcome.trim());
      this.notify(a.orgId, {
        event: 'incident.resolved',
        title: `${inc.id} resolved: ${inc.title}`,
        text: `${outcome.trim()} · by ${a.name}`,
        severity: inc.severity,
        incidentId: inc.id,
      });
    });
    return inc;
  }

  close(a: Actor, id: string) {
    this.require(a, 'incident.close', id);
    const inc = this.getIncident(a, id);
    if (inc.status !== 'resolved') fail(409, 'conflict', 'Resolve the incident before closing it.');
    tx(this.db, () => {
      this.moveIncident(a, inc, 'closed');
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, id, 'Closed', { tone: 'ok' });
      this.audit(a, 'incident.close', id);
    });
    return inc;
  }

  reopen(a: Actor, id: string, reason: string) {
    this.require(a, 'incident.reopen', id);
    if (!reason?.trim()) fail(400, 'invalid', 'A reason is required to reopen.');
    const inc = this.getIncident(a, id);
    tx(this.db, () => {
      this.moveIncident(a, inc, 'triaging');
      inc.duplicateOf = undefined;
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, id, 'Reopened', { tone: 'warn', detail: reason.trim() });
      this.audit(a, 'incident.reopen', id, 'ok', reason.trim());
    });
    return inc;
  }

  // ---- field assignments (F14) ------------------------------------------

  private hasAssignment(a: Actor, incidentId: string) {
    return !!this.db.prepare("SELECT 1 FROM assignments WHERE incident_id = ? AND responder_id = ? AND status != 'cancelled'").get(incidentId, a.userId ?? '');
  }

  private saveAssignment(orgId: string, siteId: string, x: Assignment) {
    this.db
      .prepare(
        'INSERT INTO assignments (id, org_id, incident_id, responder_id, status, data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data',
      )
      .run(x.id, orgId, x.incidentId, x.responderId, x.status, JSON.stringify(x));
    this.publish({ orgId, siteId, incidentId: x.incidentId, event: { type: 'assignment', assignment: x } });
  }

  assign(a: Actor, incidentId: string, responderId: string) {
    this.require(a, 'incident.assign', incidentId);
    const inc = this.getIncident(a, incidentId);
    const r = this.db.prepare('SELECT id, name, role FROM users WHERE id = ? AND org_id = ? AND active = 1').get(responderId, a.orgId) as
      | { id: string; name: string; role: Role }
      | undefined;
    if (!r || r.role !== 'responder') fail(400, 'invalid', 'Choose an active field responder.');
    const x: Assignment = {
      id: `${this.prefix(a.orgId)}ASG-${nextNumber(this.db, a.orgId, 'asg')}`,
      incidentId,
      responderId,
      status: 'assigned',
      createdAt: this.now(),
      updatedAt: this.now(),
      incidentTitle: inc.title,
      place: inc.place,
      zone: inc.zone,
    };
    tx(this.db, () => {
      this.saveAssignment(a.orgId, inc.siteId, x);
      if (!inc.owner) inc.owner = r!.name;
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, incidentId, `Assigned to ${r!.name}`, { detail: 'Waiting for the responder to accept.' });
      this.audit(a, 'incident.assign', incidentId, 'ok', r!.name);
    });
    this.push?.toUsers(a.orgId, [responderId], {
      title: `Assigned: ${inc.id} ${inc.title}`,
      body: `${inc.place} · ${inc.zone}`,
      url: `/field/#task/${encodeURIComponent(x.id)}`,
      tag: `asg-${x.id}`,
      incidentId: inc.id,
    });
    return x;
  }

  listAssignments(a: Actor): Assignment[] {
    const rows = this.db.prepare('SELECT data FROM assignments WHERE org_id = ?').all(a.orgId) as { data: string }[];
    return rows
      .map((r) => JSON.parse(r.data) as Assignment)
      .filter((x) => a.role !== 'responder' || x.responderId === a.userId)
      .map((x) => {
        if (x.incidentTitle) return x;
        const r = this.incRow(x.incidentId);
        const inc = r ? (JSON.parse(r.data) as Incident) : undefined;
        return inc ? { ...x, incidentTitle: inc.title, place: inc.place, zone: inc.zone } : x;
      });
  }

  updateAssignment(a: Actor, id: string, action: 'accept' | 'arrive' | 'report', body: { note?: string; idempotencyKey?: string } = {}) {
    this.require(a, 'field.update', id);
    const row = this.db.prepare('SELECT data FROM assignments WHERE id = ? AND org_id = ?').get(id, a.orgId) as { data: string } | undefined;
    const x = row ? (JSON.parse(row.data) as Assignment) : fail(404, 'not_found', 'Assignment not found.');
    if (x.responderId !== a.userId) fail(404, 'not_found', 'Assignment not found.');
    const inc = this.getIncident(a, x.incidentId);
    if (body.idempotencyKey) {
      const seen = this.db.prepare('SELECT result FROM idempotency WHERE org_id = ? AND key = ?').get(a.orgId, `asg:${body.idempotencyKey}`) as { result: string } | undefined;
      if (seen) return JSON.parse(seen.result) as Assignment;
    }
    const to = ({ accept: 'accepted', arrive: 'on_scene', report: 'reported' } as const)[action];
    if (!canMove(ASSIGNMENT_FLOW, x.status, to)) fail(409, 'conflict', `Task is ${x.status}; cannot ${action}.`);
    x.status = to;
    x.updatedAt = this.now();
    if (body.note) x.note = body.note.slice(0, 2000);
    const title = { accept: 'Responder accepted task', arrive: 'Responder on scene', report: 'Responder report received' }[action];
    tx(this.db, () => {
      this.saveAssignment(a.orgId, inc.siteId, x);
      this.event(a, a.orgId, inc.siteId, inc.id, title, { detail: body.note, tone: action === 'report' ? 'ok' : undefined });
      this.audit(a, `field.${action}`, id);
      if (body.idempotencyKey)
        this.db.prepare('INSERT INTO idempotency (org_id, key, result, created_at) VALUES (?,?,?,?)').run(a.orgId, `asg:${body.idempotencyKey}`, JSON.stringify(x), this.now());
    });
    return x;
  }

  // ---- devices ------------------------------------------------------------

  getDevice(a: Actor, id: string) {
    const d = this.devices.get(id);
    if (!d || !this.inScope(a, d.orgId, d.siteId) || a.role === 'responder') return fail(404, 'not_found', `Device ${id} not found.`);
    return d;
  }

  private publicDevice(d: Device & { orgId?: string; siteId?: string }): Device {
    const { orgId: _o, siteId: _s, ...rest } = d;
    return rest;
  }

  listDevices(a: Actor, siteId?: string): Device[] {
    if (a.role === 'responder') return [];
    return [...this.devices.values()].filter((d) => this.inScope(a, d.orgId, d.siteId) && (!siteId || d.siteId === siteId)).map((d) => this.publicDevice(d));
  }

  private saveDevice(d: Device & { orgId: string; siteId: string }, publish = true) {
    this.devices.set(d.id, d);
    this.db.prepare('UPDATE devices SET data = ? WHERE id = ?').run(JSON.stringify(this.publicDevice(d)), d.id);
    if (publish) this.publish({ orgId: d.orgId, siteId: d.siteId, event: { type: 'device', device: this.publicDevice(d) } });
  }

  registerDevice(a: Actor, input: Partial<Device> & { id: string; kind: Device['kind']; siteId?: string }) {
    this.require(a, 'admin.devices', input.id);
    if (!/^[A-Z0-9-]{3,32}$/.test(input.id)) fail(400, 'invalid', 'Device id must be 3–32 characters: A–Z, 0–9, dash.');
    if (this.devices.has(input.id)) fail(409, 'conflict', 'Device id already registered.');
    const over = this.license.check('devices', this.licenseUsage(a.orgId).devices, this.now());
    if (over) {
      this.audit(a, 'admin.device_register', input.id, 'denied', over);
      fail(402, 'license', over);
    }
    const siteId = input.siteId ?? this.defaultSite(a);
    if (!this.inScope(a, a.orgId, siteId)) fail(404, 'not_found', 'Site not found.');
    // A registered device is real hardware under test. Only an administrator later marks it verified
    // (PATCH /devices/{id}/integration); a gateway never sets it (capability matrix §8). Simulated
    // devices come from the demo/sandbox seed only, so a pilot site cannot bypass the mode gate.
    const integration: IntegrationStatus = 'testing';
    const d: Device = {
      id: input.id,
      kind: input.kind,
      model: input.model ?? 'Unspecified',
      adapterVersion: '—',
      firmwareTested: input.firmwareTested ?? 'not tested',
      integration,
      // Real devices always start in SHADOW, whoever registers them (ADR-006 §2).
      mode: modeOf({ integration }),
      capabilities: input.capabilities ?? [],
      commands: [],
      limitations: input.limitations ?? 'Not yet declared by an adapter.',
      zone: input.zone ?? 'Zone A',
      pos: input.pos ?? { x: 210, y: 140 },
      // No position until the device reports one (maps leave it off instead of at the default).
      ...(input.pos ? {} : { noFix: true }),
      accuracyM: 5,
      lastSeen: 0,
      rateMs: 1000,
      speed: 0,
    };
    tx(this.db, () => {
      this.db.prepare('INSERT INTO devices (id, org_id, site_id, data, registered_at) VALUES (?,?,?,?,?)').run(d.id, a.orgId, siteId, JSON.stringify(d), this.now());
      this.audit(a, 'device.register', d.id, 'ok', `${d.kind} ${d.integration}, mode ${d.mode}`);
    });
    this.devices.set(d.id, { ...d, orgId: a.orgId, siteId });
    this.publish({ orgId: a.orgId, siteId, event: { type: 'device', device: d } });
    return d;
  }

  handover(a: Actor, deviceId: string, toUserId: string) {
    this.require(a, 'control.handover', deviceId);
    const d = this.getDevice(a, deviceId);
    const to = this.db.prepare('SELECT id, name, role FROM users WHERE id = ? AND org_id = ? AND active = 1').get(toUserId, a.orgId) as
      | { id: string; name: string; role: Role }
      | undefined;
    if (!to || (!can(to.role, 'device.command') && to.role !== 'supervisor')) fail(400, 'invalid', 'Control can only go to an operator or supervisor.');
    const from = d.controlOwner;
    tx(this.db, () => {
      d.controlOwner = toUserId;
      this.saveDevice(d);
      const m = this.activeMission(deviceId);
      if (m) {
        m.operatorId = toUserId;
        this.saveMission(d.orgId, d.siteId, m);
        this.event(a, d.orgId, d.siteId, m.incidentId, `Control of ${d.id} handed over`, { detail: `${this.userName(a.orgId, from)} → ${to!.name}` });
      }
      this.audit(a, 'control.handover', d.id, 'ok', `${this.userName(a.orgId, from)} → ${to!.name}`);
    });
    return this.publicDevice(d);
  }

  /** The holder gives up control (e.g. at shift end). */
  release(a: Actor, deviceId: string) {
    const d = this.getDevice(a, deviceId);
    if (d.controlOwner !== a.userId) fail(409, 'control_held', 'You do not hold control of this device.');
    if (this.activeMission(deviceId)?.status === 'executing') fail(409, 'conflict', 'Pause or stop the mission before releasing control.');
    d.controlOwner = undefined;
    tx(this.db, () => {
      this.saveDevice(d);
      this.audit(a, 'control.release', d.id);
    });
    return this.publicDevice(d);
  }

  // ---- operational mode (ADR-006, L1 safety gate) ----------------------------

  /**
   * POST /devices/{id}/mode-transitions. Promotion (SHADOW → LIVE_MANUAL) needs device.mode.promote,
   * a password check within the step-up window, fresh telemetry and a reason. Demotion to a lower
   * mode needs device.mode.demote (or the system) and a reason. SIMULATION never changes here, and
   * LIVE_ASSISTED is not enabled until an automation policy exists.
   */
  transitionMode(a: Actor, deviceId: string, input: { to?: unknown; reason?: unknown }) {
    const to = input.to as OperationalMode;
    if (typeof to !== 'string' || !Object.hasOwn(MODE_RANK, to)) return fail(400, 'invalid', 'to must be SHADOW, LIVE_MANUAL or LIVE_ASSISTED.');
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    if (!reason) return fail(400, 'invalid', 'A reason is required (who is on site, which safety checks passed).');
    const d = this.getDevice(a, deviceId);
    const from = modeOf(d);
    const deny = (status: number, code: string, why: string): never => {
      this.audit(a, 'device.mode_change', d.id, 'denied', `${from} → ${to}: ${why}`);
      return fail(status, code, why);
    };
    if (from === 'SIMULATION' || to === 'SIMULATION') return deny(409, 'mode_locked', `${d.id}: SIMULATION is fixed by the adapter type and cannot be changed here.`);
    if (from === to) return fail(409, 'conflict', `${d.id} is already ${to}.`);
    const up = MODE_RANK[to] > MODE_RANK[from];
    try {
      this.require(a, up ? 'device.mode.promote' : 'device.mode.demote', d.id);
    } catch (e) {
      // Role denials are audited by require(); a missing password check is audited here.
      if (e instanceof ApiError && e.code === 'step_up_required') this.audit(a, 'device.mode_change', d.id, 'denied', `${from} → ${to}: step-up required`);
      throw e;
    }
    if (up) {
      if (to === 'LIVE_ASSISTED') return deny(409, 'not_enabled', 'LIVE_ASSISTED needs an approved automation policy (ADR-006) and is not enabled in this release.');
      const fresh = freshnessAt(this.now(), d);
      if (fresh !== 'live') return deny(409, 'stale_telemetry', `${d.id} telemetry is ${fresh}. Only a device reporting live data can be promoted.`);
    }
    return this.applyMode(a, d, to, reason);
  }

  /** Safety demotion by the platform itself. Never raises a mode; does nothing below LIVE. */
  demoteBySystem(deviceId: string, reason: string, name = 'Safety demotion') {
    const d = this.devices.get(deviceId);
    if (!d || MODE_RANK[modeOf(d)] <= MODE_RANK.SHADOW) return undefined;
    return this.applyMode(this.systemActor(d.orgId, 'system', name), d, 'SHADOW', reason);
  }

  private applyMode(a: Actor, d: Device & { orgId: string; siteId: string }, to: OperationalMode, reason: string) {
    const from = modeOf(d);
    const at = this.now();
    d.mode = to;
    let auditId = '';
    tx(this.db, () => {
      this.saveDevice(d);
      auditId = this.audit(a, 'device.mode_change', d.id, 'ok', `${from} → ${to}: ${reason}`).id;
    });
    // Live driving needs LIVE_MANUAL: any demotion ends it at once.
    if (this.driving.has(d.id) && to !== 'LIVE_MANUAL') this.endDrive(d.id, a, `mode changed to ${to}`);
    const running = to === 'SHADOW' && this.activeMission(d.id)?.status === 'executing';
    this.publish({
      orgId: d.orgId,
      siteId: d.siteId,
      event: {
        type: 'notice',
        tone: MODE_RANK[to] > MODE_RANK[from] ? 'warn' : 'info',
        text: `${d.id} mode ${from} → ${to} by ${a.name}: ${reason}${running ? ' The running mission was not stopped; stop or pause it if needed.' : ''}`,
      },
    });
    const change = { orgId: d.orgId, siteId: d.siteId, deviceId: d.id, from, to, by: a.name, reason, at, auditId };
    this.bus.emit('device.mode_changed', change);
    return { device: this.publicDevice(d), from, to, at, auditId };
  }

  /** Administrator: integration status (verified / testing). Gateways never set it. */
  setDeviceIntegration(a: Actor, deviceId: string, input: { integration?: unknown; reason?: unknown }) {
    this.require(a, 'admin.devices', deviceId);
    const to = input.integration as IntegrationStatus;
    if (!['verified', 'testing', 'simulated'].includes(to)) return fail(400, 'invalid', 'integration must be verified, testing or simulated.');
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    if (!reason) return fail(400, 'invalid', 'A reason is required (test record, HIL report).');
    const d = this.getDevice(a, deviceId);
    const from = d.integration;
    if (from === to) return fail(409, 'conflict', `${d.id} is already ${to}.`);
    if ((from === 'simulated') !== (to === 'simulated')) {
      this.audit(a, 'device.integration', d.id, 'denied', `${from} → ${to}: crosses the simulated boundary`);
      return fail(409, 'mode_locked', 'A simulated adapter and a real device are different devices (ADR-006). Register a new device id instead.');
    }
    d.integration = to;
    tx(this.db, () => {
      this.saveDevice(d);
      this.audit(a, 'device.integration', d.id, 'ok', `${from} → ${to}: ${reason}`);
    });
    return this.publicDevice(d);
  }

  // ---- edge media origins (gateway-declared stream URLs) -----------------------

  /** Allowed edge origins for one device's site: the org-wide list plus the site's own. */
  private edgeOriginsFor(orgId: string, siteId: string): string[] {
    const rows = this.db.prepare("SELECT origin FROM edge_origins WHERE org_id = ? AND (site_id = '' OR site_id = ?)").all(orgId, siteId) as { origin: string }[];
    // The platform's own media server (pushed video) is always allowed: the server set those URLs, not a gateway.
    return [...rows.map((r) => r.origin), ...(this.cfg.mediaPublicUrl ? [this.cfg.mediaPublicUrl] : [])];
  }

  /** Push mode on this server: the platform runs a media server that gateways publish into. */
  private get pushEnabled() {
    return !!(this.cfg.mediaIngestUrl && this.cfg.mediaPublicUrl);
  }

  /**
   * A declared stream with `push` becomes a stream on the platform's media server: the server, not
   * the gateway, decides the browser address. Without a media server the push flag is dropped.
   */
  private pushedStream<T extends { push?: boolean; whep?: string } | undefined>(st: T, deviceId: string): T {
    if (!st || typeof st !== 'object' || st.push !== true) return st;
    const { push: _push, whep: _whep, ...rest } = st;
    if (!this.pushEnabled) return rest as T;
    return { ...rest, whep: `${this.cfg.mediaPublicUrl}/${pushPath(deviceId)}/whep` } as T;
  }

  private publishToken(orgId: string, deviceId: string, gatewayId: string, exp: number) {
    const body = Buffer.from(`${deviceId}|${gatewayId}|${exp}`).toString('base64url');
    return `p1.${body}.${hmac(this.cfg.mediaSecret, `pub|${orgId}|${body}`)}`;
  }

  /** Where a gateway publishes one device's video: rtsp://pub:<token>@ingest-host:port/<path>. */
  private publishUrl(orgId: string, deviceId: string, gatewayId: string) {
    const u = new URL(this.cfg.mediaIngestUrl!);
    return `${u.protocol}//pub:${this.publishToken(orgId, deviceId, gatewayId, this.now() + MEDIA_PUBLISH_TTL_MS)}@${u.host}/${pushPath(deviceId)}`;
  }

  /** May this credential publish to this path? Only the gateway that holds the device, while it is connected. */
  private mayPublish(token: string, path: string): boolean {
    const [ver, body, sig] = token.split('.');
    if (ver !== 'p1' || !body || !sig) return false;
    const [deviceId, gatewayId, expStr] = Buffer.from(body, 'base64url').toString().split('|');
    if (!(Number(expStr) > this.now())) return false;
    const d = this.devices.get(deviceId);
    if (!d || !safeEqual(sig, hmac(this.cfg.mediaSecret, `pub|${d.orgId}|${body}`))) return false;
    if (path !== pushPath(d.id)) return false;
    const holder = (this.db.prepare('SELECT gateway_id FROM devices WHERE id = ?').get(d.id) as { gateway_id: string | null } | undefined)?.gateway_id;
    if (holder !== gatewayId) return false;
    const live = this.gateways.connected?.(d.orgId);
    return !live || live.some((g) => g.gatewayId === gatewayId && g.devices.includes(d.id));
  }

  listEdgeOrigins(a: Actor) {
    // Reading needs no password check; changing the list does (admin.edge_origins is a step-up action).
    this.require(a, 'admin.devices', 'edge-origins', { mutating: false });
    const rows = this.db.prepare('SELECT site_id, origin, created_by, created_at FROM edge_origins WHERE org_id = ? ORDER BY site_id, origin').all(a.orgId) as {
      site_id: string;
      origin: string;
      created_by: string;
      created_at: number;
    }[];
    return rows
      .filter((r) => !r.site_id || this.inScope(a, a.orgId, r.site_id))
      .map((r) => ({ siteId: r.site_id || null, origin: r.origin, createdBy: r.created_by, createdAt: r.created_at }));
  }

  /**
   * Replaces the allowed edge origins for one site (siteId) or the whole organisation (no siteId).
   * Stored stream URLs that are no longer allowed are removed at once; newly allowed ones are taken
   * from the gateway's next hello.
   */
  setEdgeOrigins(a: Actor, input: { siteId?: unknown; origins?: unknown }) {
    this.require(a, 'admin.edge_origins', 'edge-origins');
    let siteId = '';
    if (input.siteId !== undefined && input.siteId !== null && input.siteId !== '') siteId = this.site(a, String(input.siteId)).id;
    else if (a.siteIds.length) return fail(403, 'forbidden', 'Organisation-wide origins need an administrator for every site.');
    if (!Array.isArray(input.origins) || input.origins.length > 50) return fail(400, 'invalid', 'origins must be a list of up to 50 origins.');
    const origins: string[] = [];
    for (const raw of input.origins) {
      const r = parseEdgeOrigin(raw);
      if ('error' in r) {
        this.audit(a, 'admin.edge_origins', siteId || a.orgId, 'denied', r.error);
        return fail(400, 'invalid', r.error);
      }
      if (!origins.includes(r.origin)) origins.push(r.origin);
    }
    const before = (this.db.prepare('SELECT origin FROM edge_origins WHERE org_id = ? AND site_id = ? ORDER BY origin').all(a.orgId, siteId) as { origin: string }[]).map(
      (r) => r.origin,
    );
    tx(this.db, () => {
      this.db.prepare('DELETE FROM edge_origins WHERE org_id = ? AND site_id = ?').run(a.orgId, siteId);
      const ins = this.db.prepare('INSERT INTO edge_origins (org_id, site_id, origin, created_by, created_at) VALUES (?,?,?,?,?)');
      for (const o of origins) ins.run(a.orgId, siteId, o, a.name, this.now());
      this.audit(a, 'admin.edge_origins', siteId || a.orgId, 'ok', `${siteId ? `site ${siteId}` : 'organisation'}: [${origins.join(', ')}] (was [${before.join(', ')}])`);
      // Drop stored URLs the new list no longer allows.
      for (const d of this.devices.values()) {
        if (d.orgId !== a.orgId || (siteId && d.siteId !== siteId)) continue;
        const allowed = this.edgeOriginsFor(d.orgId, d.siteId);
        const st = vetStream(d.stream, allowed).stream;
        const comps = d.components?.map((c) => (c.stream ? { ...c, stream: vetStream(c.stream, allowed, EDGE_STREAM_KEYS.filter((k) => k !== 'playback')).stream } : c));
        if (JSON.stringify(st) !== JSON.stringify(d.stream) || JSON.stringify(comps) !== JSON.stringify(d.components)) {
          d.stream = st;
          d.components = comps;
          this.saveDevice(d);
        }
      }
    });
    return { siteId: siteId || null, origins };
  }

  /** The device's stream with only URLs its site allows right now (the list may have changed since the hello). */
  private vettedStream(d: Device & { orgId: string; siteId: string }): StreamInfo {
    if (d.integration === 'simulated' || !d.stream) return {};
    return vetStream(d.stream, this.edgeOriginsFor(d.orgId, d.siteId)).stream ?? {};
  }

  telemetryHistory(a: Actor, deviceId: string, from: number, to: number) {
    this.getDevice(a, deviceId);
    return this.db
      .prepare(
        'SELECT seq, source_time AS sourceTime, received_time AS receivedTime, received_time - source_time AS latencyMs, x, y, alt, accuracy, battery, speed, heading, signal, satellites, temperature AS temperatureC FROM telemetry WHERE device_id = ? AND received_time BETWEEN ? AND ? ORDER BY received_time LIMIT 20000',
      )
      .all(deviceId, from, to);
  }

  // ---- missions -----------------------------------------------------------

  private missionsFor(incidentId: string): Mission[] {
    return (this.db.prepare('SELECT data FROM missions WHERE incident_id = ? ORDER BY id').all(incidentId) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  private activeMission(deviceId: string): Mission | undefined {
    const r = this.db
      .prepare("SELECT data FROM missions WHERE device_id = ? AND status IN ('approved','assigned','executing','paused','pending_approval') ORDER BY rowid DESC LIMIT 1")
      .get(deviceId) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }

  private allMissions(orgId: string): Mission[] {
    return (this.db.prepare('SELECT data FROM missions WHERE org_id = ?').all(orgId) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  getMission(a: Actor, id: string) {
    const r = this.db.prepare('SELECT org_id, site_id, data FROM missions WHERE id = ?').get(id) as { org_id: string; site_id: string; data: string } | undefined;
    if (!r || !this.inScope(a, r.org_id, r.site_id) || a.role === 'responder') return fail(404, 'not_found', `Mission ${id} not found.`);
    return { m: JSON.parse(r.data) as Mission, siteId: r.site_id };
  }

  private saveMission(orgId: string, siteId: string, m: Mission) {
    this.db
      .prepare(
        'INSERT INTO missions (id, org_id, site_id, incident_id, device_id, status, data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data',
      )
      .run(m.id, orgId, siteId, m.incidentId, m.deviceId, m.status, JSON.stringify(m));
    this.publish({ orgId, siteId, event: { type: 'mission', mission: m } });
  }

  private moveMission(m: Mission, to: MissionStatus) {
    if (!canMove(MISSION_FLOW, m.status, to)) fail(409, 'conflict', `Mission is ${m.status.replace('_', ' ')}; it cannot become ${to.replace('_', ' ')}.`);
    m.status = to;
  }

  /** A route a vehicle may drive: it must not enter an active keep-out zone (or no-fly zone for aircraft). */
  private clearRoute(orgId: string, d: Device & { siteId: string }, pts: Point[]) {
    if (d.kind !== 'ugv' && d.kind !== 'uav') return pts;
    const hits = routeViolations(pts, d.pos, this.geofencesOf(orgId, d.siteId), d.kind);
    if (hits.length) fail(409, 'conflict', `Route enters ${hits.map((h) => `${GEOFENCE_KIND_LABEL[h.kind].toLowerCase()} zone "${h.name}"`).join(' and ')}. Plan around it.`);
    return pts;
  }

  private validRoute(pts: Point[]) {
    if (!Array.isArray(pts) || pts.length < 1 || pts.length > 50) fail(400, 'invalid', 'Route needs 1–50 checkpoints.');
    for (const p of pts)
      if (typeof p?.x !== 'number' || typeof p?.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) fail(400, 'invalid', 'Checkpoints must be {x, y} numbers.');
    return pts.map((p) => ({ x: p.x, y: p.y }));
  }

  createMission(a: Actor, input: { incidentId: string; deviceId: string; operatorId: string; checkpoints: Point[] }) {
    this.require(a, 'mission.prepare', input.incidentId);
    const inc = this.getIncident(a, input.incidentId);
    if (inc.status !== 'confirmed') fail(409, 'conflict', 'Verify the incident before preparing a mission.');
    const d = this.getDevice(a, input.deviceId);
    if (!isReadyAt(this.now(), d, this.allMissions(a.orgId))) fail(409, 'conflict', `${d.id} is not ready.`);
    const op = this.db.prepare('SELECT role FROM users WHERE id = ? AND org_id = ? AND active = 1').get(input.operatorId, a.orgId) as { role: Role } | undefined;
    if (!op || op.role !== 'operator') fail(400, 'invalid', 'Choose an active operator.');
    const m: Mission = {
      id: `${this.prefix(a.orgId)}MSN-${String(nextNumber(this.db, a.orgId, 'mission')).padStart(4, '0')}`,
      incidentId: inc.id,
      deviceId: d.id,
      operatorId: input.operatorId,
      checkpoints: this.clearRoute(a.orgId, d, this.validRoute(input.checkpoints)),
      planVersion: 1,
      status: 'draft',
      nextCp: 0,
      createdAt: this.now(),
    };
    tx(this.db, () => {
      this.saveMission(a.orgId, inc.siteId, m);
      this.event(a, a.orgId, inc.siteId, inc.id, `Mission ${m.id} drafted`, {
        detail: `${d.id}, ${m.checkpoints.length} checkpoints, operator ${this.userName(a.orgId, m.operatorId)}.`,
      });
      this.audit(a, 'mission.create', m.id);
    });
    return m;
  }

  editRoute(a: Actor, id: string, checkpoints: Point[]) {
    this.require(a, 'mission.prepare', id);
    const { m, siteId } = this.getMission(a, id);
    if (!['draft', 'pending_approval', 'approved', 'assigned', 'rejected'].includes(m.status)) fail(409, 'conflict', 'Route cannot be changed while the mission is running.');
    m.checkpoints = this.clearRoute(a.orgId, this.getDevice(a, m.deviceId), this.validRoute(checkpoints));
    m.planVersion += 1;
    tx(this.db, () => {
      if (m.status === 'approved' || m.status === 'assigned') {
        m.status = 'pending_approval';
        this.event(a, a.orgId, siteId, m.incidentId, 'Route changed after approval — re-approval required', {
          tone: 'warn',
          detail: `Plan v${m.planVersion}; approved plan was v${m.approvedVersion}.`,
        });
        this.publish({ orgId: a.orgId, siteId, event: { type: 'notice', tone: 'warn', text: `Route of ${m.id} changed. Re-approval required.` } });
      } else {
        this.event(a, a.orgId, siteId, m.incidentId, `Route updated (plan v${m.planVersion})`);
      }
      this.saveMission(a.orgId, siteId, m);
      this.audit(a, 'mission.edit', m.id, 'ok', `plan v${m.planVersion}`);
    });
    return m;
  }

  submitMission(a: Actor, id: string) {
    this.require(a, 'mission.prepare', id);
    const { m, siteId } = this.getMission(a, id);
    if (!['draft', 'rejected'].includes(m.status)) fail(409, 'conflict', 'Mission is not a draft.');
    tx(this.db, () => {
      this.moveMission(m, 'pending_approval');
      m.note = undefined;
      this.saveMission(a.orgId, siteId, m);
      this.event(a, a.orgId, siteId, m.incidentId, 'Approval requested', { detail: `Mission ${m.id} plan v${m.planVersion} sent to supervisor.` });
      this.audit(a, 'mission.submit', m.id);
    });
    return m;
  }

  checks(a: Actor, id: string) {
    const { m, siteId } = this.getMission(a, id);
    const d = this.getDevice(a, m.deviceId);
    return constraintChecksAt(this.now(), d, m, (u) => this.userName(a.orgId, u), this.geofencesOf(a.orgId, siteId));
  }

  approveMission(a: Actor, id: string) {
    this.require(a, 'mission.approve', id);
    const { m, siteId } = this.getMission(a, id);
    if (m.status !== 'pending_approval') fail(409, 'conflict', 'Mission is not awaiting approval.');
    const failed = this.checks(a, id).filter((c) => c.hard && !c.ok);
    if (failed.length) fail(409, 'conflict', `Cannot approve: ${failed.map((f) => f.label).join(', ')}.`);
    tx(this.db, () => {
      this.moveMission(m, 'approved');
      m.approvedVersion = m.planVersion;
      m.approvedBy = a.userId;
      this.saveMission(a.orgId, siteId, m);
      this.event(a, a.orgId, siteId, m.incidentId, 'Mission approved', { tone: 'ok', detail: `Plan v${m.planVersion} approved by ${a.name}. Waiting for operator to accept.` });
      this.audit(a, 'mission.approve', m.id, 'ok', `plan v${m.planVersion}`);
    });
    return m;
  }

  rejectMission(a: Actor, id: string, reason: string) {
    this.require(a, 'mission.approve', id);
    if (!reason?.trim()) fail(400, 'invalid', 'A reason is required.');
    const { m, siteId } = this.getMission(a, id);
    if (m.status !== 'pending_approval') fail(409, 'conflict', 'Mission is not awaiting approval.');
    tx(this.db, () => {
      this.moveMission(m, 'rejected');
      m.note = reason.trim();
      this.saveMission(a.orgId, siteId, m);
      this.event(a, a.orgId, siteId, m.incidentId, 'Mission rejected', { tone: 'warn', detail: reason.trim() });
      this.audit(a, 'mission.reject', m.id, 'ok', reason.trim());
    });
    return m;
  }

  cancelMission(a: Actor, id: string) {
    this.require(a, 'mission.prepare', id);
    const { m, siteId } = this.getMission(a, id);
    if (!['draft', 'pending_approval', 'approved', 'assigned', 'rejected'].includes(m.status)) fail(409, 'conflict', 'A running mission must be stopped by its operator.');
    tx(this.db, () => {
      this.moveMission(m, 'cancelled');
      const d = this.devices.get(m.deviceId);
      if (d && d.controlOwner === m.operatorId) {
        d.controlOwner = undefined;
        this.saveDevice(d);
      }
      this.saveMission(a.orgId, siteId, m);
      this.event(a, a.orgId, siteId, m.incidentId, `Mission ${m.id} cancelled`);
      this.audit(a, 'mission.cancel', m.id);
      if (m.patrolId) this.finishPatrolRun(a.orgId, siteId, m, this.now(), 'cancelled');
    });
    return m;
  }

  acceptMission(a: Actor, id: string) {
    this.require(a, 'mission.accept', id);
    const { m, siteId } = this.getMission(a, id);
    if (m.operatorId !== a.userId) fail(403, 'forbidden', 'This mission is assigned to another operator.');
    if (m.status !== 'approved' || m.approvedVersion !== m.planVersion) fail(409, 'conflict', 'Mission needs an approved plan first.');
    const d = this.getDevice(a, m.deviceId);
    if (d.controlOwner && d.controlOwner !== a.userId)
      fail(409, 'control_held', `Control of ${d.id} is held by ${this.userName(a.orgId, d.controlOwner)}. A handover is required.`);
    tx(this.db, () => {
      d.controlOwner = a.userId;
      this.saveDevice(d);
      this.moveMission(m, 'assigned');
      this.saveMission(a.orgId, siteId, m);
      this.event(a, a.orgId, siteId, m.incidentId, 'Operator accepted mission', { detail: `${a.name} confirmed readiness and holds control of ${d.id}.` });
      this.audit(a, 'mission.accept', m.id);
      this.audit(a, 'control.acquire', d.id);
    });
    return m;
  }

  // ---- commands -----------------------------------------------------------

  private saveCommand(orgId: string, siteId: string, c: Command) {
    this.db
      .prepare(
        'INSERT INTO commands (id, org_id, site_id, mission_id, device_id, idempotency_key, status, data) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data',
      )
      .run(c.id, orgId, siteId, c.missionId, c.deviceId, c.idempotencyKey, c.status, JSON.stringify(c));
    this.publish({ orgId, siteId, event: { type: 'command', command: c } });
  }

  private setCmd(c: Command, status: CommandStatus, detail?: string) {
    if (!canMove(COMMAND_FLOW, c.status, status)) return false;
    c.status = status;
    c.history.push({ status, at: this.now() });
    if (detail) c.detail = detail;
    return true;
  }

  listCommands(a: Actor, missionId?: string): Command[] {
    if (a.role === 'responder') return [];
    const rows = this.db.prepare('SELECT site_id, data FROM commands WHERE org_id = ? ORDER BY rowid').all(a.orgId) as { site_id: string; data: string }[];
    return rows
      .filter((r) => this.inScope(a, a.orgId, r.site_id))
      .map((r) => JSON.parse(r.data) as Command)
      .filter((c) => !missionId || c.missionId === missionId);
  }

  issueCommand(a: Actor, missionId: string, type: CommandType, idempotencyKey: string): Command {
    this.require(a, 'device.command', `${missionId}:${type}`);
    if (!idempotencyKey || idempotencyKey.length > 120) fail(400, 'invalid', 'An idempotency key is required.');
    if (!['start', 'pause', 'resume', 'stop'].includes(type)) fail(400, 'invalid', 'Unknown command.');
    const { m, siteId } = this.getMission(a, missionId);
    const dupe = this.db.prepare('SELECT data FROM commands WHERE org_id = ? AND idempotency_key = ?').get(a.orgId, idempotencyKey) as { data: string } | undefined;
    if (dupe) {
      this.audit(a, 'device.command', `${missionId}:${type}`, 'ok', `duplicate key ${idempotencyKey} ignored`);
      return JSON.parse(dupe.data) as Command;
    }
    const d = this.getDevice(a, m.deviceId);
    const now = this.now();
    const c: Command = {
      id: `${this.prefix(a.orgId)}CMD-${String(nextNumber(this.db, a.orgId, 'command')).padStart(4, '0')}`,
      idempotencyKey,
      missionId,
      deviceId: d.id,
      type,
      issuer: a.userId ?? a.name,
      issuedAt: now,
      expiresAt: now + COMMAND_TTL_MS,
      status: 'requested',
      history: [{ status: 'requested', at: now }],
      delivered: false,
    };
    const deny = (code: string, why: string): never => {
      this.setCmd(c, 'rejected', why);
      tx(this.db, () => {
        this.saveCommand(a.orgId, siteId, c);
        this.audit(a, 'device.command', `${missionId}:${type}`, 'error', why);
      });
      throw new ApiError(409, code, why);
    };
    if (!d.commands.includes(type)) deny('invalid', `${d.id} adapter does not support ${type}.`);
    // Mode gate (ADR-006, L1 safety gate): only start and resume set a vehicle moving. Stop and
    // pause always pass, so a device can be halted in any mode.
    const mode = modeOf(d);
    const by = a.kind === 'system' ? 'automation' : 'person';
    if ((type === 'start' || type === 'resume') && !modeAllowsMotion(mode, by))
      deny(
        'mode_not_live',
        by === 'automation'
          ? `${d.id} is ${mode}. Automatic ${type} needs LIVE_ASSISTED.`
          : `${d.id} is in ${mode} mode. A supervisor must promote it to LIVE_MANUAL before ${type}. Stop and pause still work.`,
      );
    // A route and a person on the sticks would both steer the vehicle.
    if ((type === 'start' || type === 'resume') && this.driving.has(d.id)) deny('conflict', `${d.id} is being driven from the console. End the drive first.`);
    if (d.controlOwner !== a.userId)
      deny(
        'control_held',
        d.controlOwner
          ? `Control of ${d.id} is held by ${this.userName(a.orgId, d.controlOwner)}. A handover is required.`
          : `You do not hold control of ${d.id}. Accept the mission first.`,
      );
    const valid: Record<CommandType, MissionStatus[]> = { start: ['assigned'], pause: ['executing'], resume: ['paused'], stop: ['executing', 'paused'] };
    if (!valid[type].includes(m.status)) deny('conflict', `Cannot ${type} while mission is ${m.status.replace('_', ' ')}.`);
    if (type === 'start' && m.approvedVersion !== m.planVersion) deny('conflict', 'Plan changed since approval. Re-approval required.');
    const fresh = freshnessAt(now, d);
    if ((type === 'start' || type === 'resume') && fresh !== 'live') deny('stale_telemetry', `Telemetry is ${fresh}. New ${type} commands are held until data is fresh.`);
    const pending = this.listCommands(a, missionId).find((x) => !isTerminalCommand(x.status));
    if (pending && type !== 'stop') deny('conflict', `Waiting for ${pending.type} (${pending.id}) to finish.`);

    this.setCmd(c, 'authorized');
    const sent = this.gateways.send(d.orgId, d.id, {
      t: 'command',
      commandId: c.id,
      idempotencyKey,
      deviceId: d.id,
      type,
      expiresAt: c.expiresAt,
      route: type === 'start' ? m.checkpoints : undefined,
      missionId,
    });
    if (sent) this.setCmd(c, 'sent');
    tx(this.db, () => {
      this.saveCommand(a.orgId, siteId, c);
      this.event(a, a.orgId, siteId, m.incidentId, `${type.toUpperCase()} requested`, {
        detail: `${c.id} ${sent ? 'sent to' : 'queued for'} ${d.id}. Waiting for device response.`,
      });
      this.audit(a, 'device.command', `${missionId}:${type}`, 'ok', c.id);
    });
    if (fresh !== 'live')
      this.publish({ orgId: a.orgId, siteId, event: { type: 'notice', tone: 'warn', text: `Telemetry is ${fresh}. The ${type} request was sent but the result may be unknown.` } });
    return c;
  }

  private findCommand(id: string) {
    const r = this.db.prepare('SELECT org_id, site_id, data FROM commands WHERE id = ?').get(id) as { org_id: string; site_id: string; data: string } | undefined;
    return r ? { c: JSON.parse(r.data) as Command, orgId: r.org_id, siteId: r.site_id } : undefined;
  }

  private missionById(id: string) {
    const r = this.db.prepare('SELECT org_id, site_id, data FROM missions WHERE id = ?').get(id) as { org_id: string; site_id: string; data: string } | undefined;
    return r ? { m: JSON.parse(r.data) as Mission, orgId: r.org_id, siteId: r.site_id } : undefined;
  }

  private applyCommand(c: Command, orgId: string, siteId: string) {
    const found = this.missionById(c.missionId);
    if (!found) return;
    const { m } = found;
    const d = this.devices.get(c.deviceId);
    const sys = { actor: c.deviceId };
    switch (c.type) {
      case 'start': {
        if (!canMove(MISSION_FLOW, m.status, 'executing')) return;
        m.status = 'executing';
        m.note = undefined;
        const r = this.incRow(m.incidentId);
        if (r) {
          const inc = JSON.parse(r.data) as Incident;
          if (inc.status === 'confirmed') {
            inc.status = 'responding';
            this.saveIncident(orgId, siteId, inc);
          }
        }
        this.event(null, orgId, siteId, m.incidentId, `Mission ${m.id} started`, { ...sys, tone: 'ok', detail: 'Start confirmed by the vehicle.' });
        break;
      }
      case 'pause':
        if (!canMove(MISSION_FLOW, m.status, 'paused')) return;
        m.status = 'paused';
        this.event(null, orgId, siteId, m.incidentId, `${c.deviceId} paused`, { ...sys, detail: 'Hold confirmed by vehicle telemetry (speed 0).' });
        break;
      case 'resume':
        if (!canMove(MISSION_FLOW, m.status, 'executing')) return;
        m.status = 'executing';
        m.note = undefined;
        this.event(null, orgId, siteId, m.incidentId, `${c.deviceId} resumed`, sys);
        break;
      case 'stop':
        if (!canMove(MISSION_FLOW, m.status, 'cancelled')) return;
        m.status = 'cancelled';
        this.event(null, orgId, siteId, m.incidentId, `${c.deviceId} stopped`, { ...sys, tone: 'warn', detail: 'Stop confirmed by vehicle telemetry (speed 0). Mission ended.' });
        if (m.patrolId) this.finishPatrolRun(orgId, siteId, m, this.now(), 'stopped');
        break;
    }
    if (d && (c.type === 'pause' || c.type === 'stop')) {
      d.speed = 0;
      this.saveDevice(d);
    }
    this.saveMission(orgId, siteId, m);
  }

  // ---- gateway ingest -----------------------------------------------------

  /** Called when a gateway says hello. Returns accepted/rejected device ids. */
  gatewayHello(orgId: string, siteIds: string[], gatewayId: string, decls: AdapterDeclaration[], geo?: GeoAnchor) {
    const accepted: string[] = [];
    const rejected: { deviceId: string; reason: string }[] = [];
    const media: MediaPublish[] = [];
    const notes: string[] = [];
    const sys = this.systemActor(orgId, 'gateway', gatewayId);
    if (geo && Number.isFinite(geo.originLat) && Number.isFinite(geo.originLon)) this.checkGatewayAnchor(sys, siteIds, gatewayId, geo);
    const orgEnv = (this.db.prepare('SELECT env FROM orgs WHERE id = ?').get(orgId) as { env: string } | undefined)?.env ?? this.cfg.env;
    for (const decl of decls) {
      const d = this.devices.get(decl.deviceId);
      if (!d || d.orgId !== orgId || (siteIds.length && !siteIds.includes(d.siteId))) {
        rejected.push({ deviceId: decl.deviceId, reason: 'Device is not registered for this gateway. Register it under Administration first.' });
        continue;
      }
      if (orgEnv === 'demo' && decl.integration !== 'simulated') {
        rejected.push({ deviceId: decl.deviceId, reason: 'The demo organisation accepts simulated adapters only. Use the developer sandbox or a pilot environment.' });
        continue;
      }
      // A declaration may only make things stricter. A device registered as simulated takes
      // commands without a LIVE mode, so a real adapter may not drive it.
      if (d.integration === 'simulated' && decl.integration !== 'simulated') {
        rejected.push({ deviceId: decl.deviceId, reason: 'Registered as a simulated device, but a real adapter declared it. Register it as a real device first.' });
        continue;
      }
      // Push mode: the server sets the browser address of a pushed stream (on its own media server).
      const declStream = this.pushedStream(decl.stream, d.id);
      const declComps = Array.isArray(decl.components)
        ? decl.components.map((c) => (c && typeof c === 'object' && c.stream ? { ...c, stream: this.pushedStream(c.stream, d.id) } : c))
        : decl.components;
      // Stream URLs must sit on an edge origin allowed for the device's site (SSRF guard).
      const allowed = this.edgeOriginsFor(orgId, d.siteId);
      const st = vetStream(declStream, allowed);
      const comps = sanitizeComponents(declComps, allowed);
      const refused = [...st.rejected, ...(comps?.rejected ?? [])];
      if (refused.length) this.audit(sys, 'gateway.stream_rejected', d.id, 'denied', `${refused.join('; ')}. Allow the origin under edge origins, then reconnect the gateway.`);
      if (decl.integration !== d.integration) notes.push(`${d.id} declared ${String(decl.integration).slice(0, 20)}, kept ${d.integration}`);
      const prevGateway = (this.db.prepare('SELECT gateway_id FROM devices WHERE id = ?').get(d.id) as { gateway_id: string | null } | undefined)?.gateway_id;
      // Everything except the integration status and the mode, which only people set.
      Object.assign(d, {
        model: decl.model,
        adapterVersion: decl.adapterVersion,
        firmwareTested: decl.firmwareTested,
        capabilities: decl.capabilities,
        commands: decl.commands,
        limitations: `${decl.limitations} Link loss: ${decl.linkLossBehavior}`,
        rateMs: decl.rateMs,
        view: decl.view ?? d.view,
        stream: st.stream,
        mount: sanitizeMount(decl.mount) ?? d.mount,
        catalogId: decl.catalogId && VEHICLE_CATALOG[decl.catalogId] ? decl.catalogId : d.catalogId,
        indoor: sanitizeIndoor(decl.indoor) ?? d.indoor,
        payloads: Array.isArray(decl.payloads) ? decl.payloads.filter((p) => typeof p === 'string' && PAYLOAD_CATALOG[p]) : d.payloads,
        components: comps?.components ?? d.components,
        teleop: d.kind === 'ugv' ? sanitizeTeleop(decl.teleop) : undefined,
      });
      d.mode = modeOf(d);
      this.db.prepare('UPDATE devices SET gateway_id = ? WHERE id = ?').run(gatewayId, d.id);
      this.lastSeq.delete(d.id); // a new connection may restart sequence numbers
      this.saveDevice(d);
      // The same gateway reconnecting keeps the mode; a different one is a new control path.
      if (prevGateway && prevGateway !== gatewayId) this.demoteBySystem(d.id, `control path changed: gateway ${prevGateway} → ${gatewayId}`);
      accepted.push(d.id);
      if (decl.stream?.push === true) {
        if (this.pushEnabled) media.push({ deviceId: d.id, publish: this.publishUrl(orgId, d.id, gatewayId) });
        else this.audit(sys, 'gateway.stream_rejected', d.id, 'denied', 'The gateway wants to push video, but this server has no media server for it (set MEDIA_INGEST_URL and MEDIA_PUBLIC_URL).');
      }
    }
    // Anything never delivered before this (re)connect is dropped, never replayed (F09).
    for (const id of accepted) this.expireUndelivered(id, 'Not delivered before the gateway reconnected. Not replayed.');
    // A (re)connected simulated UAV learns where to orbit.
    for (const id of accepted) {
      this.lastOverwatch.delete(id);
      const d = this.devices.get(id);
      if (d?.kind === 'uav') this.syncOverwatch(orgId, d.siteId);
    }
    this.audit(
      sys,
      'gateway.connect',
      gatewayId,
      'ok',
      `accepted ${accepted.join(', ') || 'none'}${rejected.length ? `; rejected ${rejected.map((r) => r.deviceId).join(', ')}` : ''}${notes.length ? `; ignored ${notes.join(', ')}` : ''}`,
    );
    return { accepted, rejected, media };
  }

  gatewayClosed(orgId: string, gatewayId: string) {
    const sys = this.systemActor(orgId, 'gateway', gatewayId);
    for (const id of [...this.driving.keys()]) {
      const holder = (this.db.prepare('SELECT gateway_id FROM devices WHERE id = ?').get(id) as { gateway_id: string | null } | undefined)?.gateway_id;
      if (holder === gatewayId) this.endDrive(id, sys, 'gateway disconnected');
    }
    this.audit(sys, 'gateway.disconnect', gatewayId);
  }

  // ---- live driving from the console --------------------------------------------------
  //
  // A vehicle in LIVE_MANUAL (simulators in SIMULATION) that declares `teleop` can be driven by the
  // operator who takes a drive session: it also takes control of the device (F08). Stick samples
  // come over the console WebSocket and go straight to the gateway, which caps them, turns them into
  // RC overrides and stops the vehicle when they stop coming. Start, stop and refusals are audited;
  // the samples themselves are not (ten a second).

  /** Opens a drive session: the caller holds control and may send stick samples. */
  startDriving(a: Actor, deviceId: string) {
    this.require(a, 'device.command', deviceId);
    const d = this.getDevice(a, deviceId);
    const deny = (status: number, code: string, why: string): never => {
      this.audit(a, 'drive.start', d.id, 'denied', why);
      return fail(status, code, why);
    };
    if (d.kind !== 'ugv' || !d.teleop) return deny(409, 'not_enabled', `${d.id} cannot be driven from the console (its gateway does not offer it).`);
    const mode = modeOf(d);
    if (mode !== 'LIVE_MANUAL' && mode !== 'SIMULATION')
      return deny(409, 'mode_locked', `${d.id} is in ${mode}. A supervisor must promote it to LIVE_MANUAL before anyone drives it.`);
    const fresh = freshnessAt(this.now(), d);
    if (fresh !== 'live') return deny(409, 'stale_telemetry', `${d.id} telemetry is ${fresh}. Drive only a vehicle reporting live data.`);
    const m = this.activeMission(d.id);
    if (m && ['assigned', 'executing', 'paused'].includes(m.status)) return deny(409, 'conflict', `${d.id} is on mission ${m.id}. Stop or finish it first.`);
    const cur = this.driving.get(d.id);
    if (cur && cur.userId !== a.userId) return deny(409, 'control_held', `${d.id} is being driven by ${this.userName(a.orgId, cur.userId)}.`);
    if (d.controlOwner && d.controlOwner !== a.userId) return deny(409, 'control_held', `Control of ${d.id} is held by ${this.userName(a.orgId, d.controlOwner)}. A handover is required.`);
    if (!cur) this.driving.set(d.id, { userId: a.userId!, orgId: d.orgId, since: this.now(), seq: -1, lastAt: 0, ownedBefore: d.controlOwner === a.userId });
    d.controlOwner = a.userId;
    d.drivenBy = a.userId;
    tx(this.db, () => {
      this.saveDevice(d);
      this.audit(a, 'drive.start', d.id, 'ok', `${mode} · limits throttle ${Math.round(d.teleop!.maxThrottle * 100)}% steer ${Math.round(d.teleop!.maxSteer * 100)}%`);
    });
    return this.publicDevice(d);
  }

  /** Ends a drive session: the driver, or a supervisor/administrator stopping someone else's. */
  stopDriving(a: Actor, deviceId: string) {
    const d = this.getDevice(a, deviceId);
    const cur = this.driving.get(d.id);
    if (!cur) return this.publicDevice(d);
    if (cur.userId !== a.userId && a.role !== 'supervisor' && a.role !== 'admin') fail(409, 'control_held', `${d.id} is being driven by ${this.userName(a.orgId, cur.userId)}.`);
    this.endDrive(d.id, a, cur.userId === a.userId ? 'driver stopped' : `stopped by ${a.name}`);
    return this.publicDevice(d);
  }

  /** One stick sample from the driver (WebSocket). False when it is not theirs to send or too soon. */
  drive(a: Actor, msg: { deviceId?: unknown; seq?: unknown; throttle?: unknown; steer?: unknown }): boolean {
    const id = String(msg.deviceId ?? '');
    const cur = this.driving.get(id);
    if (!cur || cur.userId !== a.userId || cur.orgId !== a.orgId) return false;
    const seq = Number(msg.seq);
    if (!Number.isInteger(seq) || seq <= cur.seq) return false;
    const now = this.now();
    if (now - cur.lastAt < DRIVE_MIN_INTERVAL_MS) return false;
    const clamp = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
    cur.seq = seq;
    cur.lastAt = now;
    return this.gateways.send(cur.orgId, id, { t: 'drive', deviceId: id, seq, throttle: clamp(msg.throttle), steer: clamp(msg.steer), at: now });
  }

  /** The driver's console went away: stop everything they were driving. */
  stopAllDriving(a: Actor, why: string) {
    for (const [id, cur] of [...this.driving]) if (cur.userId === a.userId && cur.orgId === a.orgId) this.endDrive(id, a, why);
  }

  private endDrive(deviceId: string, a: Actor, why: string) {
    const cur = this.driving.get(deviceId);
    if (!cur) return;
    this.driving.delete(deviceId);
    // Tell the gateway at once (it would also stop on its own when samples stop coming).
    this.gateways.send(cur.orgId, deviceId, { t: 'drive', deviceId, seq: cur.seq + 1, throttle: 0, steer: 0, at: this.now(), release: true });
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.drivenBy = undefined;
    const m = this.activeMission(deviceId);
    if (!cur.ownedBefore && !m && d.controlOwner === cur.userId) d.controlOwner = undefined;
    tx(this.db, () => {
      this.saveDevice(d);
      this.audit(a, 'drive.stop', d.id, 'ok', `${this.userName(cur.orgId, cur.userId)} · ${why}`);
    });
  }

  private expireUndelivered(deviceId: string, why: string) {
    const rows = this.db.prepare("SELECT org_id, site_id, data FROM commands WHERE device_id = ? AND status IN ('requested','authorized','sent')").all(deviceId) as {
      org_id: string;
      site_id: string;
      data: string;
    }[];
    for (const r of rows) {
      const c = JSON.parse(r.data) as Command;
      if (this.setCmd(c, 'timed_out', why)) this.saveCommand(r.org_id, r.site_id, c);
    }
  }

  telemetry(orgId: string, t: GwTelemetry) {
    const d = this.devices.get(t.deviceId);
    if (!d || d.orgId !== orgId) return;
    const last = this.lastSeq.get(d.id) ?? -1;
    if (t.seq <= last) return; // duplicate or out of order
    this.lastSeq.set(d.id, t.seq);
    const now = this.now();
    // A sample without a position (no GNSS fix) keeps the device alive but its position unknown.
    const pos = t.pos && Number.isFinite(t.pos.x) && Number.isFinite(t.pos.y) ? { x: t.pos.x, y: t.pos.y } : undefined;
    if (pos) {
      d.pos = pos;
      delete d.noFix;
    } else d.noFix = true;
    if (t.alt !== undefined) d.alt = t.alt;
    d.accuracyM = t.accuracyM;
    if (t.battery !== undefined) d.battery = t.battery;
    d.speed = t.speed;
    if (t.heading !== undefined) d.heading = t.heading;
    if (t.signal !== undefined) d.signal = t.signal;
    if (t.satellites !== undefined) d.satellites = t.satellites;
    if (d.indoor) d.floorPatrol = t.floorPatrol === true || undefined;
    if (t.temperatureC !== undefined) d.temperatureC = t.temperatureC;
    if (d.indoor && Number.isFinite(t.level)) d.indoor = { ...d.indoor, level: Math.round(t.level as number) };
    if (Array.isArray(t.components)) d.components = applyComponentUpdates(d.components, sanitizeComponentUpdates(t.components));
    if (t.gimbal && Number.isFinite(t.gimbal.yaw) && Number.isFinite(t.gimbal.pitch)) {
      const g = t.gimbal;
      const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
      d.gimbal = {
        yaw: +g.yaw,
        pitch: +g.pitch,
        roll: Number.isFinite(g.roll) ? g.roll : undefined,
        zoom: Number.isFinite(g.zoom) ? g.zoom : undefined,
        recording: bool(g.recording),
        spotlight: bool(g.spotlight),
        beacon: bool(g.beacon),
        announcing: typeof g.announcing === 'string' && g.announcing ? g.announcing.slice(0, 160) : undefined,
      };
    }
    // Source → received delay. Clamp at 0 in case the device clock runs slightly ahead.
    d.latencyMs = Math.max(0, now - t.sourceTime);
    d.lastSeen = now;
    if (pos && (d.kind === 'ugv' || d.kind === 'uav')) {
      this.trackStats(d, now);
      this.trackFences(d, now);
    }
    this.devices.set(d.id, d);
    this.db.prepare('UPDATE devices SET data = ? WHERE id = ?').run(JSON.stringify(this.publicDevice(d)), d.id);
    // Position history: only samples that have a position (a replay must not show a guessed one).
    if (pos)
      this.db
      .prepare(
        'INSERT INTO telemetry (device_id, seq, source_time, received_time, x, y, alt, accuracy, battery, speed, quality, heading, signal, satellites, temperature) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        d.id,
        t.seq,
        t.sourceTime,
        now,
        pos.x,
        pos.y,
        t.alt ?? null,
        t.accuracyM,
        t.battery ?? null,
        t.speed,
        t.quality,
        t.heading ?? null,
        t.signal ?? null,
        t.satellites ?? null,
        t.temperatureC ?? null,
      );
    if (t.nextCp !== undefined) {
      const m = this.activeMission(d.id);
      if (m && m.nextCp !== t.nextCp && ['executing', 'paused'].includes(m.status)) {
        m.nextCp = t.nextCp;
        this.saveMission(d.orgId, d.siteId, m);
      }
    }
    this.publish({
      orgId,
      siteId: d.siteId,
      event: {
        type: 'telemetry',
        deviceId: d.id,
        at: t.sourceTime,
        pos: d.pos,
        alt: d.alt,
        battery: d.battery,
        speed: d.speed,
        accuracyM: d.accuracyM,
        lastSeen: now,
        heading: d.heading,
        signal: d.signal,
        latencyMs: d.latencyMs,
        satellites: d.satellites,
        temperatureC: d.temperatureC,
        gimbal: d.gimbal,
        stats: d.stats,
        noFix: d.noFix,
        ...(Array.isArray(t.components) && t.components.length ? { components: d.components } : {}),
      },
    });
  }

  // ---- camera control (gimbal, zoom, photo, record) -------------------------

  /**
   * Sends a camera action to the device's gateway and waits for the answer. Camera control
   * never moves a vehicle, so it needs no mission approval, but it is permission-checked and
   * audited, and on a vehicle only the operator holding control may use it.
   */
  async cameraControl(a: Actor, deviceId: string, raw: unknown): Promise<CameraResult> {
    const action = sanitizeCameraAction(raw);
    if (!action) {
      this.require(a, 'camera.control', deviceId);
      return fail(400, 'invalid', 'Unknown or malformed camera action.');
    }
    const d = this.checkCameraControl(a, deviceId, action);
    if (a.kind === 'user') this.manualCamera.set(d.id, this.now());
    const result = await this.sendCamera(d, action);
    // Speed commands come in pairs (press, release); audit both so the record shows the full move.
    this.audit(
      a,
      isPayloadAction(action) ? 'payload.control' : 'camera.control',
      d.id,
      result.ok ? 'ok' : 'error',
      `${describeCameraAction(action)} — ${result.detail}${result.ok && !result.confirmed ? ' (not confirmed)' : ''}`,
    );
    return result;
  }

  /** Permission, gimbal, control holder and freshness checks shared by all camera requests. */
  private checkCameraControl(a: Actor, deviceId: string, action?: CameraAction) {
    this.require(a, action && isPayloadAction(action) ? 'payload.control' : 'camera.control', deviceId);
    const d = this.getDevice(a, deviceId);
    const need = action ? actionCapability(action) : 'gimbal';
    if (!d.capabilities.includes(need)) {
      const what: Record<string, string> = {
        gimbal: 'gimbal camera',
        spotlight: 'searchlight',
        beacon: 'warning light',
        speaker: 'loudspeaker',
        zoom: 'zoom',
        photo: 'photo function',
        record: 'recording',
      };
      return fail(400, 'invalid', `${d.id} has no ${what[need] ?? need}.`);
    }
    if (d.kind !== 'cctv' && d.controlOwner && d.controlOwner !== a.userId && a.role !== 'system') {
      this.audit(a, 'camera.control', d.id, 'denied', 'another operator holds control');
      return fail(409, 'not_control_owner', `Another operator holds control of ${d.id}. Ask them to hand over control.`);
    }
    // Moving the camera or switching an actuator on needs a LIVE mode; stops, lights off, photo and record do not.
    const mode = modeOf(d);
    const by = a.kind === 'system' ? 'automation' : 'person';
    if ((action ? cameraActionMoves(action) : true) && !modeAllowsMotion(mode, by)) {
      this.audit(a, action && isPayloadAction(action) ? 'payload.control' : 'camera.control', d.id, 'denied', `${action ? describeCameraAction(action) : 'point at a place'}: mode ${mode}`);
      return fail(409, 'mode_not_live', `${d.id} is in ${mode} mode. Camera moves need LIVE_MANUAL; a supervisor promotes the device.`);
    }
    if (freshnessAt(this.now(), d) === 'offline') return fail(409, 'device_offline', `${d.id} is offline. Camera control is unavailable.`);
    return d;
  }

  /** One request to the camera through its gateway; resolves with the camera's answer or a timeout. */
  private sendCamera(d: Device & { orgId: string }, action: CameraAction) {
    const requestId = `cam-${randomUUID()}`;
    return new Promise<CameraResult>((resolve) => {
      const timer = setTimeout(() => finish({ ok: false, confirmed: false, detail: 'No answer from the gateway. The camera may not have moved.' }), CAMERA_REPLY_TIMEOUT_MS);
      const finish = (r: CameraResult) => {
        clearTimeout(timer);
        this.cameraWaits.delete(requestId);
        resolve(r);
      };
      this.cameraWaits.set(requestId, { orgId: d.orgId, deviceId: d.id, done: finish });
      const msg = { t: 'camera', requestId, deviceId: d.id, ...action } as SrvCamera;
      if (!this.gateways.send(d.orgId, d.id, msg)) finish({ ok: false, confirmed: false, detail: `${d.id} gateway is not connected. Command not sent.` });
    });
  }

  /**
   * Points a gimbal camera at a place on the site grid: turns it and zooms to frame about 8 m of
   * scene. Fixed cameras use their configured mount; vehicle cameras the vehicle's heading.
   */
  async aimCamera(a: Actor, deviceId: string, input: { x?: unknown; y?: unknown; incidentId?: unknown }): Promise<CameraResult & { aim?: Aim; lineOfSight?: boolean }> {
    let target: Point;
    let label: string;
    if (typeof input.incidentId === 'string' && input.incidentId) {
      const inc = this.getIncident(a, input.incidentId);
      target = inc.pos;
      label = inc.id;
    } else {
      const x = Number(input.x);
      const y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return fail(400, 'invalid', 'Give a site position {x, y} or an incidentId.');
      target = { x, y };
      label = `${x.toFixed(0)}, ${y.toFixed(0)} m`;
    }
    const d = this.checkCameraControl(a, deviceId);
    const mount = mountOf(d);
    if (!mount) return fail(400, 'invalid', `${d.id} has no mounting data, so it cannot be pointed at a place. Add "mount" to its adapter config.`);
    const aim = aimAt(d.pos, mount, target);
    if (!aim.reachable) return fail(409, 'out_of_reach', `${d.id} cannot turn that far (needs ${aim.yaw.toFixed(0)}°, limit ±135°).`);
    if (a.kind === 'user') this.manualCamera.set(d.id, this.now());
    const r = await this.aimSend(d, aim);
    const los = lineOfSight(d.pos, target, this.buildingsOf(d.siteId), mount.heightM);
    this.audit(a, 'camera.control', d.id, r.ok ? 'ok' : 'error', `point at ${label} (yaw ${aim.yaw}°, pitch ${aim.pitch}°, ${aim.zoom}×, ${aim.distanceM} m) — ${r.detail}`);
    return { ...r, detail: los ? r.detail : `${r.detail} A building may block the view.`, aim, lineOfSight: los };
  }

  private async aimSend(d: Device & { orgId: string }, aim: Aim): Promise<CameraResult> {
    const turn = await this.sendCamera(d, { action: 'gimbal_angle', yaw: aim.yaw, pitch: aim.pitch });
    if (!turn.ok) return turn;
    const zoom = d.capabilities.includes('zoom') ? await this.sendCamera(d, { action: 'zoom_to', level: aim.zoom }) : { ok: true, confirmed: true, detail: '' };
    const confirmed = turn.confirmed && zoom.confirmed;
    return { ok: zoom.ok, confirmed, detail: confirmed ? `Pointed at the target, ${aim.zoom}× zoom.` : zoom.ok ? 'Sent. The camera did not confirm every step.' : zoom.detail };
  }

  private buildingsOf(siteId: string): Building[] {
    const r = this.db.prepare('SELECT geometry FROM sites WHERE id = ?').get(siteId) as { geometry: string } | undefined;
    try {
      return (r ? (JSON.parse(r.geometry) as SiteGeometry).buildings : []) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * New alert with a known position: turn the nearest fixed gimbal camera that can see it, unless
   * an operator used that camera in the last minute (manual control wins). Logged on the timeline.
   */
  private async autoAim(orgId: string, siteId: string, inc: Incident) {
    const now = this.now();
    const devices = [...this.devices.values()].filter((d) => d.orgId === orgId && d.siteId === siteId);
    const busy = (id: string) => now - (this.manualCamera.get(id) ?? 0) < MANUAL_CAMERA_HOLD_MS;
    // Auto-aim is automation: only simulated cameras or LIVE_ASSISTED ones are turned.
    const pick = pickCamera(devices, inc.pos, this.buildingsOf(siteId), (d) => freshnessAt(now, d) !== 'offline' && modeAllowsMotion(modeOf(d), 'automation'), busy);
    if (!pick) return;
    const d = this.devices.get(pick.device.id)!;
    const r = await this.aimSend(d, pick.aim);
    const sys = this.systemActor(orgId, 'system', 'Auto camera');
    this.audit(sys, 'camera.control', d.id, r.ok ? 'ok' : 'error', `auto-point at ${inc.id} (yaw ${pick.aim.yaw}°, pitch ${pick.aim.pitch}°, ${pick.aim.zoom}×) — ${r.detail}`);
    if (!inc.cameraId && r.ok) {
      inc.cameraId = d.id;
      this.saveIncident(orgId, siteId, inc);
    }
    this.event(null, orgId, siteId, inc.id, r.ok ? `${d.id} turned to the alert automatically` : `${d.id} could not be turned to the alert`, {
      actor: 'Auto camera',
      tone: r.ok ? undefined : 'warn',
      detail: r.ok
        ? `${pick.aim.distanceM} m away, ${pick.aim.zoom}× zoom. ${r.confirmed ? 'Confirmed by the camera.' : 'Not confirmed by the camera.'} Operators can take over at any time.`
        : r.detail,
    });
  }

  /** Answer from a gateway. Ignored unless it matches an open request from the same org and device. */
  cameraResult(orgId: string, r: GwCameraResult) {
    const w = this.cameraWaits.get(String(r.requestId));
    if (!w || w.orgId !== orgId || w.deviceId !== r.deviceId) return;
    w.done({ ok: !!r.ok, confirmed: !!r.ok && !!r.confirmed, detail: String(r.detail ?? (r.ok ? 'Done.' : 'Failed.')).slice(0, 200) });
  }

  commandUpdate(orgId: string, u: GwCommandUpdate) {
    const found = this.findCommand(u.commandId);
    if (!found || found.orgId !== orgId) return;
    const { c, siteId } = found;
    if (isTerminalCommand(c.status)) return;
    if (u.status === 'acknowledged') c.delivered = true;
    // Gateways may skip intermediate states; walk forward through them.
    const path: CommandStatus[] = u.status === 'succeeded' ? ['acknowledged', 'executing', 'succeeded'] : u.status === 'executing' ? ['acknowledged', 'executing'] : [u.status];
    let moved = false;
    for (const s of path) if (c.status !== s && this.setCmd(c, s, s === u.status ? u.detail : undefined)) moved = true;
    if (!moved) return;
    tx(this.db, () => {
      if (u.status === 'succeeded') this.applyCommand(c, orgId, siteId);
      if (u.status === 'rejected' || u.status === 'failed') {
        const mm = this.missionById(c.missionId);
        if (mm) this.event(null, orgId, siteId, mm.m.incidentId, `${c.type.toUpperCase()} ${u.status} by device`, { actor: c.deviceId, tone: 'warn', detail: u.detail });
      }
      this.saveCommand(orgId, siteId, c);
    });
  }

  deviceEvent(orgId: string, e: GwDeviceEvent) {
    const d = this.devices.get(e.deviceId);
    if (!d || d.orgId !== orgId) return;
    if (e.kind === 'detection') {
      if (!e.detection) return;
      try {
        // The camera speaks for itself: a system actor named after the device raises the detection.
        this.ingestDetection(this.systemActor(orgId, 'system', d.id), { ...e.detection, deviceId: d.id, at: e.at, source: e.detection.source ?? `${d.id} analytics` });
      } catch (err) {
        console.error('[detection]', d.id, err instanceof Error ? err.message : err);
      }
      return;
    }
    if (e.kind === 'analytics') {
      if (!e.analytics || typeof e.analytics !== 'object') return;
      const a = e.analytics;
      d.analytics = {
        provider: String(a.provider ?? 'edge-vision').slice(0, 40),
        running: !!a.running,
        source: a.source ? String(a.source).slice(0, 20) : undefined,
        fps: Number.isFinite(a.fps) ? Math.round(Number(a.fps) * 100) / 100 : undefined,
        frames: Number.isFinite(a.frames) ? Number(a.frames) : undefined,
        lastFrameAt: Number.isFinite(a.lastFrameAt) ? Number(a.lastFrameAt) : undefined,
        detections: Number.isFinite(a.detections) ? Number(a.detections) : undefined,
        lastDetectionAt: Number.isFinite(a.lastDetectionAt) ? Number(a.lastDetectionAt) : undefined,
        detectors: a.detectors && typeof a.detectors === 'object' ? JSON.parse(JSON.stringify(a.detectors).slice(0, 4000)) : undefined,
        model: a.model ? String(a.model).slice(0, 120) : undefined,
        errors: Number.isFinite(a.errors) ? Number(a.errors) : undefined,
        lastError: a.lastError ? String(a.lastError).slice(0, 200) : undefined,
        updatedAt: e.at,
      };
      this.saveDevice(d);
      return;
    }
    const m = this.activeMission(d.id);
    tx(this.db, () => {
      switch (e.kind) {
        case 'route_complete':
          // Events can overtake the start confirmation (e.g. vehicle already at the target):
          // a finished route proves the start command ran.
          if (m && m.status === 'assigned') {
            for (const r of this.db.prepare("SELECT org_id, site_id, data FROM commands WHERE mission_id = ? AND status IN ('sent','acknowledged','executing')").all(m.id) as {
              org_id: string;
              site_id: string;
              data: string;
            }[]) {
              const c = JSON.parse(r.data) as Command;
              if (c.type !== 'start') continue;
              c.delivered = true;
              for (const s of ['acknowledged', 'executing', 'succeeded'] as CommandStatus[]) if (c.status !== s) this.setCmd(c, s);
              this.applyCommand(c, r.org_id, r.site_id);
              this.saveCommand(r.org_id, r.site_id, c);
              Object.assign(m, this.missionById(m.id)!.m);
            }
          }
          if (m && m.status === 'executing') {
            m.status = 'completed';
            m.nextCp = m.checkpoints.length;
            this.saveMission(orgId, d.siteId, m);
            this.event(null, orgId, d.siteId, m.incidentId, `${d.id} reached final checkpoint`, {
              actor: d.id,
              tone: 'ok',
              at: e.at,
              detail: 'Arrival confirmed by vehicle telemetry.',
            });
            this.onMissionCompleted(orgId, d.siteId, m, e.at);
          }
          break;
        case 'checkpoint':
          if (m) this.event(null, orgId, d.siteId, m.incidentId, `${d.id} passed checkpoint ${(e.checkpoint ?? 0) + 1}`, { actor: d.id, at: e.at });
          break;
        case 'failsafe_stop':
          if (m && (m.status === 'executing' || m.status === 'paused')) {
            m.status = 'paused';
            m.note = 'Vehicle stopped by link-loss failsafe. Operator must resume.';
            this.saveMission(orgId, d.siteId, m);
            this.event(null, orgId, d.siteId, m.incidentId, `${d.id} reconnected — stopped by link-loss failsafe`, {
              actor: d.id,
              tone: 'warn',
              at: e.at,
              detail: 'No queued commands were replayed. Mission paused until the operator resumes.',
            });
          }
          break;
        case 'fault':
          if (m) this.event(null, orgId, d.siteId, m.incidentId, `${d.id} fault`, { actor: d.id, tone: 'warn', at: e.at, detail: e.detail });
          break;
        case 'snapshot': {
          const incidentId = m?.incidentId ?? this.lastMissionIncident(d.id) ?? this.lastCameraIncident(orgId, d.id);
          if (incidentId && e.frame)
            this.storeEvidence(orgId, d.siteId, incidentId, {
              kind: 'snapshot',
              title: `${d.id} onboard camera`,
              source: d.id,
              recordedBy: d.id,
              capturedAt: e.at,
              mime: e.frame.mime,
              bytes: Buffer.from(e.frame.base64, 'base64'),
              simulated: d.integration === 'simulated',
            });
          break;
        }
      }
    });
  }

  private lastMissionIncident(deviceId: string) {
    const r = this.db.prepare('SELECT incident_id FROM missions WHERE device_id = ? ORDER BY rowid DESC LIMIT 1').get(deviceId) as { incident_id: string } | undefined;
    return r?.incident_id;
  }

  /** The newest open incident a fixed camera is attached to (for its photos and detections). */
  private lastCameraIncident(orgId: string, deviceId: string) {
    const r = this.db
      .prepare(
        "SELECT id FROM incidents WHERE org_id = ? AND json_extract(data, '$.cameraId') = ? AND status NOT IN ('closed', 'dismissed', 'duplicate') ORDER BY json_extract(data, '$.createdAt') DESC LIMIT 1",
      )
      .get(orgId, deviceId) as { id: string } | undefined;
    return r?.id;
  }

  // ---- AI / sensor detections ------------------------------------------------

  /**
   * A detection from video analytics, a thermal camera or an NVR. The organisation's rules decide:
   * raise an incident (with the frame as evidence), join the open incident from the same camera,
   * log it for the record, or ignore it. Every detection is stored; the console sees incidents.
   */
  ingestDetection(a: Actor, raw: unknown): Detection {
    this.require(a, 'incident.create', 'detection');
    const now = this.now();
    let input: ReturnType<typeof sanitizeDetection>;
    try {
      input = sanitizeDetection(raw, now);
    } catch (e) {
      return fail(400, 'invalid', (e as Error).message);
    }
    if (input.externalId) {
      const seen = this.db.prepare('SELECT data FROM detections WHERE org_id = ? AND external_id = ?').get(a.orgId, input.externalId) as { data: string } | undefined;
      if (seen) return { ...(JSON.parse(seen.data) as Detection), outcome: 'duplicate' };
    }
    const d = input.deviceId ? this.devices.get(input.deviceId) : undefined;
    if (input.deviceId && (!d || d.orgId !== a.orgId || !this.inScope(a, a.orgId, d.siteId))) fail(404, 'not_found', `Device ${input.deviceId} not found.`);
    const siteId = d?.siteId ?? this.defaultSite(a);
    const settings = getOrgSettings(this.db, a.orgId);
    const source = input.source ?? (a.kind === 'apikey' ? a.name : (d?.id ?? 'Analytics'));
    const det: Detection = {
      id: `${this.prefix(a.orgId)}DET-${String(nextNumber(this.db, a.orgId, 'detection', 1)).padStart(5, '0')}`,
      at: input.at,
      receivedAt: now,
      type: input.type,
      confidence: input.confidence,
      source,
      deviceId: d?.id,
      zone: input.zone ?? d?.zone,
      place: input.place ?? (d ? `${d.id} view` : undefined),
      pos: input.pos ?? d?.pos,
      attributes: input.attributes,
      outcome: 'logged',
    };
    const rule = matchRule(
      settings.detection.rules,
      { type: det.type, confidence: det.confidence, zone: det.zone, at: det.at, attributes: det.attributes },
      settings.detection.timezone,
    );
    det.ruleId = rule?.id;
    const simulated = d?.integration === 'simulated' || /simulat/i.test(source);
    if (rule?.action === 'ignore') det.outcome = 'ignored';
    else if (rule?.action === 'incident') {
      const title = detectionTitle(det);
      const detail = detectionDetail({ ...det, bbox: input.bbox });
      const open = rule.cooldownS > 0 ? this.openDetectionIncident(a.orgId, d?.id, det.type, now - rule.cooldownS * 1000) : undefined;
      if (open) {
        det.outcome = 'merged';
        det.incidentId = open.id;
        this.event(null, a.orgId, siteId, open.id, `${title} again`, { actor: source, tone: 'alert', at: det.at, detail });
        this.audit(a, 'detection.merge', det.id, 'ok', `${det.type} ${Math.round(det.confidence * 100)}% → ${open.id}`);
      } else {
        const inc = this.createIncident(
          { ...a, name: source },
          {
            siteId,
            title: `${title}${d ? ` · ${d.id}` : ''}`,
            type: `Detection: ${detectionLabel(det)}`,
            severity: rule.severity,
            zone: det.zone,
            place: det.place,
            pos: det.pos,
            source: `${source}${simulated ? ' (simulated)' : ''}`,
            cameraId: d?.kind === 'cctv' ? d.id : undefined,
            at: det.at,
            noAutoAim: !input.pos,
          },
        );
        det.outcome = 'incident';
        det.incidentId = inc.id;
        this.event(null, a.orgId, siteId, inc.id, 'Detection details', { actor: source, at: det.at, detail });
        this.notify(a.orgId, {
          event: 'detection.incident',
          title: `${inc.id} ${title}`,
          text: detail,
          severity: rule.severity,
          incidentId: inc.id,
          data: { type: det.type, confidence: det.confidence, deviceId: det.deviceId },
        });
      }
      if (input.snapshot && det.incidentId) {
        const ev = this.storeEvidence(a.orgId, siteId, det.incidentId, {
          kind: 'snapshot',
          title: `${source}: ${title}`,
          source,
          recordedBy: source,
          capturedAt: det.at,
          mime: input.snapshot.mime,
          bytes: Buffer.from(input.snapshot.base64, 'base64'),
          simulated,
        });
        det.snapshotEvidenceId = ev.id;
      }
    }
    if (input.bbox) det.bbox = input.bbox;
    this.db
      .prepare(
        'INSERT INTO detections (id, org_id, site_id, at, received_at, device_id, type, confidence, outcome, incident_id, rule_id, external_id, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        det.id,
        a.orgId,
        siteId,
        det.at,
        det.receivedAt,
        det.deviceId ?? null,
        det.type,
        det.confidence,
        det.outcome,
        det.incidentId ?? null,
        det.ruleId ?? null,
        input.externalId ?? null,
        JSON.stringify(det),
      );
    this.publish({ orgId: a.orgId, siteId, event: { type: 'detection', detection: det } });
    this.bus.emit('detection', { orgId: a.orgId, detection: det });
    return det;
  }

  /** The open incident a recent detection of this type from this device raised (cooldown window). */
  private openDetectionIncident(orgId: string, deviceId: string | undefined, type: Detection['type'], since: number) {
    const rows = this.db
      .prepare(
        "SELECT incident_id FROM detections WHERE org_id = ? AND device_id IS ? AND type = ? AND at >= ? AND outcome IN ('incident', 'merged') AND incident_id IS NOT NULL ORDER BY at DESC LIMIT 5",
      )
      .all(orgId, deviceId ?? null, type, since) as { incident_id: string }[];
    for (const r of rows) {
      const inc = this.db.prepare("SELECT data FROM incidents WHERE id = ? AND status NOT IN ('closed', 'dismissed', 'duplicate')").get(r.incident_id) as
        | { data: string }
        | undefined;
      if (inc) return JSON.parse(inc.data) as Incident;
    }
    return undefined;
  }

  listDetections(a: Actor, q: { from?: number; to?: number; deviceId?: string; type?: string; outcome?: string; limit?: number }): Detection[] {
    this.require(a, 'report.view', 'detections', { mutating: false });
    const to = q.to ?? this.now();
    const from = q.from ?? to - 24 * 3600_000;
    const limit = Math.min(1000, Math.max(1, q.limit ?? 200));
    const where = ['org_id = ?', 'at BETWEEN ? AND ?'];
    const params: unknown[] = [a.orgId, from, to];
    if (a.siteIds.length) {
      where.push(`site_id IN (${a.siteIds.map(() => '?').join(',')})`);
      params.push(...a.siteIds);
    }
    if (q.deviceId) {
      where.push('device_id = ?');
      params.push(q.deviceId);
    }
    if (q.type) {
      where.push('type = ?');
      params.push(q.type);
    }
    if (q.outcome) {
      where.push('outcome = ?');
      params.push(q.outcome);
    }
    const rows = this.db.prepare(`SELECT data FROM detections WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`).all(...(params as string[]), limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Detection);
  }

  /** Detection counts by type and outcome for the KPI views. */
  detectionStats(a: Actor, from: number, to: number) {
    this.require(a, 'report.view', 'detections', { mutating: false });
    return this.db
      .prepare(`SELECT type, outcome, COUNT(*) AS n FROM detections WHERE org_id = ? AND at BETWEEN ? AND ?${this.siteClause(a)} GROUP BY type, outcome ORDER BY n DESC`)
      .all(a.orgId, from, to, ...a.siteIds) as { type: Detection['type']; outcome: DetectionOutcome; n: number }[];
  }

  // ---- timers -------------------------------------------------------------

  sweep() {
    const now = this.now();
    const rows = this.db.prepare("SELECT org_id, site_id, data FROM commands WHERE status IN ('requested','authorized','sent','acknowledged','executing')").all() as {
      org_id: string;
      site_id: string;
      data: string;
    }[];
    for (const r of rows) {
      const c = JSON.parse(r.data) as Command;
      const age = now - c.issuedAt;
      const d = this.devices.get(c.deviceId);
      let changed = false;
      if ((c.status === 'authorized' || c.status === 'sent' || c.status === 'requested') && (age >= COMMAND_ACK_TIMEOUT_MS || now > c.expiresAt)) {
        changed = this.setCmd(
          c,
          'timed_out',
          c.status === 'authorized'
            ? 'Edge gateway not connected. Command was not delivered.'
            : 'No acknowledgement from the device. Result unknown — check with the field operator.',
        );
      } else if ((c.status === 'acknowledged' || c.status === 'executing') && ((d && freshnessAt(now, d) !== 'live' && age >= COMMAND_ACK_TIMEOUT_MS + 1000) || age > 60_000)) {
        changed = this.setCmd(c, 'unknown', 'Device stopped reporting before confirming. Outcome unknown.');
      }
      if (changed) {
        tx(this.db, () => {
          this.saveCommand(r.org_id, r.site_id, c);
          const mm = this.missionById(c.missionId);
          if (mm)
            this.event(null, r.org_id, r.site_id, mm.m.incidentId, `${c.type.toUpperCase()} request ${c.status === 'unknown' ? 'outcome unknown' : 'timed out'}`, {
              actor: 'Platform',
              tone: 'warn',
              detail: c.detail,
            });
        });
      }
    }
    for (const d of this.devices.values()) {
      const f = freshnessAt(now, d);
      const before = this.lastFresh.get(d.id);
      this.lastFresh.set(d.id, f);
      // A driver who cannot see live data must not keep driving.
      if (f !== 'live' && this.driving.has(d.id)) this.endDrive(d.id, this.systemActor(d.orgId, 'system', 'Safety stop'), `telemetry ${f}`);
      if (before === undefined || before === f) continue;
      this.publish({ orgId: d.orgId, siteId: d.siteId, event: { type: 'device', device: this.publicDevice(d) } });
      if (f === 'offline')
        this.notify(d.orgId, {
          event: 'device.offline',
          title: `${d.id} offline`,
          text: `${d.model} · last seen ${fmtTime(d.lastSeen, true)} · ${d.zone}`,
          data: { deviceId: d.id, kind: d.kind },
        });
      const m = this.activeMission(d.id);
      if (m && ['executing', 'paused', 'assigned'].includes(m.status)) {
        this.event(null, d.orgId, d.siteId, m.incidentId, f === 'live' ? `${d.id} telemetry restored` : `${d.id} telemetry ${f}`, {
          actor: 'Platform',
          tone: f === 'live' ? 'ok' : 'warn',
          detail: f === 'live' ? undefined : 'Position uncertain. New start/resume commands are held.',
        });
      }
    }
  }

  // ---- evidence -----------------------------------------------------------

  private evidenceDir(orgId: string) {
    const dir = join(this.cfg.dataDir, 'evidence', orgId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  storeEvidence(
    orgId: string,
    siteId: string,
    incidentId: string,
    x: {
      kind: Evidence['kind'];
      title: string;
      source: string;
      recordedBy: string;
      capturedAt: number;
      mime?: string;
      bytes?: Buffer;
      text?: string;
      simulated: boolean;
      idempotencyKey?: string;
      retentionClass?: string;
    },
  ) {
    const id = `${this.prefix(orgId)}EV-${String(nextNumber(this.db, orgId, 'evidence', 102)).padStart(4, '0')}`;
    const body = x.bytes ?? Buffer.from(x.text ?? x.title, 'utf8');
    const checksum = sha256(body);
    let path: string | null = null;
    if (x.bytes) {
      const ext =
        (x.mime ?? 'application/octet-stream')
          .split('/')[1]
          ?.replace('svg+xml', 'svg')
          .replace(/[^a-z0-9]/g, '') || 'bin';
      path = join('evidence', orgId, `${id}.${ext}`);
      this.evidenceDir(orgId);
      writeFileSync(join(this.cfg.dataDir, path), x.bytes);
    }
    const ev: Evidence = {
      id,
      incidentId,
      kind: x.kind,
      title: x.title.slice(0, 200),
      source: x.source,
      capturedAt: x.capturedAt,
      receivedAt: this.now(),
      recordedBy: x.recordedBy,
      checksum,
      simulated: x.simulated,
      mime: x.mime ?? (x.bytes ? 'application/octet-stream' : 'text/plain'),
      size: body.length,
      retentionClass: x.retentionClass ?? 'standard',
    };
    this.db
      .prepare('INSERT INTO evidence (id, org_id, incident_id, sha256, path, idempotency_key, data) VALUES (?,?,?,?,?,?,?)')
      .run(id, orgId, incidentId, checksum, path, x.idempotencyKey ?? null, JSON.stringify(ev));
    const what = { note: 'Note', snapshot: 'Snapshot', photo: 'Photo', clip: 'Video clip', file: 'File' }[x.kind];
    this.event(null, orgId, siteId, incidentId, `${what} attached`, { actor: x.recordedBy, detail: x.kind === 'note' ? x.text : ev.title });
    this.publish({ orgId, siteId, incidentId, event: { type: 'evidence', evidence: ev } });
    return ev;
  }

  addEvidence(
    a: Actor,
    incidentId: string,
    input: { kind?: 'note' | 'photo' | 'file'; title?: string; text?: string; mime?: string; contentBase64?: string; capturedAt?: number; idempotencyKey?: string },
  ) {
    this.require(a, 'evidence.add', incidentId);
    const inc = this.getIncident(a, incidentId);
    if (input.idempotencyKey) {
      const seen = this.db.prepare('SELECT data FROM evidence WHERE org_id = ? AND idempotency_key = ?').get(a.orgId, input.idempotencyKey) as { data: string } | undefined;
      if (seen) return JSON.parse(seen.data) as Evidence; // re-upload from a flaky phone link
    }
    const kind = input.kind ?? (input.contentBase64 ? 'photo' : 'note');
    let bytes: Buffer | undefined;
    if (input.contentBase64) {
      bytes = Buffer.from(input.contentBase64, 'base64');
      if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) fail(400, 'invalid', 'File must be between 1 byte and 8 MB.');
      if (!/^(image\/(jpeg|png|webp|svg\+xml)|application\/pdf|text\/plain|video\/mp4)$/.test(input.mime ?? '')) fail(400, 'invalid', 'File type not allowed.');
    } else if (!input.text?.trim()) fail(400, 'invalid', 'Add a note or a file.');
    let ev!: Evidence;
    tx(this.db, () => {
      ev = this.storeEvidence(a.orgId, inc.siteId, incidentId, {
        kind,
        title: input.title?.trim() || (kind === 'note' ? input.text!.trim().slice(0, 200) : 'Attachment'),
        text: input.text?.trim(),
        source: a.role === 'responder' ? 'Field responder' : 'Operator',
        recordedBy: a.name,
        capturedAt: input.capturedAt ?? this.now(),
        mime: input.mime,
        bytes,
        simulated: false,
        idempotencyKey: input.idempotencyKey,
      });
      this.audit(a, 'evidence.add', incidentId, 'ok', ev.id);
    });
    return ev;
  }

  private evidenceFor(a: Actor, incidentIds: Set<string>): Evidence[] {
    const rows = this.db.prepare('SELECT data FROM evidence WHERE org_id = ?').all(a.orgId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Evidence).filter((e) => incidentIds.has(e.incidentId));
  }

  listEvidence(a: Actor, incidentId: string): Evidence[] {
    this.require(a, 'evidence.view', incidentId, { mutating: false });
    this.getIncident(a, incidentId);
    const merged = this.listIncidents({ ...a, role: a.role === 'responder' ? 'dispatcher' : a.role }, {})
      .filter((i) => i.duplicateOf === incidentId)
      .map((i) => i.id);
    return this.evidenceFor(a, new Set([incidentId, ...merged]));
  }

  /** Returns file bytes for viewing or exporting. Both are permission-checked and audited. */
  evidenceContent(a: Actor, id: string, exportFile: boolean) {
    this.require(a, exportFile ? 'evidence.export' : 'evidence.view', id, { mutating: false });
    const r = this.db.prepare('SELECT org_id, incident_id, path, data FROM evidence WHERE id = ?').get(id) as
      | { org_id: string; incident_id: string; path: string | null; data: string }
      | undefined;
    if (!r || r.org_id !== a.orgId) return fail(404, 'not_found', 'Evidence not found.');
    this.getIncident(a, r.incident_id);
    const ev = JSON.parse(r.data) as Evidence;
    const bytes = r.path ? readFileSync(join(this.cfg.dataDir, r.path)) : Buffer.from(ev.title, 'utf8');
    const intact = sha256(bytes) === ev.checksum;
    this.audit(a, exportFile ? 'evidence.export' : 'evidence.view', id, 'ok', intact ? 'checksum ok' : 'CHECKSUM MISMATCH');
    return { ev, bytes, intact };
  }

  // ---- reports ------------------------------------------------------------

  report(a: Actor, incidentId: string, exportFile: boolean) {
    this.require(a, exportFile ? 'evidence.export' : 'report.view', incidentId, { mutating: false });
    const inc = this.getIncident(a, incidentId);
    const missions = this.missionsFor(incidentId);
    const cmds = missions.flatMap((m) => this.listCommands(a, m.id));
    const events = (this.db.prepare('SELECT data FROM timeline WHERE incident_id = ? AND org_id = ? ORDER BY at').all(incidentId, a.orgId) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as TimelineEvent,
    );
    const files = this.listEvidence({ ...a, role: a.role === 'auditor' || a.role === 'supervisor' ? a.role : 'dispatcher' }, incidentId);
    const name = (id?: string) => this.userName(a.orgId, id);
    const meta = this.meta(a.orgId);
    const lines = [
      `# Incident report ${inc.id} — ${inc.title}`,
      '',
      meta.dataLabel !== 'LIVE'
        ? `> ${meta.dataLabel} DATA — generated by the 13STORE Public Security Twin (${this.cfg.env} environment). Not an operational record.`
        : `> Generated by the 13STORE Public Security Twin.`,
      '',
      `- Report generated: ${fmtDate(this.now())} ${fmtTime(this.now(), true)} (Asia/Bangkok) by ${a.name}`,
      `- Zone / place: ${inc.zone} · ${inc.place}`,
      `- Type / severity: ${inc.type} · ${inc.severity}`,
      `- Status: ${inc.status}${inc.duplicateOf ? ` (duplicate of ${inc.duplicateOf})` : ''}`,
      `- Source: ${inc.source}`,
      `- Received: ${fmtDate(inc.createdAt)} ${fmtTime(inc.createdAt, true)}`,
      `- Owner: ${inc.owner ?? '—'}`,
      `- Outcome: ${inc.outcome ?? '—'}`,
      '',
      '## Missions',
      ...(missions.length
        ? missions.map(
            (m) =>
              `- ${m.id} · ${m.deviceId} · operator ${name(m.operatorId)} · plan v${m.planVersion} · approved ${m.approvedVersion ? `v${m.approvedVersion} by ${name(m.approvedBy)}` : 'no'} · ${m.status}`,
          )
        : ['- None']),
      '',
      '## Commands',
      ...(cmds.length ? cmds.map((c) => `- ${c.id} ${c.type} by ${name(c.issuer)} at ${fmtTime(c.issuedAt, true)} → ${c.status}${c.detail ? ` (${c.detail})` : ''}`) : ['- None']),
      '',
      '## Timeline (source time · received time)',
      ...events.map((e) => `- ${fmtTime(e.at, true)} · ${fmtTime(e.receivedAt, true)} — ${e.title} (${e.actor})${e.detail ? `: ${e.detail}` : ''}`),
      '',
      '## Evidence',
      ...(files.length
        ? files.map((f) => `- ${f.id} ${f.title} · ${f.source} · ${fmtTime(f.capturedAt, true)} · sha-256 ${f.checksum}${f.simulated ? ' · SIMULATED' : ''}`)
        : ['- None']),
      '',
      'Checksums show a file has not changed since it was stored. They are not, on their own, proof of admissibility.',
    ];
    this.audit(a, exportFile ? 'report.export' : 'report.view', incidentId);
    return { markdown: lines.join('\n'), incident: inc, missions, commands: cmds, timeline: events, evidence: files };
  }

  // ---- media (simulated media gateway) -------------------------------------

  mediaSession(a: Actor, deviceId: string) {
    this.require(a, 'media.view', deviceId, { mutating: false });
    const d = this.getDevice(a, deviceId);
    if (!d.capabilities.includes('video') && !d.capabilities.includes('camera')) fail(400, 'invalid', `${d.id} has no camera.`);
    const exp = this.now() + 60_000;
    const sig = hmac(this.cfg.mediaSecret, `${a.orgId}|${d.id}|${a.userId}|${exp}`);
    this.audit(a, 'media.session', d.id);
    const url = `/api/v1/media/${encodeURIComponent(d.id)}/frame.svg?u=${encodeURIComponent(a.userId ?? '')}&exp=${exp}&sig=${sig}`;
    const label = d.integration === 'simulated' ? 'SIMULATED' : 'LIVE';
    // Real device with a stream on the site media server: hand out a short-lived token that the
    // media server checks with us (POST /api/v1/media/auth) before it serves any video. Only URLs
    // on an edge origin the site allows today are handed out.
    const st = this.vettedStream(d);
    if (st.whep || st.hls || st.whepSub) {
      const token = this.mediaToken(d.orgId, d.id, a.userId ?? '', this.now() + MEDIA_TOKEN_TTL_MS);
      const withToken = (u?: string) => (u ? `${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : undefined);
      return { url, expiresAt: exp, label, whep: withToken(st.whep), hls: withToken(st.hls), whepSub: withToken(st.whepSub), hlsSub: withToken(st.hlsSub), token };
    }
    return { url, expiresAt: exp, label };
  }

  private mediaToken(orgId: string, deviceId: string, userId: string, exp: number) {
    const body = `${deviceId}.${userId}.${exp}`;
    return `${Buffer.from(body).toString('base64url')}.${hmac(this.cfg.mediaSecret, `mtx|${orgId}|${body}`)}`;
  }

  /**
   * Called by the site media server (MediaMTX `authMethod: http`) for every viewer.
   * Allows only `read` of the path that belongs to the device in a valid, unexpired token,
   * issued to a user who is still active in the device's organisation.
   */
  mediaAuth(req: { action?: string; path?: string; query?: string; token?: string; password?: string }): boolean {
    const q = new URLSearchParams(String(req.query ?? ''));
    // A gateway pushing a device's camera into the platform's media server (RTSP basic auth: pub / token).
    if (req.action === 'publish') return this.pushEnabled && this.mayPublish(String(req.password || q.get('token') || ''), String(req.path ?? '').replace(/^\/+|\/+$/g, ''));
    if (req.action !== 'read' && req.action !== 'playback') return false;
    const token = q.get('token') || req.token || req.password || '';
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return false;
    const body = Buffer.from(b64, 'base64url').toString();
    const [deviceId, userId, expStr] = body.split('.');
    const exp = Number(expStr);
    if (!(exp > this.now())) return false;
    const d = this.devices.get(deviceId);
    if (!d || !safeEqual(sig, hmac(this.cfg.mediaSecret, `mtx|${d.orgId}|${body}`))) return false;
    const u = this.db.prepare('SELECT org_id FROM users WHERE id = ? AND active = 1').get(userId) as { org_id: string } | undefined;
    if (!u || u.org_id !== d.orgId) return false;
    // The token is for one device: the requested path must be that device's stream path.
    const st = this.vettedStream(d);
    const paths = [st.whep, st.hls, st.whepSub, st.hlsSub].filter(Boolean).map((s) => streamPath(s!));
    return paths.includes(String(req.path ?? '').replace(/^\/+|\/+$/g, ''));
  }

  /** Verifies a signed media URL. No session needed, so <img> tags work; scope is bound into the signature. */
  mediaFrame(deviceId: string, userId: string, exp: number, sig: string) {
    if (!(exp > this.now())) fail(410, 'forbidden', 'Media link expired.');
    const d = this.devices.get(deviceId);
    const u = this.db.prepare('SELECT org_id FROM users WHERE id = ? AND active = 1').get(userId) as { org_id: string } | undefined;
    if (!d || !u || u.org_id !== d.orgId) return fail(403, 'forbidden', 'Invalid media link.');
    if (!safeEqual(sig, hmac(this.cfg.mediaSecret, `${d.orgId}|${d.id}|${userId}|${exp}`))) return fail(403, 'forbidden', 'Invalid media link.');
    const f = freshnessAt(this.now(), d);
    const t = f === 'live' ? this.now() : d.lastSeen;
    const banner = f === 'live' ? (d.integration === 'simulated' ? 'SIMULATED FEED' : 'LIVE') : f === 'stale' ? 'FEED DELAYED' : 'NO SIGNAL';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#101b2b"/><polygon points="0,180 120,96 200,96 320,180" fill="#2a3442"/><rect x="120" y="110" width="96" height="6" fill="#e8edf2"/><text x="10" y="20" fill="#f1f5f9" font-family="sans-serif" font-size="12">${d.id}</text><text x="310" y="20" fill="#fbbf24" font-family="sans-serif" font-size="10" text-anchor="end">${banner}</text><text x="10" y="170" fill="#f1f5f9" font-family="monospace" font-size="11">${fmtDate(t)} ${fmtTime(t, true)}</text></svg>`;
  }

  // ---- recordings (media server playback) ---------------------------------------

  /**
   * Recorded video available for a device between two times. Real devices answer from the site
   * media server's playback API (MediaMTX); simulated devices derive coverage from telemetry and
   * play back as a labelled storyboard, so the workflow can be shown without hardware.
   */
  async recordings(
    a: Actor,
    deviceId: string,
    from: number,
    to: number,
  ): Promise<{ label: 'RECORDED' | 'SIMULATED'; segments: { start: number; end: number }[]; playback: boolean }> {
    this.require(a, 'media.view', deviceId, { mutating: false });
    const d = this.getDevice(a, deviceId);
    if (!d.capabilities.includes('video') && !d.capabilities.includes('camera')) fail(400, 'invalid', `${d.id} has no camera.`);
    if (!(to > from)) fail(400, 'invalid', 'to must be after from.');
    if (to - from > 7 * 86_400_000) fail(400, 'invalid', 'At most 7 days at a time.');
    const pb = this.playbackOf(d);
    if (pb) {
      const token = this.mediaToken(d.orgId, d.id, a.userId ?? '', this.now() + MEDIA_TOKEN_TTL_MS);
      const url = `${pb.base}/list?path=${encodeURIComponent(pb.path)}&start=${encodeURIComponent(new Date(from).toISOString())}&end=${encodeURIComponent(new Date(to).toISOString())}&token=${encodeURIComponent(token)}`;
      let list: { start: string; duration: number }[];
      try {
        const r = await this.edgeGet(url, { timeoutMs: 6000, maxBytes: 4 * 1024 * 1024 });
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        list = JSON.parse(r.body.toString('utf8')) as { start: string; duration: number }[];
        if (!Array.isArray(list)) throw new Error('not a list');
      } catch (e) {
        return fail(502, 'error', `The site media server did not answer for recordings (${(e as Error).message}).`);
      }
      const segments = list
        .map((x) => ({ start: Date.parse(x.start), end: Date.parse(x.start) + Math.round(Number(x.duration) * 1000) }))
        .filter((x) => Number.isFinite(x.start) && x.end > x.start)
        .sort((x, y) => x.start - y.start);
      return { label: 'RECORDED', segments, playback: true };
    }
    // Coverage from telemetry: the device was online (and, for a simulated camera, "recording").
    const gap = Math.max(5000, 3 * d.rateMs);
    const starts = this.db
      .prepare(
        'WITH t AS (SELECT received_time rt, LAG(received_time) OVER (ORDER BY received_time) prev FROM telemetry WHERE device_id = ? AND received_time BETWEEN ? AND ?) SELECT rt FROM t WHERE prev IS NULL OR rt - prev > ?',
      )
      .all(d.id, from, to, gap) as { rt: number }[];
    const ends = this.db
      .prepare(
        'WITH t AS (SELECT received_time rt, LEAD(received_time) OVER (ORDER BY received_time) nxt FROM telemetry WHERE device_id = ? AND received_time BETWEEN ? AND ?) SELECT rt FROM t WHERE nxt IS NULL OR nxt - rt > ?',
      )
      .all(d.id, from, to, gap) as { rt: number }[];
    const segments = starts.map((st, i) => ({ start: st.rt, end: Math.max(st.rt + 1000, (ends[i]?.rt ?? st.rt) + d.rateMs) }));
    return { label: 'SIMULATED', segments, playback: false };
  }

  /** A playable link for a stretch of recording. Real devices: the media server's MP4 export; simulated: a storyboard. */
  clipUrl(a: Actor, deviceId: string, start: number, durationS: number) {
    this.require(a, 'media.view', deviceId, { mutating: false });
    const d = this.getDevice(a, deviceId);
    const dur = clampDuration(durationS);
    if (!Number.isFinite(start) || start > this.now()) fail(400, 'invalid', 'start must be a past timestamp in milliseconds.');
    this.audit(a, 'media.playback', d.id, 'ok', `${new Date(start).toISOString()} +${dur}s`);
    const exp = this.now() + MEDIA_TOKEN_TTL_MS;
    const pb = this.playbackOf(d);
    if (pb) {
      const token = this.mediaToken(d.orgId, d.id, a.userId ?? '', exp);
      return {
        url: `${pb.base}/get?path=${encodeURIComponent(pb.path)}&start=${encodeURIComponent(new Date(start).toISOString())}&duration=${dur}&format=mp4&token=${encodeURIComponent(token)}`,
        mime: 'video/mp4',
        label: 'RECORDED' as const,
        expiresAt: exp,
      };
    }
    const sig = hmac(this.cfg.mediaSecret, `${d.orgId}|${d.id}|${a.userId ?? ''}|${exp}|sb|${start}|${dur}`);
    return {
      url: `/api/v1/media/${encodeURIComponent(d.id)}/storyboard.svg?start=${start}&duration=${dur}&u=${encodeURIComponent(a.userId ?? '')}&exp=${exp}&sig=${sig}`,
      mime: 'image/svg+xml',
      label: 'SIMULATED' as const,
      expiresAt: exp,
    };
  }

  /** Signed storyboard for simulated recordings: six frames with the time and where the device was. */
  storyboard(deviceId: string, start: number, durationS: number, userId: string, exp: number, sig: string) {
    if (!(exp > this.now())) fail(410, 'forbidden', 'Media link expired.');
    const d = this.devices.get(deviceId);
    const u = this.db.prepare('SELECT org_id FROM users WHERE id = ? AND active = 1').get(userId) as { org_id: string } | undefined;
    if (!d || !u || u.org_id !== d.orgId) return fail(403, 'forbidden', 'Invalid media link.');
    const dur = clampDuration(durationS);
    if (!safeEqual(sig, hmac(this.cfg.mediaSecret, `${d.orgId}|${d.id}|${userId}|${exp}|sb|${start}|${dur}`))) return fail(403, 'forbidden', 'Invalid media link.');
    return this.renderStoryboard(d, start, dur);
  }

  private renderStoryboard(d: Device, start: number, dur: number) {
    const frames = 6;
    const w = 240;
    const h = 135;
    const cells: string[] = [];
    for (let i = 0; i < frames; i++) {
      const t = start + ((dur * 1000) / (frames - 1)) * i;
      const row = this.db.prepare('SELECT x, y, speed FROM telemetry WHERE device_id = ? AND received_time <= ? ORDER BY received_time DESC LIMIT 1').get(d.id, t) as
        | { x: number; y: number; speed: number }
        | undefined;
      const x = 4 + i * (w + 6);
      const pos = row ? `x ${Math.round(row.x)} · y ${Math.round(row.y)} · ${row.speed.toFixed(1)} m/s` : 'no telemetry';
      cells.push(
        `<g transform="translate(${x},4)"><rect width="${w}" height="${h}" rx="4" fill="#101b2b"/><polygon points="0,${h} 90,70 150,70 ${w},${h}" fill="#2a3442"/>` +
          `<rect x="90" y="82" width="72" height="5" fill="#e8edf2"/>${row ? `<circle cx="${60 + ((i * 20) % 120)}" cy="${98}" r="5" fill="#22d3ee"/>` : ''}` +
          `<text x="8" y="16" fill="#f1f5f9" font-family="sans-serif" font-size="11">${d.id}</text><text x="${w - 8}" y="16" fill="#fbbf24" font-family="sans-serif" font-size="9" text-anchor="end">SIMULATED RECORDING</text>` +
          `<text x="8" y="${h - 20}" fill="#f1f5f9" font-family="monospace" font-size="10">${fmtDate(t)} ${fmtTime(t, true)}</text><text x="8" y="${h - 8}" fill="#9fb3c8" font-family="monospace" font-size="9">${pos}</text></g>`,
      );
    }
    const W = frames * (w + 6) + 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h + 8}" width="${W}" height="${h + 8}"><rect width="${W}" height="${h + 8}" fill="#0b1220"/>${cells.join('')}</svg>`;
  }

  /** Saves a stretch of recording to the incident as evidence (checksummed, audited). */
  async clipToEvidence(a: Actor, incidentId: string, deviceId: string, start: number, durationS: number) {
    this.require(a, 'evidence.add', incidentId);
    const inc = this.getIncident(a, incidentId);
    const d = this.getDevice(a, deviceId);
    const dur = clampDuration(durationS);
    if (!Number.isFinite(start) || start > this.now()) fail(400, 'invalid', 'start must be a past timestamp in milliseconds.');
    const pb = this.playbackOf(d);
    let bytes: Buffer;
    let mime: string;
    if (pb) {
      const token = this.mediaToken(d.orgId, d.id, a.userId ?? '', this.now() + MEDIA_TOKEN_TTL_MS);
      const url = `${pb.base}/get?path=${encodeURIComponent(pb.path)}&start=${encodeURIComponent(new Date(start).toISOString())}&duration=${dur}&format=mp4&token=${encodeURIComponent(token)}`;
      try {
        const r = await this.edgeGet(url, { timeoutMs: 60_000, maxBytes: 256 * 1024 * 1024 });
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        bytes = r.body;
      } catch (e) {
        return fail(502, 'error', `Could not fetch the recording from the site media server (${(e as Error).message}).`);
      }
      if (!bytes.length) fail(404, 'not_found', 'No recording for that time.');
      mime = 'video/mp4';
    } else {
      bytes = Buffer.from(this.renderStoryboard(d, start, dur), 'utf8');
      mime = 'image/svg+xml';
    }
    const ev = this.storeEvidence(a.orgId, inc.siteId, inc.id, {
      kind: 'clip',
      title: `${d.id} recording ${fmtTime(start, true)}–${fmtTime(start + dur * 1000, true)}`,
      source: d.id,
      recordedBy: a.name,
      capturedAt: start,
      mime,
      bytes,
      simulated: !pb,
    });
    this.audit(a, 'evidence.clip', ev.id, 'ok', `${d.id} ${new Date(start).toISOString()} +${dur}s → ${inc.id}`);
    return ev;
  }

  /** Playback base URL and recording path of a real device with a media-server stream on an allowed edge origin. */
  private playbackOf(d: Device & { orgId: string; siteId: string }): { base: string; path: string } | undefined {
    const st = this.vettedStream(d);
    if (!st.playback) return undefined;
    const path = streamPath(st.whep ?? st.hls ?? st.whepSub ?? st.hlsSub ?? '');
    if (!path) return undefined;
    return { base: st.playback.replace(/\/+$/, ''), path };
  }

  // ---- geofences ----------------------------------------------------------------

  /** Fences of a site. A site without any gets the demo defaults so the console has something to show. */
  geofencesOf(orgId: string, siteId: string): Geofence[] {
    const cached = this.fenceCache.get(siteId);
    if (cached) return cached;
    let rows = this.db.prepare('SELECT data FROM geofences WHERE org_id = ? AND site_id = ?').all(orgId, siteId) as { data: string }[];
    if (!rows.length) {
      const ins = this.db.prepare('INSERT OR IGNORE INTO geofences (id, org_id, site_id, data) VALUES (?,?,?,?)');
      for (const g of DEFAULT_GEOFENCES) {
        const id = `${this.prefix(orgId)}${g.id}`;
        ins.run(id, orgId, siteId, JSON.stringify({ ...g, id, createdBy: 'Site setup', createdAt: this.now() }));
      }
      rows = this.db.prepare('SELECT data FROM geofences WHERE org_id = ? AND site_id = ?').all(orgId, siteId) as { data: string }[];
    }
    const list = rows.map((r) => JSON.parse(r.data) as Geofence);
    this.fenceCache.set(siteId, list);
    return list;
  }

  listGeofences(a: Actor, siteId?: string) {
    const site = this.site(a, siteId);
    return this.geofencesOf(a.orgId, site.id);
  }

  saveGeofence(a: Actor, input: Partial<Geofence> & { siteId?: string }, id?: string): Geofence {
    this.require(a, 'site.geofences', id ?? 'geofence');
    const site = this.site(a, input.siteId);
    const existing = id ? this.geofencesOf(a.orgId, site.id).find((g) => g.id === id) : undefined;
    if (id && !existing) fail(404, 'not_found', 'Geofence not found.');
    const name = String(input.name ?? existing?.name ?? '').trim();
    if (!name || name.length > 80) fail(400, 'invalid', 'A name of up to 80 characters is required.');
    const kind = (input.kind ?? existing?.kind ?? 'keep_out') as Geofence['kind'];
    if (!['keep_out', 'caution', 'no_fly'].includes(kind)) fail(400, 'invalid', 'kind must be keep_out, caution or no_fly.');
    const poly = (input.poly ?? existing?.poly ?? []) as Point[];
    if (
      !Array.isArray(poly) ||
      poly.length < 3 ||
      poly.length > 30 ||
      poly.some((p) => typeof p?.x !== 'number' || typeof p?.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y))
    )
      fail(400, 'invalid', 'poly needs 3–30 {x, y} points.');
    if (!poly.some(insideDemoArea)) fail(400, 'invalid', 'The zone must touch the site.');
    const appliesTo = ((input.appliesTo ?? existing?.appliesTo ?? ['ugv', 'uav']) as string[]).filter((k) => k === 'ugv' || k === 'uav') as Geofence['appliesTo'];
    if (!appliesTo.length) fail(400, 'invalid', 'appliesTo must include ugv and/or uav.');
    const g: Geofence = {
      id: id ?? `${this.prefix(a.orgId)}GF-${String(nextNumber(this.db, a.orgId, 'geofence', 10)).padStart(3, '0')}`,
      name,
      kind,
      poly: poly.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })),
      active: input.active ?? existing?.active ?? true,
      appliesTo: [...new Set(appliesTo)],
      reason: typeof input.reason === 'string' ? input.reason.trim().slice(0, 160) || undefined : existing?.reason,
      createdBy: existing?.createdBy ?? a.name,
      createdAt: existing?.createdAt ?? this.now(),
    };
    this.db
      .prepare('INSERT INTO geofences (id, org_id, site_id, data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(g.id, a.orgId, site.id, JSON.stringify(g));
    this.fenceCache.delete(site.id);
    this.audit(a, existing ? 'geofence.update' : 'geofence.create', g.id, 'ok', `${g.kind} "${g.name}" ${g.active ? 'active' : 'inactive'} for ${g.appliesTo.join('/')}`);
    this.publish({ orgId: a.orgId, siteId: site.id, event: { type: 'geofence', geofence: g } });
    return g;
  }

  deleteGeofence(a: Actor, id: string) {
    this.require(a, 'site.geofences', id);
    const row = this.db.prepare('SELECT site_id, data FROM geofences WHERE id = ? AND org_id = ?').get(id, a.orgId) as { site_id: string; data: string } | undefined;
    if (!row || !this.inScope(a, a.orgId, row.site_id)) return fail(404, 'not_found', 'Geofence not found.');
    this.db.prepare('DELETE FROM geofences WHERE id = ?').run(id);
    this.fenceCache.delete(row.site_id);
    const g = JSON.parse(row.data) as Geofence;
    this.audit(a, 'geofence.delete', id, 'ok', g.name);
    this.publish({ orgId: a.orgId, siteId: row.site_id, event: { type: 'geofence', geofence: g, deleted: true } });
    return { ok: true };
  }

  /** Live geofence tracking: entering a keep-out or no-fly zone is a breach; caution zones are noted. */
  private trackFences(d: Device & { orgId: string; siteId: string }, now: number) {
    if (d.kind !== 'ugv' && d.kind !== 'uav') return;
    const fences = this.geofencesOf(d.orgId, d.siteId);
    const nowIn = new Set(fencesAt(d.pos, fences, d.kind).map((f) => f.id));
    const was = this.insideFences.get(d.id) ?? new Set<string>();
    const m = this.activeMission(d.id);
    for (const id of nowIn) {
      if (was.has(id)) continue;
      const f = fences.find((x) => x.id === id)!;
      const breach = f.kind !== 'caution' && (d.kind === 'uav' || f.kind === 'keep_out');
      const text = `${d.id} entered ${GEOFENCE_KIND_LABEL[f.kind].toLowerCase()} zone "${f.name}"`;
      if (m) this.event(null, d.orgId, d.siteId, m.incidentId, text, { actor: d.id, tone: breach ? 'alert' : 'warn', at: now, detail: f.reason });
      this.audit(this.systemActor(d.orgId, 'system', 'Geofence'), 'geofence.breach', d.id, breach ? 'error' : 'ok', `${f.id} ${f.name}${m ? ` during ${m.id}` : ''}`);
      this.publish({ orgId: d.orgId, siteId: d.siteId, event: { type: 'notice', tone: breach ? 'error' : 'warn', text: `${text}.${f.reason ? ` ${f.reason}` : ''}` } });
      this.bus.emit('geofence', { orgId: d.orgId, deviceId: d.id, fence: f, breach });
      if (breach)
        this.notify(d.orgId, {
          event: 'geofence.breach',
          title: text,
          text: f.reason ?? `${GEOFENCE_KIND_LABEL[f.kind]} zone`,
          severity: 'high',
          incidentId: m?.incidentId,
          data: { deviceId: d.id, fenceId: f.id, pos: d.pos },
        });
    }
    for (const id of was) {
      if (nowIn.has(id)) continue;
      const f = fences.find((x) => x.id === id);
      if (f && f.kind !== 'caution') this.publish({ orgId: d.orgId, siteId: d.siteId, event: { type: 'notice', tone: 'info', text: `${d.id} left zone "${f.name}".` } });
    }
    this.insideFences.set(d.id, nowIn);
  }

  // ---- usage counters, service, docking ---------------------------------------------

  private statsOf(d: Device): DeviceStats {
    if (d.stats) return d.stats;
    const row = this.db.prepare('SELECT data FROM device_stats WHERE device_id = ?').get(d.id) as { data: string } | undefined;
    d.stats = row
      ? (JSON.parse(row.data) as DeviceStats)
      : {
          odometerM: 0,
          runtimeS: 0,
          missions: 0,
          serviceOdometerM: 0,
          serviceRuntimeS: 0,
          serviceIntervalM: d.kind === 'uav' ? 0 : 500_000,
          serviceIntervalH: d.kind === 'uav' ? 100 : 250,
          // First fix carries GNSS noise: the dock is the parking spot to the nearest metre.
          dock: { x: Math.round(d.pos.x), y: Math.round(d.pos.y) },
        };
    return d.stats;
  }

  private saveStats(d: Device, force = false) {
    const st = this.statsOf(d);
    const now = this.now();
    if (!force && now - (this.lastStatsSave.get(d.id) ?? 0) < 5000) return;
    this.lastStatsSave.set(d.id, now);
    this.db.prepare('INSERT INTO device_stats (device_id, data) VALUES (?,?) ON CONFLICT(device_id) DO UPDATE SET data = excluded.data').run(d.id, JSON.stringify(st));
  }

  /** Odometer and runtime from consecutive fixes; docked when parked at the home position with no mission. */
  private trackStats(d: Device & { orgId: string; siteId: string }, now: number) {
    const st = this.statsOf(d);
    const prev = this.lastFix.get(d.id);
    if (prev) {
      const dt = Math.min(10, Math.max(0, (now - prev.at) / 1000));
      const dist = Math.hypot(d.pos.x - prev.pos.x, d.pos.y - prev.pos.y);
      if (d.speed > 0.3 && dist < 30) {
        st.odometerM = Math.round((st.odometerM + dist) * 10) / 10;
        st.runtimeS = Math.round((st.runtimeS + dt) * 10) / 10;
      }
    }
    this.lastFix.set(d.id, { pos: { ...d.pos }, at: now });
    const docked = !!st.dock && d.speed < 0.1 && Math.hypot(d.pos.x - st.dock.x, d.pos.y - st.dock.y) < 4 && !this.activeMission(d.id);
    st.docked = docked;
    this.saveStats(d);
  }

  private onMissionCompleted(orgId: string, siteId: string, m: Mission, at: number) {
    const d = this.devices.get(m.deviceId);
    if (d) {
      const st = this.statsOf(d);
      st.missions += 1;
      this.saveStats(d, true);
    }
    if (m.patrolId) this.finishPatrolRun(orgId, siteId, m, at);
  }

  /** Marks a service visit: wear counters restart from here. */
  recordService(a: Actor, deviceId: string, note: string) {
    this.require(a, 'device.service', deviceId);
    const d = this.getDevice(a, deviceId);
    const st = this.statsOf(d);
    st.lastServiceAt = this.now();
    st.serviceOdometerM = st.odometerM;
    st.serviceRuntimeS = st.runtimeS;
    this.saveStats(d, true);
    this.saveDevice(d);
    this.audit(a, 'device.service', d.id, 'ok', `${note?.trim() || 'service recorded'} · odometer ${Math.round(st.odometerM)} m · runtime ${Math.round(st.runtimeS / 360) / 10} h`);
    return st;
  }

  updateDeviceStats(a: Actor, deviceId: string, patch: { serviceIntervalM?: number; serviceIntervalH?: number; dock?: Point | null }) {
    this.require(a, 'admin.devices', deviceId);
    const d = this.getDevice(a, deviceId);
    const st = this.statsOf(d);
    const num = (v: unknown, max: number): number | undefined => {
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) return fail(400, 'invalid', `Value must be between 0 and ${max}.`);
      return v;
    };
    const im = num(patch.serviceIntervalM, 10_000_000);
    const ih = num(patch.serviceIntervalH, 100_000);
    if (im !== undefined) st.serviceIntervalM = im;
    if (ih !== undefined) st.serviceIntervalH = ih;
    if (patch.dock === null) st.dock = undefined;
    else if (patch.dock) {
      if (!Number.isFinite(patch.dock.x) || !Number.isFinite(patch.dock.y) || !insideDemoArea(patch.dock)) fail(400, 'invalid', 'dock must be {x, y} inside the site.');
      st.dock = { x: patch.dock.x, y: patch.dock.y };
    }
    this.saveStats(d, true);
    this.saveDevice(d);
    this.audit(a, 'admin.device_update', d.id, 'ok', `service interval ${st.serviceIntervalM} m / ${st.serviceIntervalH} h${st.dock ? `, dock ${st.dock.x},${st.dock.y}` : ''}`);
    return st;
  }

  // ---- route planning and unit suggestion --------------------------------------------

  /** Plans a route for a vehicle to a place or an incident, around buildings and keep-out zones. */
  planRouteFor(a: Actor, input: { deviceId: string; to?: Point; incidentId?: string; via?: Point[] }) {
    this.require(a, 'mission.prepare', 'route', { mutating: false });
    const d = this.getDevice(a, String(input.deviceId ?? ''));
    if (d.kind !== 'ugv' && d.kind !== 'uav') fail(400, 'invalid', `${d.id} is not a vehicle.`);
    const to = input.incidentId ? this.getIncident(a, input.incidentId).pos : input.to;
    if (!to || typeof to.x !== 'number' || typeof to.y !== 'number' || !Number.isFinite(to.x) || !Number.isFinite(to.y))
      return fail(400, 'invalid', 'Give a destination {x, y} or an incidentId.');
    const via = Array.isArray(input.via)
      ? input.via.filter((p) => typeof p?.x === 'number' && typeof p?.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)).slice(0, 10)
      : undefined;
    const plan = d.indoor ? planFor(d, to) : planRoute(d.pos, to, { fences: this.geofencesOf(a.orgId, d.siteId), kind: d.kind as 'ugv' | 'uav', via });
    return { deviceId: d.id, from: d.pos, to, ...plan };
  }

  /** Vehicles that could respond to an incident, ranked by estimated arrival. */
  suggestUnits(a: Actor, incidentId: string) {
    this.require(a, 'mission.prepare', incidentId, { mutating: false });
    const inc = this.getIncident(a, incidentId);
    const now = this.now();
    const missions = this.allMissions(a.orgId);
    const units = [...this.devices.values()].filter(
      (d) => d.orgId === a.orgId && d.siteId === inc.siteId && (d.kind === 'ugv' || d.kind === 'uav') && d.commands.includes('start'),
    );
    const fences = this.geofencesOf(a.orgId, inc.siteId);
    return rankUnits(units, inc.pos, fences)
      .map(({ unit: d, plan, etaS, lengthM }) => {
        const ready = isReadyAt(now, d, missions);
        const fresh = freshnessAt(now, d);
        const reason = !d.commands.length
          ? 'No commands'
          : fresh !== 'live'
            ? `Telemetry ${fresh}`
            : (d.battery ?? 100) < 25
              ? `Battery ${Math.round(d.battery ?? 0)}%`
              : !ready
                ? 'On another mission'
                : !plan.ok
                  ? plan.reason
                  : undefined;
        return {
          deviceId: d.id,
          kind: d.kind,
          model: d.model,
          ready: ready && plan.ok,
          battery: d.battery,
          etaS: plan.ok ? etaS : null,
          lengthM: plan.ok ? lengthM : null,
          checkpoints: plan.ok ? plan.checkpoints : [],
          reason,
        };
      })
      .sort((x, y) => Number(y.ready) - Number(x.ready) || (x.etaS ?? Infinity) - (y.etaS ?? Infinity));
  }

  // ---- scheduled patrols ---------------------------------------------------------------

  listPatrols(a: Actor): (Patrol & { siteId: string })[] {
    if (a.role === 'responder' || a.role === 'admin') return [];
    const rows = this.db.prepare('SELECT site_id, data FROM patrols WHERE org_id = ? ORDER BY rowid').all(a.orgId) as { site_id: string; data: string }[];
    return rows.filter((r) => this.inScope(a, a.orgId, r.site_id)).map((r) => ({ ...(JSON.parse(r.data) as Patrol), siteId: r.site_id }));
  }

  private patrolRow(orgId: string, id: string) {
    const r = this.db.prepare('SELECT site_id, data FROM patrols WHERE id = ? AND org_id = ?').get(id, orgId) as { site_id: string; data: string } | undefined;
    return r ? { p: JSON.parse(r.data) as Patrol, siteId: r.site_id } : undefined;
  }

  private savePatrol(orgId: string, siteId: string, p: Patrol) {
    this.db
      .prepare('INSERT INTO patrols (id, org_id, site_id, data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(p.id, orgId, siteId, JSON.stringify(p));
    this.publish({ orgId, siteId, event: { type: 'patrol', patrol: p } });
  }

  upsertPatrol(a: Actor, input: Partial<Patrol>, id?: string): Patrol {
    this.require(a, 'patrol.manage', id ?? 'patrol');
    const cur = id ? this.patrolRow(a.orgId, id) : undefined;
    if (id && (!cur || !this.inScope(a, a.orgId, cur.siteId))) return fail(404, 'not_found', 'Patrol not found.');
    const prev = cur?.p;
    const name = String(input.name ?? prev?.name ?? '').trim();
    if (!name || name.length > 80) fail(400, 'invalid', 'A name of up to 80 characters is required.');
    const d = this.getDevice(a, String(input.deviceId ?? prev?.deviceId ?? ''));
    if ((d.kind !== 'ugv' && d.kind !== 'uav') || !d.commands.includes('start')) fail(400, 'invalid', `${d.id} cannot run patrols (no start command).`);
    const operatorId = String(input.operatorId ?? prev?.operatorId ?? '');
    const op = this.db.prepare('SELECT role FROM users WHERE id = ? AND org_id = ? AND active = 1').get(operatorId, a.orgId) as { role: Role } | undefined;
    if (!op || op.role !== 'operator') fail(400, 'invalid', 'Choose an active operator.');
    const raw = this.validRoute((input.route ?? prev?.route ?? []) as Point[]);
    // Indoor vehicles get the floor-plan checks below instead of the outdoor obstacle check.
    const route = d.indoor ? raw : this.clearRoute(a.orgId, d, raw);
    if (d.indoor) {
      // Indoor vehicles patrol their floor: the route has to pass the same checks as an indoor mission.
      const bad = indoorRouteChecks(d, { checkpoints: route } as Mission).filter((c) => c.hard && !c.ok);
      if (bad.length) fail(400, 'invalid', `${d.id} is an indoor vehicle: ${bad.map((c) => `${c.label.toLowerCase()} (${c.detail})`).join('; ')}.`);
    }
    const days = [...new Set(((input.days ?? prev?.days ?? []) as unknown[]).map(Number))].filter((x) => Number.isInteger(x) && x >= 0 && x <= 6).sort();
    if (!days.length) fail(400, 'invalid', 'Pick at least one weekday.');
    const times = [...new Set(((input.times ?? prev?.times ?? []) as unknown[]).map(String))].filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).sort();
    if (!times.length || times.length > 24) fail(400, 'invalid', 'Give 1–24 times as HH:MM.');
    const tz = getOrgSettings(this.db, a.orgId).detection.timezone;
    const now = this.now();
    const p: Patrol = {
      id: id ?? `${this.prefix(a.orgId)}PAT-${String(nextNumber(this.db, a.orgId, 'patrol')).padStart(3, '0')}`,
      name,
      deviceId: d.id,
      operatorId,
      route,
      days,
      times,
      enabled: input.enabled ?? prev?.enabled ?? true,
      autoStart: input.autoStart ?? prev?.autoStart ?? false,
      createdBy: prev?.createdBy ?? a.userId ?? a.name,
      createdAt: prev?.createdAt ?? now,
      lastRunAt: prev?.lastRunAt,
      lastMissionId: prev?.lastMissionId,
      lastOutcome: prev?.lastOutcome,
      note: typeof input.note === 'string' ? input.note.trim().slice(0, 200) || undefined : prev?.note,
    };
    p.nextRunAt = p.enabled ? nextRun(now, p.days, p.times, tz) : undefined;
    this.savePatrol(a.orgId, d.siteId, p);
    this.audit(
      a,
      prev ? 'patrol.update' : 'patrol.create',
      p.id,
      'ok',
      `${p.name}: ${d.id}, ${p.days.join('')} at ${p.times.join(' ')}${p.autoStart ? ', auto-start' : ''}${p.enabled ? '' : ', disabled'}`,
    );
    return p;
  }

  deletePatrol(a: Actor, id: string) {
    this.require(a, 'patrol.manage', id);
    const cur = this.patrolRow(a.orgId, id);
    if (!cur || !this.inScope(a, a.orgId, cur.siteId)) return fail(404, 'not_found', 'Patrol not found.');
    this.db.prepare('DELETE FROM patrols WHERE id = ?').run(id);
    this.audit(a, 'patrol.delete', id, 'ok', cur.p.name);
    this.publish({ orgId: a.orgId, siteId: cur.siteId, event: { type: 'patrol', patrol: cur.p, deleted: true } });
    return { ok: true };
  }

  /** Runs a patrol now (supervisor). */
  runPatrol(a: Actor, id: string) {
    this.require(a, 'patrol.manage', id);
    const cur = this.patrolRow(a.orgId, id);
    if (!cur || !this.inScope(a, a.orgId, cur.siteId)) return fail(404, 'not_found', 'Patrol not found.');
    const r = this.startPatrolRun(a.orgId, cur.siteId, cur.p, a, 'manual');
    if (!r.ok) return fail(409, 'conflict', r.reason);
    return r;
  }

  /** Timer: start every enabled patrol whose time has come. */
  runPatrols(now = this.now()) {
    const rows = this.db.prepare('SELECT org_id, site_id, data FROM patrols').all() as { org_id: string; site_id: string; data: string }[];
    const out: { id: string; ok: boolean; reason?: string }[] = [];
    for (const r of rows) {
      const p = JSON.parse(r.data) as Patrol;
      if (!p.enabled || !p.nextRunAt || p.nextRunAt > now) continue;
      const tz = getOrgSettings(this.db, r.org_id).detection.timezone;
      const res = this.startPatrolRun(r.org_id, r.site_id, p, this.systemActor(r.org_id, 'system', 'Patrol scheduler'), 'schedule', now);
      out.push({ id: p.id, ...res });
      const fresh = this.patrolRow(r.org_id, p.id)?.p ?? p;
      fresh.nextRunAt = nextRun(now, fresh.days, fresh.times, tz);
      this.savePatrol(r.org_id, r.site_id, fresh);
    }
    return out;
  }

  /**
   * One patrol run: a patrol incident (verified by the schedule's standing order) and a mission
   * approved under the standing approval of the supervisor who set the schedule. With autoStart
   * the vehicle is assigned to the operator and started; otherwise the operator accepts as usual.
   */
  private startPatrolRun(
    orgId: string,
    siteId: string,
    p: Patrol,
    a: Actor,
    trigger: 'schedule' | 'manual',
    now = this.now(),
  ): { ok: true; incidentId: string; missionId: string; started: boolean } | { ok: false; reason: string } {
    const d = this.devices.get(p.deviceId);
    const skip = (reason: string) => {
      p.lastRunAt = now;
      p.lastOutcome = 'skipped';
      this.savePatrol(orgId, siteId, p);
      this.audit(a, 'patrol.skip', p.id, 'error', reason);
      this.publish({ orgId, siteId, event: { type: 'notice', tone: 'warn', text: `Patrol "${p.name}" skipped: ${reason}` } });
      this.notify(orgId, { event: 'patrol.skipped', title: `Patrol "${p.name}" skipped`, text: reason, data: { patrolId: p.id, deviceId: p.deviceId } });
      return { ok: false as const, reason };
    };
    if (!d || d.orgId !== orgId) return skip(`${p.deviceId} is not registered.`);
    const fresh = freshnessAt(now, d);
    if (fresh !== 'live') return skip(`${d.id} telemetry is ${fresh}.`);
    if ((d.battery ?? 100) < 25) return skip(`${d.id} battery ${Math.round(d.battery ?? 0)}% is too low.`);
    if (!isReadyAt(now, d, this.allMissions(orgId))) return skip(`${d.id} is on another mission.`);
    const hits = routeViolations(p.route, d.pos, this.geofencesOf(orgId, siteId), d.kind as 'ugv' | 'uav');
    if (hits.length) return skip(`route enters keep-out zone "${hits[0].name}".`);
    const operator = this.db.prepare('SELECT name FROM users WHERE id = ? AND org_id = ? AND active = 1').get(p.operatorId, orgId) as { name: string } | undefined;
    if (!operator) return skip('the assigned operator is no longer active.');
    const source = trigger === 'schedule' ? 'Patrol scheduler' : a.name;
    const inc: Incident = {
      id: `${this.prefix(orgId)}INC-${String(nextNumber(this.db, orgId, 'incident', 1)).padStart(3, '0')}`,
      title: `Patrol: ${p.name}`,
      type: 'Scheduled patrol',
      severity: 'low',
      status: 'confirmed',
      zone: d.zone,
      place: p.name,
      pos: p.route[p.route.length - 1],
      source,
      createdAt: now,
      owner: operator.name,
      thumb: 'path',
      patrolId: p.id,
    };
    const m: Mission = {
      id: `${this.prefix(orgId)}MSN-${String(nextNumber(this.db, orgId, 'mission')).padStart(4, '0')}`,
      incidentId: inc.id,
      deviceId: d.id,
      operatorId: p.operatorId,
      checkpoints: p.route.map((q) => ({ ...q })),
      planVersion: 1,
      approvedVersion: 1,
      approvedBy: p.createdBy,
      status: 'approved',
      nextCp: 0,
      createdAt: now,
      patrolId: p.id,
      note: `Standing approval from patrol schedule ${p.id} (${this.userName(orgId, p.createdBy)}).`,
    };
    let started = false;
    tx(this.db, () => {
      this.saveIncident(orgId, siteId, inc);
      this.event(a, orgId, siteId, inc.id, trigger === 'schedule' ? 'Scheduled patrol due' : 'Patrol started by supervisor', {
        actor: source,
        tone: 'info',
        detail: `${d.id} · ${p.route.length} checkpoints · operator ${operator.name}.`,
      });
      this.saveMission(orgId, siteId, m);
      this.event(a, orgId, siteId, inc.id, 'Mission approved (standing approval)', {
        actor: source,
        tone: 'ok',
        detail: `Plan v1 pre-approved by ${this.userName(orgId, p.createdBy)} when the schedule was set.`,
      });
      this.audit(a, 'patrol.run', p.id, 'ok', `${inc.id} ${m.id} (${trigger})`);
    });
    if (p.autoStart && (!d.controlOwner || d.controlOwner === p.operatorId)) {
      d.controlOwner = p.operatorId;
      this.saveDevice(d);
      m.status = 'assigned';
      this.saveMission(orgId, siteId, m);
      this.event(a, orgId, siteId, inc.id, 'Operator assigned by schedule', { actor: source, detail: `${operator.name} holds control of ${d.id} for this patrol.` });
      try {
        this.issueCommand({ ...this.systemActor(orgId, 'system', 'Patrol scheduler'), userId: p.operatorId }, m.id, 'start', `${m.id}:patrol-start`);
        started = true;
      } catch (e) {
        this.event(null, orgId, siteId, inc.id, 'Automatic start refused', { tone: 'warn', detail: e instanceof Error ? e.message : String(e) });
      }
    }
    p.lastRunAt = now;
    p.lastMissionId = m.id;
    p.lastOutcome = started ? 'started' : 'approved';
    this.savePatrol(orgId, siteId, p);
    return { ok: true, incidentId: inc.id, missionId: m.id, started };
  }

  /** A patrol mission finished: close its incident with the outcome and give the vehicle back. */
  private finishPatrolRun(orgId: string, siteId: string, m: Mission, at: number, how: 'completed' | 'cancelled' | 'stopped' = 'completed') {
    const r = this.incRow(m.incidentId);
    if (!r) return;
    const inc = JSON.parse(r.data) as Incident;
    const d = this.devices.get(m.deviceId);
    if (d && d.controlOwner === m.operatorId) {
      d.controlOwner = undefined;
      this.saveDevice(d);
    }
    if (!['closed', 'dismissed', 'duplicate'].includes(inc.status)) {
      inc.status = 'closed';
      inc.outcome = inc.outcome ?? (how === 'completed' ? 'Patrol completed. No findings reported.' : `Patrol ${how} before completion.`);
      this.saveIncident(orgId, siteId, inc);
      this.event(null, orgId, siteId, inc.id, how === 'completed' ? 'Patrol completed' : 'Patrol ended early', {
        actor: m.deviceId,
        tone: how === 'completed' ? 'ok' : 'warn',
        at,
        detail:
          how === 'completed'
            ? `${m.checkpoints.length} checkpoints driven. Incident closed automatically; evidence stays attached.`
            : `Mission ${m.id} ${how}. Incident closed; evidence stays attached.`,
      });
    }
    this.audit(this.systemActor(orgId, 'system', 'Patrol scheduler'), 'patrol.complete', m.patrolId ?? m.id, 'ok', `${m.id} ${inc.id}`);
  }

  // ---- playbooks, SLA, notifications, KPIs -----------------------------------------------

  /** Sends to the organisation's channels that want this event. Fire and forget; failures are logged. */
  notify(orgId: string, msg: Outbound) {
    const channels = getOrgSettings(this.db, orgId).notifications.channels;
    if (!Notifier.matching(channels, msg).length) return;
    void this.notifier.dispatch(orgId, channels, msg).catch((e) => console.error('[notify]', e));
  }

  /** Administrator: send a test message through one channel and return the delivery record. */
  async testChannel(a: Actor, channelId: string) {
    this.require(a, 'admin.settings', channelId);
    const c = getOrgSettings(this.db, a.orgId).notifications.channels.find((x) => x.id === channelId);
    if (!c) return fail(404, 'not_found', 'Channel not found.');
    const d = await this.notifier.deliver(a.orgId, c, {
      event: 'incident.new',
      title: `Test from ${a.name}`,
      text: `Notification channel "${c.name}" works. ${fmtDate(this.now())} ${fmtTime(this.now(), true)}`,
      severity: 'low',
    });
    this.audit(a, 'admin.notification_test', c.id, d.status === 'sent' ? 'ok' : 'error', d.detail);
    return d;
  }

  notificationLog(a: Actor, limit = 50) {
    this.require(a, 'admin.settings', 'notifications', { mutating: false });
    return (this.db.prepare('SELECT data FROM notifications WHERE org_id = ? ORDER BY at DESC LIMIT ?').all(a.orgId, Math.min(500, Math.max(1, limit))) as { data: string }[]).map(
      (r) => JSON.parse(r.data),
    );
  }

  /** Ticks or clears a playbook step on an incident. */
  setStep(a: Actor, incidentId: string, stepId: string, done: boolean) {
    this.require(a, 'evidence.add', incidentId);
    const inc = this.getIncident(a, incidentId);
    const step = inc.checklist?.find((x) => x.id === stepId);
    if (!step) return fail(404, 'not_found', 'Step not found.');
    if (done) {
      step.doneAt = this.now();
      step.by = a.name;
    } else {
      step.doneAt = undefined;
      step.by = undefined;
    }
    tx(this.db, () => {
      this.saveIncident(a.orgId, inc.siteId, inc);
      this.event(a, a.orgId, inc.siteId, inc.id, done ? `Step done: ${step.title}` : `Step reopened: ${step.title}`, { tone: done ? 'ok' : undefined });
      this.audit(a, 'incident.step', `${inc.id}:${stepId}`, 'ok', done ? 'done' : 'reopened');
    });
    return inc;
  }

  /** Every 10 s: raise each SLA breach once, on the timeline, as a notice, in the audit log and to the channels. */
  checkSla(now = this.now()) {
    const rows = this.db.prepare("SELECT org_id, site_id, data FROM incidents WHERE status NOT IN ('closed', 'dismissed', 'duplicate')").all() as {
      org_id: string;
      site_id: string;
      data: string;
    }[];
    const books = new Map<string, Playbook[]>();
    const out: { incidentId: string; stage: SlaStage }[] = [];
    for (const r of rows) {
      const inc = JSON.parse(r.data) as Incident;
      if (inc.patrolId) continue;
      if (!books.has(r.org_id)) books.set(r.org_id, getOrgSettings(this.db, r.org_id).playbooks);
      const book = pickPlaybook(books.get(r.org_id)!, inc);
      if (!book) continue;
      const events = (this.db.prepare('SELECT data FROM timeline WHERE org_id = ? AND incident_id = ?').all(r.org_id, inc.id) as { data: string }[]).map(
        (x) => JSON.parse(x.data) as TimelineEvent,
      );
      const stages = slaStages(inc, events, book.sla, now);
      const already = new Set(inc.slaBreached ?? []);
      let changed = false;
      for (const st of stages) {
        if (st.status !== 'breached' || already.has(st.stage)) continue;
        already.add(st.stage);
        changed = true;
        out.push({ incidentId: inc.id, stage: st.stage });
        const title = `SLA breached: ${SLA_STAGE_LABEL[st.stage].toLowerCase()} within ${st.limitMin} min`;
        this.event(null, r.org_id, r.site_id, inc.id, title, {
          actor: 'Platform',
          tone: 'alert',
          at: now,
          detail: `${book.name}. ${st.doneAt ? `Done after ${Math.round((st.doneAt - inc.createdAt) / 60_000)} min.` : 'Still open.'}`,
        });
        this.audit(this.systemActor(r.org_id, 'system', 'SLA'), 'sla.breach', inc.id, 'error', `${st.stage} > ${st.limitMin} min (${book.id})`);
        this.bus.emit('sla', { orgId: r.org_id, incidentId: inc.id, stage: st.stage });
        // Old breaches found at start-up (restored data, long outage) go on the record but do not page anyone.
        if (now - st.dueAt < 5 * 60_000) {
          this.publish({ orgId: r.org_id, siteId: r.site_id, incidentId: inc.id, event: { type: 'notice', tone: 'error', text: `${inc.id}: ${title}.` } });
          this.notify(r.org_id, {
            event: 'sla.breach',
            title: `${inc.id} ${title}`,
            text: `${inc.title} · ${inc.zone} · ${inc.place} · owner ${inc.owner ?? 'unassigned'}`,
            severity: inc.severity,
            incidentId: inc.id,
            data: { stage: st.stage, limitMin: st.limitMin },
          });
          this.push?.toRoles(r.org_id, ['supervisor'], r.site_id, {
            title: `SLA breached: ${inc.id}`,
            body: `${SLA_STAGE_LABEL[st.stage]} > ${st.limitMin} min · ${inc.title}`,
            url: '/',
            tag: `sla-${inc.id}-${st.stage}`,
            incidentId: inc.id,
          });
        }
      }
      if (changed) {
        inc.slaBreached = [...already];
        this.saveIncident(r.org_id, r.site_id, inc);
      }
    }
    return out;
  }

  /** Operational KPIs for a period (report.view). */
  kpi(a: Actor, from: number, to: number) {
    this.require(a, 'report.view', 'kpi', { mutating: false });
    if (!(to > from)) fail(400, 'invalid', 'to must be after from.');
    const settings = getOrgSettings(this.db, a.orgId);
    const incidents = this.listIncidents(a, { from, to, limit: 5000 });
    const ids = new Set(incidents.map((i) => i.id));
    const timeline = (
      this.db.prepare('SELECT data FROM timeline WHERE org_id = ? AND at BETWEEN ? AND ?').all(a.orgId, from - 86_400_000, to + 7 * 86_400_000) as { data: string }[]
    )
      .map((r) => JSON.parse(r.data) as TimelineEvent)
      .filter((e) => ids.has(e.incidentId));
    const missions = this.allMissions(a.orgId).filter((m) => ids.has(m.incidentId));
    const detections = this.db
      .prepare(`SELECT type, outcome, at FROM detections WHERE org_id = ? AND at BETWEEN ? AND ?${this.siteClause(a)}`)
      .all(a.orgId, from, to, ...a.siteIds) as {
      type: string;
      outcome: string;
      at: number;
    }[];
    const patrolRuns = (
      this.db.prepare("SELECT at, action FROM audit WHERE org_id = ? AND action IN ('patrol.run', 'patrol.skip') AND at BETWEEN ? AND ?").all(a.orgId, from, to) as {
        at: number;
        action: string;
      }[]
    ).map((r) => ({ ok: r.action === 'patrol.run', at: r.at }));
    return computeKpi({ from, to, incidents, timeline, missions, playbooks: settings.playbooks, detections, patrolRuns, now: this.now() }, settings.detection.timezone);
  }

  /** Markdown KPI report for a period; downloads are audited like incident reports. */
  kpiReport(a: Actor, from: number, to: number, exportFile: boolean) {
    this.require(a, exportFile ? 'evidence.export' : 'report.view', 'kpi', { mutating: false });
    const k = this.kpi(a, from, to);
    const org = (this.db.prepare('SELECT name FROM orgs WHERE id = ?').get(a.orgId) as { name: string } | undefined)?.name ?? a.orgId;
    const md = kpiMarkdown(k, {
      title: `Operations report ${fmtDate(from)} – ${fmtDate(to)}`,
      org,
      generatedBy: `${a.name} · ${fmtDate(this.now())} ${fmtTime(this.now(), true)}`,
      dataLabel: this.meta(a.orgId).dataLabel,
      fmtDate,
    });
    this.audit(a, exportFile ? 'report.export' : 'report.view', `kpi:${new Date(from).toISOString().slice(0, 10)}..${new Date(to).toISOString().slice(0, 10)}`);
    return { markdown: md, kpi: k };
  }

  /** Channels as the console may see them (secrets masked). */
  maskedChannels(channels: NotificationChannel[]) {
    return maskChannels(channels);
  }

  // ---- snapshot -----------------------------------------------------------

  meta(orgId: string): Meta {
    const anySim = [...this.devices.values()].some((d) => d.orgId === orgId && d.integration === 'simulated');
    return {
      env: this.cfg.env,
      version: this.cfg.version,
      serverTime: this.now(),
      dataLabel: this.cfg.env === 'demo' ? 'SIMULATION' : anySim ? 'MIXED DEMO' : 'LIVE',
      sso: this.cfg.oidc ? { name: this.cfg.oidc.name, startUrl: '/api/v1/auth/sso' } : undefined,
      license: (() => {
        const st = this.licenseStatus(orgId);
        return { state: st.state, customer: st.customer, daysLeft: st.daysLeft };
      })(),
    };
  }

  // ---- GIS: WGS 84 anchor, GeoJSON ------------------------------------------------------

  /** The site's WGS 84 anchor (grid origin + rotation). Falls back to the demo anchor for old records. */
  siteAnchor(orgId: string, siteId: string): GeoAnchor {
    const r = this.db.prepare('SELECT geometry FROM sites WHERE id = ? AND org_id = ?').get(siteId, orgId) as { geometry: string } | undefined;
    const g = r ? (JSON.parse(r.geometry) as Partial<SiteGeometry>) : undefined;
    const a = g?.geo;
    return a && Number.isFinite(a.originLat) && Number.isFinite(a.originLon)
      ? { originLat: a.originLat, originLon: a.originLon, rotationDeg: a.rotationDeg ?? 0 }
      : { ...SITE.geo };
  }

  /** Administrator: set where the site grid sits on Earth. Everything shown in lat/lon follows. */
  setSiteGeo(a: Actor, siteId: string | undefined, input: Partial<GeoAnchor>) {
    this.require(a, 'site.manage', siteId ?? 'site');
    const site = this.site(a, siteId);
    const lat = Number(input.originLat);
    const lon = Number(input.originLon);
    const rot = input.rotationDeg === undefined || input.rotationDeg === null ? 0 : Number(input.rotationDeg);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return fail(400, 'invalid', 'originLat must be a latitude in degrees (−90…90).');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return fail(400, 'invalid', 'originLon must be a longitude in degrees (−180…180).');
    if (!Number.isFinite(rot) || rot < -180 || rot > 360) return fail(400, 'invalid', 'rotationDeg must be in degrees (−180…360).');
    const geo: GeoAnchor = { originLat: Math.round(lat * 1e7) / 1e7, originLon: Math.round(lon * 1e7) / 1e7, rotationDeg: Math.round(rot * 100) / 100 };
    const geometry = { ...site.geometry, geo };
    this.db.prepare('UPDATE sites SET geometry = ? WHERE id = ?').run(JSON.stringify(geometry), site.id);
    this.audit(a, 'site.geo', site.id, 'ok', `anchor ${geo.originLat}, ${geo.originLon} rot ${geo.rotationDeg}°`);
    const info: SiteInfo = { id: site.id, name: site.name, geometry };
    this.publish({ orgId: a.orgId, siteId: site.id, event: { type: 'site', site: info } });
    return info;
  }

  /** The site as a WGS 84 FeatureCollection. A download is audited like an export. */
  siteGeoJson(a: Actor, siteId: string | undefined, layers?: string[], download = false) {
    const site = this.site(a, siteId);
    const want = (layers ?? []).map((l) => l.trim()).filter((l): l is GeoLayer => (GEO_LAYERS as string[]).includes(l));
    // Administrators manage the system but do not see incident data (same rule as the API).
    const incidents = a.role === 'admin' ? [] : this.listIncidents(a, { siteId: site.id }).filter((i) => !['closed', 'duplicate', 'dismissed'].includes(i.status));
    const fc = siteGeoJson({
      site,
      anchor: this.siteAnchor(a.orgId, site.id),
      geofences: this.geofencesOf(a.orgId, site.id),
      devices: this.listDevices(a, site.id),
      incidents,
      layers: want.length ? want : undefined,
      dataLabel: this.meta(a.orgId).dataLabel,
      generatedAt: this.now(),
    });
    if (download) this.audit(a, 'site.export', site.id, 'ok', `geojson ${fc.features.length} features`);
    return fc;
  }

  /** Geofences drawn in a GIS (GeoJSON polygons) → zones on this site. */
  importGeofences(a: Actor, input: unknown, siteId?: string) {
    this.require(a, 'site.geofences', 'geofence');
    const site = this.site(a, siteId);
    const anchor = this.siteAnchor(a.orgId, site.id);
    const res = geofencesFromGeoJson(anchor, { width: site.geometry.width, height: site.geometry.height }, input, { max: 100 });
    const existing = this.geofencesOf(a.orgId, site.id);
    if (existing.length + res.geofences.length > 300) return fail(400, 'invalid', 'At most 300 geofences per site.');
    const created: Geofence[] = [];
    tx(this.db, () => {
      for (const g of res.geofences) {
        // A zone with the same name is replaced, so re-importing a GIS layer updates rather than duplicates.
        const same = existing.find((x) => x.name === g.name);
        created.push(this.saveGeofence(a, { ...g, siteId: site.id }, same?.id));
      }
    });
    this.audit(a, 'geofence.import', site.id, 'ok', `${created.length} zones${res.errors.length ? `, ${res.errors.length} skipped` : ''}`);
    return { imported: created.length, geofences: created, errors: res.errors };
  }

  /** A gateway converts positions with its own anchor: it must be the one the site is registered with. */
  private checkGatewayAnchor(sys: Actor, siteIds: string[], gatewayId: string, geo: GeoAnchor) {
    const sites = siteIds.length ? siteIds : (this.db.prepare('SELECT id FROM sites WHERE org_id = ?').all(sys.orgId) as { id: string }[]).map((r) => r.id);
    for (const siteId of sites) {
      const want = this.siteAnchor(sys.orgId, siteId);
      const here = siteToGeo(want, { x: 0, y: 0 });
      const dLat = ((geo.originLat - here.lat) * Math.PI * 6_378_137) / 180;
      const dLon = ((geo.originLon - here.lon) * Math.PI * 6_378_137 * Math.cos((here.lat * Math.PI) / 180)) / 180;
      const offM = Math.hypot(dLat, dLon);
      const dRot = Math.abs(((geo.rotationDeg ?? 0) - (want.rotationDeg ?? 0) + 540) % 360) - 180;
      if (offM > 2 || Math.abs(dRot) > 0.5) {
        const text = `Gateway ${gatewayId} uses a site anchor ${offM.toFixed(1)} m${Math.abs(dRot) > 0.5 ? ` and ${Math.abs(dRot).toFixed(1)}°` : ''} off the one registered for the site. Positions from real devices may be shifted; fix the gateway config or the site anchor.`;
        this.audit(sys, 'gateway.geo_mismatch', gatewayId, 'error', text);
        this.publish({ orgId: sys.orgId, siteId, event: { type: 'notice', tone: 'warn', text } });
      }
    }
  }

  site(a: Actor, siteId?: string) {
    const id = siteId ?? this.defaultSite(a);
    const r = this.db.prepare('SELECT id, org_id, name, geometry FROM sites WHERE id = ?').get(id) as { id: string; org_id: string; name: string; geometry: string } | undefined;
    if (!r || !this.inScope(a, r.org_id, r.id)) return fail(404, 'not_found', 'Site not found.');
    const geometry = JSON.parse(r.geometry) as SiteGeometry;
    if (!geometry.geo) geometry.geo = { ...SITE.geo };
    return { id: r.id, name: r.name, geometry };
  }

  listSites(a: Actor) {
    const rows = this.db.prepare('SELECT id, org_id, name FROM sites WHERE org_id = ?').all(a.orgId) as { id: string; org_id: string; name: string }[];
    return rows.filter((r) => this.inScope(a, r.org_id, r.id)).map((r) => ({ id: r.id, name: r.name }));
  }

  orgUsers(a: Actor): User[] {
    const rows = this.db.prepare('SELECT id, name, role, title FROM users WHERE org_id = ? AND active = 1').all(a.orgId) as unknown as User[];
    return rows.map((u) => ({ id: u.id, name: u.name, role: u.role, title: u.title }));
  }

  snapshot(a: Actor, siteId?: string): Snapshot {
    const site = this.site(a, siteId);
    const incidents = a.role === 'admin' ? [] : this.listIncidents(a, { siteId: site.id });
    const ids = new Set(incidents.map((i) => i.id));
    const timeline = (this.db.prepare('SELECT data FROM timeline WHERE org_id = ? ORDER BY at').all(a.orgId) as { data: string }[])
      .map((r) => JSON.parse(r.data) as TimelineEvent)
      .filter((e) => ids.has(e.incidentId));
    const missions = a.role === 'responder' || a.role === 'admin' ? [] : this.allMissions(a.orgId).filter((m) => ids.has(m.incidentId));
    return {
      serverTime: this.now(),
      meta: this.meta(a.orgId),
      site,
      users: this.orgUsers(a),
      incidents,
      devices: this.listDevices(a, site.id),
      missions,
      commands: a.role === 'admin' ? [] : this.listCommands(a).filter((c) => missions.some((m) => m.id === c.missionId)),
      timeline,
      evidence: can(a.role as Role, 'evidence.view') ? this.evidenceFor(a, ids) : [],
      assignments: this.listAssignments(a).filter((x) => ids.has(x.incidentId)),
      geofences: this.geofencesOf(a.orgId, site.id),
      playbooks: getOrgSettings(this.db, a.orgId).playbooks,
      patrols:
        a.role === 'admin' || a.role === 'responder'
          ? []
          : this.listPatrols(a)
              .filter((p) => p.siteId === site.id)
              .map(({ siteId: _s, ...p }) => p),
    };
  }

  /** Can this console connection receive the event? Mirrors read scoping. */
  visible(a: Actor, m: BusMessage) {
    if (m.orgId !== a.orgId) return false;
    if (m.siteId && a.siteIds.length && !a.siteIds.includes(m.siteId)) return false;
    const e = m.event;
    if (e.type === 'resync') return true;
    if (e.type === 'notice') return a.role !== 'responder' || (!!m.incidentId && this.hasAssignment(a, m.incidentId));
    if (e.type === 'geofence' || e.type === 'site') return true;
    if (e.type === 'detection') return a.role !== 'responder' && a.role !== 'admin' && can(a.role as Role, 'media.view');
    if (e.type === 'patrol') return a.role !== 'responder' && a.role !== 'admin';
    if (a.role === 'admin') return e.type === 'audit' || e.type === 'device';
    if (e.type === 'audit') return can(a.role as Role, 'audit.view');
    if (a.role === 'responder') {
      if (['device', 'telemetry', 'mission', 'command'].includes(e.type)) return false;
      return !!m.incidentId && this.hasAssignment(a, m.incidentId);
    }
    if (e.type === 'evidence') return can(a.role as Role, 'evidence.view');
    return true;
  }

  systemActor(orgId: string, role: ActorRole = 'system', name = 'System'): Actor {
    return { kind: 'system', orgId, siteIds: [], name, role };
  }

  userActor(u: SessionUser, extra: Partial<Actor> = {}): Actor {
    return { kind: 'user', orgId: u.orgId, siteIds: u.siteIds, userId: u.id, name: u.name, role: u.role, stepUpUntil: u.stepUpUntil, ...extra };
  }
}

/** Local weekday, date and minutes of a timestamp in a time zone. */
function localClock(at: number, tz: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const y = Number(get('year'));
  const mo = Number(get('month'));
  const d = Number(get('day'));
  const h = Number(get('hour')) % 24;
  const mi = Number(get('minute'));
  // Offset between the zone's wall clock and UTC at this instant.
  const offsetMs = Date.UTC(y, mo - 1, d, h, mi) - (at - (at % 60_000));
  return { day, y, mo, d, h, mi, offsetMs };
}

/** Next instant after `after` that falls on one of the weekdays at one of the HH:MM times, in the zone. */
export function nextRun(after: number, days: number[], times: string[], tz: string): number | undefined {
  let best: number | undefined;
  for (let k = 0; k < 8 && best === undefined; k++) {
    const probe = after + k * 86_400_000;
    const lc = localClock(probe, tz);
    if (!days.includes(lc.day)) continue;
    for (const t of times) {
      const [h, mi] = t.split(':').map(Number);
      const instant = Date.UTC(lc.y, lc.mo - 1, lc.d, h, mi) - lc.offsetMs;
      if (instant > after && (best === undefined || instant < best)) best = instant;
    }
  }
  return best;
}

/** Clip length: 5 s to 10 minutes, whole seconds. */
function clampDuration(s: number) {
  if (!Number.isFinite(s)) fail(400, 'invalid', 'duration must be seconds.');
  return Math.max(5, Math.min(600, Math.round(s)));
}

/** Media server path of a stream URL: https://edge/cam-zt30-01/whep → cam-zt30-01. */
export function streamPath(url: string) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last === 'whep' || last === 'index.m3u8') parts.pop();
    return parts.join('/');
  } catch {
    return '';
  }
}

/** Indoor declaration from a gateway: a known building id, a sane level, a known positioning source. */
function sanitizeIndoor(v: unknown): Device['indoor'] {
  const i = v as Record<string, unknown> | undefined;
  if (!i || typeof i !== 'object' || typeof i.buildingId !== 'string' || !/^[A-Z0-9-]{1,16}$/.test(i.buildingId)) return undefined;
  const level = typeof i.level === 'number' && Number.isFinite(i.level) ? Math.round(i.level) : 1;
  const positioning = ['slam', 'uwb', 'vision', 'fixed'].includes(i.positioning as string) ? (i.positioning as 'slam') : undefined;
  return { buildingId: i.buildingId, level: Math.max(-5, Math.min(200, level)), positioning };
}

const COMP_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Equipment list from a gateway declaration: bounded strings, known kinds and statuses, stream URLs on allowed origins. */
function sanitizeComponents(v: unknown, allowedOrigins: readonly string[]): { components: DeviceComponent[]; rejected: string[] } | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: DeviceComponent[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of v.slice(0, 32)) {
    const c = raw as Record<string, unknown>;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !COMP_ID.test(c.id) || seen.has(c.id)) continue;
    const name = str(c.name, 80);
    if (!name) continue;
    seen.add(c.id);
    const vetted = vetStream(
      c.stream,
      allowedOrigins,
      EDGE_STREAM_KEYS.filter((k) => k !== 'playback'),
    );
    rejected.push(...vetted.rejected.map((r) => `${c.id}.${r}`));
    const stream = vetted.stream;
    out.push({
      id: c.id,
      name,
      kind: COMPONENT_KINDS.includes(c.kind as ComponentKind) ? (c.kind as ComponentKind) : 'other',
      version: str(c.version, 60),
      status: COMPONENT_STATUSES.includes(c.status as ComponentStatus) ? (c.status as ComponentStatus) : 'pending',
      detail: str(c.detail, 160),
      facing: ['front', 'rear', 'left', 'right', 'down'].includes(c.facing as string) ? (c.facing as DeviceComponent['facing']) : undefined,
      stream,
    });
  }
  return { components: out, rejected };
}

function sanitizeComponentUpdates(v: unknown[]): ComponentUpdate[] {
  const out: ComponentUpdate[] = [];
  for (const raw of v.slice(0, 32)) {
    const u = raw as Record<string, unknown>;
    if (!u || typeof u !== 'object' || typeof u.id !== 'string' || !COMP_ID.test(u.id)) continue;
    out.push({
      id: u.id,
      status: COMPONENT_STATUSES.includes(u.status as ComponentStatus) ? (u.status as ComponentStatus) : undefined,
      version: str(u.version, 60),
      detail: str(u.detail, 160),
    });
  }
  return out;
}

/** Mount data from a gateway declaration: numbers only, sane ranges. */
function sanitizeMount(m: unknown): Device['mount'] {
  const v = m as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object') return undefined;
  const n = (x: unknown, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : undefined);
  const bearingDeg = n(v.bearingDeg, -360, 360);
  const heightM = n(v.heightM, 0, 200);
  if (bearingDeg === undefined || heightM === undefined) return undefined;
  return { bearingDeg: (bearingDeg + 360) % 360, heightM, fovDeg: n(v.fovDeg, 1, 120), rangeM: n(v.rangeM, 1, 5000) };
}
