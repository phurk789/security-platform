// "Twin HUD" theme: full-screen 3D city with glass panels floating around it, focused on the
// UGV and drone fleet (live onboard video, battery, speed/altitude, link, mission progress).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Drone, LayoutDashboard, LayoutPanelLeft, Moon, Satellite, Sun, Truck } from 'lucide-react';
import type { Device } from '@13store/shared';
import { ageMs, can, currentUser, freshness, userName } from '../domain/policy';
import { ago, useT } from '../i18n';
import { useStore } from '../store';
import { FreshBadge } from './Badges';
import { CameraFeed } from './CameraFeed';
import './hud.css';

// ---------------------------------------------------------------------------
// Theme preference (per browser)
// ---------------------------------------------------------------------------

export type Theme = 'hud' | 'classic';
const KEY = 'ps-theme';
const listeners = new Set<() => void>();

function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'hud';
  } catch {
    return 'hud';
  }
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode: keep it for this page only */
  }
  current = t;
  listeners.forEach((l) => l());
}

let current: Theme = readTheme();

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => current,
    () => current,
  );
}

/** The HUD layout needs room for panels around the map; narrower screens keep the classic layout. */
export function useWide(min = 1200) {
  const q = `(min-width: ${min}px)`;
  const [wide, setWide] = useState(() => typeof matchMedia === 'undefined' || matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return wide;
}

// ---------------------------------------------------------------------------
// Appearance: dark (control room, default) or light (white theme, daytime twin)
// ---------------------------------------------------------------------------

export type Appearance = 'dark' | 'light';
const AKEY = 'ps-appearance';
const aListeners = new Set<() => void>();
function readAppearance(): Appearance {
  try {
    return localStorage.getItem(AKEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
let appearance: Appearance = readAppearance();
applyAppearance(appearance);

function applyAppearance(a: Appearance) {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = a;
}

export function setAppearance(a: Appearance) {
  try {
    localStorage.setItem(AKEY, a);
  } catch {
    /* keep for this page only */
  }
  appearance = a;
  applyAppearance(a);
  aListeners.forEach((l) => l());
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (cb) => (aListeners.add(cb), () => aListeners.delete(cb)),
    () => appearance,
    () => appearance,
  );
}

export function AppearanceToggle() {
  const t = useT();
  const a = useAppearance();
  return (
    <button className="appearance-toggle" onClick={() => setAppearance(a === 'dark' ? 'light' : 'dark')} title={a === 'dark' ? t('Switch to the light theme') : t('Switch to the dark theme')} aria-label={a === 'dark' ? t('Switch to the light theme') : t('Switch to the dark theme')}>
      {a === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

export function ThemeToggle() {
  const t = useT();
  const theme = useTheme();
  const next = theme === 'hud' ? 'classic' : 'hud';
  return (
    <button className="theme-toggle" onClick={() => setTheme(next)} title={theme === 'hud' ? t('Switch to the classic layout') : t('Switch to the Twin HUD layout')} aria-label={t('Layout')}>
      {theme === 'hud' ? <LayoutDashboard size={16} /> : <LayoutPanelLeft size={16} />}
      <span>{theme === 'hud' ? 'HUD' : t('Classic')}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Fleet panel: one card per UGV / UAV
// ---------------------------------------------------------------------------

export function FleetPanel() {
  const { s } = useStore();
  const t = useT();
  const [video, setVideo] = useState(true);
  const fleet = Object.values(s.devices)
    .filter((d) => d.kind === 'ugv' || d.kind === 'uav')
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'ugv' ? -1 : 1));
  const live = fleet.filter((d) => freshness(s, d) === 'live').length;
  return (
    <section className="panel hud-fleet">
      <div className="panel-head">
        <h2>{t('Fleet')} <small className="hud-count">{live}/{fleet.length} LIVE</small></h2>
        <button className={`hud-chip${video ? ' on' : ''}`} onClick={() => setVideo((v) => !v)} aria-pressed={video}>
          {t('Video')}
        </button>
      </div>
      <div className="hud-fleet-list">
        {fleet.map((d) => (
          <FleetCard key={d.id} d={d} video={video} />
        ))}
        {!fleet.length && <p className="empty">{t('No vehicles registered.')}</p>}
      </div>
    </section>
  );
}

export function FleetCard({ d, video }: { d: Device; video: boolean }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const me = currentUser(s);
  const f = freshness(s, d);
  const sel = s.selectedDeviceId === d.id;
  const m = s.missions.find((x) => x.deviceId === d.id && ['approved', 'assigned', 'executing', 'paused'].includes(x.status));
  const Icon = d.kind === 'uav' ? Drone : Truck;
  const known = f !== 'offline';
  const battery = d.battery ?? 0;
  const progress = m ? Math.min(1, m.nextCp / Math.max(1, m.checkpoints.length)) : 0;
  const state = !known ? t('No data') : m ? statusText(m.status, t) : d.commands.length ? t('Standby') : t('Display only');
  return (
    <article className={`fleet-card f-${f}${sel ? ' sel' : ''}`} onClick={() => dispatch({ type: 'selectDevice', id: d.id })}>
      <header>
        <span className={`fc-ico k-${d.kind}`}><Icon size={16} /></span>
        <b>{d.id}</b>
        <span className="fc-kind">{d.catalogId ?? (d.kind === 'uav' ? 'UAV' : 'UGV')}{d.payloads?.length ? ' · 4in1' : ''}{d.integration === 'simulated' ? ' · SIM' : ''}</span>
        <span className="fc-fresh"><FreshBadge f={f} age={f === 'live' ? undefined : ago(ageMs(s, d))} /></span>
      </header>
      {video && d.capabilities.includes('camera') && (
        <div className="fc-feed" onClick={(e) => e.stopPropagation()}>
          {can(me.role, 'media.view') ? (
            <CameraFeed scene="ugv" label={t('{id} onboard', { id: d.id })} deviceId={d.id} time={f === 'live' ? s.now : d.lastSeen} freshness={f} replay={s.replay.active} />
          ) : (
            <div className="fc-novideo">{t('Your role cannot view video.')}</div>
          )}
        </div>
      )}
      <div className="fc-stats">
        <Ring value={known ? battery : null} label="BAT" />
        <Stat label={t('Speed')} value={known ? d.speed.toFixed(1) : '—'} unit="m/s" />
        {d.kind === 'uav' ? <Stat label={t('Altitude')} value={known && d.alt !== undefined ? d.alt.toFixed(0) : '—'} unit="m" /> : <Stat label="GNSS" value={known && d.satellites !== undefined ? String(d.satellites) : '—'} unit={<Satellite size={11} />} />}
        <div className="fc-stat">
          <small>{t('Link')}</small>
          <Bars v={known ? d.signal : undefined} />
        </div>
      </div>
      <footer>
        <div className="fc-state">
          <span>{state}</span>
          {m && <span className="muted">{m.id} · CP {Math.min(m.nextCp + 1, m.checkpoints.length)}/{m.checkpoints.length}</span>}
        </div>
        {m && (
          <div className="fc-bar">
            <i style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        {d.controlOwner && <div className="fc-ctl">{t('Controlled by')} {userName(s, d.controlOwner)}</div>}
      </footer>
    </article>
  );
}

function statusText(st: string, t: ReturnType<typeof useT>) {
  const map: Record<string, string> = { approved: t('Approved'), assigned: t('Ready to start'), executing: t('Executing'), paused: t('Paused') };
  return map[st] ?? st;
}

function Ring({ value, label }: { value: number | null; label: string }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const v = value === null ? 0 : Math.max(0, Math.min(100, value));
  const tone = value === null ? 'off' : v < 20 ? 'red' : v < 40 ? 'amber' : 'ok';
  return (
    <div className={`fc-ring ${tone}`} role="img" aria-label={`${label} ${value === null ? '—' : Math.round(v) + '%'}`}>
      <svg viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} className="track" />
        <circle cx="22" cy="22" r={r} className="val" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 22 22)" />
      </svg>
      <span>
        <b>{value === null ? '—' : Math.round(v)}</b>
        <small>{label}</small>
      </span>
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: React.ReactNode }) {
  return (
    <div className="fc-stat">
      <small>{label}</small>
      <b>
        {value} <em>{unit}</em>
      </b>
    </div>
  );
}

function Bars({ v }: { v?: number }) {
  const n = v === undefined ? 0 : v >= 80 ? 4 : v >= 60 ? 3 : v >= 35 ? 2 : v > 0 ? 1 : 0;
  return (
    <span className={`fc-bars n${n}`} title={v === undefined ? '—' : `${Math.round(v)}%`}>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={i <= n ? 'on' : ''} style={{ height: `${4 + i * 3}px` }} />
      ))}
      <small>{v === undefined ? '—' : `${Math.round(v)}%`}</small>
    </span>
  );
}
