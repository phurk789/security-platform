// Pan/tilt/zoom, photo and record for gimbal cameras (SIYI ZT30, ZR30, A8 mini …).
// Press and hold an arrow to turn, release to stop — like the SIYI app. Every action is checked
// and logged by the platform; the status line says "confirmed" only when the camera answered.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Camera, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, Crosshair, Flashlight, LocateFixed, Megaphone, Minus, Plus, Siren } from 'lucide-react';
import { ANNOUNCEMENTS, aimAt, describeCameraAction, mountOf, type CameraAction, type Device } from '@13store/shared';
import { can, currentUser, freshness, userName } from '../domain/policy';
import { useT } from '../i18n';
import { useStore, type CameraResult } from '../store';
import './camera-controls.css';

type Dir = 'up' | 'down' | 'left' | 'right';
const VEC: Record<Dir, [number, number]> = {
  up: [0, 1],
  down: [0, -1],
  left: [-1, 0],
  right: [1, 0],
};
const KEYS: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** Slower turns when zoomed in, so the target stays in frame (as the SIYI app does). */
const panSpeed = (zoom = 1) => Math.round(Math.min(60, Math.max(10, 60 / Math.sqrt(zoom))));

export function CameraControls({ device: d, aimAt: target }: { device: Device; /** Incident this camera can be pointed at. */ aimAt?: { incidentId: string } }) {
  const { s, dispatch, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const [status, setStatus] = useState<{ r: CameraResult; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const holding = useRef<null | 'pan' | 'zoom'>(null);
  const sendRef = useRef<(a: CameraAction) => Promise<CameraResult>>(async () => ({ ok: false, confirmed: false, detail: '' }));

  const f = freshness(s, d);
  const g = d.gimbal;
  const reason = !can(me.role, 'camera.control')
    ? t('Your role cannot move cameras.')
    : s.replay.active
      ? t('Replay: camera control is off.')
      : f === 'offline'
        ? t('Camera offline. Control unavailable.')
        : d.kind !== 'cctv' && d.controlOwner && d.controlOwner !== me.id
          ? t('Only {name} can move this camera.', {
              name: userName(s, d.controlOwner),
            })
          : null;
  const off = !!reason;

  const send = async (a: CameraAction): Promise<CameraResult> => {
    if (session) return session.cameraControl(d.id, a);
    // Offline demo: the reducer re-checks and applies it to the simulated gimbal.
    dispatch({ type: 'cameraControl', deviceId: d.id, action: a });
    if (s.linkCut[d.id])
      return {
        ok: false,
        confirmed: false,
        detail: t('Camera is not responding. Command not sent.'),
      };
    const detail =
      a.action === 'photo'
        ? t('Photo taken.')
        : a.action === 'record'
          ? g?.recording
            ? t('Recording stopped.')
            : t('Recording started.')
          : a.action === 'spotlight'
            ? a.on
              ? t('Searchlight on.')
              : t('Searchlight off.')
            : a.action === 'beacon'
              ? a.on
                ? t('Warning light on.')
                : t('Warning light off.')
              : a.action === 'announce'
                ? t('Announcement playing.')
                : describeCameraAction(a);
    return { ok: true, confirmed: true, detail };
  };
  sendRef.current = send;

  const run = async (a: CameraAction, quiet = false) => {
    if (off) return;
    if (!quiet) setBusy(true);
    const r = await send(a);
    setBusy(false);
    // Speed/zoom "stop" messages only surface when they fail.
    if (!quiet || !r.ok) setStatus({ r, at: Date.now() });
  };

  const startPan = (dir: Dir) => {
    if (off || holding.current) return;
    holding.current = 'pan';
    const v = panSpeed(g?.zoom);
    void run({
      action: 'gimbal_speed',
      yaw: VEC[dir][0] * v,
      pitch: VEC[dir][1] * v,
    });
  };
  const startZoom = (dir: 1 | -1) => {
    if (off || holding.current) return;
    holding.current = 'zoom';
    void run({ action: 'zoom', dir });
  };
  const release = () => {
    const h = holding.current;
    holding.current = null;
    if (h === 'pan') void run({ action: 'gimbal_speed', yaw: 0, pitch: 0 }, true);
    if (h === 'zoom') void run({ action: 'zoom', dir: 0 }, true);
  };

  // Never leave the gimbal turning: stop on unmount, tab switch or window blur.
  useEffect(() => {
    const stop = () => {
      const h = holding.current;
      holding.current = null;
      if (h === 'pan') void sendRef.current({ action: 'gimbal_speed', yaw: 0, pitch: 0 });
      if (h === 'zoom') void sendRef.current({ action: 'zoom', dir: 0 });
    };
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', stop);
    return () => {
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', stop);
      stop();
    };
  }, [d.id]);

  const hold = (start: () => void) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      start();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.repeat) return;
    if (KEYS[e.key]) {
      e.preventDefault();
      startPan(KEYS[e.key]);
    } else if (e.key === '+' || e.key === '=') startZoom(1);
    else if (e.key === '-') startZoom(-1);
    else if (e.key === 'c' || e.key === 'C') void run({ action: 'center' });
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (KEYS[e.key] || ['+', '=', '-'].includes(e.key)) release();
  };

  const inc = target ? s.incidents.find((i) => i.id === target.incidentId) : undefined;
  const mount = mountOf(d);
  const aim = inc && mount ? aimAt(d.pos, mount, inc.pos) : null;
  const pointAt = async () => {
    if (off || !inc) return;
    setBusy(true);
    let r: CameraResult;
    if (session) r = await session.aimCamera(d.id, { incidentId: inc.id });
    else {
      dispatch({
        type: 'aimCamera',
        deviceId: d.id,
        target: { incidentId: inc.id },
      });
      r = s.linkCut[d.id]
        ? {
            ok: false,
            confirmed: false,
            detail: t('Camera is not responding. Command not sent.'),
          }
        : aim?.reachable
          ? {
              ok: true,
              confirmed: true,
              detail: t('Pointed at {id}, {zoom}× zoom.', {
                id: inc.id,
                zoom: aim.zoom,
              }),
            }
          : { ok: false, confirmed: false, detail: t('Cannot turn that far.') };
    }
    setBusy(false);
    setStatus({ r, at: Date.now() });
  };

  const fresh = status && Date.now() - status.at < 6000 ? status.r : null;
  const hasGimbal = d.capabilities.includes('gimbal');
  const hasPayload = ['spotlight', 'beacon', 'speaker'].some((c) => d.capabilities.includes(c));

  return (
    <div
      className={`ptz${off ? ' off' : ''}`}
      tabIndex={off ? -1 : 0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      aria-label={t('Camera control for {id}. Arrow keys turn, + and − zoom, C centres.', { id: d.id })}
    >
      {hasGimbal && (
        <>
          <div className="ptz-pad" role="group" aria-label={t('Pan and tilt')}>
            <button className="u" disabled={off} aria-label={t('Tilt up')} {...hold(() => startPan('up'))}>
              <ChevronUp size={18} />
            </button>
            <button className="l" disabled={off} aria-label={t('Pan left')} {...hold(() => startPan('left'))}>
              <ChevronLeft size={18} />
            </button>
            <button className="c" disabled={off || busy} aria-label={t('Centre')} title={t('Centre')} onClick={() => void run({ action: 'center' })}>
              <Crosshair size={16} />
            </button>
            <button className="r" disabled={off} aria-label={t('Pan right')} {...hold(() => startPan('right'))}>
              <ChevronRight size={18} />
            </button>
            <button className="d" disabled={off} aria-label={t('Tilt down')} {...hold(() => startPan('down'))}>
              <ChevronDown size={18} />
            </button>
          </div>

          <div className="ptz-mid">
            <div className="ptz-zoom" role="group" aria-label={t('Zoom')}>
              <button disabled={off} aria-label={t('Zoom out')} {...hold(() => startZoom(-1))}>
                <Minus size={16} />
              </button>
              <span className="ptz-zl">{(g?.zoom ?? 1).toFixed(1)}×</span>
              <button disabled={off} aria-label={t('Zoom in')} {...hold(() => startZoom(1))}>
                <Plus size={16} />
              </button>
            </div>
            <div className="ptz-read" aria-live="off">
              <span>
                {t('Pan')} <b>{fmtDeg(g?.yaw)}</b>
              </span>
              <span>
                {t('Tilt')} <b>{fmtDeg(g?.pitch)}</b>
              </span>
            </div>
          </div>
        </>
      )}

      <div className="ptz-act">
        {d.capabilities.includes('photo') && (
          <button className="ptz-btn" disabled={off || busy} onClick={() => void run({ action: 'photo' })}>
            <Camera size={16} /> {t('Photo')}
          </button>
        )}
        {d.capabilities.includes('record') && (
          <button className={`ptz-btn rec${g?.recording ? ' on' : ''}`} disabled={off || busy} aria-pressed={!!g?.recording} onClick={() => void run({ action: 'record' })}>
            <Circle size={12} fill="currentColor" /> {g?.recording ? t('Stop REC') : t('Record')}
          </button>
        )}
      </div>

      {hasPayload && <PayloadRow d={d} off={off || !can(me.role, 'payload.control')} busy={busy} run={run} />}

      {inc && aim && (
        <button className="ptz-aim" disabled={off || busy || !aim.reachable} onClick={() => void pointAt()} title={aim.reachable ? undefined : t('Cannot turn that far.')}>
          <LocateFixed size={16} /> {t('Point at {id}', { id: inc.id })}
          <span className="muted">
            · {aim.distanceM} m · {aim.zoom}×
          </span>
        </button>
      )}

      <div className={`ptz-status${fresh ? (fresh.ok ? (fresh.confirmed ? ' ok' : ' warn') : ' err') : ''}`} role="status">
        {reason ??
          (fresh
            ? fresh.ok
              ? fresh.confirmed
                ? `✓ ${t('Confirmed by camera')} · ${fresh.detail}`
                : `${t('Sent — camera did not confirm')}${fresh.detail ? ` · ${fresh.detail}` : ''}`
              : `✕ ${fresh.detail}`
            : t('Hold an arrow to turn. Arrow keys, + / − and C also work.'))}
      </div>
    </div>
  );
}

/** 4-in-1 module: searchlight, red/blue warning light, loudspeaker presets. */
function PayloadRow({ d, off, busy, run }: { d: Device; off: boolean; busy: boolean; run: (a: CameraAction) => Promise<void> }) {
  const t = useT();
  const g = d.gimbal;
  const [msg, setMsg] = useState(ANNOUNCEMENTS[0].id);
  const [lang, setLang] = useState<'th' | 'en'>('th');
  const has = (c: string) => d.capabilities.includes(c);
  const preset = ANNOUNCEMENTS.find((m) => m.id === msg)!;
  return (
    <div className="ptz-payload" role="group" aria-label={t('4-in-1 module')}>
      <div className="ptz-pl-row">
        {has('spotlight') && (
          <button
            className={`ptz-btn pl-spot${g?.spotlight ? ' on' : ''}`}
            disabled={off || busy}
            aria-pressed={!!g?.spotlight}
            onClick={() => void run({ action: 'spotlight', on: !g?.spotlight })}
          >
            <Flashlight size={15} /> {t('Searchlight')}
          </button>
        )}
        {has('beacon') && (
          <button
            className={`ptz-btn pl-beacon${g?.beacon ? ' on' : ''}`}
            disabled={off || busy}
            aria-pressed={!!g?.beacon}
            onClick={() => void run({ action: 'beacon', on: !g?.beacon })}
          >
            <Siren size={15} /> {t('Warning light')}
          </button>
        )}
      </div>
      {has('speaker') && (
        <div className="ptz-pl-row">
          <select value={msg} disabled={off} onChange={(e) => setMsg(e.target.value)} aria-label={t('Announcement')}>
            {ANNOUNCEMENTS.map((m) => (
              <option key={m.id} value={m.id}>
                {lang === 'th' ? m.th : m.en}
              </option>
            ))}
          </select>
          <button className="ptz-lang" disabled={off} onClick={() => setLang(lang === 'th' ? 'en' : 'th')} title={t('Announcement language')}>
            {lang.toUpperCase()}
          </button>
          <button
            className={`ptz-btn pl-speak${g?.announcing ? ' on' : ''}`}
            disabled={off || busy}
            onClick={() =>
              void run({
                action: 'announce',
                message: lang === 'th' ? preset.th : preset.en,
              })
            }
          >
            <Megaphone size={15} /> {t('Announce')}
          </button>
        </div>
      )}
      {g?.announcing && <div className="ptz-pl-now">📢 {g.announcing}</div>}
    </div>
  );
}

function fmtDeg(v?: number) {
  return v === undefined ? '—' : `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(1)}°`;
}
