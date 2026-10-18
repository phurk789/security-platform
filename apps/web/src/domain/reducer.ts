// State machine for the prototype. The reducer stands in for the server: every mutating
// message is re-checked here (role, control ownership, freshness, replay) even if the UI
// already hid the button — PRD F05/F06/F08/F12 and acceptance list §11.

import {
  COMMAND_ACK_TIMEOUT_MS,
  COMMAND_TTL_MS,
  LINK_LOSS_FAILSAFE_MS,
  applyCameraAction,
  describeCameraAction,
  actionCapability,
  isPayloadAction,
  aimAt,
  lineOfSight,
  mountOf,
  pickCamera,
  BUILDINGS,
  type Aim,
  gimbalSample,
  newSimGimbal,
  stepSimGimbal,
  type CameraAction,
  bearing,
  gaussian,
  newMotion,
  newSensors,
  readSensors,
  sampleLatency,
  stepMotion,
  stepSensors,
  UAV_PATROL,
  uavOnStation,
  uavOrbitPoint,
  can,
  constraintChecks,
  currentUser,
  freshness,
  isReady,
  userName,
  type Action,
} from './policy';
import { initialState } from './scenario';
import type { AppState, Command, CommandStatus, CommandType, Detection, Incident, Layers, Device, Mission, Point, TimelineEvent, VehicleSim, View } from '@13store/shared';
import { INDOOR_UGV_SPEED, floorPlan, pickPlaybook, routeCrossesWalls } from '@13store/shared';

export type Msg =
  | { type: 'tick'; dt: number }
  | { type: 'setUser'; userId: string }
  | { type: 'setView'; view: View }
  | { type: 'setMapMode'; mode: '2d' | '3d' }
  | { type: 'toggleLayer'; layer: keyof Layers }
  | { type: 'selectIncident'; id: string | null }
  | { type: 'selectDevice'; id: string | null }
  | { type: 'selectBuilding'; id: string | null }
  | { type: 'setIndoor'; view: { buildingId: string; level: number } | null }
  | { type: 'openCamera'; incidentId: string }
  | { type: 'confirmIncident'; incidentId: string }
  | { type: 'dismissIncident'; incidentId: string; reason: string }
  | { type: 'mergeIncident'; incidentId: string; intoId: string; reason: string }
  | { type: 'createMission'; incidentId: string; deviceId: string; operatorId: string; checkpoints: Point[] }
  | { type: 'editRoute'; missionId: string; checkpoints: Point[] }
  | { type: 'submitMission'; missionId: string }
  | { type: 'approveMission'; missionId: string }
  | { type: 'rejectMission'; missionId: string; reason: string }
  | { type: 'cancelMission'; missionId: string }
  | { type: 'acceptMission'; missionId: string }
  | { type: 'issueCommand'; missionId: string; command: CommandType; idempotencyKey: string }
  | { type: 'handover'; deviceId: string; toUserId: string }
  | { type: 'cameraControl'; deviceId: string; action: CameraAction }
  | { type: 'aimCamera'; deviceId: string; target: { incidentId: string } | Point }
  | { type: 'resolveIncident'; incidentId: string; outcome: string }
  | { type: 'closeIncident'; incidentId: string }
  | { type: 'addNote'; incidentId: string; text: string }
  | { type: 'setChecksum'; evidenceId: string; checksum: string }
  | { type: 'exportReport'; incidentId: string }
  | { type: 'demoInjectAlert' }
  | { type: 'demoInjectDetection'; kind?: 'person' | 'thermal_hotspot' }
  | { type: 'setStep'; incidentId: string; stepId: string; done: boolean }
  | { type: 'demoCutLink'; deviceId: string }
  | { type: 'demoRestoreLink'; deviceId: string }
  | { type: 'demoReset' }
  | { type: 'enterReplay'; at: number }
  | { type: 'seekReplay'; at: number }
  | { type: 'exitReplay' }
  | { type: 'dismissToast'; id: string }
  | { type: 'togglePresentation' }
  // Server-only actions (no-ops with a notice in the offline demo).
  | { type: 'assignResponder'; incidentId: string; responderId: string }
  | { type: 'reopenIncident'; incidentId: string; reason: string }
  | { type: 'editIncident'; incidentId: string; severity?: Incident['severity']; incidentType?: string }
  | { type: 'toast'; tone: 'info' | 'warn' | 'error' | 'ok'; text: string };

export function makeInitialState(): AppState {
  const s = initialState();
  // CCTV-04 is the offline camera behind INC-022.
  s.linkCut['CCTV-04'] = true;
  return s;
}

// ---------------------------------------------------------------------------
// helpers (mutate the draft)
// ---------------------------------------------------------------------------

function nextId(s: AppState, prefix: string) {
  s.seq += 1;
  return `${prefix}-${String(s.seq).padStart(4, '0')}`;
}

function toast(s: AppState, tone: 'info' | 'warn' | 'error' | 'ok', text: string) {
  s.toasts.push({ id: nextId(s, 'toast'), tone, text, at: s.now });
  if (s.toasts.length > 4) s.toasts.shift();
}

function audit(s: AppState, action: string, object: string, result: 'ok' | 'denied' | 'error', detail?: string) {
  const u = currentUser(s);
  s.audit.push({ id: nextId(s, 'AUD'), at: s.now, actor: u.name, role: u.role, action, object, result, detail });
}

/** Offline demo: give a new incident its playbook checklist, as the server does. */
export function attachPlaybook(s: Pick<AppState, 'playbooks'>, inc: Incident) {
  const book = pickPlaybook(s.playbooks, inc);
  if (!book) return;
  inc.playbookId = book.id;
  inc.checklist = book.steps.map((st) => ({ id: st.id, title: st.title, detail: st.detail, role: st.role }));
}

function event(s: AppState, incidentId: string, title: string, opts: Partial<TimelineEvent> = {}) {
  s.timeline.push({
    id: nextId(s, 'EVT'),
    incidentId,
    at: opts.at ?? s.now,
    receivedAt: opts.receivedAt ?? s.now,
    actor: opts.actor ?? currentUser(s).name,
    title,
    detail: opts.detail,
    tone: opts.tone,
  });
}

/** Server-side guard. Returns false (and records a denial) when the action is not allowed. */
function guard(s: AppState, action: Action, object: string, opts: { allowInReplay?: boolean } = {}) {
  if (s.replay.active && !opts.allowInReplay) {
    audit(s, action, object, 'denied', 'replay mode');
    toast(s, 'warn', 'You are viewing replay. Device control and changes are off.');
    return false;
  }
  const u = currentUser(s);
  if (!can(u.role, action)) {
    audit(s, action, object, 'denied', `role ${u.role} lacks ${action}`);
    toast(s, 'error', `Permission denied: ${u.role} cannot ${action.replace('.', ' ')}.`);
    return false;
  }
  return true;
}

function reject(s: AppState, action: string, object: string, why: string) {
  audit(s, action, object, 'error', why);
  toast(s, 'warn', why);
}

function incident(s: AppState, id: string) {
  return s.incidents.find((i) => i.id === id);
}

function mission(s: AppState, id: string) {
  return s.missions.find((m) => m.id === id);
}

export function missionForIncident(s: AppState, incidentId: string): Mission | undefined {
  const list = s.missions.filter((m) => m.incidentId === incidentId);
  return list[list.length - 1];
}

function setCmd(c: Command, status: CommandStatus, at: number, detail?: string) {
  c.status = status;
  c.history.push({ status, at });
  if (detail) c.detail = detail;
}

const TERMINAL: CommandStatus[] = ['succeeded', 'rejected', 'failed', 'timed_out', 'unknown'];
export const isTerminal = (c: Command) => TERMINAL.includes(c.status);

// ---------------------------------------------------------------------------
// simulation tick
// ---------------------------------------------------------------------------

/** Vehicle-side simulation state, created on first use. */
function simFor(s: AppState, d: Device): VehicleSim {
  s.sim ??= {};
  return (s.sim[d.id] ??= { motion: newMotion(d.pos, d.heading ?? 90, d.indoor ? INDOOR_UGV_SPEED : undefined), sensors: newSensors(d.battery ?? 100, d.kind) });
}

/** Auto-aim leaves a camera alone this long after an operator used it (same as the server). */
const MANUAL_CAMERA_HOLD_MS = 60_000;

function gimbalOf(s: AppState, d: Device) {
  const v = simFor(s, d);
  v.gimbal ??= newSimGimbal(d.kind === 'cctv' ? -7 : 0);
  return v;
}

/** Turn and zoom a simulated gimbal to an aim. */
function aimSim(s: AppState, d: Device, aim: Aim) {
  const v = gimbalOf(s, d);
  applyCameraAction(v.gimbal!, { action: 'gimbal_angle', yaw: aim.yaw, pitch: aim.pitch });
  if (d.capabilities.includes('zoom')) applyCameraAction(v.gimbal!, { action: 'zoom_to', level: aim.zoom });
}

/** New alert: the nearest fixed gimbal camera that can see it turns there, unless an operator is using it. */
function autoAim(s: AppState, inc: Incident) {
  const pick = pickCamera(
    Object.values(s.devices),
    inc.pos,
    BUILDINGS,
    (d) => !s.linkCut[d.id] && freshness(s, d) !== 'offline',
    (id) => s.now - (s.sim?.[id]?.cameraManualAt ?? -Infinity) < MANUAL_CAMERA_HOLD_MS,
  );
  if (!pick) return;
  aimSim(s, pick.device, pick.aim);
  inc.cameraId ??= pick.device.id;
  s.audit.push({
    id: nextId(s, 'AUD'),
    at: s.now,
    actor: 'Auto camera',
    role: 'system',
    action: 'camera.control',
    object: pick.device.id,
    result: 'ok',
    detail: `auto-point at ${inc.id} (yaw ${pick.aim.yaw}°, pitch ${pick.aim.pitch}°, ${pick.aim.zoom}×)`,
  });
  event(s, inc.id, `${pick.device.id} turned to the alert automatically`, {
    actor: 'Auto camera',
    detail: `${pick.aim.distanceM} m away, ${pick.aim.zoom}× zoom. Confirmed by the camera. Operators can take over at any time.`,
  });
}

/** The incident a simulated UAV should watch: an open, verified incident, preferring one with a live mission. */
function overwatchTarget(s: AppState): Incident | undefined {
  const open = s.incidents.filter((i) => i.status === 'confirmed' || i.status === 'responding');
  if (!open.length) return undefined;
  const withMission = open.find((i) => s.missions.some((m) => m.incidentId === i.id && ['assigned', 'executing', 'paused'].includes(m.status)));
  return withMission ?? open.sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** Quiet time after the last command before an indoor vehicle goes back to its own round, so an
 *  operator's stop is confirmed and stays visible. */
const FLOOR_PATROL_RESUME_MS = 20_000;

/**
 * Indoor patrol vehicles (capability `floor_patrol`) drive their floor's patrol route on a loop
 * whenever no mission holds them: the warehouse robot keeps doing rounds between alerts. It
 * rejoins the round at the nearest point it can reach without crossing a wall or rack.
 */
function floorPatrolStep(s: AppState, d: Device, v: VehicleSim) {
  if (!d.indoor || !d.capabilities.includes('floor_patrol')) return;
  const busy = s.missions.some((m) => m.deviceId === d.id && ['assigned', 'executing', 'paused'].includes(m.status));
  const lastCmd = Math.max(-Infinity, ...s.commands.filter((c) => c.deviceId === d.id).map((c) => c.issuedAt));
  const blocked = busy || s.linkCut[d.id] || v.failsafeAt !== undefined || (d.battery ?? 100) < 20 || s.now - lastCmd < FLOOR_PATROL_RESUME_MS;
  if (blocked) {
    // Stop the round (a mission's own route is never touched: starting one clears the flag).
    if (v.floorPatrol) {
      v.motion.intent = 'hold';
      v.motion.route = null;
    }
    v.floorPatrol = false;
    return;
  }
  const m = v.motion;
  if (v.floorPatrol && m.route && !m.done) return;
  const plan = floorPlan(d.indoor.buildingId, d.indoor.level);
  const loop = plan?.patrolRoute;
  if (!plan || !loop || loop.length < 2) return;
  const ring = loop[0].x === loop.at(-1)!.x && loop[0].y === loop.at(-1)!.y ? loop.slice(0, -1) : loop;
  const here = { x: m.x, y: m.y };
  let start = -1;
  let best = Infinity;
  ring.forEach((p, i) => {
    const dd = Math.hypot(p.x - here.x, p.y - here.y);
    if (dd < best && routeCrossesWalls([here, p], plan) < 0) {
      best = dd;
      start = i;
    }
  });
  if (start < 0) return; // nowhere reachable in a straight line: wait for an operator
  m.route = [...ring.slice(start), ...ring.slice(0, start), ring[start]].map((p) => ({ ...p }));
  m.nextCp = 0;
  m.done = false;
  m.intent = 'drive';
  m.brake = 'normal';
  v.floorPatrol = true;
}

function tick(s: AppState, dt: number) {
  s.now += dt;
  const sec = dt / 1000;

  // Vehicle side: physics, sensors and the link-loss failsafe run whether or not the platform hears them.
  for (const d of Object.values(s.devices)) {
    const v = simFor(s, d);
    if (d.kind === 'ugv') {
      if (s.linkCut[d.id]) {
        v.linkLostAt ??= s.now;
        if (v.failsafeAt === undefined && s.now - v.linkLostAt >= LINK_LOSS_FAILSAFE_MS && (v.motion.intent === 'drive' || v.motion.speed > 0)) {
          v.motion.intent = 'hold';
          v.motion.brake = 'hard';
          v.failsafeAt = s.now;
          s.failsafeAt[d.id] = s.now;
        }
      } else {
        v.linkLostAt = undefined;
      }
      floorPatrolStep(s, d, v);
      stepMotion(v.motion, sec);
    } else if (d.kind === 'uav') {
      // Overwatch (simulated): the orbit moves over a verified incident and back to the patrol loop after.
      const watch = d.capabilities.includes('overwatch') ? overwatchTarget(s) : undefined;
      v.orbit ??= { x: UAV_PATROL.cx, y: UAV_PATROL.cy };
      const next = uavOrbitPoint(v.orbit, watch ? watch.pos : null, s.now, sec, v.sensors.wind);
      if (watch && v.overwatchFor !== watch.id && uavOnStation(v.orbit, watch.pos)) {
        v.overwatchFor = watch.id;
        event(s, watch.id, `${d.id} overwatch on station`, {
          actor: d.id,
          tone: 'info',
          detail: 'Simulated flight: orbiting the alert at 40 m. Aerial view available on the device panel.',
        });
      }
      if (!watch) v.overwatchFor = undefined;
      const moved = Math.hypot(next.x - v.motion.x, next.y - v.motion.y);
      if (sec > 0 && moved < 20) {
        v.motion.speed = moved / sec;
        if (moved > 0.01) v.motion.heading = bearing(v.motion, next);
      }
      v.motion.x = next.x;
      v.motion.y = next.y;
    }
    stepSensors(v.sensors, sec, d.kind, d.kind === 'ugv' ? v.motion.speed : 0);
    if (['gimbal', 'spotlight', 'beacon', 'speaker'].some((c) => d.capabilities.includes(c))) {
      v.gimbal ??= newSimGimbal(d.kind === 'cctv' ? -7 : 0);
      stepSimGimbal(v.gimbal, sec);
      // Attitude rides with the video stream, so it updates every tick while the link is up.
      if (!s.linkCut[d.id]) d.gimbal = gimbalSample(v.gimbal);
    }
  }

  // Platform side: what arrives over the radio, at each device's telemetry rate.
  for (const d of Object.values(s.devices)) {
    if (s.linkCut[d.id]) continue; // no telemetry arrives
    if (s.now - d.lastSeen < d.rateMs) continue;
    const v = simFor(s, d);

    if (d.kind === 'ugv') {
      if (v.failsafeAt !== undefined) {
        // First telemetry after reconnect: the vehicle reports it stopped itself.
        v.failsafeAt = undefined;
        s.failsafeAt[d.id] = undefined;
        const m = s.missions.find((x) => x.deviceId === d.id && x.status === 'executing');
        if (m) {
          m.status = 'paused';
          m.note = 'Vehicle stopped by link-loss failsafe. Operator must resume.';
          event(s, m.incidentId, `${d.id} reconnected — stopped by link-loss failsafe`, {
            actor: d.id,
            tone: 'warn',
            detail: 'No queued commands were replayed. Mission paused until the operator resumes.',
          });
        }
      }
      report(s, d, v);
      const m = s.missions.find((x) => x.deviceId === d.id && (x.status === 'executing' || x.status === 'paused'));
      if (m && v.motion.route) {
        m.nextCp = v.motion.nextCp;
        if (v.motion.done && m.status === 'executing') completeMission(s, m);
      }
    } else if (d.kind === 'uav') {
      report(s, d, v);
      d.alt = Math.round((40 + gaussian() * 0.25) * 10) / 10;
    } else {
      d.signal = readSensors(v.sensors, d.pos, 'cctv').signal;
      d.latencyMs = sampleLatency(d.signal);
    }

    d.lastSeen = s.now;
    if (d.kind !== 'cctv') {
      s.telemetry.push({ deviceId: d.id, at: s.now, x: d.pos.x, y: d.pos.y, speed: d.speed, battery: d.battery, signal: d.signal, heading: d.heading });
      if (s.telemetry.length > 4000) s.telemetry.splice(0, s.telemetry.length - 4000);
    }
  }

  for (const c of s.commands) {
    if (isTerminal(c)) continue;
    progressCommand(s, c);
  }
}

/** Copy what the device would report (noisy fix, honest accuracy, link quality) onto the platform's record. */
function report(s: AppState, d: Device, v: VehicleSim) {
  const r = readSensors(v.sensors, { x: v.motion.x, y: v.motion.y }, d.kind, { slam: d.indoor?.positioning === 'slam' });
  d.pos = r.pos;
  d.accuracyM = r.accuracyM;
  d.battery = r.battery;
  d.speed = Math.round(v.motion.speed * (d.kind === 'uav' ? 10 : 100)) / (d.kind === 'uav' ? 10 : 100);
  d.heading = Math.round(v.motion.heading);
  d.signal = r.signal;
  d.satellites = r.satellites;
  d.temperatureC = r.temperatureC;
  d.latencyMs = sampleLatency(r.signal);
  void s;
}

function completeMission(s: AppState, m: Mission) {
  const deviceId = m.deviceId;
  m.status = 'completed';
  m.nextCp = m.checkpoints.length;
  const inc = incident(s, m.incidentId);
  event(s, m.incidentId, `${deviceId} reached final checkpoint`, {
    actor: deviceId,
    tone: 'ok',
    detail: 'Arrival confirmed by vehicle telemetry. Onboard camera snapshot attached.',
  });
  s.evidence.push({
    id: nextId(s, 'EV'),
    incidentId: m.incidentId,
    kind: 'snapshot',
    title: `${deviceId} onboard camera at ${inc?.place ?? 'checkpoint'}`,
    source: deviceId,
    capturedAt: s.now,
    recordedBy: deviceId,
    simulated: true,
  });
}

/** The device starts doing what the command asks (vehicle side). */
function actuate(s: AppState, c: Command) {
  const d = s.devices[c.deviceId];
  const m = mission(s, c.missionId);
  if (!d || !m) return;
  simFor(s, d).floorPatrol = false; // a command from the platform always takes over from the round
  const v = simFor(s, d).motion;
  switch (c.type) {
    case 'start':
      v.route = m.checkpoints.map((p) => ({ ...p }));
      v.nextCp = m.nextCp;
      v.done = false;
      v.intent = 'drive';
      v.brake = 'normal';
      break;
    case 'resume':
      v.intent = 'drive';
      v.brake = 'normal';
      break;
    case 'pause':
      v.intent = 'hold';
      v.brake = 'normal';
      break;
    case 'stop':
      v.intent = 'hold';
      v.brake = 'normal';
      v.route = null;
      break;
  }
}

/** True once the vehicle really does it: moving for start/resume, stopped for pause/stop. */
function effectConfirmed(s: AppState, c: Command) {
  const d = s.devices[c.deviceId];
  if (!d) return false;
  const v = simFor(s, d).motion;
  return c.type === 'start' || c.type === 'resume' ? v.speed > 0 || v.done : v.speed === 0;
}

function progressCommand(s: AppState, c: Command) {
  const t = s.now - c.issuedAt;
  const linkOk = !s.linkCut[c.deviceId];
  const m = mission(s, c.missionId);

  switch (c.status) {
    case 'requested':
    case 'authorized':
      if (t >= 200) setCmd(c, 'sent', s.now);
      return;
    case 'sent':
      if (linkOk && t >= 700 && s.now <= c.expiresAt) {
        c.delivered = true;
        setCmd(c, 'acknowledged', s.now);
      } else if (t >= COMMAND_ACK_TIMEOUT_MS || s.now > c.expiresAt) {
        setCmd(c, 'timed_out', s.now, 'No acknowledgement from the device. Result unknown — check with the field operator.');
        if (m) event(s, m.incidentId, `${c.type.toUpperCase()} request timed out`, { actor: 'Platform', tone: 'warn', detail: c.detail });
      }
      return;
    case 'acknowledged':
      if (!linkOk) {
        if (t >= COMMAND_ACK_TIMEOUT_MS + 1000) setCmd(c, 'unknown', s.now, 'Device acknowledged but stopped reporting. Outcome unknown.');
        return;
      }
      if (t >= 1000) {
        setCmd(c, 'executing', s.now);
        actuate(s, c);
      }
      return;
    case 'executing':
      if (!linkOk) {
        if (t >= COMMAND_ACK_TIMEOUT_MS + 1000) setCmd(c, 'unknown', s.now, 'Device stopped reporting before confirming. Outcome unknown.');
        return;
      }
      if (t >= 1100 && effectConfirmed(s, c)) applyCommand(s, c);
      else if (t >= 12_000) setCmd(c, 'failed', s.now, 'Effect not confirmed by the vehicle.');
      return;
  }
}

function applyCommand(s: AppState, c: Command) {
  const m = mission(s, c.missionId);
  const d = s.devices[c.deviceId];
  if (!m) return setCmd(c, 'failed', s.now, 'Mission not found');
  switch (c.type) {
    case 'start':
      m.status = 'executing';
      m.note = undefined;
      {
        const inc = incident(s, m.incidentId);
        if (inc && inc.status === 'confirmed') inc.status = 'responding';
      }
      event(s, m.incidentId, `Mission ${m.id} started`, { actor: d.id, tone: 'ok', detail: 'Start confirmed by the vehicle.' });
      break;
    case 'pause':
      m.status = 'paused';
      d.speed = 0;
      event(s, m.incidentId, `${d.id} paused`, { actor: d.id, detail: 'Hold confirmed by vehicle telemetry (speed 0).' });
      break;
    case 'resume':
      m.status = 'executing';
      m.note = undefined;
      event(s, m.incidentId, `${d.id} resumed`, { actor: d.id });
      break;
    case 'stop':
      m.status = 'cancelled';
      d.speed = 0;
      event(s, m.incidentId, `${d.id} stopped`, { actor: d.id, tone: 'warn', detail: 'Stop confirmed by vehicle telemetry (speed 0). Mission ended.' });
      break;
  }
  setCmd(c, 'succeeded', s.now);
}

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------

export function reducer(prev: AppState, msg: Msg): AppState {
  const s: AppState = structuredClone(prev);
  const me = currentUser(s);

  switch (msg.type) {
    case 'tick':
      tick(s, msg.dt);
      return s;

    case 'setUser':
      s.userId = msg.userId;
      return s;
    case 'setView':
      s.view = msg.view;
      return s;
    case 'setMapMode':
      s.mapMode = msg.mode;
      return s;
    case 'toggleLayer':
      s.layers[msg.layer] = !s.layers[msg.layer];
      return s;
    case 'selectIncident':
      s.selectedIncidentId = msg.id;
      s.selectedDeviceId = null;
      s.selectedBuildingId = null;
      return s;
    case 'selectDevice':
      s.selectedDeviceId = msg.id;
      if (msg.id) {
        s.selectedBuildingId = null;
        const d = s.devices[msg.id];
        if (d?.indoor) s.indoorView = { buildingId: d.indoor.buildingId, level: d.indoor.level };
      }
      return s;
    case 'setIndoor':
      s.indoorView = msg.view;
      return s;
    case 'selectBuilding':
      s.selectedBuildingId = msg.id;
      if (msg.id) s.selectedDeviceId = null;
      return s;
    case 'dismissToast':
      s.toasts = s.toasts.filter((t) => t.id !== msg.id);
      return s;
    case 'togglePresentation':
      s.presentation = !s.presentation;
      return s;
    case 'toast':
      toast(s, msg.tone, msg.text);
      return s;
    case 'assignResponder':
    case 'reopenIncident':
    case 'editIncident':
      toast(s, 'info', 'Available when connected to the platform server.');
      return s;

    // -- incidents ----------------------------------------------------------
    case 'openCamera': {
      const inc = incident(s, msg.incidentId);
      if (!inc || !guard(s, 'incident.triage', msg.incidentId)) return s;
      if (inc.status === 'new') {
        inc.status = 'triaging';
        inc.owner = me.name;
        event(s, inc.id, 'Camera opened', { detail: `${inc.cameraId ?? 'Camera'} stream available for review.` });
        event(s, inc.id, 'Operator reviewing', { detail: 'Monitoring feed and verifying the situation.' });
        audit(s, 'incident.triage', inc.id, 'ok');
      }
      return s;
    }
    case 'confirmIncident': {
      const inc = incident(s, msg.incidentId);
      if (!inc || !guard(s, 'incident.verify', msg.incidentId)) return s;
      if (!['new', 'triaging'].includes(inc.status)) return (reject(s, 'incident.verify', inc.id, 'Incident is not awaiting verification.'), s);
      inc.status = 'confirmed';
      inc.owner = me.name;
      event(s, inc.id, 'Verified — action required', { tone: 'ok', detail: 'Verified by operator from camera review.' });
      audit(s, 'incident.confirm', inc.id, 'ok');
      return s;
    }
    case 'dismissIncident': {
      const inc = incident(s, msg.incidentId);
      if (!inc || !guard(s, 'incident.verify', msg.incidentId)) return s;
      if (!msg.reason.trim()) return (reject(s, 'incident.dismiss', inc.id, 'A reason is required.'), s);
      inc.status = 'dismissed';
      inc.outcome = msg.reason;
      event(s, inc.id, 'Dismissed as false alarm', { detail: msg.reason });
      audit(s, 'incident.dismiss', inc.id, 'ok', msg.reason);
      return s;
    }
    case 'mergeIncident': {
      const inc = incident(s, msg.incidentId);
      const into = incident(s, msg.intoId);
      if (!inc || !into || !guard(s, 'incident.verify', msg.incidentId)) return s;
      if (!msg.reason.trim()) return (reject(s, 'incident.merge', inc.id, 'A reason is required.'), s);
      if (inc.id === into.id) return (reject(s, 'incident.merge', inc.id, 'Cannot merge an incident into itself.'), s);
      inc.status = 'duplicate';
      inc.duplicateOf = into.id;
      inc.outcome = msg.reason;
      event(s, inc.id, `Merged into ${into.id}`, { detail: msg.reason });
      event(s, into.id, `${inc.id} merged into this incident`, { detail: `Original evidence retained under ${inc.id}. ${msg.reason}` });
      audit(s, 'incident.merge', inc.id, 'ok', `into ${into.id}`);
      return s;
    }
    case 'resolveIncident': {
      const inc = incident(s, msg.incidentId);
      if (!inc || !guard(s, 'incident.resolve', msg.incidentId)) return s;
      if (!['confirmed', 'responding'].includes(inc.status)) return (reject(s, 'incident.resolve', inc.id, 'Only confirmed or responding incidents can be resolved.'), s);
      const active = s.missions.find((m) => m.incidentId === inc.id && ['executing', 'paused'].includes(m.status));
      if (active) return (reject(s, 'incident.resolve', inc.id, `Mission ${active.id} is still active. End it first.`), s);
      inc.status = 'resolved';
      inc.outcome = msg.outcome;
      event(s, inc.id, 'Resolved', { tone: 'ok', detail: msg.outcome });
      audit(s, 'incident.resolve', inc.id, 'ok', msg.outcome);
      return s;
    }
    case 'closeIncident': {
      const inc = incident(s, msg.incidentId);
      if (!inc || !guard(s, 'incident.close', msg.incidentId)) return s;
      if (inc.status !== 'resolved') return (reject(s, 'incident.close', inc.id, 'Resolve the incident before closing it.'), s);
      inc.status = 'closed';
      event(s, inc.id, 'Closed', { tone: 'ok' });
      audit(s, 'incident.close', inc.id, 'ok');
      return s;
    }
    case 'addNote': {
      const inc = incident(s, msg.incidentId);
      if (!inc || !guard(s, 'evidence.add', msg.incidentId) || !msg.text.trim()) return s;
      s.evidence.push({
        id: nextId(s, 'EV'),
        incidentId: inc.id,
        kind: 'note',
        title: msg.text.trim(),
        source: 'Operator note',
        capturedAt: s.now,
        recordedBy: me.name,
        simulated: false,
      });
      event(s, inc.id, 'Note attached', { detail: msg.text.trim() });
      audit(s, 'evidence.add', inc.id, 'ok');
      return s;
    }
    case 'setChecksum': {
      const ev = s.evidence.find((e) => e.id === msg.evidenceId);
      if (ev && !ev.checksum) ev.checksum = msg.checksum;
      return s;
    }
    case 'exportReport': {
      if (!guard(s, 'evidence.export', msg.incidentId, { allowInReplay: true })) return s;
      audit(s, 'report.export', msg.incidentId, 'ok', 'Markdown report downloaded');
      toast(s, 'ok', `Report for ${msg.incidentId} exported. Download recorded in audit log.`);
      return s;
    }

    // -- missions -----------------------------------------------------------
    case 'createMission': {
      const inc = incident(s, msg.incidentId);
      const d = s.devices[msg.deviceId];
      if (!inc || !d || !guard(s, 'mission.prepare', msg.incidentId)) return s;
      if (inc.status !== 'confirmed') return (reject(s, 'mission.prepare', inc.id, 'Verify the incident before preparing a mission.'), s);
      if (!isReady(s, d)) return (reject(s, 'mission.prepare', d.id, `${d.id} is not ready.`), s);
      const m: Mission = {
        id: nextId(s, 'MSN'),
        incidentId: inc.id,
        deviceId: d.id,
        operatorId: msg.operatorId,
        checkpoints: msg.checkpoints.map((p) => ({ ...p })),
        planVersion: 1,
        status: 'draft',
        nextCp: 0,
        createdAt: s.now,
      };
      s.missions.push(m);
      event(s, inc.id, `Mission ${m.id} drafted`, { detail: `${d.id}, ${m.checkpoints.length} checkpoints, operator ${userName(s, m.operatorId)}.` });
      audit(s, 'mission.create', m.id, 'ok');
      return s;
    }
    case 'editRoute': {
      const m = mission(s, msg.missionId);
      if (!m || !guard(s, 'mission.prepare', msg.missionId)) return s;
      if (!['draft', 'pending_approval', 'approved', 'assigned', 'rejected'].includes(m.status))
        return (reject(s, 'mission.edit', m.id, 'Route cannot be changed while the mission is running.'), s);
      m.checkpoints = msg.checkpoints.map((p) => ({ ...p }));
      m.planVersion += 1;
      if (m.status === 'approved' || m.status === 'assigned') {
        m.status = 'pending_approval';
        toast(s, 'warn', 'Route changed. Re-approval required.');
        event(s, m.incidentId, 'Route changed after approval — re-approval required', { tone: 'warn', detail: `Plan v${m.planVersion}; approved plan was v${m.approvedVersion}.` });
      } else {
        event(s, m.incidentId, `Route updated (plan v${m.planVersion})`);
      }
      audit(s, 'mission.edit', m.id, 'ok', `plan v${m.planVersion}`);
      return s;
    }
    case 'submitMission': {
      const m = mission(s, msg.missionId);
      if (!m || !guard(s, 'mission.prepare', msg.missionId)) return s;
      if (!['draft', 'rejected'].includes(m.status)) return (reject(s, 'mission.submit', m.id, 'Mission is not a draft.'), s);
      m.status = 'pending_approval';
      event(s, m.incidentId, 'Approval requested', { detail: `Mission ${m.id} plan v${m.planVersion} sent to supervisor.` });
      audit(s, 'mission.submit', m.id, 'ok');
      return s;
    }
    case 'approveMission': {
      const m = mission(s, msg.missionId);
      if (!m || !guard(s, 'mission.approve', msg.missionId)) return s;
      if (m.status !== 'pending_approval') return (reject(s, 'mission.approve', m.id, 'Mission is not awaiting approval.'), s);
      const failed = constraintChecks(s, m).filter((c) => c.hard && !c.ok);
      if (failed.length) return (reject(s, 'mission.approve', m.id, `Cannot approve: ${failed.map((f) => f.label).join(', ')}.`), s);
      m.status = 'approved';
      m.approvedVersion = m.planVersion;
      m.approvedBy = me.id;
      event(s, m.incidentId, 'Mission approved', { tone: 'ok', detail: `Plan v${m.planVersion} approved by ${me.name}. Waiting for operator to accept.` });
      audit(s, 'mission.approve', m.id, 'ok', `plan v${m.planVersion}`);
      return s;
    }
    case 'rejectMission': {
      const m = mission(s, msg.missionId);
      if (!m || !guard(s, 'mission.approve', msg.missionId)) return s;
      if (m.status !== 'pending_approval') return (reject(s, 'mission.reject', m.id, 'Mission is not awaiting approval.'), s);
      if (!msg.reason.trim()) return (reject(s, 'mission.reject', m.id, 'A reason is required.'), s);
      m.status = 'rejected';
      m.note = msg.reason;
      event(s, m.incidentId, 'Mission rejected', { tone: 'warn', detail: msg.reason });
      audit(s, 'mission.reject', m.id, 'ok', msg.reason);
      return s;
    }
    case 'cancelMission': {
      const m = mission(s, msg.missionId);
      if (!m || !guard(s, 'mission.prepare', msg.missionId)) return s;
      if (!['draft', 'pending_approval', 'approved', 'assigned', 'rejected'].includes(m.status))
        return (reject(s, 'mission.cancel', m.id, 'A running mission must be stopped by its operator.'), s);
      m.status = 'cancelled';
      const d = s.devices[m.deviceId];
      if (d.controlOwner === m.operatorId) d.controlOwner = undefined;
      event(s, m.incidentId, `Mission ${m.id} cancelled`);
      audit(s, 'mission.cancel', m.id, 'ok');
      return s;
    }
    case 'acceptMission': {
      const m = mission(s, msg.missionId);
      if (!m || !guard(s, 'mission.accept', msg.missionId)) return s;
      if (m.operatorId !== me.id) return (reject(s, 'mission.accept', m.id, 'This mission is assigned to another operator.'), s);
      if (m.status !== 'approved' || m.approvedVersion !== m.planVersion) return (reject(s, 'mission.accept', m.id, 'Mission needs an approved plan first.'), s);
      const d = s.devices[m.deviceId];
      if (d.controlOwner && d.controlOwner !== me.id)
        return (reject(s, 'mission.accept', d.id, `Control of ${d.id} is held by ${userName(s, d.controlOwner)}. A handover is required.`), s);
      d.controlOwner = me.id;
      m.status = 'assigned';
      event(s, m.incidentId, 'Operator accepted mission', { detail: `${me.name} confirmed readiness and holds control of ${d.id}.` });
      audit(s, 'mission.accept', m.id, 'ok');
      audit(s, 'control.acquire', d.id, 'ok');
      return s;
    }
    case 'cameraControl': {
      const d = s.devices[msg.deviceId];
      const perm = isPayloadAction(msg.action) ? 'payload.control' : 'camera.control';
      if (!d || !guard(s, perm, msg.deviceId)) return s;
      if (!d.capabilities.includes(actionCapability(msg.action))) {
        toast(s, 'warn', `${d.id} cannot do that (${actionCapability(msg.action)}).`);
        return s;
      }
      if (d.kind !== 'cctv' && d.controlOwner && d.controlOwner !== me.id) {
        audit(s, 'camera.control', d.id, 'denied', 'another operator holds control');
        toast(s, 'warn', `Another operator holds control of ${d.id}.`);
        return s;
      }
      if (s.linkCut[d.id]) {
        audit(s, 'camera.control', d.id, 'error', `${describeCameraAction(msg.action)} — camera not responding`);
        return s;
      }
      const v = gimbalOf(s, d);
      v.cameraManualAt = s.now;
      const answer = applyCameraAction(v.gimbal!, msg.action);
      d.gimbal = gimbalSample(v.gimbal!);
      audit(s, perm, d.id, 'ok', `${describeCameraAction(msg.action)} — ${answer}`);
      if (['photo', 'record', 'announce'].includes(msg.action.action)) toast(s, 'ok', `${d.id}: ${answer}`);
      return s;
    }
    case 'aimCamera': {
      const d = s.devices[msg.deviceId];
      if (!d || !guard(s, 'camera.control', msg.deviceId)) return s;
      const inc = 'incidentId' in msg.target ? incident(s, msg.target.incidentId) : undefined;
      const target = inc ? inc.pos : 'x' in msg.target ? msg.target : null;
      const mount = mountOf(d);
      if (!target || !mount || !d.capabilities.includes('gimbal')) {
        toast(s, 'warn', `${d.id} cannot be pointed at that place.`);
        return s;
      }
      if (d.kind !== 'cctv' && d.controlOwner && d.controlOwner !== me.id) {
        audit(s, 'camera.control', d.id, 'denied', 'another operator holds control');
        toast(s, 'warn', `Another operator holds control of ${d.id}.`);
        return s;
      }
      const aim = aimAt(d.pos, mount, target);
      const label = inc ? inc.id : `${target.x.toFixed(0)}, ${target.y.toFixed(0)} m`;
      if (!aim.reachable || s.linkCut[d.id]) {
        audit(s, 'camera.control', d.id, 'error', `point at ${label} — ${s.linkCut[d.id] ? 'camera not responding' : 'out of reach'}`);
        toast(s, 'warn', s.linkCut[d.id] ? `${d.id} is not responding.` : `${d.id} cannot turn that far.`);
        return s;
      }
      aimSim(s, d, aim);
      gimbalOf(s, d).cameraManualAt = s.now;
      audit(s, 'camera.control', d.id, 'ok', `point at ${label} (yaw ${aim.yaw}°, pitch ${aim.pitch}°, ${aim.zoom}×, ${aim.distanceM} m)`);
      if (!lineOfSight(d.pos, target, BUILDINGS, mount.heightM)) toast(s, 'warn', `${d.id}: a building may block the view of ${label}.`);
      return s;
    }
    case 'handover': {
      const d = s.devices[msg.deviceId];
      if (!d || !guard(s, 'control.handover', msg.deviceId)) return s;
      const from = d.controlOwner;
      d.controlOwner = msg.toUserId;
      const m = s.missions.find((x) => x.deviceId === d.id && ['assigned', 'executing', 'paused'].includes(x.status));
      if (m) {
        m.operatorId = msg.toUserId;
        event(s, m.incidentId, `Control of ${d.id} handed over`, { detail: `${userName(s, from)} → ${userName(s, msg.toUserId)}` });
      }
      audit(s, 'control.handover', d.id, 'ok', `${userName(s, from)} → ${userName(s, msg.toUserId)}`);
      return s;
    }
    case 'issueCommand':
      issueCommand(s, msg.missionId, msg.command, msg.idempotencyKey);
      return s;

    // -- demo controls ------------------------------------------------------
    case 'demoInjectAlert': {
      if (!guard(s, 'demo.control', 'scenario')) return s;
      const n = 25 + s.incidents.filter((i) => Number(i.id.slice(4)) >= 25).length;
      const inc: Incident = {
        id: `INC-0${n}`,
        title: 'Repeated gate sensor trigger',
        type: 'Sensor alert',
        severity: 'medium',
        status: 'new',
        zone: 'Zone B',
        place: 'Service gate',
        pos: { x: 341, y: 238 },
        source: 'Gate sensor SG-2 (simulated)',
        createdAt: s.now,
        cameraId: 'CCTV-02',
        thumb: 'gate',
      };
      attachPlaybook(s, inc);
      s.incidents.unshift(inc);
      event(s, inc.id, 'Alert received', { actor: 'Gate sensor SG-2', tone: 'alert', receivedAt: s.now + 600, detail: 'Same sensor as INC-024. Possible duplicate.' });
      autoAim(s, inc);
      toast(s, 'info', `New simulated alert ${inc.id}: ${inc.title}.`);
      return s;
    }
    case 'setStep': {
      const inc = incident(s, msg.incidentId);
      const step = inc?.checklist?.find((x) => x.id === msg.stepId);
      if (!inc || !step) return s;
      if (!guard(s, 'evidence.add', msg.incidentId)) return s;
      const me = s.users.find((u) => u.id === s.userId);
      step.doneAt = msg.done ? s.now : undefined;
      step.by = msg.done ? me?.name : undefined;
      event(s, inc.id, msg.done ? `Step done: ${step.title}` : `Step reopened: ${step.title}`, { tone: msg.done ? 'ok' : undefined });
      audit(s, 'incident.step', `${inc.id}:${step.id}`, 'ok', msg.done ? 'done' : 'reopened');
      return s;
    }
    case 'demoInjectDetection': {
      // Offline demo of the AI detection path: what the server's rules would do with an analytics event.
      if (!guard(s, 'demo.control', 'scenario')) return s;
      const thermal = msg.kind === 'thermal_hotspot';
      const n = 25 + s.incidents.filter((i) => Number(i.id.slice(4)) >= 25).length;
      const source = thermal ? 'Thermal analytics (simulated)' : 'Video analytics (simulated)';
      const inc: Incident = {
        id: `INC-0${n}`,
        title: thermal ? 'Thermal hotspot 78.5 °C · CCTV-02' : 'Person detected · CCTV-02',
        type: thermal ? 'Detection: Thermal hotspot' : 'Detection: Person',
        severity: thermal ? 'high' : 'medium',
        status: 'new',
        zone: 'Zone B',
        place: thermal ? 'Service gate · transformer' : 'Service gate',
        pos: thermal ? { x: 352, y: 232 } : { x: 341, y: 238 },
        source,
        createdAt: s.now,
        cameraId: 'CCTV-02',
        thumb: 'gate',
      };
      attachPlaybook(s, inc);
      s.incidents.unshift(inc);
      event(s, inc.id, 'Alert received', { actor: source, tone: 'alert', detail: `${inc.type.replace('Detection: ', '')} reported.` });
      event(s, inc.id, 'Detection details', { actor: source, detail: thermal ? `${source} · confidence 93% · 78.5 °C` : `${source} · confidence 87% · box 47/49/10/39%` });
      s.evidence.push({
        id: nextId(s, 'EV'),
        incidentId: inc.id,
        kind: 'snapshot',
        title: `${source}: ${inc.title.split(' · ')[0]}`,
        source,
        capturedAt: s.now,
        recordedBy: source,
        simulated: true,
      });
      event(s, inc.id, 'Snapshot attached', { actor: source, detail: `${source}: ${inc.title.split(' · ')[0]}` });
      const det: Detection = {
        id: nextId(s, 'DET'),
        at: s.now,
        receivedAt: s.now,
        type: thermal ? 'thermal_hotspot' : 'person',
        confidence: thermal ? 0.93 : 0.87,
        source,
        deviceId: 'CCTV-02',
        zone: inc.zone,
        place: inc.place,
        pos: inc.pos,
        attributes: thermal ? { temperatureC: 78.5 } : undefined,
        bbox: thermal ? [0.58, 0.42, 0.12, 0.16] : [0.47, 0.49, 0.1, 0.39],
        outcome: 'incident',
        incidentId: inc.id,
        ruleId: thermal ? 'fire' : 'intrusion',
      };
      s.detections = [det, ...s.detections].slice(0, 200);
      autoAim(s, inc);
      toast(s, 'info', `AI detection ${inc.id}: ${inc.title} (rule: ${thermal ? 'fire' : 'intrusion'}).`);
      return s;
    }
    case 'demoCutLink': {
      if (!guard(s, 'demo.control', msg.deviceId, { allowInReplay: true })) return s;
      // Vehicle side (see tick): it keeps going for the failsafe delay, then brakes to a stop (PRD §8).
      s.linkCut[msg.deviceId] = true;
      audit(s, 'demo.cut_link', msg.deviceId, 'ok');
      toast(s, 'warn', `Demo: network to ${msg.deviceId} cut.`);
      return s;
    }
    case 'demoRestoreLink': {
      if (!guard(s, 'demo.control', msg.deviceId, { allowInReplay: true })) return s;
      s.linkCut[msg.deviceId] = false;
      // Commands never delivered before expiry are dropped, not replayed (F09).
      for (const c of s.commands) {
        if (c.deviceId === msg.deviceId && !isTerminal(c) && !c.delivered) {
          setCmd(c, 'timed_out', s.now, 'Expired during link loss. Not delivered on reconnect.');
        }
      }
      audit(s, 'demo.restore_link', msg.deviceId, 'ok');
      toast(s, 'info', `Demo: network to ${msg.deviceId} restored.`);
      return s;
    }
    case 'demoReset': {
      const fresh = makeInitialState();
      fresh.presentation = s.presentation;
      fresh.toasts = [{ id: 'toast-reset', tone: 'info', text: 'Demo dataset reset.', at: fresh.now }];
      return fresh;
    }

    // -- replay -------------------------------------------------------------
    case 'enterReplay':
      s.replay = { active: true, at: Math.min(msg.at, s.now) };
      s.view = s.view === 'evidence' ? 'evidence' : s.view;
      audit(s, 'replay.enter', s.selectedIncidentId ?? 'site', 'ok');
      return s;
    case 'seekReplay':
      s.replay.at = Math.min(msg.at, s.now);
      return s;
    case 'exitReplay':
      s.replay = { active: false, at: s.now };
      return s;
  }
}

function issueCommand(s: AppState, missionId: string, type: CommandType, key: string) {
  const object = `${missionId}:${type}`;
  if (!guard(s, 'device.command', object)) return;
  const me = currentUser(s);
  const m = mission(s, missionId);
  if (!m) return reject(s, 'device.command', object, 'Mission not found.');
  const d = s.devices[m.deviceId];

  // Idempotency: the same key never creates a second command (F07).
  const dupe = s.commands.find((c) => c.idempotencyKey === key);
  if (dupe) {
    audit(s, 'device.command', object, 'ok', `duplicate key ${key} ignored`);
    toast(s, 'info', `Duplicate ${type} request ignored (same idempotency key). Tracking ${dupe.id}.`);
    return;
  }

  const fail = (why: string) => {
    const c = newCommand(s, m, type, key, me.id);
    setCmd(c, 'rejected', s.now, why);
    reject(s, 'device.command', object, why);
  };

  if (!d.commands.includes(type)) return fail(`${d.id} adapter does not support ${type}.`);
  if (d.controlOwner !== me.id)
    return fail(
      d.controlOwner ? `Control of ${d.id} is held by ${userName(s, d.controlOwner)}. A handover is required.` : `You do not hold control of ${d.id}. Accept the mission first.`,
    );

  const valid: Record<CommandType, Mission['status'][]> = {
    start: ['assigned'],
    pause: ['executing'],
    resume: ['paused'],
    stop: ['executing', 'paused'],
  };
  if (!valid[type].includes(m.status)) return fail(`Cannot ${type} while mission is ${m.status.replace('_', ' ')}.`);
  if (type === 'start' && m.approvedVersion !== m.planVersion) return fail('Plan changed since approval. Re-approval required.');

  const fresh = freshness(s, d);
  if ((type === 'start' || type === 'resume') && fresh !== 'live') return fail(`Telemetry is ${fresh}. New ${type} commands are held until data is fresh.`);

  const pending = s.commands.find((c) => c.missionId === m.id && !isTerminal(c));
  if (pending && type !== 'stop') return fail(`Waiting for ${pending.type} (${pending.id}) to finish.`);

  const c = newCommand(s, m, type, key, me.id);
  setCmd(c, 'authorized', s.now);
  event(s, m.incidentId, `${type.toUpperCase()} requested`, { detail: `${c.id} sent to ${d.id}. Waiting for device response.` });
  audit(s, 'device.command', object, 'ok', c.id);
  if (fresh !== 'live') toast(s, 'warn', `Telemetry is ${fresh}. The ${type} request was sent but the result may be unknown.`);
}

function newCommand(s: AppState, m: Mission, type: CommandType, key: string, issuer: string): Command {
  const c: Command = {
    id: nextId(s, 'CMD'),
    idempotencyKey: key,
    missionId: m.id,
    deviceId: m.deviceId,
    type,
    issuer,
    issuedAt: s.now,
    expiresAt: s.now + COMMAND_TTL_MS,
    status: 'requested',
    history: [{ status: 'requested', at: s.now }],
    delivered: false,
  };
  s.commands.push(c);
  return c;
}
