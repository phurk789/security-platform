import { useState } from 'react';
import {
  Ban,
  BatteryMedium,
  Check,
  CircleAlert,
  Ellipsis,
  FileText,
  Hand,
  Lock,
  MapPin,
  Merge,
  OctagonX,
  Pause,
  Play,
  Route as RouteIcon,
  Send,
  ShieldCheck,
  UserCheck,
  Video,
  X,
} from 'lucide-react';
import { ageMs, can, currentUser, fmtAge, fmtTime, freshness, isReady, userName } from '../domain/policy';
import { isTerminal, missionForIncident } from '../domain/reducer';
import { constraintChecks } from '../domain/policy';
import { DEFAULT_ROUTE } from '@13store/shared';
import type { AppState, CommandType, Device, Incident, Mission, Point } from '@13store/shared';
import { useStore } from '../store';
import { CameraFeed } from './CameraFeed';
import { Badge, CommandBadge, FreshBadge, IncidentBadge, IntegrationBadge, MissionBadge } from './Badges';
import { ReasonDialog } from './Dialog';

export const ROUTES: { id: string; label: string; pts: Point[] }[] = [
  { id: 'direct', label: 'Direct to service gate · 3 checkpoints', pts: DEFAULT_ROUTE },
  {
    id: 'sweep',
    label: 'Perimeter sweep via Building 4 · 5 checkpoints',
    pts: [
      { x: 262, y: 218 },
      { x: 290, y: 204 },
      { x: 384, y: 204 },
      { x: 384, y: 224 },
      { x: 334, y: 228 },
    ],
  },
];

function routeId(pts: Point[]) {
  return ROUTES.find((r) => r.pts.length === pts.length && r.pts.every((p, i) => p.x === pts[i].x && p.y === pts[i].y))?.id ?? 'custom';
}

export function RightPanel() {
  const { s } = useStore();
  const dev = s.selectedDeviceId ? s.devices[s.selectedDeviceId] : undefined;
  if (dev) return <DevicePanel d={dev} />;
  const inc = s.incidents.find((i) => i.id === s.selectedIncidentId);
  if (!inc)
    return (
      <aside className="panel right empty-state">
        <MapPin size={28} />
        <p>Select an incident in the queue or on the map.</p>
      </aside>
    );
  return <IncidentPanel inc={inc} />;
}

function IncidentPanel({ inc }: { inc: Incident }) {
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const m = missionForIncident(s, inc.id);
  const live = m && ['assigned', 'executing', 'paused'].includes(m.status);
  const [feedTab, setFeedTab] = useState<'cctv' | 'ugv'>('cctv');
  const cam = inc.cameraId ? s.devices[inc.cameraId] : undefined;
  const ugv = m ? s.devices[m.deviceId] : undefined;
  const showUgvFeed = live && feedTab === 'ugv' && ugv;
  const replay = s.replay.active;

  return (
    <aside className="panel right">
      <div className="panel-head">
        <h2>Incident details</h2>
        <button className="icon-btn" aria-label="More"><Ellipsis size={18} /></button>
      </div>
      <div className="inc-head">
        <div className="row gap">
          <span className="inc-big-id">{inc.id}</span>
          {inc.status === 'new' || inc.status === 'triaging' ? (
            <Badge tone="amber"><CircleAlert size={13} /> Unverified</Badge>
          ) : (
            <IncidentBadge status={inc.status} />
          )}
        </div>
        <h3>{inc.title}</h3>
        <div className="muted row gap-s"><MapPin size={14} /> {inc.place} <span className="sep">|</span> {inc.zone}</div>
        <dl className="meta">
          <div><dt>Source</dt><dd>{inc.source}</dd></div>
          <div><dt>Received</dt><dd>{fmtTime(inc.createdAt, true)} · {fmtAge(s.now - inc.createdAt)} ago</dd></div>
          <div><dt>Owner</dt><dd>{inc.owner ?? 'Unassigned'}</dd></div>
          <div><dt>Status</dt><dd><IncidentBadge status={inc.status} /></dd></div>
        </dl>
      </div>

      {(cam || showUgvFeed) && (
        <div className="feed-wrap">
          {live && ugv && (
            <div className="tabs small">
              <button className={feedTab === 'cctv' ? 'on' : ''} onClick={() => setFeedTab('cctv')}>{cam?.id ?? 'CCTV'}</button>
              <button className={feedTab === 'ugv' ? 'on' : ''} onClick={() => setFeedTab('ugv')}>{ugv.id} camera</button>
            </div>
          )}
          {showUgvFeed ? (
            <CameraFeed
              scene="ugv"
              label={`${ugv.id} onboard`}
              time={replay ? s.replay.at : freshness(s, ugv) === 'live' ? s.now : ugv.lastSeen}
              freshness={replay ? 'live' : freshness(s, ugv)}
              replay={replay}
              progress={m ? m.nextCp / m.checkpoints.length : 0}
            />
          ) : cam ? (
            <CameraFeed
              scene={cam.view ?? 'gate'}
              label={`${cam.id}  ${inc.place}`}
              time={replay ? s.replay.at : freshness(s, cam) === 'live' ? s.now : cam.lastSeen}
              freshness={replay ? 'live' : freshness(s, cam)}
              replay={replay}
            />
          ) : null}
        </div>
      )}

      <div className="panel-body">
        <Stage inc={inc} m={m} />
      </div>

      <div className="panel-foot">
        <button className="btn-outline" onClick={() => dispatch({ type: 'setView', view: 'evidence' })}>
          <FileText size={18} /> View evidence
        </button>
        <RoleHint s={s} inc={inc} m={m} role={me.role} />
      </div>
    </aside>
  );
}

function RoleHint({ s, inc, m, role }: { s: AppState; inc: Incident; m?: Mission; role: string }) {
  let text: string | null = null;
  if (s.replay.active) text = 'You are viewing replay. Device control is off.';
  else if (role === 'auditor') text = 'Read-only role. Actions are disabled.';
  else if (m?.status === 'pending_approval' && role !== 'supervisor') text = 'Waiting for supervisor approval. (Demo: switch role to Supervisor.)';
  else if (m?.status === 'approved' && role !== 'operator') text = 'Approved. Waiting for the operator to accept. (Demo: switch role to Operator.)';
  else if (m?.status === 'assigned' && role !== 'operator') text = 'Operator holds control. Only they can start the mission.';
  else if (inc.status === 'confirmed' && !m) text = 'Approval required before dispatch.';
  if (!text) return null;
  return (
    <p className="hint"><CircleAlert size={16} /> {text}</p>
  );
}

function Stage({ inc, m }: { inc: Incident; m?: Mission }) {
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const [dlg, setDlg] = useState<null | 'dismiss' | 'merge' | 'reject'>(null);
  const [mergeInto, setMergeInto] = useState('');
  const canVerify = can(me.role, 'incident.verify') && !s.replay.active;

  // --- verification ------------------------------------------------------
  if (inc.status === 'new' || inc.status === 'triaging') {
    const others = s.incidents.filter((i) => i.id !== inc.id && !['closed', 'duplicate', 'dismissed'].includes(i.status));
    return (
      <>
        <section className="step">
          <h4>Step 1 · Verify the alert</h4>
          <p className="muted">New alert. Not yet confirmed by an operator. Review the camera before deciding.</p>
          {inc.status === 'new' ? (
            <button className="btn-primary wide" disabled={!can(me.role, 'incident.triage') || s.replay.active} onClick={() => dispatch({ type: 'openCamera', incidentId: inc.id })}>
              <Video size={18} /> Open camera &amp; start review
            </button>
          ) : (
            <button className="btn-primary wide" disabled={!canVerify} onClick={() => dispatch({ type: 'confirmIncident', incidentId: inc.id })}>
              <ShieldCheck size={18} /> Confirm — action required
            </button>
          )}
          <div className="row gap-s">
            <button className="btn-secondary grow" disabled={!canVerify} onClick={() => setDlg('dismiss')}><Ban size={16} /> False alarm</button>
            <button className="btn-secondary grow" disabled={!canVerify || !others.length} onClick={() => { setMergeInto(others[0]?.id ?? ''); setDlg('merge'); }}><Merge size={16} /> Merge duplicate</button>
          </div>
        </section>
        <ReadyDevices />
        {dlg === 'dismiss' && (
          <ReasonDialog
            title={`Dismiss ${inc.id} as false alarm`}
            hint="e.g. Staff member opening the gate for a scheduled delivery, confirmed on CCTV-02."
            confirmLabel="Dismiss alert"
            danger
            onClose={() => setDlg(null)}
            onConfirm={(r) => { dispatch({ type: 'dismissIncident', incidentId: inc.id, reason: r }); setDlg(null); }}
          />
        )}
        {dlg === 'merge' && (
          <ReasonDialog
            title={`Merge ${inc.id} into another incident`}
            hint="e.g. Same sensor triggered twice within one minute."
            confirmLabel="Merge"
            onClose={() => setDlg(null)}
            extra={
              <label className="field">
                <span>Merge into</span>
                <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
                  {others.map((o) => <option key={o.id} value={o.id}>{o.id} · {o.title}</option>)}
                </select>
                <small className="muted">Original evidence stays attached to {inc.id}.</small>
              </label>
            }
            onConfirm={(r) => { dispatch({ type: 'mergeIncident', incidentId: inc.id, intoId: mergeInto, reason: r }); setDlg(null); }}
          />
        )}
      </>
    );
  }

  // --- planning / approval / live ---------------------------------------
  const ended = !m || ['cancelled', 'rejected', 'completed', 'failed'].includes(m.status);
  if ((inc.status === 'confirmed' || inc.status === 'responding') && m && !ended) {
    if (m.status === 'draft' || m.status === 'pending_approval' || m.status === 'approved') return <Planner m={m} />;
    return <LiveMission m={m} />;
  }
  if (m?.status === 'rejected' && inc.status === 'confirmed') return <Planner m={m} />;

  if (inc.status === 'confirmed' && (!m || ['cancelled', 'failed'].includes(m.status))) {
    return (
      <>
        {m && <p className="banner info">Previous mission {m.id}: <MissionBadge status={m.status} /></p>}
        <PrepareMission inc={inc} />
        <details className="step">
          <summary>Resolve without a mission</summary>
          <Outcome inc={inc} />
        </details>
      </>
    );
  }

  if (inc.status === 'confirmed' || inc.status === 'responding') {
    return (
      <section className="step">
        <h4>Step 4 · Record the outcome</h4>
        {m && <p className="muted">Mission {m.id}: <MissionBadge status={m.status} /></p>}
        <Outcome inc={inc} />
      </section>
    );
  }

  if (inc.status === 'resolved') {
    return (
      <section className="step">
        <h4>Resolved</h4>
        <p>{inc.outcome}</p>
        <div className="row gap-s">
          <button className="btn-primary grow" disabled={!can(me.role, 'incident.close') || s.replay.active} onClick={() => dispatch({ type: 'closeIncident', incidentId: inc.id })}><Lock size={16} /> Close incident</button>
          <button className="btn-secondary grow" onClick={() => dispatch({ type: 'setView', view: 'reports' })}><FileText size={16} /> Report</button>
        </div>
      </section>
    );
  }

  return (
    <section className="step">
      <h4>{inc.status === 'closed' ? 'Closed' : inc.status === 'duplicate' ? `Duplicate of ${inc.duplicateOf}` : 'Dismissed'}</h4>
      {inc.outcome && <p>{inc.outcome}</p>}
      <button className="btn-secondary wide" onClick={() => dispatch({ type: 'setView', view: 'reports' })}><FileText size={16} /> Open report</button>
    </section>
  );
}

function Outcome({ inc }: { inc: Incident }) {
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const [outcome, setOutcome] = useState('');
  return (
    <>
      <label className="field">
        <span>Outcome</span>
        <textarea rows={3} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="e.g. Gate found closed and locked. No one present. Sensor flagged for maintenance." />
      </label>
      <button className="btn-primary wide" disabled={!outcome.trim() || !can(me.role, 'incident.resolve') || s.replay.active} onClick={() => dispatch({ type: 'resolveIncident', incidentId: inc.id, outcome })}>
        <Check size={18} /> Resolve incident
      </button>
    </>
  );
}

function ReadyDevices({ onPick, picked }: { onPick?: (id: string) => void; picked?: string }) {
  const { s } = useStore();
  const list = Object.values(s.devices).filter((d) => d.kind !== 'cctv');
  return (
    <section className="step">
      <h4>{onPick ? 'Choose device' : 'Available device'}</h4>
      {list.map((d) => (
        <DeviceCard key={d.id} d={d} onPick={onPick} picked={picked === d.id} />
      ))}
    </section>
  );
}

function DeviceCard({ d, onPick, picked }: { d: Device; onPick?: (id: string) => void; picked?: boolean }) {
  const { s } = useStore();
  const f = freshness(s, d);
  const ready = isReady(s, d);
  const canPatrol = d.commands.length > 0;
  return (
    <button
      type="button"
      className={`dev-card${picked ? ' picked' : ''}${!ready || !canPatrol ? ' dim' : ''}`}
      disabled={!onPick || !ready || !canPatrol}
      onClick={() => onPick?.(d.id)}
    >
      <div className={`dev-thumb k-${d.kind}`} aria-hidden>
        <svg viewBox="0 0 80 56">
          {d.kind === 'ugv' ? (
            <g>
              <rect x="14" y="20" width="52" height="16" rx="4" fill="#2f3a48" stroke="#5c6b7d" />
              <rect x="34" y="8" width="4" height="12" fill="#5c6b7d" />
              <rect x="30" y="4" width="12" height="6" rx="2" fill="#38bdf8" opacity=".7" />
              {[18, 34, 50].map((x) => <circle key={x} cx={x + 4} cy="40" r="7" fill="#151d27" stroke="#4b5868" />)}
            </g>
          ) : (
            <g stroke="#5c6b7d" fill="#2f3a48">
              <rect x="30" y="22" width="20" height="12" rx="3" />
              <line x1="30" y1="24" x2="12" y2="14" /><line x1="50" y1="24" x2="68" y2="14" />
              <line x1="30" y1="32" x2="12" y2="42" /><line x1="50" y1="32" x2="68" y2="42" />
              {[[12, 14], [68, 14], [12, 42], [68, 42]].map(([x, y]) => <ellipse key={`${x}${y}`} cx={x} cy={y} rx="9" ry="2.5" fill="#38bdf8" opacity=".35" />)}
            </g>
          )}
        </svg>
      </div>
      <div className="dev-info">
        <div className="row between">
          <strong>{d.id}</strong>
          {d.battery !== undefined && <span className="batt"><BatteryMedium size={16} /> {Math.round(d.battery)}%</span>}
        </div>
        <div className="row gap-s wrap">
          <IntegrationBadge i={d.integration} />
          <FreshBadge f={f} />
        </div>
        <small className="muted">Updated {fmtAge(ageMs(s, d))} ago · {d.capabilities.slice(0, 2).map((c) => c.replace('_', ' ')).join(' · ')}</small>
        {!canPatrol && <small className="warn-text">Display only — no commands supported</small>}
        {canPatrol && !ready && <small className="warn-text">Not ready{d.controlOwner ? ` · held by ${userName(s, d.controlOwner)}` : ''}</small>}
      </div>
    </button>
  );
}

function PrepareMission({ inc }: { inc: Incident }) {
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState('UGV-01');
  const [route, setRoute] = useState('direct');
  const operators = s.users.filter((u) => u.role === 'operator');
  const [op, setOp] = useState(operators[0]?.id ?? '');
  const allowed = can(me.role, 'mission.prepare') && !s.replay.active;

  if (!open)
    return (
      <>
        <ReadyDevices />
        <section className="step">
          <button className="btn-primary wide big" disabled={!allowed} onClick={() => setOpen(true)}>
            <Play size={18} /> Prepare mission
          </button>
        </section>
      </>
    );

  return (
    <>
      <section className="step">
        <h4>Step 2 · Prepare mission</h4>
        <ol className="stepper">
          <li className="on">Device</li><li className="on">Route &amp; operator</li><li>Checks</li><li>Approval</li>
        </ol>
      </section>
      <ReadyDevices onPick={setDeviceId} picked={deviceId} />
      <section className="step">
        <label className="field">
          <span><RouteIcon size={14} /> Route</span>
          <select value={route} onChange={(e) => setRoute(e.target.value)}>
            {ROUTES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span><UserCheck size={14} /> Operator</span>
          <select value={op} onChange={(e) => setOp(e.target.value)}>
            {operators.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.title}</option>)}
          </select>
        </label>
        <div className="row gap-s">
          <button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
          <button
            className="btn-primary grow"
            disabled={!allowed || !deviceId}
            onClick={() => dispatch({ type: 'createMission', incidentId: inc.id, deviceId, operatorId: op, checkpoints: ROUTES.find((r) => r.id === route)!.pts })}
          >
            Save draft &amp; run checks
          </button>
        </div>
      </section>
    </>
  );
}

function Planner({ m }: { m: Mission }) {
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const [dlg, setDlg] = useState(false);
  const checks = constraintChecks(s, m);
  const hardFail = checks.some((c) => c.hard && !c.ok);
  const canPrep = can(me.role, 'mission.prepare') && !s.replay.active;
  const canApprove = can(me.role, 'mission.approve') && !s.replay.active;
  const rid = routeId(m.checkpoints);
  const reapproval = m.status === 'pending_approval' && m.approvedVersion !== undefined && m.approvedVersion !== m.planVersion;

  return (
    <>
      <section className="step">
        <div className="row between">
          <h4>{m.status === 'draft' || m.status === 'rejected' ? 'Step 2 · Mission draft' : m.status === 'pending_approval' ? 'Step 3 · Approval' : 'Step 3 · Operator acceptance'}</h4>
          <MissionBadge status={m.status} />
        </div>
        {reapproval && <p className="banner warn">Route changed. Re-approval required (plan v{m.planVersion}, approved v{m.approvedVersion}).</p>}
        {m.status === 'rejected' && m.note && <p className="banner warn">Rejected: {m.note}</p>}
        <dl className="meta">
          <div><dt>Mission</dt><dd>{m.id} · plan v{m.planVersion}</dd></div>
          <div><dt>Device</dt><dd>{m.deviceId}</dd></div>
          <div><dt>Operator</dt><dd>{userName(s, m.operatorId)}</dd></div>
          <div><dt>Approved by</dt><dd>{m.approvedBy && m.approvedVersion === m.planVersion ? userName(s, m.approvedBy) : '—'}</dd></div>
        </dl>
        <label className="field">
          <span><RouteIcon size={14} /> Route {m.approvedVersion === m.planVersion ? '(approved — solid on map)' : '(draft — dashed on map)'}</span>
          <select
            value={rid}
            disabled={!canPrep}
            onChange={(e) => {
              const r = ROUTES.find((x) => x.id === e.target.value);
              if (r) dispatch({ type: 'editRoute', missionId: m.id, checkpoints: r.pts });
            }}
          >
            {ROUTES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            {rid === 'custom' && <option value="custom">Custom route</option>}
          </select>
        </label>
      </section>
      <section className="step">
        <h4>Constraint checks</h4>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? 'ok' : c.hard ? 'fail' : 'warn'}>
              {c.ok ? <Check size={15} /> : c.hard ? <X size={15} /> : <CircleAlert size={15} />}
              <span>{c.label}</span>
              <small>{c.detail}</small>
            </li>
          ))}
        </ul>
      </section>
      <section className="step">
        {(m.status === 'draft' || m.status === 'rejected') && (
          <>
            <button className="btn-primary wide big" disabled={!canPrep || hardFail} onClick={() => dispatch({ type: 'submitMission', missionId: m.id })}>
              <Send size={18} /> Submit for approval
            </button>
            <button className="btn-secondary wide" disabled={!canPrep} onClick={() => dispatch({ type: 'cancelMission', missionId: m.id })}>Discard draft</button>
          </>
        )}
        {m.status === 'pending_approval' && (
          <div className="row gap-s">
            <button className="btn-secondary grow" disabled={!canApprove} onClick={() => setDlg(true)}>Reject</button>
            <button className="btn-primary grow" disabled={!canApprove || hardFail} onClick={() => dispatch({ type: 'approveMission', missionId: m.id })}>
              <ShieldCheck size={18} /> Approve plan v{m.planVersion}
            </button>
          </div>
        )}
        {m.status === 'approved' && (
          <button
            className="btn-primary wide big"
            disabled={me.role !== 'operator' || me.id !== m.operatorId || s.replay.active}
            onClick={() => dispatch({ type: 'acceptMission', missionId: m.id })}
          >
            <Hand size={18} /> Accept mission &amp; take control
          </button>
        )}
      </section>
      {dlg && (
        <ReasonDialog
          title={`Reject ${m.id}`}
          hint="e.g. Use the perimeter route to avoid the delivery bay."
          confirmLabel="Reject plan"
          danger
          onClose={() => setDlg(false)}
          onConfirm={(r) => { dispatch({ type: 'rejectMission', missionId: m.id, reason: r }); setDlg(false); }}
        />
      )}
    </>
  );
}

function LiveMission({ m }: { m: Mission }) {
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const d = s.devices[m.deviceId];
  const f = freshness(s, d);
  const age = ageMs(s, d);
  const cmds = s.commands.filter((c) => c.missionId === m.id).slice().reverse();
  const pending = cmds.find((c) => !isTerminal(c));
  const holder = d.controlOwner;
  const iHold = holder === me.id;
  const off = s.replay.active;

  const send = (type: CommandType) => {
    const n = s.commands.filter((c) => c.missionId === m.id && c.type === type && isTerminal(c)).length;
    dispatch({ type: 'issueCommand', missionId: m.id, command: type, idempotencyKey: `${m.id}:${type}:${n}` });
  };
  const has = (t: CommandType) => d.commands.includes(t);

  return (
    <>
      <section className="step">
        <div className="row between">
          <h4>Step 3 · Live mission</h4>
          <MissionBadge status={m.status} />
        </div>
        <div className={`control-held${iHold ? ' me' : ''}`}>
          <Lock size={15} /> CONTROL HELD: <strong>{userName(s, holder)}</strong>
          {iHold && <span className="muted"> (you)</span>}
        </div>
        <dl className="meta">
          <div><dt>Telemetry</dt><dd><FreshBadge f={f} age={`${fmtAge(age)} ago`} /></dd></div>
          <div><dt>Battery</dt><dd>{Math.round(d.battery ?? 0)}%</dd></div>
          <div><dt>Progress</dt><dd>Checkpoint {Math.min(m.nextCp + 1, m.checkpoints.length)} of {m.checkpoints.length}</dd></div>
          <div><dt>Speed</dt><dd>{f === 'live' ? `${d.speed.toFixed(1)} m/s` : 'unknown'}</dd></div>
        </dl>
        {f !== 'live' && (
          <p className="banner warn">
            Last data {fmtAge(age)} ago. New start/resume commands are held. Vehicle state is uncertain — check with the field operator.
          </p>
        )}
        {m.note && <p className="banner info">{m.note}</p>}
      </section>

      <section className="step">
        {!iHold && (
          <p className="banner info">
            Only {userName(s, holder)} can command {d.id}.
            {can(me.role, 'control.handover') && !off && (
              <button className="link" onClick={() => dispatch({ type: 'handover', deviceId: d.id, toUserId: me.id })}>Take over control (logged)</button>
            )}
          </p>
        )}
        {m.status === 'assigned' && has('start') && (
          <button className="btn-primary wide big" disabled={!iHold || off} onClick={() => send('start')}>
            <Play size={18} /> {pending?.type === 'start' ? 'Start requested — waiting for vehicle' : 'Send start request'}
          </button>
        )}
        {(m.status === 'executing' || m.status === 'paused') && (
          <div className="ctl-grid">
            {m.status === 'executing' && has('pause') && (
              <button className="btn-secondary" disabled={!iHold || off} onClick={() => send('pause')} title="Hold position. Mission can be resumed.">
                <Pause size={18} /> Pause mission
              </button>
            )}
            {m.status === 'paused' && has('resume') && (
              <button className="btn-secondary" disabled={!iHold || off} onClick={() => send('resume')}>
                <Play size={18} /> Resume
              </button>
            )}
            {has('stop') && (
              <button className="btn-danger" disabled={!iHold || off} onClick={() => send('stop')} title="Ask the vehicle to stop and end the mission. Not an emergency stop.">
                <OctagonX size={18} /> Stop request
              </button>
            )}
          </div>
        )}
        <p className="fine">Stop request is not an emergency stop. Use the physical E-stop on the vehicle for emergencies.</p>
      </section>

      <section className="step">
        <h4>Commands</h4>
        {cmds.length === 0 && <p className="muted">No commands sent yet.</p>}
        <ul className="cmds">
          {cmds.map((c) => (
            <li key={c.id}>
              <div className="row between">
                <strong>{c.type.toUpperCase()}</strong>
                <CommandBadge status={c.status} />
              </div>
              <small className="muted mono">
                {c.id} · sent {fmtTime(c.issuedAt, true)} by {userName(s, c.issuer)} · key {c.idempotencyKey.split(':').slice(1).join(':')}
              </small>
              {c.detail && <small className={c.status === 'succeeded' ? 'muted' : 'warn-text'}>{c.detail}</small>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function DevicePanel({ d }: { d: Device }) {
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const f = freshness(s, d);
  return (
    <aside className="panel right">
      <div className="panel-head">
        <h2>Device</h2>
        <button className="icon-btn" aria-label="Close device" onClick={() => dispatch({ type: 'selectDevice', id: null })}><X size={18} /></button>
      </div>
      <div className="inc-head">
        <div className="row gap"><span className="inc-big-id">{d.id}</span><IntegrationBadge i={d.integration} /></div>
        <h3>{d.model}</h3>
        <div className="row gap-s"><FreshBadge f={f} age={`${fmtAge(ageMs(s, d))} ago`} /></div>
      </div>
      {d.kind === 'cctv' && (
        <div className="feed-wrap">
          <CameraFeed scene={d.view ?? 'plaza'} label={d.id} time={f === 'live' ? s.now : d.lastSeen} freshness={f} replay={s.replay.active} />
        </div>
      )}
      <div className="panel-body">
        <section className="step">
          <dl className="meta">
            <div><dt>Zone</dt><dd>{d.zone}</dd></div>
            <div><dt>Position</dt><dd>{d.pos.x.toFixed(0)}, {d.pos.y.toFixed(0)} m ± {d.accuracyM} m</dd></div>
            {d.alt !== undefined && <div><dt>Altitude</dt><dd>{d.alt} m (site datum, simulated)</dd></div>}
            {d.battery !== undefined && <div><dt>Battery</dt><dd>{Math.round(d.battery)}%</dd></div>}
            <div><dt>Adapter</dt><dd>{d.adapterVersion}</dd></div>
            <div><dt>Firmware tested</dt><dd>{d.firmwareTested}</dd></div>
            <div><dt>Control</dt><dd>{userName(s, d.controlOwner)}</dd></div>
            <div><dt>Commands</dt><dd>{d.commands.length ? d.commands.join(', ') : 'none (view only)'}</dd></div>
          </dl>
          <p className="muted">{d.limitations}</p>
          {d.controlOwner && can(me.role, 'control.handover') && d.controlOwner !== me.id && !s.replay.active && (
            <button className="btn-secondary wide" onClick={() => dispatch({ type: 'handover', deviceId: d.id, toUserId: me.id })}>
              <Hand size={16} /> Take over control (logged)
            </button>
          )}
        </section>
      </div>
    </aside>
  );
}
