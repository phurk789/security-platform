// Live driving from the console (UGVs whose gateway offers it). The operator opens a drive session,
// then steers with WASD / arrow keys or the round pad. Samples go out ten times a second; the
// gateway caps them and stops the vehicle when they stop coming, so closing the tab, losing the
// network or switching units always ends in a stop.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Gamepad2, OctagonX, ShieldCheck } from 'lucide-react';
import { modeOf, type Device } from '@13store/shared';
import { can, currentUser, freshness, userName } from '../domain/policy';
import { CENTRED, DRIVE_KEYS, DRIVE_SEND_MS, keysToSticks, padToSticks, type Sticks } from '../domain/drive';
import { useT } from '../i18n';
import { useStore } from '../store';
import { ModeBadge } from './Badges';
import './drive.css';

/** Increases for the life of the page, so the server never sees a sample number twice. */
let driveSeq = 0;

const RUNNING = ['assigned', 'executing', 'paused'];

export function DrivePanel({ d }: { d: Device }) {
  const { s, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const mode = modeOf(d);
  const mine = !!d.drivenBy && d.drivenBy === me.id;
  const driver = d.drivenBy && !mine ? userName(s, d.drivenBy) : null;
  const fresh = freshness(s, d);
  const onMission = s.missions.some((m) => m.deviceId === d.id && RUNNING.includes(m.status));
  const part = d.components?.find((c) => c.id === 'drive');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [reason, setReason] = useState('');
  const [sticks, setSticks] = useState<Sticks>(CENTRED);

  // Latest state for cleanup: was this console still the driver when the panel went away?
  const latest = useRef(s);
  latest.current = s;
  const keys = useRef(new Set<string>());
  const pad = useRef<Sticks | null>(null);

  useEffect(() => {
    if (!mine || !session) return;
    const id = d.id;
    const current = () => pad.current ?? keysToSticks(keys.current);
    const push = () => {
      const st = current();
      setSticks(st);
      session.driveSample(id, ++driveSeq, st.throttle, st.steer);
    };
    const stop = () => {
      keys.current.clear();
      pad.current = null;
      setSticks(CENTRED);
      void session.stopDriving(id);
    };
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'escape') {
        e.preventDefault();
        return stop();
      }
      if (!DRIVE_KEYS.has(k)) return;
      e.preventDefault();
      if (!keys.current.has(k)) {
        keys.current.add(k);
        push();
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (keys.current.delete(k)) push();
    };
    // Focus lost: forget held keys (their key-up never comes). Tab hidden: the driver cannot see.
    const blur = () => {
      keys.current.clear();
      pad.current = null;
      push();
    };
    const hidden = () => document.hidden && stop();
    const timer = window.setInterval(push, DRIVE_SEND_MS);
    push();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', hidden);
      keys.current.clear();
      pad.current = null;
      setSticks(CENTRED);
      // Another unit selected, or the panel closed, while still driving: end the drive.
      if (latest.current.devices[id]?.drivenBy === latest.current.userId) void session.stopDriving(id);
    };
  }, [mine, d.id, session]);

  if (!session || !d.teleop) return null;
  const role = me.role;
  const simulated = mode === 'SIMULATION';
  const canDrive = can(role, 'device.command');
  const canPromote = can(role, 'device.mode.promote');
  const canDemote = can(role, 'device.mode.demote');
  const modeOk = mode === 'LIVE_MANUAL' || simulated;

  const start = async () => {
    setBusy(true);
    await session.startDriving(d.id);
    setBusy(false);
  };
  const changeMode = async (to: 'LIVE_MANUAL' | 'SHADOW') => {
    const why = reason.trim() || (to === 'SHADOW' ? t('Driving finished') : '');
    if (!why) return;
    setBusy(true);
    if (await session.setDeviceMode(d.id, to, why)) setReason('');
    setBusy(false);
  };

  const onPad = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!mine || (e.type === 'pointermove' && !e.currentTarget.hasPointerCapture(e.pointerId))) return;
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    pad.current = padToSticks(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), r.width / 2);
    setSticks(pad.current);
  };
  const padUp = () => {
    pad.current = null;
    setSticks(keysToSticks(keys.current));
  };

  const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  const lim = d.teleop;

  return (
    <section className="panel cc-box drive">
      <div className="panel-head">
        <h2>
          <Gamepad2 size={15} /> {t('Drive')}
        </h2>
        <ModeBadge d={d} />
      </div>
      <div className="cc-box-body">
        {part?.detail && <p className={`drive-state tone-${part.status}`}>{part.detail}</p>}

        {mine ? (
          <>
            <div
              className="drive-pad"
              role="application"
              aria-label={t('Drive pad: drag up to go forward, sideways to turn')}
              onPointerDown={onPad}
              onPointerMove={onPad}
              onPointerUp={padUp}
              onPointerCancel={padUp}
            >
              <span className="drive-axis h" />
              <span className="drive-axis v" />
              <span className="drive-knob" style={{ left: `${50 + sticks.steer * 50}%`, top: `${50 - sticks.throttle * 50}%` }} />
            </div>
            <div className="drive-read">
              <span>
                <small>{t('Throttle')}</small>
                <b>{pct(sticks.throttle * lim.maxThrottle)}</b>
              </span>
              <span>
                <small>{t('Steering')}</small>
                <b>{pct(sticks.steer * lim.maxSteer)}</b>
              </span>
              <span>
                <small>{t('Speed')}</small>
                <b>{d.speed.toFixed(1)} m/s</b>
              </span>
            </div>
            <button className="drive-stop" onClick={() => void session.stopDriving(d.id)}>
              <OctagonX size={18} /> {t('STOP · end drive')}
            </button>
            <p className="fine">{t('Hold W A S D or the arrow keys, or drag the pad. Space or Esc stops. Release everything and the vehicle stops.')}</p>
          </>
        ) : driver ? (
          <>
            <p>{t('{who} is driving {id}.', { who: driver, id: d.id })}</p>
            {(role === 'supervisor' || role === 'admin') && (
              <button className="btn-secondary wide" disabled={busy} onClick={() => void session.stopDriving(d.id)}>
                <OctagonX size={16} /> {t('Stop their drive')}
              </button>
            )}
          </>
        ) : (
          <>
            {!modeOk && <p className="muted">{t('{id} is in {mode}. A supervisor must allow live driving (LIVE MANUAL) first.', { id: d.id, mode: mode.replace('_', ' ') })}</p>}
            {modeOk && !canDrive && <p className="muted">{t('Operators drive vehicles. Your role can watch only.')}</p>}
            {modeOk && canDrive && (
              <>
                {fresh !== 'live' && <p className="muted">{t('Telemetry is {f}. Drive only a vehicle reporting live data.', { f: fresh.toUpperCase() })}</p>}
                {onMission && <p className="muted">{t('{id} is on a mission. Stop or finish it first.', { id: d.id })}</p>}
                {!simulated && (
                  <label className="drive-check">
                    <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} />
                    <span>{t('I can see the vehicle or its video, the area is clear, and a pilot holds the remote ready to disarm.')}</span>
                  </label>
                )}
                <button className="btn-primary wide" disabled={busy || fresh !== 'live' || onMission || (!simulated && !ready)} onClick={() => void start()}>
                  <Gamepad2 size={16} /> {t('Start driving')}
                </button>
                <p className="fine">
                  {t('Limited to {th}% throttle and {st}% steering. Stops {ms} ms after input stops.', {
                    th: Math.round(lim.maxThrottle * 100),
                    st: Math.round(lim.maxSteer * 100),
                    ms: lim.deadmanMs,
                  })}
                </p>
              </>
            )}
          </>
        )}

        {!simulated && !mine && (canPromote || (canDemote && mode !== 'SHADOW')) && (
          <div className="drive-mode">
            {mode === 'SHADOW' && canPromote && (
              <>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('Reason: who is on site, which checks passed')} maxLength={500} />
                <button className="btn-secondary wide" disabled={busy || !reason.trim() || fresh !== 'live'} onClick={() => void changeMode('LIVE_MANUAL')}>
                  <ShieldCheck size={16} /> {t('Allow live driving (LIVE MANUAL)')}
                </button>
              </>
            )}
            {mode === 'LIVE_MANUAL' && canDemote && (
              <button className="btn-secondary wide" disabled={busy || !!d.drivenBy} onClick={() => void changeMode('SHADOW')}>
                {t('Back to SHADOW (no commands)')}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
