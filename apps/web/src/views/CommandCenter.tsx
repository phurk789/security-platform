// Unified UGV & UAV Command Center: one screen to watch and run every ground and air unit.
// Left: unit roster. Centre: primary onboard video with flight/drive instruments, the 3D twin
// following the unit, live telemetry. Right: mission control (same safety rules as the incident
// flow), camera control, unit activity log.
import { useMemo, useState } from 'react';
import { Activity, ArrowRight, Crosshair, Drone, Gauge, ListChecks, MapPinned, Navigation, Truck } from 'lucide-react';
import { UGV_SPEED, dist, type Device, type Mission } from '@13store/shared';
import { can, currentUser, fmtTime, freshness, userName } from '../domain/policy';
import { isTerminal } from '../domain/reducer';
import { useT, type T } from '../i18n';
import { useStore } from '../store';
import { CommandBadge, MissionBadge } from '../components/Badges';
import { CameraFeed } from '../components/CameraFeed';
import { CameraControls } from '../components/CameraControls';
import { FleetCard } from '../components/Hud';
import { LiveMission } from '../components/IncidentPanel';
import { TelemetryPanel } from '../components/TelemetryPanel';
import { Twin3D } from '../components/Twin3D';
import { webglAvailable } from '../twin/world';
import './command-center.css';

const OPEN_MISSION = ['draft', 'pending_approval', 'approved', 'assigned', 'executing', 'paused'];

export function CommandCenter() {
  const { s, dispatch } = useStore();
  const t = useT();
  const [filter, setFilter] = useState<'all' | 'ugv' | 'uav'>('all');
  const units = Object.values(s.devices)
    .filter((d) => d.kind === 'ugv' || d.kind === 'uav')
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'ugv' ? -1 : 1));
  const shown = units.filter((d) => filter === 'all' || d.kind === filter);
  const selId = s.selectedDeviceId && units.some((u) => u.id === s.selectedDeviceId) ? s.selectedDeviceId : units[0]?.id;
  const d = selId ? s.devices[selId] : undefined;
  const m = d ? s.missions.find((x) => x.deviceId === d.id && OPEN_MISSION.includes(x.status)) : undefined;
  const count = (k: 'ugv' | 'uav') => units.filter((u) => u.kind === k).length;

  return (
    <div className="cc">
      <aside className="panel cc-rail">
        <div className="panel-head">
          <h2>{t('Units')}</h2>
          <span className="hud-count">{units.filter((u) => freshness(s, u) === 'live').length}/{units.length} LIVE</span>
        </div>
        <div className="cc-filter seg" role="tablist">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>{t('All')} {units.length}</button>
          <button className={filter === 'ugv' ? 'on' : ''} onClick={() => setFilter('ugv')}><Truck size={14} /> {count('ugv')}</button>
          <button className={filter === 'uav' ? 'on' : ''} onClick={() => setFilter('uav')}><Drone size={14} /> {count('uav')}</button>
        </div>
        <div className="cc-units">
          {shown.map((u) => (
            <FleetCard key={u.id} d={u} video={false} />
          ))}
          {!shown.length && <p className="empty">{t('No units of this type.')}</p>}
        </div>
      </aside>

      {d ? (
        <>
          <section className="cc-main">
            <MissionStrip d={d} m={m} />
            <div className="cc-video">
              {can(currentUser(s).role, 'media.view') ? (
                <>
                  <CameraFeed scene="ugv" label={t('{id} onboard', { id: d.id })} deviceId={d.id} time={freshness(s, d) === 'live' ? s.now : d.lastSeen} freshness={freshness(s, d)} replay={s.replay.active} />
                  <Instruments d={d} m={m} />
                </>
              ) : (
                <div className="cc-novideo">{t('Your role cannot view video. Ask a supervisor if you need access.')}</div>
              )}
            </div>
            <div className="cc-lower">
              <div className="panel cc-twin">
                <div className="cc-twin-head"><MapPinned size={14} /> {t('Digital twin · following {id}', { id: d.id })}</div>
                {webglAvailable() ? <Twin3D follow={d.id} /> : <p className="empty">{t('3D view needs WebGL.')}</p>}
              </div>
              <div className="cc-tlm">
                <TelemetryPanel deviceId={d.id} />
              </div>
            </div>
          </section>

          <aside className="cc-side">
            <section className="panel cc-box">
              <div className="panel-head"><h2>{t('Mission control')}</h2></div>
              <div className="cc-box-body">
                <MissionControl d={d} m={m} />
              </div>
            </section>
            {d.capabilities.includes('gimbal') && (
              <section className="panel cc-box">
                <div className="panel-head"><h2>{t('Camera')}</h2></div>
                <div className="cc-box-body">
                  <CameraControls device={d} aimAt={m ? { incidentId: m.incidentId } : undefined} />
                </div>
              </section>
            )}
            <section className="panel cc-box cc-log-box">
              <div className="panel-head"><h2>{t('Activity')}</h2></div>
              <ActivityLog d={d} />
            </section>
          </aside>
        </>
      ) : (
        <section className="cc-main cc-empty">
          <p className="empty">{t('No ground or air units registered.')}</p>
          <button className="btn-secondary" onClick={() => dispatch({ type: 'setView', view: 'devices' })}>{t('Open devices')}</button>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mission strip: unit, mission, incident, checkpoint progress, distance and ETA
// ---------------------------------------------------------------------------

function remaining(d: Device, m: Mission) {
  let total = 0;
  let from = d.pos;
  for (const cp of m.checkpoints.slice(m.nextCp)) {
    total += dist(from, cp);
    from = cp;
  }
  return total;
}

function MissionStrip({ d, m }: { d: Device; m?: Mission }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const inc = m ? s.incidents.find((i) => i.id === m.incidentId) : undefined;
  const Icon = d.kind === 'uav' ? Drone : Truck;
  const left = m ? remaining(d, m) : 0;
  const moving = m?.status === 'executing';
  const eta = moving ? left / Math.max(d.speed > 0.5 ? d.speed : UGV_SPEED * 0.6, 0.5) : null;
  return (
    <div className="panel cc-strip">
      <span className={`fc-ico k-${d.kind}`}><Icon size={18} /></span>
      <div className="cc-strip-id">
        <b>{d.id}</b>
        <small>{d.model}</small>
      </div>
      {m ? (
        <>
          <div className="cc-strip-m">
            <span className="mono">{m.id}</span> <MissionBadge status={m.status} />
            {inc && (
              <button className="link" onClick={() => { dispatch({ type: 'selectIncident', id: inc.id }); dispatch({ type: 'setView', view: 'overview' }); }}>
                {inc.id} · {inc.title} <ArrowRight size={12} />
              </button>
            )}
          </div>
          <ol className="cc-cps" aria-label={t('Checkpoints')}>
            {m.checkpoints.map((_, i) => (
              <li key={i} className={i < m.nextCp ? 'done' : i === m.nextCp && ['executing', 'paused'].includes(m.status) ? 'next' : ''}>
                <span>{i + 1}</span>
              </li>
            ))}
          </ol>
          <div className="cc-strip-num">
            <small>{t('Remaining')}</small>
            <b>{Math.round(left)} m</b>
          </div>
          <div className="cc-strip-num">
            <small>ETA</small>
            <b>{eta === null ? '—' : fmtDuration(eta)}</b>
          </div>
        </>
      ) : (
        <div className="cc-strip-m muted">{d.commands.length ? t('No active mission. Missions start from an incident and need a supervisor’s approval.') : t('Display and video only. This unit takes no commands.')}</div>
      )}
    </div>
  );
}

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Instruments drawn over the video: heading tape, speed tape, altitude tape (UAV), status corners
// ---------------------------------------------------------------------------

function Instruments({ d, m }: { d: Device; m?: Mission }) {
  const { s } = useStore();
  const f = freshness(s, d);
  if (f === 'offline') return null;
  const hdg = ((d.heading ?? 0) % 360 + 360) % 360;
  const mode = m?.status === 'executing' ? 'AUTO' : m?.status === 'paused' ? 'HOLD' : d.commands.length ? 'STANDBY' : 'MONITOR';
  // Heading tape: ±60° across 360 px, centred at x = 320.
  const ticks = [];
  for (let a = Math.ceil((hdg - 60) / 5) * 5; a <= hdg + 60; a += 5) {
    const x = 320 + (a - hdg) * 3;
    const n = ((a % 360) + 360) % 360;
    const major = n % 30 === 0;
    ticks.push(<line key={`h${a}`} x1={x} x2={x} y1={major ? 40 : 45} y2={52} className="ins-tick" />);
    if (major) ticks.push(<text key={`l${a}`} x={x} y={36} className="ins-lbl" textAnchor="middle">{({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[n] ?? String(n).padStart(3, '0')}</text>);
  }
  return (
    <svg className={`instruments${f === 'stale' ? ' stale' : ''}`} viewBox="0 0 640 360" preserveAspectRatio="none" aria-hidden="true">
      {/* heading */}
      <g>
        <line x1={200} x2={440} y1={52} y2={52} className="ins-tick" />
        {ticks}
        <path d="M314 58 L320 52 L326 58" className="ins-caret" />
        <rect x={296} y={58} width={48} height={18} rx={2} className="ins-box" />
        <text x={320} y={71} className="ins-val" textAnchor="middle">{String(Math.round(hdg)).padStart(3, '0')}°</text>
      </g>
      {/* speed tape */}
      <Tape x={46} value={d.speed} step={1} label="SPD" unit="m/s" side="left" />
      {/* altitude tape (air units) */}
      {d.kind === 'uav' && <Tape x={594} value={d.alt ?? 0} step={5} label="ALT" unit="m" side="right" />}
      {/* corners */}
      <text x={18} y={292} className="ins-mode">{mode}</text>
      <text x={18} y={310} className="ins-sm">GNSS {d.satellites ?? '—'} · ±{d.accuracyM.toFixed(1)} m</text>
      <text x={622} y={292} className="ins-mode" textAnchor="end">BAT {d.battery !== undefined ? Math.round(d.battery) : '—'}%</text>
      <text x={622} y={310} className="ins-sm" textAnchor="end">LINK {d.signal !== undefined ? Math.round(d.signal) : '—'}% · {d.latencyMs !== undefined ? Math.round(d.latencyMs) : '—'} ms</text>
    </svg>
  );
}

function Tape({ x, value, step, label, unit, side }: { x: number; value: number; step: number; label: string; unit: string; side: 'left' | 'right' }) {
  // ±5 steps across 180 px, centred at y = 190.
  const px = 18 / step;
  const lines = [];
  for (let v = Math.ceil((value - 5 * step) / step) * step; v <= value + 5 * step; v += step) {
    if (v < 0) continue;
    const y = 190 - (v - value) * px;
    const major = Math.round(v / step) % 2 === 0;
    const dir = side === 'left' ? 1 : -1;
    lines.push(<line key={`t${v}`} x1={x} x2={x + dir * (major ? 12 : 7)} y1={y} y2={y} className="ins-tick" />);
    if (major) lines.push(<text key={`v${v}`} x={x + dir * 16} y={y + 4} className="ins-lbl" textAnchor={side === 'left' ? 'start' : 'end'}>{Number(v.toFixed(1))}</text>);
  }
  const bx = side === 'left' ? x - 34 : x - 6;
  return (
    <g>
      <line x1={x} x2={x} y1={100} y2={280} className="ins-tick" />
      {lines}
      <rect x={bx} y={180} width={40} height={20} rx={2} className="ins-box" />
      <text x={bx + 20} y={194} className="ins-val" textAnchor="middle">{value.toFixed(1)}</text>
      <text x={x} y={94} className="ins-sm" textAnchor="middle">{label} {unit}</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Mission control: the live-mission controls from the incident flow, or what is needed next
// ---------------------------------------------------------------------------

function MissionControl({ d, m }: { d: Device; m?: Mission }) {
  const { dispatch } = useStore();
  const t = useT();
  if (!d.commands.length) return <p className="muted">{t('{id} is display and video only. It takes no commands.', { id: d.id })}</p>;
  if (!m) {
    return (
      <div className="cc-next">
        <p className="muted">{t('No active mission. Missions start from an incident and need a supervisor’s approval.')}</p>
        <button className="btn-secondary wide" onClick={() => dispatch({ type: 'setView', view: 'missions' })}><ListChecks size={16} /> {t('Open missions')}</button>
      </div>
    );
  }
  if (['assigned', 'executing', 'paused'].includes(m.status)) return <div className="cc-live"><LiveMission m={m} /></div>;
  return (
    <div className="cc-next">
      <p>{nextStep(m, t)}</p>
      <button className="btn-secondary wide" onClick={() => { dispatch({ type: 'selectIncident', id: m.incidentId }); dispatch({ type: 'setView', view: 'overview' }); }}>
        <Crosshair size={16} /> {t('Open {id}', { id: m.incidentId })}
      </button>
    </div>
  );
}

function nextStep(m: Mission, t: T) {
  switch (m.status) {
    case 'draft':
      return t('Draft route. The dispatcher submits it for approval.');
    case 'pending_approval':
      return t('Waiting for a supervisor to approve the route.');
    case 'approved':
      return t('Approved. The operator accepts the mission and takes control.');
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Activity: commands and events for this unit
// ---------------------------------------------------------------------------

function ActivityLog({ d }: { d: Device }) {
  const { s } = useStore();
  const t = useT();
  const rows = useMemo(() => {
    const cmds = s.commands.filter((c) => c.deviceId === d.id).map((c) => ({ at: c.issuedAt, key: c.id, kind: 'cmd' as const, c }));
    const evs = s.timeline.filter((e) => e.actor === d.id || e.title.includes(d.id)).map((e) => ({ at: e.at, key: e.id, kind: 'ev' as const, e }));
    return [...cmds, ...evs].sort((a, b) => b.at - a.at).slice(0, 12);
  }, [s.commands, s.timeline, d.id]);
  if (!rows.length) return <p className="empty">{t('No activity yet.')}</p>;
  return (
    <ul className="cc-log">
      {rows.map((r) =>
        r.kind === 'cmd' ? (
          <li key={r.key}>
            <span className="cc-log-t">{fmtTime(r.at, true)}</span>
            <span className="cc-log-i"><Navigation size={13} /></span>
            <span className="cc-log-x">
              <b>{t(r.c.type)}</b> · {s.users.some((u) => u.id === r.c.issuer) ? userName(s, r.c.issuer) : r.c.issuer}
              {!isTerminal(r.c) && <Activity size={12} className="spin-soft" />}
            </span>
            <CommandBadge status={r.c.status} />
          </li>
        ) : (
          <li key={r.key} className={r.e.tone ? `tone-${r.e.tone}` : ''}>
            <span className="cc-log-t">{fmtTime(r.at, true)}</span>
            <span className="cc-log-i"><Gauge size={13} /></span>
            <span className="cc-log-x">{r.e.title}</span>
          </li>
        ),
      )}
    </ul>
  );
}
