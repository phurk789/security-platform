// Scheduled patrols: recurring routes a vehicle drives on a timetable, with a standing approval
// from the supervisor who set the schedule. Server-backed; the offline demo shows the explanation.
import { useMemo, useState } from 'react';
import { CalendarClock, MapPinned, Play, Plus, Trash2 } from 'lucide-react';
import { ROUTES, floorPlan, fmtDate, fmtTime, planRoute, type Point } from '@13store/shared';
import { can, currentUser, userName } from '../domain/policy';
import { finishedDraft, routeDraft, useRouteDraft } from '../domain/routeDraft';
import { useStore } from '../store';
import { useT } from '../i18n';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface PatrolForm {
  name: string;
  deviceId: string;
  operatorId: string;
  /** A preset route id, or 'draw' for checkpoints drawn on the map. */
  routeId: string;
  days: number[];
  times: string;
  autoStart: boolean;
}

/** The form as it was when the operator went to the map to draw, if they are coming back from it. */
const returningForm = () => {
  const d = routeDraft.get();
  return d?.purpose === 'patrol' && d.state === 'done' ? (d.meta as PatrolForm | undefined) : undefined;
};

export function PatrolsCard() {
  const { s, session, dispatch, mode } = useStore();
  const t = useT();
  const me = currentUser(s);
  const manage = can(me.role, 'patrol.manage') && !s.replay.active && !!session;
  // Coming back from drawing on the map: reopen the form as it was.
  const [open, setOpen] = useState(() => !!returningForm());
  const vehicles = Object.values(s.devices).filter((d) => (d.kind === 'ugv' || d.kind === 'uav') && d.commands.includes('start'));
  const operators = s.users.filter((u) => u.role === 'operator');
  const [form, setForm] = useState<PatrolForm>(
    () =>
      returningForm() ?? {
        name: '',
        deviceId: vehicles[0]?.id ?? '',
        operatorId: operators[0]?.id ?? '',
        routeId: 'sweep',
        days: [1, 2, 3, 4, 5],
        times: '22:00, 02:00',
        autoStart: false,
      },
  );
  // The lists can arrive after the first render: fall back to the first vehicle / operator until a choice is made.
  const deviceId = vehicles.some((v) => v.id === form.deviceId) ? form.deviceId : (vehicles[0]?.id ?? '');
  const operatorId = operators.some((u) => u.id === form.operatorId) ? form.operatorId : (operators[0]?.id ?? '');
  const dev = s.devices[deviceId];
  const draft = useRouteDraft();
  const drawn = finishedDraft(draft, 'patrol', deviceId);
  const canDraw = mode === 'remote' && !!dev && !dev.indoor;
  const drawOnMap = () => {
    routeDraft.start({ purpose: 'patrol', deviceId, points: drawn?.points ?? [], returnTo: 'missions', meta: { ...form, deviceId, operatorId, routeId: 'draw' } });
    dispatch({ type: 'setView', view: 'overview' });
  };
  const close = () => {
    if (routeDraft.get()?.purpose === 'patrol') routeDraft.clear();
    setOpen(false);
  };
  // Loop: the preset route and back to where the vehicle is parked, planned around buildings and keep-out zones.
  // A route drawn on the map is driven exactly as drawn.
  const loop = useMemo(() => {
    if (!dev) return undefined;
    // Indoor vehicles patrol their floor plan; outdoor presets would cross walls.
    if (dev.indoor) return floorPlan(dev.indoor.buildingId, dev.indoor.level)?.patrolRoute;
    if (form.routeId === 'draw') return drawn?.points;
    const preset = (ROUTES.find((r) => r.id === form.routeId) ?? ROUTES[0]).pts;
    const home = dev.stats?.dock ?? dev.pos;
    const back = planRoute(preset[preset.length - 1], home, { fences: s.geofences, kind: dev.kind as 'ugv' | 'uav' });
    const out: Point[] = [...preset, ...(back.ok ? back.checkpoints : [])];
    return out;
  }, [dev, form.routeId, s.geofences, drawn]);
  const times = form.times
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const valid = form.name.trim() && deviceId && operatorId && form.days.length && times.length && times.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)) && loop?.length;

  if (!session) {
    return (
      <section className="card">
        <h3>
          <CalendarClock size={16} /> {t('Scheduled patrols')}
        </h3>
        <p className="fine">
          {t(
            'Patrol schedules run on the platform server: a supervisor sets route, vehicle, operator and times once; the server raises each run with a standing approval and the operator starts it, or the vehicle starts by itself when allowed.',
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="row between wrap">
        <h3>
          <CalendarClock size={16} /> {t('Scheduled patrols')} <small className="muted">({s.patrols.length})</small>
        </h3>
        {manage && (
          <button className="btn-secondary small" onClick={() => (open ? close() : setOpen(true))}>
            <Plus size={14} /> {t('New schedule')}
          </button>
        )}
      </div>
      {s.patrols.length === 0 && !open && <p className="fine">{t('No patrol schedules yet. A supervisor can add one: the route is approved once and runs on the timetable.')}</p>}
      <ul className="list patrols">
        {s.patrols.map((p) => (
          <li key={p.id} className={p.enabled ? '' : 'dim'}>
            <span>
              <b>{p.name}</b> <span className="mono muted">{p.id}</span>
              <br />
              <small className="muted">
                {p.deviceId} · {userName(s, p.operatorId)} · {t('{n} checkpoints', { n: p.route.length })} · {p.days.map((d) => t(DAYS[d])).join(' ')} · {p.times.join(', ')}
                {p.autoStart ? ` · ${t('auto-start')}` : ''}
              </small>
              <br />
              <small className="muted">
                {p.nextRunAt ? t('Next {date} {time}', { date: fmtDate(p.nextRunAt), time: fmtTime(p.nextRunAt) }) : t('Disabled')}
                {p.lastRunAt
                  ? ` · ${t('Last {time}: {outcome}', { time: fmtTime(p.lastRunAt), outcome: t(p.lastOutcome ?? '—') })}${p.lastMissionId ? ` (${p.lastMissionId})` : ''}`
                  : ''}
              </small>
            </span>
            {manage && (
              <span className="row gap-s">
                <button className="btn-ghost small" onClick={() => void session.runPatrol(p.id)} title={t('Run now')}>
                  <Play size={14} /> {t('Run now')}
                </button>
                <button className="btn-ghost small" onClick={() => void session.savePatrol({ enabled: !p.enabled }, p.id)}>
                  {p.enabled ? t('Disable') : t('Enable')}
                </button>
                <button className="btn-ghost small" onClick={() => void session.deletePatrol(p.id)} aria-label={t('Delete')}>
                  <Trash2 size={14} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {open && manage && (
        <form
          className="patrol-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !loop) return;
            void session
              .savePatrol({
                name: form.name.trim(),
                deviceId,
                operatorId,
                route: loop,
                days: form.days,
                times,
                autoStart: form.autoStart,
                enabled: true,
              })
              .then((r) => {
                if (r) close();
              });
          }}
        >
          <input placeholder={t('Name, e.g. Night perimeter')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })} aria-label={t('Vehicle')}>
            {vehicles.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id} · {d.model}
              </option>
            ))}
          </select>
          <select value={operatorId} onChange={(e) => setForm({ ...form, operatorId: e.target.value })} aria-label={t('Operator')}>
            {operators.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          {dev?.indoor ? (
            <select value="floor" disabled aria-label={t('Route')}>
              <option value="floor">{t('Floor patrol · {b} level {n} · {k} checkpoints', { b: dev.indoor.buildingId, n: dev.indoor.level, k: loop?.length ?? 0 })}</option>
            </select>
          ) : (
            <select
              value={form.routeId}
              onChange={(e) => {
                setForm({ ...form, routeId: e.target.value });
                if (e.target.value === 'draw' && !drawn) drawOnMap();
              }}
              aria-label={t('Route')}
            >
              {ROUTES.map((r) => (
                <option key={r.id} value={r.id}>
                  {t(r.label)}
                </option>
              ))}
              {canDraw && (
                <option value="draw">{drawn ? t('Drawn on the map · {k} checkpoints', { k: drawn.points.length }) : t('Draw checkpoints on the map…')}</option>
              )}
            </select>
          )}
          {form.routeId === 'draw' && canDraw && (
            <button type="button" className="btn-secondary small" onClick={drawOnMap}>
              <MapPinned size={14} /> {drawn ? t('Change on the map') : t('Draw on the map')}
            </button>
          )}
          <div className="chips">
            {DAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                className={`chip ${form.days.includes(i) ? 'on' : ''}`}
                onClick={() => setForm({ ...form, days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i].sort() })}
              >
                {t(d)}
              </button>
            ))}
          </div>
          <input placeholder={t('Times, e.g. 22:00, 02:00')} value={form.times} onChange={(e) => setForm({ ...form, times: e.target.value })} />
          <label className="check">
            <input type="checkbox" checked={form.autoStart} onChange={(e) => setForm({ ...form, autoStart: e.target.checked })} />{' '}
            {t('Start automatically when the vehicle is ready (the operator keeps control and can pause or stop)')}
          </label>
          <p className="fine">
            {form.routeId === 'draw' && !dev?.indoor
              ? loop?.length
                ? t('Drawn route: {n} checkpoints, driven as drawn. Standing approval is recorded under your name; the route is checked against keep-out zones on every run.', {
                    n: loop.length,
                  })
                : t('No checkpoints drawn yet.')
              : loop
                ? t('Loop: {n} checkpoints, back to the dock. Standing approval is recorded under your name; the route is checked against keep-out zones on every run.', {
                    n: loop.length,
                  })
                : ''}
          </p>
          <div className="row gap-s">
            <button type="button" className="btn-secondary" onClick={close}>
              {t('Cancel')}
            </button>
            <button className="btn-primary" disabled={!valid}>
              {t('Save schedule')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
