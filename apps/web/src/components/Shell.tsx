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
  LogOut,
  Settings,
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
import { can, currentUser, fmtDate, fmtTime, freshness, isReady } from '../domain/policy';
import { isTerminal, missionForIncident } from '../domain/reducer';
import { SITE } from '@13store/shared';
import type { AppState, Incident, View } from '@13store/shared';
import { useStore } from '../store';
import { LangToggle, ago, roleLabel, useLang, useT, type T } from '../i18n';
import { IncidentBadge } from './Badges';
import { CameraFeed } from './CameraFeed';
import { ThemeToggle } from './Hud';

export function TopBar() {
  const { s, dispatch, session, mode } = useStore();
  const t = useT();
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
        <button className="site-select" title={t('Only sites you are authorised for are listed')}>
          <MapPin size={16} /> {SITE.name} <ChevronDown size={16} />
        </button>
        {s.replay.active ? (
          <span className="mode mode-replay"><History size={16} /> REPLAY · {fmtTime(s.replay.at, true)}</span>
        ) : (
          <span className={`mode ${s.dataLabel === 'LIVE' ? 'mode-live' : 'mode-sim'}`} title={mode === 'standalone' ? t('Browser-only simulation. Not connected to a platform server.') : t('{env} environment', { env: session?.meta.env })}>
            <TriangleAlert size={16} /> {s.dataLabel === 'OFFLINE DEMO' ? 'SIMULATION · OFFLINE' : s.dataLabel}
          </span>
        )}
      </div>
      <div className="top-right">
        <span className={`health ${allLive ? 'ok' : 'warn'}`} title={t('Simulated services health')}>
          <span className="dot" /> {allLive ? t('Systems OK') : t('Telemetry degraded')}
        </span>
        <span className="clock"><Calendar size={16} /> {fmtDate(s.now)} &nbsp; {fmtTime(s.now)}</span>
        <ThemeToggle />
        <LangToggle />
        <div className="user">
          <button className="user-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span className="avatar">{me.name.split(' ').map((p) => p[0]).join('')}</span>
            <span className="user-txt"><b>{me.name}</b><small>{me.title}</small></span>
            <ChevronDown size={16} />
          </button>
          {open && (
            <div className="pop user-pop">
              {mode === 'standalone' ? (
                <>
                  <p className="pop-h">{t('Switch role (offline demo)')}</p>
                  {s.users.map((u) => (
                    <button key={u.id} className={u.id === me.id ? 'on' : ''} onClick={() => { dispatch({ type: 'setUser', userId: u.id }); setOpen(false); }}>
                      {u.id === me.id ? <Check size={14} /> : <span className="sp" />} {u.name} <small>{roleLabel(u.role)}</small>
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <p className="pop-h">{session?.user.orgName} · {roleLabel(me.role)}</p>
                  {session?.switchUser && (
                    <>
                      <p className="pop-h">{t('Sign in as (demo)')}</p>
                      {session.demoUsers.map((u) => (
                        <button key={u.username} className={u.name === me.name ? 'on' : ''} onClick={() => { setOpen(false); void session.switchUser!(u.username); }}>
                          {u.name === me.name ? <Check size={14} /> : <span className="sp" />} {u.name} <small>{roleLabel(u.role)}</small>
                        </button>
                      ))}
                    </>
                  )}
                  <a className="pop-link" href="/field/">{t('Field app (mobile)')}</a>
                  <a className="pop-link" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">{t('API reference (OpenAPI)')}</a>
                </>
              )}
              <hr />
              <button onClick={() => dispatch({ type: 'togglePresentation' })}>
                <Monitor size={14} /> {s.presentation ? t('Presentation mode on') : t('Presentation mode off')}
              </button>
              {session && (
                <button onClick={() => session.logout()}>
                  <LogOut size={14} /> {t('Sign out')}
                </button>
              )}
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
  { id: 'admin', label: 'Admin', Icon: Settings },
];

function navFor(role: string): View[] {
  if (role === 'admin') return ['admin', 'devices'];
  return ['overview', 'incidents', 'missions', 'devices', 'evidence', 'reports'];
}

export function SideNav() {
  const { s, dispatch } = useStore();
  const t = useT();
  const unverified = s.incidents.some((i) => i.status === 'new');
  const allowed = navFor(currentUser(s).role);
  return (
    <nav className="sidenav" aria-label={t('Main')}>
      {NAV.filter((n) => allowed.includes(n.id)).map(({ id, label, Icon }) => (
        <button key={id} className={s.view === id ? 'on' : ''} onClick={() => dispatch({ type: 'setView', view: id })} aria-current={s.view === id}>
          <span className="ico">
            <Icon size={22} />
            {id === 'incidents' && unverified && <span className="pip" aria-label={t('Unverified alerts')} />}
          </span>
          {t(label)}
        </button>
      ))}
    </nav>
  );
}

const OPEN = (i: Incident) => !['closed', 'duplicate', 'dismissed'].includes(i.status);

export function IncidentQueue() {
  const { s, dispatch } = useStore();
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const list = s.incidents
    .filter((i) => (showAll ? true : OPEN(i)))
    .filter((i) => !s.replay.active || i.createdAt <= s.replay.at)
    .sort((a, b) => b.createdAt - a.createdAt);
  return (
    <aside className="panel queue">
      <div className="panel-head">
        <h2>{t('Incident queue')}</h2>
        <div className="row gap-s">
          <button className={`icon-btn${showAll ? ' on' : ''}`} title={showAll ? t('Showing all') : t('Showing open only')} onClick={() => setShowAll((v) => !v)}><Filter size={18} /></button>
          <button className="icon-btn" title={t('Sort: newest first')}><SlidersHorizontal size={18} /></button>
        </div>
      </div>
      <div className="queue-list">
        {list.length === 0 && <p className="empty">{t('No open incidents. The site is quiet.')}</p>}
        {list.map((i) => (
          <button key={i.id} className={`inc-card${s.selectedIncidentId === i.id ? ' sel' : ''} st-${i.status}`} onClick={() => dispatch({ type: 'selectIncident', id: i.id })}>
            <div className="thumb">
              <CameraFeed scene={i.thumb} label={i.id} time={s.now} compact />
            </div>
            <div className="ic-body">
              <div className="row between"><b>{i.id}</b><small className="muted">{ago(s.now - i.createdAt)}</small></div>
              <div className="ic-title">{i.title}</div>
              <IncidentBadge status={i.status} />
              <small className="muted">{i.zone} · {i.owner ?? t('Unassigned')}</small>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function Kpis() {
  const { s } = useStore();
  const t = useT();
  const open = s.incidents.filter((i) => OPEN(i) && i.status !== 'resolved').length;
  const ready = Object.values(s.devices).filter((d) => isReady(s, d)).length;
  const live = Object.values(s.devices).filter((d) => freshness(s, d) === 'live').length;
  const active = s.missions.filter((m) => ['approved', 'assigned', 'executing', 'paused'].includes(m.status)).length;
  return (
    <div className="kpis">
      <div className="kpi"><Bell size={20} className="amber" /><div><small>{t('Open incidents')}</small><b>{open}</b></div></div>
      <div className="kpi" title={t('Devices ready for a new mission')}><Server size={20} /><div><small>{t('Ready devices')}</small><b>{ready}<span className="muted"> / {t('{n} reporting', { n: live })}</span></b></div></div>
      <div className="kpi"><Send size={20} /><div><small>{t('Active missions')}</small><b>{active}</b></div></div>
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

function phases(s: AppState, inc: Incident, t: T): Phase[] {
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
    { label: t('Alert received'), time: inc.createdAt, detail: inc.source },
    { label: t('Camera opened'), time: opened?.at, detail: opened ? t('{cam} stream available for review.', { cam: inc.cameraId ?? t('Camera') }) : t('Open the camera to review.') },
    { label: t('Operator reviewing'), time: verified?.at, detail: verified ? t('Verified — action required.') : t('Monitoring feed and verifying the situation.') },
    {
      label: t('Mission approval'),
      time: m?.approvedVersion === m?.planVersion ? approved?.at : undefined,
      detail: !m
        ? t('Approval required before dispatch.')
        : m.status === 'pending_approval'
          ? t('Requested {time} · waiting for supervisor.', { time: requested ? fmtTime(requested.at) : '' })
          : approved
            ? t('Approved plan v{v}.', { v: m.approvedVersion })
            : t('Draft in progress.'),
    },
    { label: t('Response'), time: started?.at, detail: started ? (m?.status === 'completed' ? t('Mission completed.') : t('Mission status: {status}.', { status: missionStatusText(m?.status, t) })) : t('Starts after operator accepts.') },
    { label: t('Outcome'), time: resolved?.at, detail: resolved ? (inc.status === 'closed' ? t('Closed.') : resolved.title) : t('Record result and close.') },
  ];
  let current = steps.findIndex((p) => !p.time);
  if (current === -1) current = steps.length;
  return steps.map((p, i) => ({ ...p, state: i < current ? 'done' : i === current ? 'current' : 'todo' }));
}

export function BottomTimeline() {
  const { s, dispatch } = useStore();
  const t = useT();
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
        <h2>{t('Event timeline')} {inc && <small className="muted">· {inc.id}</small>}</h2>
        <div className="tabs small">
          <button className={tab === 'progress' ? 'on' : ''} onClick={() => setTab('progress')}>{t('Progress')}</button>
          <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>{t('Log ({n})', { n: log.length })}</button>
        </div>
        {pending.length > 0 && (
          <span className="pending-chip"><Zap size={14} /> {t(pending.length > 1 ? '{n} commands pending' : '{n} command pending', { n: pending.length })}</span>
        )}
        {!s.replay.active && inc && (
          <button className="btn-ghost small" onClick={() => { dispatch({ type: 'enterReplay', at: inc.createdAt }); dispatch({ type: 'setView', view: 'evidence' }); }}>
            <History size={14} /> {t('Replay')}
          </button>
        )}
        <button className="icon-btn" aria-label={collapsed ? t('Expand timeline') : t('Collapse timeline')} onClick={() => setCollapsed((c) => !c)}>
          <ChevronDown size={18} style={{ transform: collapsed ? 'rotate(180deg)' : undefined }} />
        </button>
      </div>
      {!collapsed && tab === 'progress' && inc && (
        <ol className="phases">
          {phases(s, inc, t).map((p, i) => (
            <li key={i} className={p.state}>
              <div className="ph-top">
                <span className="ph-dot">{p.state === 'done' ? <Check size={14} /> : null}</span>
                <span className="ph-time">{p.time ? fmtTime(p.time) : t('Pending')}</span>
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
              {e.receivedAt - e.at > 500 && <span className="muted mono" title={t('Source time vs received time')}> · rcv +{((e.receivedAt - e.at) / 1000).toFixed(1)}s</span>}
            </li>
          ))}
        </ul>
      )}
      {!collapsed && tab === 'progress' && !inc && <p className="empty">{t('Select an incident to see its progress.')}</p>}
    </section>
  );
}

export function Toasts() {
  const { s, dispatch } = useStore();
  const { t } = useLang();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {s.toasts.map((x) => (
        <div key={x.id} className={`toast t-${x.tone}`}>
          {x.tone === 'error' || x.tone === 'warn' ? <CircleAlert size={16} /> : x.tone === 'ok' ? <Check size={16} /> : <Info size={16} />}
          <span>{t(x.text)}</span>
          <button className="icon-btn" aria-label={t('Dismiss')} onClick={() => dispatch({ type: 'dismissToast', id: x.id })}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export function Footer() {
  const { s, dispatch, session, mode } = useStore();
  const t = useT();
  const demoEnv = mode === 'standalone' || session?.meta.env === 'demo';
  const [open, setOpen] = useState(false);
  const me = currentUser(s);
  const cut = !!s.linkCut['UGV-01'];
  const allowed = can(me.role, 'demo.control');
  return (
    <footer className="footer">
      <span>
        <span className={`dot ${s.dataLabel === 'LIVE' ? 'ok' : ''}`} />{' '}
        {mode === 'standalone'
          ? t('Offline demo · Runs in this browser only. All data and visuals are simulated.')
          : s.dataLabel === 'LIVE'
            ? t('{org} · Pilot environment · Connected', { org: session?.user.orgName })
            : s.dataLabel === 'MIXED DEMO'
              ? t('Pilot environment with simulated devices. Each simulated item is labelled.')
              : t('Demo environment · Simulated devices through the edge gateway. No real vehicles are commanded.')}
      </span>
      <div className="foot-right">
        {demoEnv && <div className="demo">
          <button className="btn-ghost small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <SlidersHorizontal size={14} /> {t('Demo controls')}
          </button>
          {open && (
            <div className="pop demo-pop">
              <p className="pop-h">{t('Presenter controls')}</p>
              <button disabled={!allowed} onClick={() => dispatch({ type: 'demoInjectAlert' })}><Bell size={14} /> {t('Inject duplicate gate alert')}</button>
              {cut ? (
                <button disabled={!allowed} onClick={() => dispatch({ type: 'demoRestoreLink', deviceId: 'UGV-01' })}><Plug size={14} /> {t('Restore UGV-01 network')}</button>
              ) : (
                <button disabled={!allowed} onClick={() => dispatch({ type: 'demoCutLink', deviceId: 'UGV-01' })}><Unplug size={14} /> {t('Cut UGV-01 network')}</button>
              )}
              <button onClick={() => { dispatch({ type: 'demoReset' }); setOpen(false); }}><RotateCcw size={14} /> {t('Reset demo dataset')}</button>
              {!allowed && <small className="muted">{t('This role cannot use demo controls.')}</small>}
            </div>
          )}
        </div>}
        <span className="muted">{t('Terms')}</span>
        <span className="muted">{t('Privacy')}</span>
        <span className="muted">v{session?.meta.version ?? '0.2.0'}{mode === 'standalone' ? ` ${t('offline')}` : ''}</span>
      </div>
    </footer>
  );
}

function missionStatusText(status: string | undefined, t: T) {
  const map: Record<string, string> = {
    draft: 'Draft',
    pending_approval: 'Pending approval',
    approved: 'Approved',
    assigned: 'Assigned',
    executing: 'Executing',
    paused: 'Paused',
    completed: 'Completed',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    failed: 'Failed',
  };
  return t(map[status ?? ''] ?? status ?? '');
}
