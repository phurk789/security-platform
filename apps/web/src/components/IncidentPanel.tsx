import { useEffect, useMemo, useState } from 'react';
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
  RotateCcw,
  Users,
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
import { ageMs, can, currentUser, fmtTime, freshness, isReady, userName } from '../domain/policy';
import { isTerminal, missionForIncident } from '../domain/reducer';
import { constraintChecks } from '../domain/policy';
import { DEFAULT_ROUTE, planRoute, rankUnits } from '@13store/shared';
import type { AppState, CommandType, Device, Incident, Mission, Point } from '@13store/shared';
import { useStore } from '../store';
import { CameraFeed } from './CameraFeed';
import { Badge, CommandBadge, FreshBadge, IncidentBadge, IntegrationBadge, MissionBadge } from './Badges';
import { ReasonDialog } from './Dialog';
import { TelemetryPanel } from './TelemetryPanel';
import { BuildingPanel } from './BuildingPanel';
import { SiteOverview } from './SiteOverview';
import { DevicePanel } from './DevicePanel';
import { Checklist, SlaChips } from './Sla';
import { BUILDINGS, floorPlan } from '@13store/shared';
import { ago, useT } from '../i18n';

const SEV = { low: 'Low', medium: 'Medium', high: 'High' } as const;

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
  const bld = s.selectedBuildingId ? BUILDINGS.find((b) => b.id === s.selectedBuildingId) : undefined;
  if (bld) return <BuildingPanel b={bld} />;
  const dev = s.selectedDeviceId ? s.devices[s.selectedDeviceId] : undefined;
  if (dev) return <DevicePanel d={dev} />;
  const inc = s.incidents.find((i) => i.id === s.selectedIncidentId);
  if (!inc) return <SiteOverview />;
  return <IncidentPanel inc={inc} />;
}

function IncidentPanel({ inc }: { inc: Incident }) {
  const { s, dispatch, mode } = useStore();
  const t = useT();
  const me = currentUser(s);
  const m = missionForIncident(s, inc.id);
  const live = m && ['assigned', 'executing', 'paused'].includes(m.status);
  const [feedTab, setFeedTab] = useState<'cctv' | 'ugv'>('cctv');
  const cam = inc.cameraId ? s.devices[inc.cameraId] : undefined;
  const ugv = m ? s.devices[m.deviceId] : undefined;
  const showUgvFeed = live && feedTab === 'ugv' && ugv;
  const replay = s.replay.active;
  const videoOk = useVideoAllowed(showUgvFeed ? ugv?.id : cam?.id);

  return (
    <aside className="panel right">
      <div className="panel-head">
        <h2>{t('Incident details')}</h2>
        <div className="row">
          <button className="icon-btn" aria-label={t('More')}>
            <Ellipsis size={18} />
          </button>
          <button className="icon-btn" aria-label={t('Deselect incident')} title={t('Back to the site overview')} onClick={() => dispatch({ type: 'selectIncident', id: null })}>
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="inc-head">
        <div className="row gap">
          <span className="inc-big-id">{inc.id}</span>
          {inc.status === 'new' || inc.status === 'triaging' ? (
            <Badge tone="amber">
              <CircleAlert size={13} /> {t('Unverified')}
            </Badge>
          ) : (
            <IncidentBadge status={inc.status} />
          )}
        </div>
        <h3>{inc.title}</h3>
        <div className="muted row gap-s">
          <MapPin size={14} /> {inc.place} <span className="sep">|</span> {inc.zone}
        </div>
        <SlaChips inc={inc} />
        <dl className="meta">
          <div>
            <dt>{t('Source')}</dt>
            <dd>{inc.source}</dd>
          </div>
          <div>
            <dt>{t('Received')}</dt>
            <dd>
              {fmtTime(inc.createdAt, true)} · {ago(s.now - inc.createdAt)}
            </dd>
          </div>
          <div>
            <dt>{t('Owner')}</dt>
            <dd>{inc.owner ?? t('Unassigned')}</dd>
          </div>
          <div>
            <dt>{t('Status')}</dt>
            <dd>
              <IncidentBadge status={inc.status} />
            </dd>
          </div>
          <div>
            <dt>{t('Severity')}</dt>
            <dd>
              {mode === 'remote' && can(me.role, 'incident.edit') && !replay ? (
                <select
                  id={`sev-${inc.id}`}
                  className="sev"
                  value={inc.severity}
                  onChange={(e) => dispatch({ type: 'editIncident', incidentId: inc.id, severity: e.target.value as Incident['severity'] })}
                >
                  <option value="low">{t('Low')}</option>
                  <option value="medium">{t('Medium')}</option>
                  <option value="high">{t('High')}</option>
                </select>
              ) : (
                <span className="cap">{t(SEV[inc.severity])}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>{t('Type')}</dt>
            <dd>{inc.type}</dd>
          </div>
        </dl>
      </div>

      {(cam || showUgvFeed) && videoOk !== true && (
        <div className="feed-wrap">
          <NoVideo why={videoOk === null ? t('Opening video…') : t('Your role cannot view video. Ask a supervisor if you need access.')} />
        </div>
      )}
      {(cam || showUgvFeed) && videoOk === true && (
        <div className="feed-wrap">
          {live && ugv && (
            <div className="tabs small">
              <button className={feedTab === 'cctv' ? 'on' : ''} onClick={() => setFeedTab('cctv')}>
                {cam?.id ?? 'CCTV'}
              </button>
              <button className={feedTab === 'ugv' ? 'on' : ''} onClick={() => setFeedTab('ugv')}>
                {t('{id} camera', { id: ugv.id })}
              </button>
            </div>
          )}
          {showUgvFeed ? (
            <CameraFeed
              scene="ugv"
              label={t('{id} onboard', { id: ugv.id })}
              time={replay ? s.replay.at : freshness(s, ugv) === 'live' ? s.now : ugv.lastSeen}
              freshness={replay ? 'live' : freshness(s, ugv)}
              replay={replay}
              progress={m ? m.nextCp / m.checkpoints.length : 0}
              controls
              aimIncidentId={inc.id}
            />
          ) : cam ? (
            <CameraFeed
              scene={cam.view ?? 'gate'}
              label={`${cam.id}  ${inc.place}`}
              time={replay ? s.replay.at : freshness(s, cam) === 'live' ? s.now : cam.lastSeen}
              freshness={replay ? 'live' : freshness(s, cam)}
              replay={replay}
              controls
              aimIncidentId={inc.id}
            />
          ) : null}
        </div>
      )}

      <div className="panel-body">
        <Stage inc={inc} m={m} />
        <Checklist inc={inc} />
        <FieldTasks inc={inc} />
      </div>

      <div className="panel-foot">
        <button className="btn-outline" onClick={() => dispatch({ type: 'setView', view: 'evidence' })}>
          <FileText size={18} /> {t('View evidence')}
        </button>
        <RoleHint s={s} inc={inc} m={m} role={me.role} />
      </div>
    </aside>
  );
}

function RoleHint({ s, inc, m, role }: { s: AppState; inc: Incident; m?: Mission; role: string }) {
  const t = useT();
  let text: string | null = null;
  if (s.replay.active) text = 'You are viewing replay. Device control is off.';
  else if (role === 'auditor') text = 'Read-only role. Actions are disabled.';
  else if (m?.status === 'pending_approval' && role !== 'supervisor') text = 'Waiting for supervisor approval. (Demo: switch role to Supervisor.)';
  else if (m?.status === 'approved' && role !== 'operator') text = 'Approved. Waiting for the operator to accept. (Demo: switch role to Operator.)';
  else if (m?.status === 'assigned' && role !== 'operator') text = 'Operator holds control. Only they can start the mission.';
  else if (inc.status === 'confirmed' && !m) text = 'Approval required before dispatch.';
  if (!text) return null;
  return (
    <p className="hint">
      <CircleAlert size={16} /> {t(text)}
    </p>
  );
}

function Stage({ inc, m }: { inc: Incident; m?: Mission }) {
  const { s, dispatch } = useStore();
  const t = useT();
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
          <h4>{t('Step 1 · Verify the alert')}</h4>
          <p className="muted">{t('New alert. Not yet confirmed by an operator. Review the camera before deciding.')}</p>
          {inc.status === 'new' ? (
            <button
              className="btn-primary wide"
              disabled={!can(me.role, 'incident.triage') || s.replay.active}
              onClick={() => dispatch({ type: 'openCamera', incidentId: inc.id })}
            >
              <Video size={18} /> {t('Open camera & start review')}
            </button>
          ) : (
            <button className="btn-primary wide" disabled={!canVerify} onClick={() => dispatch({ type: 'confirmIncident', incidentId: inc.id })}>
              <ShieldCheck size={18} /> {t('Confirm — action required')}
            </button>
          )}
          <div className="row gap-s">
            <button className="btn-secondary grow" disabled={!canVerify} onClick={() => setDlg('dismiss')}>
              <Ban size={16} /> {t('False alarm')}
            </button>
            <button
              className="btn-secondary grow"
              disabled={!canVerify || !others.length}
              onClick={() => {
                setMergeInto(others[0]?.id ?? '');
                setDlg('merge');
              }}
            >
              <Merge size={16} /> {t('Merge duplicate')}
            </button>
          </div>
        </section>
        <ReadyDevices />
        {dlg === 'dismiss' && (
          <ReasonDialog
            title={t('Dismiss {id} as false alarm', { id: inc.id })}
            hint={t('e.g. Staff member opening the gate for a scheduled delivery, confirmed on CCTV-02.')}
            confirmLabel={t('Dismiss alert')}
            danger
            onClose={() => setDlg(null)}
            onConfirm={(r) => {
              dispatch({ type: 'dismissIncident', incidentId: inc.id, reason: r });
              setDlg(null);
            }}
          />
        )}
        {dlg === 'merge' && (
          <ReasonDialog
            title={t('Merge {id} into another incident', { id: inc.id })}
            hint={t('e.g. Same sensor triggered twice within one minute.')}
            confirmLabel={t('Merge')}
            onClose={() => setDlg(null)}
            extra={
              <label className="field">
                <span>{t('Merge into')}</span>
                <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
                  {others.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.id} · {o.title}
                    </option>
                  ))}
                </select>
                <small className="muted">{t('Original evidence stays attached to {id}.', { id: inc.id })}</small>
              </label>
            }
            onConfirm={(r) => {
              dispatch({ type: 'mergeIncident', incidentId: inc.id, intoId: mergeInto, reason: r });
              setDlg(null);
            }}
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
        {m && (
          <p className="banner info">
            {t('Previous mission {id}:', { id: m.id })} <MissionBadge status={m.status} />
          </p>
        )}
        <PrepareMission inc={inc} />
        <details className="step">
          <summary>{t('Resolve without a mission')}</summary>
          <Outcome inc={inc} />
        </details>
      </>
    );
  }

  if (inc.status === 'confirmed' || inc.status === 'responding') {
    return (
      <section className="step">
        <h4>{t('Step 4 · Record the outcome')}</h4>
        {m && (
          <p className="muted">
            {t('Mission {id}:', { id: m.id })} <MissionBadge status={m.status} />
          </p>
        )}
        <Outcome inc={inc} />
      </section>
    );
  }

  if (inc.status === 'resolved') {
    return (
      <section className="step">
        <h4>{t('Resolved')}</h4>
        <p>{inc.outcome}</p>
        <div className="row gap-s">
          <button
            className="btn-primary grow"
            disabled={!can(me.role, 'incident.close') || s.replay.active}
            onClick={() => dispatch({ type: 'closeIncident', incidentId: inc.id })}
          >
            <Lock size={16} /> {t('Close incident')}
          </button>
          <button className="btn-secondary grow" onClick={() => dispatch({ type: 'setView', view: 'reports' })}>
            <FileText size={16} /> {t('Report')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="step">
      <h4>{inc.status === 'closed' ? t('Closed') : inc.status === 'duplicate' ? t('Duplicate of {id}', { id: inc.duplicateOf }) : t('Dismissed')}</h4>
      {inc.outcome && <p>{inc.outcome}</p>}
      <button className="btn-secondary wide" onClick={() => dispatch({ type: 'setView', view: 'reports' })}>
        <FileText size={16} /> {t('Open report')}
      </button>
      <Reopen inc={inc} />
    </section>
  );
}

function Outcome({ inc }: { inc: Incident }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const me = currentUser(s);
  const [outcome, setOutcome] = useState('');
  return (
    <>
      <label className="field">
        <span>{t('Outcome')}</span>
        <textarea
          rows={3}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          placeholder={t('e.g. Gate found closed and locked. No one present. Sensor flagged for maintenance.')}
        />
      </label>
      <button
        className="btn-primary wide"
        disabled={!outcome.trim() || !can(me.role, 'incident.resolve') || s.replay.active}
        onClick={() => dispatch({ type: 'resolveIncident', incidentId: inc.id, outcome })}
      >
        <Check size={18} /> {t('Resolve incident')}
      </button>
    </>
  );
}

/** Estimated arrival of every vehicle at the incident, planned around buildings and keep-out zones. */
function useUnitRanking(inc: Incident | undefined) {
  const { s } = useStore();
  const ids = Object.values(s.devices)
    .filter((d) => d.kind !== 'cctv')
    .map((d) => `${d.id}:${Math.round(d.pos.x)}:${Math.round(d.pos.y)}`)
    .join(',');
  return useMemo(() => {
    const out = new Map<string, { etaS: number; lengthM: number; ok: boolean; reason?: string; route: Point[] }>();
    if (!inc) return out;
    // Indoor vehicles follow floor plans, not the site planner: no outdoor ETA for them.
    const units = Object.values(s.devices).filter((d) => d.kind !== 'cctv' && !d.indoor);
    for (const r of rankUnits(units, inc.pos, s.geofences))
      out.set(
        r.unit.id,
        r.plan.ok ? { etaS: r.etaS, lengthM: r.lengthM, ok: true, route: r.plan.checkpoints } : { etaS: Infinity, lengthM: Infinity, ok: false, reason: r.plan.reason, route: [] },
      );
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, inc?.id, inc?.pos.x, inc?.pos.y, s.geofences]);
}

function ReadyDevices({ onPick, picked, inc }: { onPick?: (id: string) => void; picked?: string; inc?: Incident }) {
  const { s } = useStore();
  const t = useT();
  const rank = useUnitRanking(inc);
  const list = Object.values(s.devices)
    .filter((d) => d.kind !== 'cctv')
    .sort((a, b) => Number(isReady(s, b)) - Number(isReady(s, a)) || (rank.get(a.id)?.etaS ?? Infinity) - (rank.get(b.id)?.etaS ?? Infinity));
  const best = list.find((d) => isReady(s, d) && rank.get(d.id)?.ok)?.id;
  return (
    <section className="step">
      <h4>{onPick ? t('Choose device') : t('Available device')}</h4>
      {list.map((d) => (
        <DeviceCard key={d.id} d={d} onPick={onPick} picked={picked === d.id} eta={rank.get(d.id)} best={d.id === best} />
      ))}
    </section>
  );
}

function fmtEta(sec: number) {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const r = Math.round(sec % 60);
  return m ? `${m} min ${String(r).padStart(2, '0')} s` : `${r} s`;
}

function DeviceCard({
  d,
  onPick,
  picked,
  eta,
  best,
}: {
  d: Device;
  onPick?: (id: string) => void;
  picked?: boolean;
  eta?: { etaS: number; lengthM: number; ok: boolean; reason?: string };
  best?: boolean;
}) {
  const { s } = useStore();
  const t = useT();
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
              {[18, 34, 50].map((x) => (
                <circle key={x} cx={x + 4} cy="40" r="7" fill="#151d27" stroke="#4b5868" />
              ))}
            </g>
          ) : (
            <g stroke="#5c6b7d" fill="#2f3a48">
              <rect x="30" y="22" width="20" height="12" rx="3" />
              <line x1="30" y1="24" x2="12" y2="14" />
              <line x1="50" y1="24" x2="68" y2="14" />
              <line x1="30" y1="32" x2="12" y2="42" />
              <line x1="50" y1="32" x2="68" y2="42" />
              {[
                [12, 14],
                [68, 14],
                [12, 42],
                [68, 42],
              ].map(([x, y]) => (
                <ellipse key={`${x}${y}`} cx={x} cy={y} rx="9" ry="2.5" fill="#38bdf8" opacity=".35" />
              ))}
            </g>
          )}
        </svg>
      </div>
      <div className="dev-info">
        <div className="row between">
          <strong>{d.id}</strong>
          {d.battery !== undefined && (
            <span className="batt">
              <BatteryMedium size={16} /> {Math.round(d.battery)}%
            </span>
          )}
        </div>
        <div className="row gap-s wrap">
          <IntegrationBadge i={d.integration} />
          <FreshBadge f={f} />
        </div>
        <small className="muted">
          {t('Updated {ago}', { ago: ago(ageMs(s, d)) })} ·{' '}
          {d.capabilities
            .slice(0, 2)
            .map((c) => t(c.replace('_', ' ')))
            .join(' · ')}
        </small>
        {eta && canPatrol && (
          <small className={`eta${best ? ' best' : ''}`}>
            {eta.ok ? (
              <>
                <RouteIcon size={12} /> {t('ETA {eta} · {m} m', { eta: fmtEta(eta.etaS), m: eta.lengthM })}
                {best && ready ? ` · ${t('nearest')}` : ''}
              </>
            ) : (
              <>
                <RouteIcon size={12} /> {eta.reason ?? t('No clear route')}
              </>
            )}
          </small>
        )}
        {!canPatrol && <small className="warn-text">{t('Display only — no commands supported')}</small>}
        {canPatrol && !ready && (
          <small className="warn-text">
            {t('Not ready')}
            {d.controlOwner ? ` · ${t('held by {name}', { name: userName(s, d.controlOwner) })}` : ''}
          </small>
        )}
      </div>
    </button>
  );
}

function PrepareMission({ inc }: { inc: Incident }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const me = currentUser(s);
  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState('UGV-01');
  const [route, setRoute] = useState('direct');
  const picked = s.devices[deviceId];
  const indoorPlan = picked?.indoor ? floorPlan(picked.indoor.buildingId, picked.indoor.level) : undefined;
  // Route planned around buildings and keep-out zones from where the vehicle is now to the alert.
  const autoPlan = useMemo(
    () => (picked && !picked.indoor && (picked.kind === 'ugv' || picked.kind === 'uav') ? planRoute(picked.pos, inc.pos, { fences: s.geofences, kind: picked.kind }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceId, inc.id, Math.round(picked?.pos.x ?? 0), Math.round(picked?.pos.y ?? 0), s.geofences],
  );
  useEffect(() => {
    // Indoor vehicle: the floor patrol is the only sensible default; outdoor routes would cross walls.
    if (indoorPlan && route !== 'indoor') setRoute('indoor');
    else if (!indoorPlan && (route === 'indoor' || route === 'auto')) setRoute(autoPlan?.ok ? 'auto' : 'direct');
    else if (!indoorPlan && autoPlan?.ok && route === 'direct') setRoute('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);
  const operators = s.users.filter((u) => u.role === 'operator');
  const [op, setOp] = useState(operators[0]?.id ?? '');
  const allowed = can(me.role, 'mission.prepare') && !s.replay.active;

  if (!open)
    return (
      <>
        <ReadyDevices inc={inc} />
        <section className="step">
          <button className="btn-primary wide big" disabled={!allowed} onClick={() => setOpen(true)}>
            <Play size={18} /> {t('Prepare mission')}
          </button>
        </section>
      </>
    );

  return (
    <>
      <section className="step">
        <h4>{t('Step 2 · Prepare mission')}</h4>
        <ol className="stepper">
          <li className="on">{t('Device')}</li>
          <li className="on">{t('Route & operator')}</li>
          <li>{t('Checks')}</li>
          <li>{t('Approval')}</li>
        </ol>
      </section>
      <ReadyDevices onPick={setDeviceId} picked={deviceId} inc={inc} />
      <section className="step">
        <label className="field">
          <span>
            <RouteIcon size={14} /> {t('Route')}
          </span>
          <select value={route} onChange={(e) => setRoute(e.target.value)}>
            {autoPlan?.ok && (
              <option value="auto">
                {t('Auto-planned to the alert · {k} checkpoints · {m} m · ETA {eta}', { k: autoPlan.checkpoints.length, m: autoPlan.lengthM, eta: fmtEta(autoPlan.etaS) })}
              </option>
            )}
            {indoorPlan && (
              <option value="indoor">
                {t('Floor patrol · {b} level {n} · {k} checkpoints', {
                  b: t(BUILDINGS.find((x) => x.id === indoorPlan.buildingId)?.name ?? ''),
                  n: indoorPlan.level,
                  k: indoorPlan.patrolRoute.length,
                })}
              </option>
            )}
            {ROUTES.map((r) => (
              <option key={r.id} value={r.id}>
                {t(r.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            <UserCheck size={14} /> {t('Operator')}
          </span>
          <select value={op} onChange={(e) => setOp(e.target.value)}>
            {operators.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.title}
              </option>
            ))}
          </select>
        </label>
        <div className="row gap-s">
          <button className="btn-secondary" onClick={() => setOpen(false)}>
            {t('Cancel')}
          </button>
          <button
            className="btn-primary grow"
            disabled={!allowed || !deviceId}
            onClick={() =>
              dispatch({
                type: 'createMission',
                incidentId: inc.id,
                deviceId,
                operatorId: op,
                checkpoints:
                  route === 'indoor' && indoorPlan
                    ? indoorPlan.patrolRoute
                    : route === 'auto' && autoPlan?.ok
                      ? autoPlan.checkpoints
                      : (ROUTES.find((r) => r.id === route) ?? ROUTES[0]).pts,
              })
            }
          >
            {t('Save draft & run checks')}
          </button>
        </div>
      </section>
    </>
  );
}

function Planner({ m }: { m: Mission }) {
  const { s, dispatch } = useStore();
  const t = useT();
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
          <h4>
            {m.status === 'draft' || m.status === 'rejected'
              ? t('Step 2 · Mission draft')
              : m.status === 'pending_approval'
                ? t('Step 3 · Approval')
                : t('Step 3 · Operator acceptance')}
          </h4>
          <MissionBadge status={m.status} />
        </div>
        {reapproval && <p className="banner warn">{t('Route changed. Re-approval required (plan v{v}, approved v{a}).', { v: m.planVersion, a: m.approvedVersion })}</p>}
        {m.status === 'rejected' && m.note && (
          <p className="banner warn">
            {t('Rejected:')} {m.note}
          </p>
        )}
        <dl className="meta">
          <div>
            <dt>{t('Mission')}</dt>
            <dd>
              {m.id} · {t('plan v{v}', { v: m.planVersion })}
            </dd>
          </div>
          <div>
            <dt>{t('Device')}</dt>
            <dd>{m.deviceId}</dd>
          </div>
          <div>
            <dt>{t('Operator')}</dt>
            <dd>{userName(s, m.operatorId)}</dd>
          </div>
          <div>
            <dt>{t('Approved by')}</dt>
            <dd>{m.approvedBy && m.approvedVersion === m.planVersion ? userName(s, m.approvedBy) : '—'}</dd>
          </div>
        </dl>
        <label className="field">
          <span>
            <RouteIcon size={14} /> {t('Route')} {m.approvedVersion === m.planVersion ? t('(approved — solid on map)') : t('(draft — dashed on map)')}
          </span>
          <select
            value={rid}
            disabled={!canPrep}
            onChange={(e) => {
              const r = ROUTES.find((x) => x.id === e.target.value);
              if (r) dispatch({ type: 'editRoute', missionId: m.id, checkpoints: r.pts });
            }}
          >
            {ROUTES.map((r) => (
              <option key={r.id} value={r.id}>
                {t(r.label)}
              </option>
            ))}
            {rid === 'custom' && <option value="custom">{t('Custom route')}</option>}
          </select>
        </label>
      </section>
      <section className="step">
        <h4>{t('Constraint checks')}</h4>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? 'ok' : c.hard ? 'fail' : 'warn'}>
              {c.ok ? <Check size={15} /> : c.hard ? <X size={15} /> : <CircleAlert size={15} />}
              <span>{t(c.label)}</span>
              <small>{c.detail}</small>
            </li>
          ))}
        </ul>
      </section>
      <section className="step">
        {(m.status === 'draft' || m.status === 'rejected') && (
          <>
            <button className="btn-primary wide big" disabled={!canPrep || hardFail} onClick={() => dispatch({ type: 'submitMission', missionId: m.id })}>
              <Send size={18} /> {t('Submit for approval')}
            </button>
            <button className="btn-secondary wide" disabled={!canPrep} onClick={() => dispatch({ type: 'cancelMission', missionId: m.id })}>
              {t('Discard draft')}
            </button>
          </>
        )}
        {m.status === 'pending_approval' && (
          <div className="row gap-s">
            <button className="btn-secondary grow" disabled={!canApprove} onClick={() => setDlg(true)}>
              {t('Reject')}
            </button>
            <button className="btn-primary grow" disabled={!canApprove || hardFail} onClick={() => dispatch({ type: 'approveMission', missionId: m.id })}>
              <ShieldCheck size={18} /> {t('Approve plan v{v}', { v: m.planVersion })}
            </button>
          </div>
        )}
        {m.status === 'approved' && (
          <button
            className="btn-primary wide big"
            disabled={me.role !== 'operator' || me.id !== m.operatorId || s.replay.active}
            onClick={() => dispatch({ type: 'acceptMission', missionId: m.id })}
          >
            <Hand size={18} /> {t('Accept mission & take control')}
          </button>
        )}
      </section>
      {dlg && (
        <ReasonDialog
          title={t('Reject {id}', { id: m.id })}
          hint={t('e.g. Use the perimeter route to avoid the delivery bay.')}
          confirmLabel={t('Reject plan')}
          danger
          onClose={() => setDlg(false)}
          onConfirm={(r) => {
            dispatch({ type: 'rejectMission', missionId: m.id, reason: r });
            setDlg(false);
          }}
        />
      )}
    </>
  );
}

export function LiveMission({ m }: { m: Mission }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const me = currentUser(s);
  const d = s.devices[m.deviceId];
  const f = freshness(s, d);
  const age = ageMs(s, d);
  const cmds = s.commands
    .filter((c) => c.missionId === m.id)
    .slice()
    .reverse();
  const pending = cmds.find((c) => !isTerminal(c));
  const holder = d.controlOwner;
  const iHold = holder === me.id;
  const off = s.replay.active;

  const send = (type: CommandType) => {
    const n = s.commands.filter((c) => c.missionId === m.id && c.type === type && isTerminal(c)).length;
    dispatch({ type: 'issueCommand', missionId: m.id, command: type, idempotencyKey: `${m.id}:${type}:${n}` });
  };
  const has = (c: CommandType) => d.commands.includes(c);

  return (
    <>
      <section className="step">
        <div className="row between">
          <h4>{t('Step 3 · Live mission')}</h4>
          <MissionBadge status={m.status} />
        </div>
        <div className={`control-held${iHold ? ' me' : ''}`}>
          <Lock size={15} /> CONTROL HELD · {t('Controlled by')} <strong>{userName(s, holder)}</strong>
          {iHold && <span className="muted"> {t('(you)')}</span>}
        </div>
        <dl className="meta">
          <div>
            <dt>{t('Telemetry')}</dt>
            <dd>
              <FreshBadge f={f} age={ago(age)} />
            </dd>
          </div>
          <div>
            <dt>{t('Battery')}</dt>
            <dd>{Math.round(d.battery ?? 0)}%</dd>
          </div>
          <div>
            <dt>{t('Progress')}</dt>
            <dd>{t('Checkpoint {n} of {total}', { n: Math.min(m.nextCp + 1, m.checkpoints.length), total: m.checkpoints.length })}</dd>
          </div>
          <div>
            <dt>{t('Speed')}</dt>
            <dd>{f === 'live' ? `${d.speed.toFixed(1)} m/s` : t('unknown')}</dd>
          </div>
        </dl>
        <TelemetryPanel deviceId={d.id} />
        {f !== 'live' && (
          <p className="banner warn">{t('Last data {ago}. New start/resume commands are held. Vehicle state is uncertain — check with the field operator.', { ago: ago(age) })}</p>
        )}
        {m.note && <p className="banner info">{m.note}</p>}
      </section>

      <section className="step">
        {!iHold && (
          <p className="banner info">
            {t('Only {name} can command {id}.', { name: userName(s, holder), id: d.id })}
            {can(me.role, 'control.handover') && !off && (
              <button className="link" onClick={() => dispatch({ type: 'handover', deviceId: d.id, toUserId: me.id })}>
                {t('Take over control (logged)')}
              </button>
            )}
          </p>
        )}
        {m.status === 'assigned' && has('start') && (
          <button className="btn-primary wide big" disabled={!iHold || off} onClick={() => send('start')}>
            <Play size={18} /> {pending?.type === 'start' ? t('Start requested — waiting for vehicle') : t('Send start request')}
          </button>
        )}
        {(m.status === 'executing' || m.status === 'paused') && (
          <div className="ctl-grid">
            {m.status === 'executing' && has('pause') && (
              <button className="btn-secondary" disabled={!iHold || off} onClick={() => send('pause')} title={t('Hold position. Mission can be resumed.')}>
                <Pause size={18} /> {t('Pause mission')}
              </button>
            )}
            {m.status === 'paused' && has('resume') && (
              <button className="btn-secondary" disabled={!iHold || off} onClick={() => send('resume')}>
                <Play size={18} /> {t('Resume')}
              </button>
            )}
            {has('stop') && (
              <button className="btn-danger" disabled={!iHold || off} onClick={() => send('stop')} title={t('Ask the vehicle to stop and end the mission. Not an emergency stop.')}>
                <OctagonX size={18} /> {t('Stop request')}
              </button>
            )}
          </div>
        )}
        <p className="fine">{t('Stop request is not an emergency stop. Use the physical E-stop on the vehicle for emergencies.')}</p>
      </section>

      <section className="step">
        <h4>{t('Commands')}</h4>
        {cmds.length === 0 && <p className="muted">{t('No commands sent yet.')}</p>}
        <ul className="cmds">
          {cmds.map((c) => (
            <li key={c.id}>
              <div className="row between">
                <strong>{c.type.toUpperCase()}</strong>
                <CommandBadge status={c.status} />
              </div>
              <small className="muted mono">
                {t('{id} · sent {time} by {name} · key {key}', {
                  id: c.id,
                  time: fmtTime(c.issuedAt, true),
                  name: userName(s, c.issuer),
                  key: c.idempotencyKey.split(':').slice(1).join(':'),
                })}
              </small>
              {c.detail && <small className={c.status === 'succeeded' ? 'muted' : 'warn-text'}>{c.detail}</small>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** Asks the media gateway for a signed stream; video stays hidden if the role may not view it (F13). */
function useVideoAllowed(deviceId?: string) {
  const { s, session } = useStore();
  const role = currentUser(s).role;
  const [ok, setOk] = useState<boolean | null>(session ? null : can(role, 'media.view'));
  useEffect(() => {
    if (!session) return setOk(can(role, 'media.view'));
    if (!deviceId) return;
    let live = true;
    setOk(null);
    session.mediaUrl(deviceId).then(
      () => live && setOk(true),
      () => live && setOk(false),
    );
    return () => {
      live = false;
    };
  }, [deviceId, session, role]);
  return ok;
}

function NoVideo({ why }: { why: string }) {
  return (
    <div className="feed no-video">
      <Video size={22} />
      <span>{why}</span>
    </div>
  );
}

function FieldTasks({ inc }: { inc: Incident }) {
  const { s, dispatch, mode } = useStore();
  const t = useT();
  const me = currentUser(s);
  const tasks = s.assignments.filter((a) => a.incidentId === inc.id);
  const responders = s.users.filter((u) => u.role === 'responder');
  const [pick, setPick] = useState('');
  if (mode !== 'remote' || (!tasks.length && !can(me.role, 'incident.assign'))) return null;
  const open = !['closed', 'dismissed', 'duplicate', 'resolved'].includes(inc.status);
  const label = {
    assigned: t('Waiting to accept'),
    accepted: t('Accepted · en route'),
    on_scene: t('On scene'),
    reported: t('Report received'),
    cancelled: t('Cancelled'),
  } as const;
  return (
    <section className="step">
      <h4>
        <Users size={14} /> {t('Field responders')}
      </h4>
      {tasks.map((a) => (
        <div key={a.id} className="row between">
          <span>{userName(s, a.responderId)}</span>
          <Badge tone={a.status === 'reported' ? 'green' : a.status === 'on_scene' ? 'cyan' : 'amber'}>{label[a.status]}</Badge>
        </div>
      ))}
      {tasks.some((a) => a.note) && <p className="muted">“{tasks.find((a) => a.note)?.note}”</p>}
      {open && can(me.role, 'incident.assign') && responders.length > 0 && (
        <div className="row gap-s">
          <select id={`assign-${inc.id}`} className="grow" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{t('Send a field responder…')}</option>
            {responders.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.title}
              </option>
            ))}
          </select>
          <button
            className="btn-secondary"
            disabled={!pick || s.replay.active}
            onClick={() => {
              dispatch({ type: 'assignResponder', incidentId: inc.id, responderId: pick });
              setPick('');
            }}
          >
            {t('Assign')}
          </button>
        </div>
      )}
    </section>
  );
}

function Reopen({ inc }: { inc: Incident }) {
  const { s, dispatch, mode } = useStore();
  const t = useT();
  const [open, setOpen] = useState(false);
  if (mode !== 'remote' || !can(currentUser(s).role, 'incident.reopen')) return null;
  return (
    <>
      <button className="btn-secondary wide" disabled={s.replay.active} onClick={() => setOpen(true)}>
        <RotateCcw size={16} /> {t('Reopen')}
      </button>
      {open && (
        <ReasonDialog
          title={t('Reopen {id}', { id: inc.id })}
          hint={t('e.g. Sensor triggered again; needs another look.')}
          confirmLabel={t('Reopen')}
          onClose={() => setOpen(false)}
          onConfirm={(r) => {
            dispatch({ type: 'reopenIncident', incidentId: inc.id, reason: r });
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
