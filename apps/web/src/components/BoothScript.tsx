// Booth presenter: the 3-minute demo script as guided steps. "Next" performs each step
// (switches the role, presses the button) so the presenter can keep talking; the same rules apply
// as when a person clicks. Auto-play runs the whole script and loops it as an attract mode when
// nobody is at the booth. Large captions tell visitors what each step proves.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, Subtitles, X } from 'lucide-react';
import { DEFAULT_ROUTE, freshnessAt, type AppState } from '@13store/shared';
import { missionForIncident, type Msg } from '../domain/reducer';
import { useT } from '../i18n';
import { setSound, soundEnabled } from '../sound';
import { useStore, type Session } from '../store';
import { director, type Shot } from '../twin/director';
import { isKiosk, setWall, useWall } from './Wall';
import './booth.css';

const INC = 'INC-024';
const UGV = 'UGV-01';
const CAM = 'CCTV-02';

interface StepCtx {
  s: AppState;
  dispatch: (m: Msg) => void;
  session?: Session;
}

interface Step {
  id: string;
  /** Who acts: seeded user id. */
  who: string;
  title: string;
  /** What to say / what this proves (shown as the visitor caption). */
  say: string;
  run: (c: StepCtx) => void | Promise<void>;
  /** The step counts as done when this holds; auto-play then waits `dwellMs` before moving on. */
  done: (s: AppState) => boolean;
  dwellMs?: number;
  /** Where the 3D camera goes for this step (ignored while a visitor is moving the view). */
  shot?: Shot;
}

const UAV = 'UAV-02';
const GATE_POS = { x: 335, y: 236 };
const inc = (s: AppState) => s.incidents.find((i) => i.id === INC);
const mis = (s: AppState) => missionForIncident(s, INC);
const cmdOf = (s: AppState, m: { id: string }, type: string) => s.commands.filter((c) => c.missionId === m.id && c.type === type).length;

const STEPS: Step[] = [
  {
    id: 'intro',
    shot: { kind: 'idle' },
    who: 'u-alex',
    title: 'One view of the site',
    say: 'Map, cameras and vehicles in one place. Everything simulated is labelled SIM; only devices that are really ready count as ready.',
    run: ({ dispatch }) => {
      dispatch({ type: 'setView', view: 'overview' });
      dispatch({ type: 'selectIncident', id: INC });
    },
    done: (s) => s.view === 'overview' && s.selectedIncidentId === INC,
    dwellMs: 9000,
  },
  {
    id: 'camera',
    shot: { kind: 'point', p: GATE_POS, dist: 110 },
    who: 'u-alex',
    title: 'Open the camera',
    say: 'An alert stays unverified until a person looks. The nearest camera has already turned to the alert by itself.',
    run: ({ dispatch }) => {
      dispatch({ type: 'openCamera', incidentId: INC });
      dispatch({ type: 'aimCamera', deviceId: CAM, target: { incidentId: INC } });
    },
    done: (s) => inc(s)?.status === 'triaging',
    dwellMs: 7000,
  },
  {
    id: 'confirm',
    shot: { kind: 'point', p: GATE_POS, dist: 90 },
    who: 'u-alex',
    title: 'Confirm the alert',
    say: 'The dispatcher confirms what the camera shows. Every decision is written to the timeline and the audit log with who and when.',
    run: ({ dispatch }) => dispatch({ type: 'confirmIncident', incidentId: INC }),
    done: (s) => inc(s)?.status === 'confirmed',
    dwellMs: 5000,
  },
  {
    id: 'draft',
    shot: { kind: 'point', p: { x: 275, y: 227 }, dist: 175 },
    who: 'u-alex',
    title: 'Plan the UGV route',
    say: 'A patrol route to the gate for UGV-01. The draft is dashed: nothing moves until a supervisor approves it.',
    run: ({ s, dispatch }) => {
      if (!mis(s)) dispatch({ type: 'createMission', incidentId: INC, deviceId: UGV, operatorId: 'u-somchai', checkpoints: DEFAULT_ROUTE });
    },
    done: (s) => !!mis(s),
    dwellMs: 5000,
  },
  {
    id: 'submit',
    shot: { kind: 'point', p: { x: 275, y: 227 }, dist: 175 },
    who: 'u-alex',
    title: 'Submit for approval',
    say: 'Constraint checks run first: inside the demo area, device ready, operator assigned.',
    run: ({ s, dispatch }) => {
      const m = mis(s);
      if (m && m.status === 'draft') dispatch({ type: 'submitMission', missionId: m.id });
    },
    done: (s) => ['pending_approval', 'approved', 'assigned', 'executing', 'paused', 'completed'].includes(mis(s)?.status ?? ''),
    dwellMs: 4000,
  },
  {
    id: 'approve',
    shot: { kind: 'point', p: { x: 275, y: 227 }, dist: 160 },
    who: 'u-nida',
    title: 'Supervisor approves',
    say: 'Only a supervisor can approve, and the API checks it too. Change the route afterwards and approval is withdrawn automatically.',
    run: ({ s, dispatch }) => {
      const m = mis(s);
      if (m && m.status === 'pending_approval') dispatch({ type: 'approveMission', missionId: m.id });
    },
    done: (s) => ['approved', 'assigned', 'executing', 'paused', 'completed'].includes(mis(s)?.status ?? ''),
    dwellMs: 5000,
  },
  {
    id: 'accept',
    shot: { kind: 'follow', id: UGV, dist: 85 },
    who: 'u-somchai',
    title: 'Operator takes control',
    say: 'One person holds control of the vehicle at a time. Handover is logged.',
    run: ({ s, dispatch }) => {
      const m = mis(s);
      if (m && m.status === 'approved') dispatch({ type: 'acceptMission', missionId: m.id });
    },
    done: (s) => ['assigned', 'executing', 'paused', 'completed'].includes(mis(s)?.status ?? ''),
    dwellMs: 4000,
  },
  {
    id: 'start',
    shot: { kind: 'follow', id: UGV, dist: 70 },
    who: 'u-somchai',
    title: 'Send start',
    say: 'Sent, acknowledged, confirmed: the command shows success only when the vehicle actually moves.',
    run: ({ s, dispatch }) => {
      const m = mis(s);
      if (m && m.status === 'assigned') dispatch({ type: 'issueCommand', missionId: m.id, command: 'start', idempotencyKey: `${m.id}:start:${cmdOf(s, m, 'start')}` });
    },
    done: (s) => ['executing', 'paused', 'completed'].includes(mis(s)?.status ?? ''),
    dwellMs: 8000,
  },
  {
    id: 'drone',
    shot: { kind: 'follow', id: UAV, dist: 95 },
    who: 'u-somchai',
    title: 'Drone overwatch (simulated)',
    say: 'While the vehicle drives, the simulated drone is already on station above the alert for an aerial view. No real aircraft flies at the booth.',
    run: ({ dispatch }) => dispatch({ type: 'selectDevice', id: UAV }),
    done: (s) => {
      const d = s.devices[UAV];
      return !!d && Math.hypot(d.pos.x - GATE_POS.x, d.pos.y - GATE_POS.y) < 32;
    },
    dwellMs: 8000,
  },
  {
    id: 'module',
    shot: { kind: 'follow', id: UGV, dist: 48 },
    who: 'u-somchai',
    title: 'Warning light and announcement',
    say: 'The 4-in-1 module on the vehicle: warning light, searchlight and a preset announcement, all from the console and all logged.',
    run: ({ s, dispatch }) => {
      dispatch({ type: 'selectIncident', id: INC }); // back from the drone panel to the live mission
      if (!s.devices[UGV]?.gimbal?.beacon) dispatch({ type: 'cameraControl', deviceId: UGV, action: { action: 'beacon', on: true } });
      dispatch({ type: 'cameraControl', deviceId: UGV, action: { action: 'announce', message: 'This is a restricted area. Please leave now.' } });
    },
    done: (s) => !!s.devices[UGV]?.gimbal?.beacon,
    dwellMs: 7000,
  },
  {
    id: 'cut',
    shot: { kind: 'follow', id: UGV, dist: 70 },
    who: 'u-alex',
    title: 'Cut the network',
    say: 'Radio lost. Data goes STALE, new commands are held, and the vehicle stops itself after 1.5 seconds: its own failsafe, not ours.',
    run: ({ s, dispatch }) => {
      if (!s.linkCut[UGV]) dispatch({ type: 'demoCutLink', deviceId: UGV });
    },
    done: (s) => !!s.linkCut[UGV] && freshnessAt(s.now, s.devices[UGV]) !== 'live',
    dwellMs: 7000,
  },
  {
    id: 'restore',
    shot: { kind: 'follow', id: UGV, dist: 70 },
    who: 'u-alex',
    title: 'Restore the network',
    say: 'Back online. Nothing queued is replayed; the mission is paused until the operator resumes it.',
    run: ({ s, dispatch }) => {
      if (s.linkCut[UGV]) dispatch({ type: 'demoRestoreLink', deviceId: UGV });
    },
    done: (s) => !s.linkCut[UGV] && mis(s)?.status === 'paused',
    dwellMs: 6000,
  },
  {
    id: 'resume',
    shot: { kind: 'follow', id: UGV, dist: 60 },
    who: 'u-somchai',
    title: 'Resume to the gate',
    say: 'The vehicle completes the route. A snapshot from its camera is attached to the incident with a checksum.',
    run: ({ s, dispatch }) => {
      const m = mis(s);
      if (m && m.status === 'paused') dispatch({ type: 'issueCommand', missionId: m.id, command: 'resume', idempotencyKey: `${m.id}:resume:${cmdOf(s, m, 'resume')}` });
    },
    done: (s) => mis(s)?.status === 'completed',
    dwellMs: 6000,
  },
  {
    id: 'resolve',
    shot: { kind: 'point', p: GATE_POS, dist: 120 },
    who: 'u-alex',
    title: 'Record the outcome',
    say: 'Outcome recorded with the mission still linked. A false alarm is still a full record: who checked, what was seen, what was done.',
    run: ({ s, dispatch }) => {
      const i = inc(s);
      if (i?.status === 'confirmed' || i?.status === 'responding')
        dispatch({ type: 'resolveIncident', incidentId: INC, outcome: 'False alarm: delivery contractor at the service gate. Gate secured.' });
    },
    done: (s) => ['resolved', 'closed'].includes(inc(s)?.status ?? ''),
    dwellMs: 4000,
  },
  {
    id: 'close',
    shot: { kind: 'point', p: GATE_POS, dist: 140 },
    who: 'u-alex',
    title: 'Close and report',
    say: 'The report lists the incident, mission, approver, commands and evidence. Every export is logged.',
    run: ({ s, dispatch }) => {
      if (inc(s)?.status === 'resolved') dispatch({ type: 'closeIncident', incidentId: INC });
    },
    done: (s) => inc(s)?.status === 'closed',
    dwellMs: 6000,
  },
  {
    id: 'replay',
    shot: { kind: 'home' },
    who: 'u-priya',
    title: 'Replay for the auditor',
    say: 'The auditor replays the last minutes. In replay every control is off, and the audit chain can be verified.',
    run: ({ s, dispatch }) => {
      dispatch({ type: 'selectIncident', id: INC });
      if (!s.replay.active) dispatch({ type: 'enterReplay', at: s.now - 60_000 });
    },
    done: (s) => s.replay.active,
    dwellMs: 10_000,
  },
];

const USERNAME: Record<string, string> = { 'u-alex': 'alex', 'u-nida': 'nida', 'u-somchai': 'somchai', 'u-priya': 'priya', 'u-ploy': 'ploy' };
const LOOP_PAUSE_MS = 12_000;

export function BoothScript() {
  const { s, dispatch, session, mode } = useStore();
  const t = useT();
  const demoEnv = mode === 'standalone' || session?.meta.env === 'demo';
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(-1);
  const [auto, setAuto] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [busy, setBusy] = useState(false);
  const doneAt = useRef<number | null>(null);
  const sRef = useRef(s);
  sRef.current = s;
  const wall = useWall();

  // `?kiosk`: wall display with the loop running, big text, no presenter panel (W / Esc to leave).
  useEffect(() => {
    if (!demoEnv || !isKiosk()) return;
    setOpen(true);
    setAuto(true);
    setCaptions(true);
    if (!sRef.current.presentation) dispatch({ type: 'togglePresentation' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoEnv]);

  const switchTo = useCallback(
    async (userId: string) => {
      if (sRef.current.userId === userId) return;
      if (session?.switchUser) await session.switchUser(USERNAME[userId] ?? userId);
      else dispatch({ type: 'setUser', userId });
    },
    [session, dispatch],
  );

  const reset = useCallback(async () => {
    director.release();
    if (sRef.current.replay.active) dispatch({ type: 'exitReplay' });
    await switchTo('u-alex');
    dispatch({ type: 'demoReset' });
    setI(-1);
    doneAt.current = null;
  }, [dispatch, switchTo]);

  const runStep = useCallback(
    async (n: number) => {
      const step = STEPS[n];
      if (!step) return;
      setBusy(true);
      try {
        await switchTo(step.who);
        // Role switch may replace the state: run against the latest.
        await new Promise((r) => setTimeout(r, 50));
        await step.run({ s: sRef.current, dispatch, session });
        if (step.shot) director.cut(step.shot);
      } finally {
        setBusy(false);
      }
      setI(n);
      doneAt.current = null;
    },
    [dispatch, session, switchTo],
  );

  const next = useCallback(async () => {
    if (busy) return;
    if (i === -1) await reset();
    const n = i + 1;
    if (n >= STEPS.length) {
      await reset();
      return;
    }
    await runStep(n);
  }, [busy, i, reset, runStep]);

  const back = useCallback(() => {
    if (busy || i <= 0) return;
    // Steps cannot be undone (the server would not allow it either); going back only re-shows the caption.
    setI(i - 1);
  }, [busy, i]);

  // Auto-play: advance once the step's effect is visible and the dwell time has passed; loop at the end.
  const step = i >= 0 ? STEPS[i] : null;
  const isDone = step ? step.done(s) : false;
  useEffect(() => {
    if (!auto || busy) return;
    if (i === -1) {
      const h = setTimeout(() => void next(), 500);
      return () => clearTimeout(h);
    }
    if (!step) return;
    if (!isDone) {
      doneAt.current = null;
      // Safety net: a step that never completes (e.g. the server refused) moves on after 40 s.
      const h = setTimeout(() => void next(), 40_000);
      return () => clearTimeout(h);
    }
    doneAt.current ??= Date.now();
    const wait = Math.max(0, (step.dwellMs ?? 5000) - (Date.now() - doneAt.current)) + (i === STEPS.length - 1 ? LOOP_PAUSE_MS : 0);
    const h = setTimeout(() => void next(), wait);
    return () => clearTimeout(h);
  }, [auto, busy, i, isDone, step, next]);

  // Presenter keys: B opens, Space / → next, ← back, A auto, R reset, Esc close.
  useEffect(() => {
    if (!demoEnv) return;
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (!open) return;
      if (e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        void next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      } else if (e.key === 'a' || e.key === 'A') {
        setAuto((a) => !a);
      } else if (e.key === 'r' || e.key === 'R') {
        setAuto(false);
        void reset();
      } else if (e.key === 'p' || e.key === 'P') {
        dispatch({ type: 'togglePresentation' });
      } else if (e.key === 'w' || e.key === 'W') {
        setWall(!wall);
      } else if (e.key === 's' || e.key === 'S') {
        setSound(!soundEnabled());
      } else if (e.key === 'Escape') {
        setOpen(false);
        setAuto(false);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [demoEnv, open, next, back, reset, dispatch, wall]);

  if (!demoEnv) return null;
  if (!open) return null;

  const who = step ? s.users.find((u) => u.id === step.who) : undefined;
  return (
    <>
      {captions && step && (
        <div className="booth-caption" aria-live="polite">
          <span className="booth-cap-step">
            {i + 1}/{STEPS.length}
          </span>
          <b>{t(step.title)}</b>
          <span>{t(step.say)}</span>
        </div>
      )}
      <aside className="booth" role="region" aria-label={t('Booth script')}>
        <div className="booth-head">
          <b>{t('Booth script')}</b>
          <span className="booth-progress" aria-hidden="true">
            {STEPS.map((st, n) => (
              <i key={st.id} className={n < i ? 'done' : n === i ? (isDone ? 'done cur' : 'cur') : ''} />
            ))}
          </span>
          <button
            className="icon-btn"
            aria-label={t('Close')}
            onClick={() => {
              setOpen(false);
              setAuto(false);
            }}
          >
            <X size={16} />
          </button>
        </div>
        <div className="booth-body">
          {step ? (
            <>
              <div className="booth-who">
                <span className="booth-n">{i + 1}</span>
                <span>
                  {who?.name} · {who?.title}
                </span>
                <span className={`booth-state ${isDone ? 'ok' : ''}`}>{busy ? t('Working…') : isDone ? t('Done') : t('Waiting for effect…')}</span>
              </div>
              <h3>{t(step.title)}</h3>
              <p>{t(step.say)}</p>
            </>
          ) : (
            <>
              <h3>{t('Ready to start')}</h3>
              <p>
                {t(
                  'Press Next (or Space) for each step: the role switches and the action runs for you. A = auto-play loop, R = reset, P = big text, W = wall display, S = sound, B = hide.',
                )}
              </p>
            </>
          )}
        </div>
        <div className="booth-foot">
          <button className="btn-outline small" disabled={busy || i <= 0} onClick={back} aria-label={t('Back')}>
            <ChevronLeft size={16} />
          </button>
          <button className="btn-primary booth-next" disabled={busy} onClick={() => void next()}>
            {i >= STEPS.length - 1 ? t('Finish & reset') : t('Next')} <ChevronRight size={18} />
          </button>
          <button className={`btn-outline small${auto ? ' on' : ''}`} onClick={() => setAuto((a) => !a)} aria-pressed={auto} title={t('Auto-play loop (attract mode)')}>
            {auto ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button className={`btn-outline small${captions ? ' on' : ''}`} onClick={() => setCaptions((c) => !c)} aria-pressed={captions} title={t('Visitor captions')}>
            <Subtitles size={16} />
          </button>
          <button
            className="btn-outline small"
            disabled={busy}
            onClick={() => {
              setAuto(false);
              void reset();
            }}
            title={t('Reset demo dataset')}
          >
            <RotateCcw size={16} />
          </button>
        </div>
      </aside>
    </>
  );
}

/** Footer button that opens the presenter panel (same as pressing B). */
export function BoothOpenHint() {
  const t = useT();
  return <small className="muted">{t('Press B for the booth script')}</small>;
}
