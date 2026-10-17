// Wall display for a booth TV: hides the operator chrome (side nav, footer, presenter panel), keeps
// the twin, the panels and the visitor captions, and runs an event ticker along the bottom.
// `?kiosk` in the URL turns it on together with auto-play.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { fmtTime } from '../domain/policy';
import { useT } from '../i18n';
import { useStore } from '../store';

const KEY = 'ps-wall';
const listeners = new Set<() => void>();
let wall = (() => {
  try {
    if (typeof location !== 'undefined' && /[?&#]kiosk/.test(location.search + location.hash)) return true;
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
})();

export function isKiosk() {
  return typeof location !== 'undefined' && /[?&#]kiosk/.test(location.search + location.hash);
}

export function setWall(on: boolean) {
  wall = on;
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* keep for this page */
  }
  listeners.forEach((l) => l());
}

export function useWall() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => wall,
    () => wall,
  );
}

/** Latest timeline events, newest first, as a slow marquee. */
export function EventTicker() {
  const { s } = useStore();
  const t = useT();
  const items = [...s.timeline].sort((a, b) => b.at - a.at).slice(0, 8);
  const [paused, setPaused] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  // restart the animation when the newest event changes so it is seen first
  const key = items[0]?.id ?? '';
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }, [key]);
  if (!items.length) return null;
  return (
    <div className="ticker" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-live="off">
      <span className="ticker-head">{t('Live events')}</span>
      <div className="ticker-clip">
        <div ref={track} className={`ticker-track${paused ? ' paused' : ''}`}>
          {[...items, ...items].map((e, i) => (
            <span key={`${e.id}-${i}`} className={`tk tone-${e.tone ?? 'info'}`}>
              <b>{fmtTime(e.at, true)}</b> {e.incidentId} · {e.title}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
