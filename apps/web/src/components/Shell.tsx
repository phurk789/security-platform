import { useState } from 'react';
import {
  Bell,
  Calendar,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Filter,
  History,
  House,
  Info,
  MapPin,
  Monitor,
  Plug,
  RotateCcw,
  Send,
  Server,
  SlidersHorizontal,
  TriangleAlert,
  Unplug,
  X,
  Zap,
} from 'lucide-react';
import { can, currentUser, fmtAge, fmtDate, fmtTime, freshness, isReady } from '../domain/policy';
import { isTerminal, missionForIncident } from '../domain/reducer';
import { SITE } from '@13store/shared';
import type { AppState, Incident, View } from '@13store/shared';
import { useStore } from '../store';
import { IncidentBadge } from './Badges';
import { CameraFeed } from './CameraFeed';

export function TopBar() {
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const [open, setOpen] = useState(false);
  const allLive = Object.values(s.devices).filter((d) => d.kind !== 'cctv').every((d) => freshness(s, d) === 'live');
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">13<b>STORE</b></span>
        <span className="divider" />
        <span className="product">PUBLIC SECURITY TWIN</span>
      </div>
      <div className="top-mid">
        <button className="site-select" title="Only sites you are authorised for are listed">
          <MapPin size={16} /> {SITE.name} <ChevronDown size={16} />
        </button>
        {s.replay.active ? (
          <span className="mode mode-replay"><History size={16} /> REPLAY · {fmtTime(s.replay.at, true)}</span>
        ) : (
          <span className="mode mode-sim"><TriangleAlert size={16} /> SIMULATION</span>
        )}
      </div>
      <div className="top-right">
        <span className={`health ${allLive ? 'ok' : 'warn'}`} title="Simulated services health">
          <span className="dot" /> {allLive ? 'Systems OK' : 'Telemetry degraded'}
        </span>
        <span className="clock"><Calendar size={16} /> {fmtDate(s.now)} &nbsp; {fmtTime(s.now)}</span>
        <div className="user">
          <button className="user-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span className="avatar">{me.name.split(' ').map((p) => p[0]).join('')}</span>
            <span className="user-txt"><b>{me.name}</b><small>{me.title}</small></span>
            <ChevronDown size={16} />
          </button>
          {open && (
            <div className="pop user-pop">
              <p className="pop-h">Switch role (demo)</p>
              {s.users.map((u) => (
                <button key={u.id} className={u.id === me.id ? 'on' : ''} onClick={() => { dispatch({ type: 'setUser', userId: u.id }); setOpen(false); }}>
                  {u.id === me.id ? <Check size={14} /> : <span className="sp" />} {u.name} <small>{u.role}</small>
                </button>
              ))}
              <hr />
              <button onClick={() => dispatch({ type: 'togglePresentation' })}>
                <Monitor size={14} /> Presentation mode {s.presentation ? 'on' : 'off'}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

const NAV: { id: View; label: string; Icon: typeof House }[] = [
  { id: 'overview', label: 'Overview', Icon: House },
  { id: 'incidents', label: 'Incidents', Icon: Bell },
  { id: 'missions', label: 'Missions', Icon: Send },
  { id: 'devices', label: 'Devices', Icon: Server },
  { id: 'evidence', label: 'Evidence', Icon: FileText },
  { id: 'reports', label: 'Reports', Icon: ChartNoAxesColumn },
];

export function SideNav() {
  const { s, dispatch } = useStore();
  const unverified = s.incidents.some((i) => i.status === 'new');
  return (
    <nav className="sidenav" aria-label="Main">
      {NAV.map(({ id, label, Icon }) => (
        <button key={id} className={s.view === id ? 'on' : ''} onClick={() => dispatch({ type: 'setView', view: id })} aria-current={s.view === id}>
          <span className="ico">
            <Icon size={22} />
            {id === 'incidents' && unverified && <span className="pip" aria-label="Unverified alerts" />}
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
}

const OPEN = (i: Incident) => !['closed', 'duplicate', 'dismissed'].includes(i.status);

export function IncidentQueue() {
  const { s, dispatch } = useStore();
  const [showAll, setShowAll] = useState(false);
  const list = s.incidents
    .filter((i) => (showAll ? true : OPEN(i)))
    .filter((i) => !s.replay.active || i.createdAt <= s.replay.at)
    .sort((a, b) => b.createdAt - a.createdAt);
  return (
    <aside className="panel queue">
      <div className="panel-head">
        <h2>Incident queue</h2>
        <div className="row gap-s">
          <button className={`icon-btn${showAll ? ' on' : ''}`} title={showAll ? 'Showing all' : 'Showing open only'} onClick={() => setShowAll((v) => !v)}><Filter size={18} /></button>
          <button className="icon-btn" title="Sort: newest first"><SlidersHorizontal size={18} /></button>
        </div>
      </div>
      <div className="queue-list">
        {list.length === 0 && <p className="empty">No open incidents. The site is quiet.</p>}
        {list.map((i) => (
          <button key={i.id} className={`inc-card${s.selectedIncidentId === i.id ? ' sel' : ''} st-${i.status}`} onClick={() => dispatch({ type: 'selectIncident', id: i.id })}>
            <div className="thumb">
              <CameraFeed scene={i.thumb} label={i.id} time={s.now} compact />
            </div>
            <div className="ic-body">
              <div className="row between"><b>{i.id}</b><small className="muted">{fmtAge(s.now - i.createdAt)} ago</small></div>
              <div className="ic-title">{i.title}</div>
              <IncidentBadge status={i.status} />
              <small className="muted">{i.zone} · {i.owner ?? 'Unassigned'}</small>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function Kpis() {
  const { s } = useStore();
  const open = s.incidents.filter((i) => OPEN(i) && i.status !== 'resolved').length;
  const ready = Object.values(s.devices).filter((d) => isReady(s, d)).length;
  const live = Object.values(s.devices).filter((d) => freshness(s, d) === 'live').length;
  const active = s.missions.filter((m) => ['approved', 'assigned', 'executing', 'paused'].includes(m.status)).length;
  return (
    <div className="kpis">
      <div className="kpi"><Bell size={20} className="amber" /><div><small>Open incidents</small><b>{open}</b></div></div>
      <div className="kpi" title="Devices ready for a new mission"><Server size={20} /><div><small>Ready devices</small><b>{ready}<span className="muted"> / {live} reporting</span></b></div></div>
      <div className="kpi"><Send size={20} /><div><small>Active missions</small><b>{active}</b></div></div>
    </div>
  );
}

// --- bottom timeline --------------------------------------------------------

interface Phase {
  label: string;
  time?: number;
  detail: string;
  state: 'done' | 'current' | 'todo';
}

function phases(s: AppState, inc: Incident): Phase[] {
  const ev = s.timeline.filter((e) => e.incidentId === inc.id);
  const find = (re: RegExp) => ev.find((e) => re.test(e.title));
  const m = missionForIncident(s, inc.id);
  const opened = find(/Camera opened/);
  const verified = find(/Verified|Confirmed/);
  const approved = [...ev].reverse().find((e) => /Mission approved/.test(e.title));
  const requested = [...ev].reverse().find((e) => /Approval requested|re-approval/.test(e.title));
  const started = find(/started/);
  const resolved = find(/^Resolved|Dismissed|Merged into/);
  const steps: Omit<Phase, 'state'>[] = [
    { label: 'Alert received', time: inc.createdAt, detail: inc.source },
    { label: 'Camera opened', time: opened?.at, detail: opened ? `${inc.cameraId ?? 'Camera'} stream available for review.` : 'Open the camera to review.' },
    { label: 'Operator reviewing', time: verified?.at, detail: verified ? 'Verified — action required.' : 'Monitoring feed and verifying the situation.' },
    {
      label: 'Mission approval',
      time: m?.approvedVersion === m?.planVersion ? approved?.at : undefined,
      detail: !m ? 'Approval required before dispatch.' : m.status === 'pending_approval' ? `Requested ${requested ? fmtTime(requested.at) : ''} · waiting for supervisor.` : approved ? `Approved plan v${m.approvedVersion}.` : 'Draft in progress.',
    },
    { label: 'Response', time: started?.at, detail: started ? (m?.status === 'completed' ? 'Mission completed.' : `Mission ${m?.status.replace('_', ' ')}.`) : 'Starts after operator accepts.' },
    { label: 'Outcome', time: resolved?.at, detail: resolved ? (inc.status === 'closed' ? 'Closed.' : resolved.title) : 'Record result and close.' },
  ];
  let current = steps.findIndex((p) => !p.time);
  if (current === -1) current = steps.length;
  return steps.map((p, i) => ({ ...p, state: i < current ? 'done' : i === current ? 'current' : 'todo' }));
}

export function BottomTimeline() {
  const { s, dispatch } = useStore();
  const [tab, setTab] = useState<'progress' | 'log'>('progress');
  const [collapsed, setCollapsed] = useState(false);
  const inc = s.incidents.find((i) => i.id === s.selectedIncidentId);
  const pending = s.commands.filter((c) => !isTerminal(c));
  const log = s.timeline
    .filter((e) => !inc || e.incidentId === inc.id)
    .filter((e) => !s.replay.active || e.at <= s.replay.at)
    .slice()
    .reverse();
  return (
    <section className={`timeline${collapsed ? ' collapsed' : ''}`}>
      <div className="tl-head">
        <h2>Event timeline {inc && <small className="muted">· {inc.id}</small>}</h2>
        <div className="tabs small">
          <button className={tab === 'progress' ? 'on' : ''} onClick={() => setTab('progress')}>Progress</button>
          <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Log ({log.length})</button>
        </div>
        {pending.length > 0 && (
          <span className="pending-chip"><Zap size={14} /> {pending.length} command{pending.length > 1 ? 's' : ''} pending</span>
        )}
        {!s.replay.active && inc && (
          <button className="btn-ghost small" onClick={() => { dispatch({ type: 'enterReplay', at: inc.createdAt }); dispatch({ type: 'setView', view: 'evidence' }); }}>
            <History size={14} /> Replay
          </button>
        )}
        <button className="icon-btn" aria-label={collapsed ? 'Expand timeline' : 'Collapse timeline'} onClick={() => setCollapsed((c) => !c)}>
          <ChevronDown size={18} style={{ transform: collapsed ? 'rotate(180deg)' : undefined }} />
        </button>
      </div>
      {!collapsed && tab === 'progress' && inc && (
        <ol className="phases">
          {phases(s, inc).map((p, i) => (
            <li key={i} className={p.state}>
              <div className="ph-top">
                <span className="ph-dot">{p.state === 'done' ? <Check size={14} /> : null}</span>
                <span className="ph-time">{p.time ? fmtTime(p.time) : 'Pending'}</span>
              </div>
              <b>{p.label}</b>
              <small>{p.detail}</small>
            </li>
          ))}
        </ol>
      )}
      {!collapsed && tab === 'log' && (
        <ul className="log">
          {log.map((e) => (
            <li key={e.id} className={`tone-${e.tone ?? 'info'}`}>
              <span className="mono">{fmtTime(e.at, true)}</span>
              <b>{e.title}</b>
              <span className="muted">{e.actor}{e.detail ? ` — ${e.detail}` : ''}</span>
              {e.receivedAt - e.at > 500 && <span className="muted mono" title="Source time vs received time"> · rcv +{((e.receivedAt - e.at) / 1000).toFixed(1)}s</span>}
            </li>
          ))}
        </ul>
      )}
      {!collapsed && tab === 'progress' && !inc && <p className="empty">Select an incident to see its progress.</p>}
    </section>
  );
}

export function Toasts() {
  const { s, dispatch } = useStore();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {s.toasts.map((t) => (
        <div key={t.id} className={`toast t-${t.tone}`}>
          {t.tone === 'error' || t.tone === 'warn' ? <CircleAlert size={16} /> : t.tone === 'ok' ? <Check size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dispatch({ type: 'dismissToast', id: t.id })}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export function Footer() {
  const { s, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const me = currentUser(s);
  const cut = !!s.linkCut['UGV-01'];
  const allowed = can(me.role, 'demo.control');
  return (
    <footer className="footer">
      <span><span className="dot ok" /> Demo environment · No live commands. All data and visuals are simulated.</span>
      <div className="foot-right">
        <div className="demo">
          <button className="btn-ghost small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <SlidersHorizontal size={14} /> Demo controls
          </button>
          {open && (
            <div className="pop demo-pop">
              <p className="pop-h">Presenter controls</p>
              <button disabled={!allowed} onClick={() => dispatch({ type: 'demoInjectAlert' })}><Bell size={14} /> Inject duplicate gate alert</button>
              {cut ? (
                <button disabled={!allowed} onClick={() => dispatch({ type: 'demoRestoreLink', deviceId: 'UGV-01' })}><Plug size={14} /> Restore UGV-01 network</button>
              ) : (
                <button disabled={!allowed} onClick={() => dispatch({ type: 'demoCutLink', deviceId: 'UGV-01' })}><Unplug size={14} /> Cut UGV-01 network</button>
              )}
              <button onClick={() => { dispatch({ type: 'demoReset' }); setOpen(false); }}><RotateCcw size={14} /> Reset demo dataset</button>
              {!allowed && <small className="muted">Auditor role cannot use demo controls.</small>}
            </div>
          )}
        </div>
        <span className="muted">Terms</span>
        <span className="muted">Privacy</span>
        <span className="muted">v0.1.0 prototype</span>
      </div>
    </footer>
  );
}
