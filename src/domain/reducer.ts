// State machine for the prototype. The reducer stands in for the server: every mutating
// message is re-checked here (role, control ownership, freshness, replay) even if the UI
// already hid the button — PRD F05/F06/F08/F12 and acceptance list §11.

import {
  COMMAND_ACK_TIMEOUT_MS,
  UGV_SPEED,
  can,
  currentUser,
  dist,
  freshness,
  isReady,
  userName,
  type Action,
} from './policy';
import { initialState } from './scenario';
import type {
  AppState,
  Command,
  CommandStatus,
  CommandType,
  Incident,
  Layers,
  Mission,
  Point,
  TimelineEvent,
  View,
} from './types';
import { COMMAND_TTL_MS } from './policy';

export type Msg =
  | { type: 'tick'; dt: number }
  | { type: 'setUser'; userId: string }
  | { type: 'setView'; view: View }
  | { type: 'setMapMode'; mode: '2d' | '3d' }
  | { type: 'toggleLayer'; layer: keyof Layers }
  | { type: 'selectIncident'; id: string | null }
  | { type: 'selectDevice'; id: string | null }
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
  | { type: 'resolveIncident'; incidentId: string; outcome: string }
  | { type: 'closeIncident'; incidentId: string }
  | { type: 'addNote'; incidentId: string; text: string }
  | { type: 'setChecksum'; evidenceId: string; checksum: string }
  | { type: 'exportReport'; incidentId: string }
  | { type: 'demoInjectAlert' }
  | { type: 'demoCutLink'; deviceId: string }
  | { type: 'demoRestoreLink'; deviceId: string }
  | { type: 'demoReset' }
  | { type: 'enterReplay'; at: number }
  | { type: 'seekReplay'; at: number }
  | { type: 'exitReplay' }
  | { type: 'dismissToast'; id: string }
  | { type: 'togglePresentation' };

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

function tick(s: AppState, dt: number) {
  s.now += dt;

  for (const d of Object.values(s.devices)) {
    if (s.linkCut[d.id]) continue; // no telemetry arrives
    if (s.now - d.lastSeen < d.rateMs) continue;
    const elapsed = (s.now - d.lastSeen) / 1000;
    const wasFailsafe = s.failsafeAt[d.id];

    if (d.kind === 'ugv') {
      const m = s.missions.find((x) => x.deviceId === d.id && x.status === 'executing');
      if (wasFailsafe) {
        // First telemetry after reconnect: the vehicle reports it stopped itself.
        s.failsafeAt[d.id] = undefined;
        d.speed = 0;
        if (m) {
          m.status = 'paused';
          m.note = 'Vehicle stopped by link-loss failsafe. Operator must resume.';
          event(s, m.incidentId, `${d.id} reconnected — stopped by link-loss failsafe`, {
            actor: d.id,
            tone: 'warn',
            detail: 'No queued commands were replayed. Mission paused until the operator resumes.',
          });
        }
      } else if (m) {
        moveAlong(s, d.id, m, UGV_SPEED * elapsed);
      } else {
        d.speed = 0;
      }
      if (d.battery !== undefined && d.speed > 0) d.battery = Math.max(0, d.battery - 0.05 * elapsed);
    }

    if (d.kind === 'uav') {
      const a = (s.now / 1000) * 0.08;
      d.pos = { x: 318 + Math.cos(a) * 34, y: 52 + Math.sin(a) * 26 };
    }

    d.lastSeen = s.now;
    if (d.kind !== 'cctv') {
      s.telemetry.push({ deviceId: d.id, at: s.now, x: d.pos.x, y: d.pos.y });
      if (s.telemetry.length > 4000) s.telemetry.splice(0, s.telemetry.length - 4000);
    }
  }

  for (const c of s.commands) {
    if (isTerminal(c)) continue;
    progressCommand(s, c);
  }
}

function moveAlong(s: AppState, deviceId: string, m: Mission, budget: number) {
  const d = s.devices[deviceId];
  let moved = 0;
  while (budget > 0 && m.nextCp < m.checkpoints.length) {
    const target = m.checkpoints[m.nextCp];
    const gap = dist(d.pos, target);
    if (gap <= budget) {
      d.pos = { ...target };
      budget -= gap;
      moved += gap;
      m.nextCp += 1;
    } else {
      d.pos = {
        x: d.pos.x + ((target.x - d.pos.x) / gap) * budget,
        y: d.pos.y + ((target.y - d.pos.y) / gap) * budget,
      };
      moved += budget;
      budget = 0;
    }
  }
  d.speed = moved > 0 ? UGV_SPEED : 0;
  if (m.nextCp >= m.checkpoints.length) {
    d.speed = 0;
    m.status = 'completed';
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
      if (t >= 1000) setCmd(c, 'executing', s.now);
      return;
    case 'executing':
      if (!linkOk) {
        if (t >= COMMAND_ACK_TIMEOUT_MS + 1000) setCmd(c, 'unknown', s.now, 'Device stopped reporting before confirming. Outcome unknown.');
        return;
      }
      if (t >= 1700) applyCommand(s, c);
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
      { const inc = incident(s, m.incidentId); if (inc && inc.status === 'confirmed') inc.status = 'responding'; }
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
// constraint checks shown to the supervisor before approval (PRD §3, UXUI S03)
// ---------------------------------------------------------------------------

export interface Check {
  label: string;
  ok: boolean;
  hard: boolean;
  detail: string;
}

export function constraintChecks(s: AppState, m: Mission): Check[] {
  const d = s.devices[m.deviceId];
  const fresh = freshness(s, d);
  const inside = m.checkpoints.every((p) => p.x > 20 && p.x < 400 && p.y > 16 && p.y < 240);
  const battery = d.battery ?? 0;
  return [
    { label: 'Telemetry fresh', ok: fresh === 'live', hard: true, detail: fresh === 'live' ? 'Last seen < 5 s' : `Telemetry ${fresh}` },
    { label: 'Battery ≥ 30%', ok: battery >= 30, hard: true, detail: `${Math.round(battery)}%` },
    { label: 'Route inside demo area', ok: inside, hard: true, detail: `${m.checkpoints.length} checkpoints inside site boundary` },
    { label: 'Operator assigned', ok: !!m.operatorId, hard: true, detail: userName(s, m.operatorId) },
    { label: 'Control available', ok: !d.controlOwner || d.controlOwner === m.operatorId, hard: true, detail: d.controlOwner ? `Held by ${userName(s, d.controlOwner)}` : 'No current holder' },
    { label: 'Integration status', ok: d.integration === 'verified', hard: false, detail: d.integration === 'simulated' ? 'SIMULATED device — demo only' : d.integration },
  ];
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
      return s;
    case 'selectDevice':
      s.selectedDeviceId = msg.id;
      return s;
    case 'dismissToast':
      s.toasts = s.toasts.filter((t) => t.id !== msg.id);
      return s;
    case 'togglePresentation':
      s.presentation = !s.presentation;
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
      if (!['new', 'triaging'].includes(inc.status)) return reject(s, 'incident.verify', inc.id, 'Incident is not awaiting verification.'), s;
      inc.status = 'confirmed';
      inc.owner = me.name;
      event(s, inc.id, 'Verified — action required', { tone: 'ok', detail: 'Verified by operator from camera review.' });
      audit(s, 'incident.confirm', inc.id, 'ok');
      return s;
    }
    case 'dismissIncident': {
      const inc = incident(s, msg.incidentId);
      if (!inc || !guard(s, 'incident.verify', msg.incidentId)) return s;
      if (!msg.reason.trim()) return reject(s, 'incident.dismiss', inc.id, 'A reason is required.'), s;
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
      if (!msg.reason.trim()) return reject(s, 'incident.merge', inc.id, 'A reason is required.'), s;
      if (inc.id === into.id) return reject(s, 'incident.merge', inc.id, 'Cannot merge an incident into itself.'), s;
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
      if (!['confirmed', 'responding'].includes(inc.status)) return reject(s, 'incident.resolve', inc.id, 'Only confirmed or responding incidents can be resolved.'), s;
      const active = s.missions.find((m) => m.incidentId === inc.id && ['executing', 'paused'].includes(m.status));
      if (active) return reject(s, 'incident.resolve', inc.id, `Mission ${active.id} is still active. End it first.`), s;
      inc.status = 'resolved';
      inc.outcome = msg.outcome;
      event(s, inc.id, 'Resolved', { tone: 'ok', detail: msg.outcome });
      audit(s, 'incident.resolve', inc.id, 'ok', msg.outcome);
      return s;
    }
    case 'closeIncident': {
      const inc = incident(s, msg.incidentId);
      if (!inc || !guard(s, 'incident.close', msg.incidentId)) return s;
      if (inc.status !== 'resolved') return reject(s, 'incident.close', inc.id, 'Resolve the incident before closing it.'), s;
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
      if (inc.status !== 'confirmed') return reject(s, 'mission.prepare', inc.id, 'Verify the incident before preparing a mission.'), s;
      if (!isReady(s, d)) return reject(s, 'mission.prepare', d.id, `${d.id} is not ready.`), s;
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
        return reject(s, 'mission.edit', m.id, 'Route cannot be changed while the mission is running.'), s;
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
      if (!['draft', 'rejected'].includes(m.status)) return reject(s, 'mission.submit', m.id, 'Mission is not a draft.'), s;
      m.status = 'pending_approval';
      event(s, m.incidentId, 'Approval requested', { detail: `Mission ${m.id} plan v${m.planVersion} sent to supervisor.` });
      audit(s, 'mission.submit', m.id, 'ok');
      return s;
    }
    case 'approveMission': {
      const m = mission(s, msg.missionId);
      if (!m || !guard(s, 'mission.approve', msg.missionId)) return s;
      if (m.status !== 'pending_approval') return reject(s, 'mission.approve', m.id, 'Mission is not awaiting approval.'), s;
      const failed = constraintChecks(s, m).filter((c) => c.hard && !c.ok);
      if (failed.length) return reject(s, 'mission.approve', m.id, `Cannot approve: ${failed.map((f) => f.label).join(', ')}.`), s;
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
      if (m.status !== 'pending_approval') return reject(s, 'mission.reject', m.id, 'Mission is not awaiting approval.'), s;
      if (!msg.reason.trim()) return reject(s, 'mission.reject', m.id, 'A reason is required.'), s;
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
        return reject(s, 'mission.cancel', m.id, 'A running mission must be stopped by its operator.'), s;
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
      if (m.operatorId !== me.id) return reject(s, 'mission.accept', m.id, 'This mission is assigned to another operator.'), s;
      if (m.status !== 'approved' || m.approvedVersion !== m.planVersion) return reject(s, 'mission.accept', m.id, 'Mission needs an approved plan first.'), s;
      const d = s.devices[m.deviceId];
      if (d.controlOwner && d.controlOwner !== me.id) return reject(s, 'mission.accept', d.id, `Control of ${d.id} is held by ${userName(s, d.controlOwner)}. A handover is required.`), s;
      d.controlOwner = me.id;
      m.status = 'assigned';
      event(s, m.incidentId, 'Operator accepted mission', { detail: `${me.name} confirmed readiness and holds control of ${d.id}.` });
      audit(s, 'mission.accept', m.id, 'ok');
      audit(s, 'control.acquire', d.id, 'ok');
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
      s.incidents.unshift(inc);
      event(s, inc.id, 'Alert received', { actor: 'Gate sensor SG-2', tone: 'alert', receivedAt: s.now + 600, detail: 'Same sensor as INC-024. Possible duplicate.' });
      toast(s, 'info', `New simulated alert ${inc.id}: ${inc.title}.`);
      return s;
    }
    case 'demoCutLink': {
      if (!guard(s, 'demo.control', msg.deviceId, { allowInReplay: true })) return s;
      s.linkCut[msg.deviceId] = true;
      const d = s.devices[msg.deviceId];
      const m = s.missions.find((x) => x.deviceId === msg.deviceId && x.status === 'executing');
      if (d.kind === 'ugv' && m) {
        // Vehicle side: adapter detects link loss and stops in place (tested failsafe per PRD §8).
        s.failsafeAt[d.id] = s.now;
        d.speed = 0;
      }
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
    return fail(d.controlOwner ? `Control of ${d.id} is held by ${userName(s, d.controlOwner)}. A handover is required.` : `You do not hold control of ${d.id}. Accept the mission first.`);

  const valid: Record<CommandType, Mission['status'][]> = {
    start: ['assigned'],
    pause: ['executing'],
    resume: ['paused'],
    stop: ['executing', 'paused'],
  };
  if (!valid[type].includes(m.status)) return fail(`Cannot ${type} while mission is ${m.status.replace('_', ' ')}.`);
  if (type === 'start' && m.approvedVersion !== m.planVersion) return fail('Plan changed since approval. Re-approval required.');

  const fresh = freshness(s, d);
  if ((type === 'start' || type === 'resume') && fresh !== 'live')
    return fail(`Telemetry is ${fresh}. New ${type} commands are held until data is fresh.`);

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
