// Scheduled patrols: recurring routes a vehicle drives on a timetable, with a standing approval
// from the supervisor who set the schedule. Server-backed; the offline demo shows the explanation.
// The mission planning page lists the schedules; this is the form for a new one, shown beside
// the map so its route can be drawn there.
import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, MapPinned } from 'lucide-react';
import { ROUTES, floorPlan, planRoute, type Patrol, type Point } from '@13store/shared';
import { can, currentUser } from '../domain/policy';
import { finishedDraft, routeDraft, useRouteDraft } from '../domain/routeDraft';
import { useSavedRoutes } from '../domain/savedRoutes';
import { useStore } from '../store';
import { useT } from '../i18n';

/** Day names, Sunday first (English labels to translate). */
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface PatrolFormValues {
  name: string;
  deviceId: string;
  operatorId: string;
  /** A preset route id, 'draw' for checkpoints drawn on the map, or a saved route ("lib:<id>"). */
  routeId: string;
  days: number[];
  times: string;
  autoStart: boolean;
}

/** The form as it was when its route was being drawn, if the page was left and opened again. */
const returningForm = () => {
  const d = routeDraft.get();
  return d?.purpose === 'patrol' ? (d.meta as PatrolFormValues | undefined) : undefined;
};

/** Without a server: what patrol schedules are, since they run there. */
export function PatrolsOffline() {
  const t = useT();
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

/**
 * A new patrol schedule. `startWithRoute`: the route choice to start with (e.g. a saved route,
 * "lib:<id>"). `onLoop` hears the route the patrol would drive, for the map.
 */
export function PatrolForm({
  startWithRoute,
  onSaved,
  onCancel,
  onLoop,
}: {
  startWithRoute?: string | null;
  onSaved: (p: Patrol) => void;
  onCancel: () => void;
  onLoop?: (points: Point[] | undefined) => void;
}) {
  const { s, session, mode } = useStore();
  const t = useT();
  const me = currentUser(s);
  const manage = can(me.role, 'patrol.manage') && !s.replay.active && !!session;
  const vehicles = Object.values(s.devices).filter((d) => (d.kind === 'ugv' || d.kind === 'uav') && d.commands.includes('start'));
  // Whoever sets up the patrol approves its runs, so someone else operates it (two-person rule).
  const operators = s.users.filter((u) => can(u.role, 'mission.accept') && u.id !== me.id);
  const [form, setForm] = useState<PatrolFormValues>(
    () =>
      returningForm() ?? {
        name: '',
        deviceId: vehicles[0]?.id ?? '',
        operatorId: operators[0]?.id ?? '',
        routeId: startWithRoute ?? 'sweep',
        days: [1, 2, 3, 4, 5],
        times: '22:00, 02:00',
        autoStart: false,
      },
  );
  // The lists can arrive after the first render: fall back to the first vehicle / operator until a choice is made.
  const deviceId = vehicles.some((v) => v.id === form.deviceId) ? form.deviceId : (vehicles[0]?.id ?? '');
  const operatorId = operators.some((u) => u.id === form.operatorId) ? form.operatorId : (operators[0]?.id ?? '');
  const dev = s.devices[deviceId];
  // The preset loops are drawn on the demo plant: a real vehicle patrols a route drawn on its own map.
  const presets = dev?.integration === 'simulated';
  // The site's saved routes ("lib:<id>"): a real vehicle takes those or a drawn route.
  const library = useSavedRoutes(session?.api, s.site?.id);
  const saved = form.routeId.startsWith('lib:') ? library.find((r) => `lib:${r.id}` === form.routeId) : undefined;
  const routeId = presets || saved ? form.routeId : 'draw';
  const draft = useRouteDraft();
  const drawn = finishedDraft(draft, 'patrol', deviceId);
  const drawingHere = draft?.state === 'drawing' && draft.purpose === 'patrol';
  const canDraw = mode === 'remote' && !!dev && !dev.indoor;
  const drawOnMap = () => {
    // Drawn on the planning page's own map; the form's values ride along in case the page is left.
    routeDraft.start({ purpose: 'patrol', deviceId, points: drawn?.points ?? [], returnTo: 'missions', meta: { ...form, deviceId, operatorId, routeId: 'draw' } });
  };
  const close = () => {
    if (routeDraft.get()?.purpose === 'patrol') routeDraft.clear();
    onCancel();
  };
  // Loop: the preset route and back to where the vehicle is parked, planned around buildings and keep-out zones.
  // A route drawn on the map is driven exactly as drawn.
  const loop = useMemo(() => {
    if (!dev) return undefined;
    // Indoor vehicles patrol their floor plan; outdoor presets would cross walls.
    if (dev.indoor) return floorPlan(dev.indoor.buildingId, dev.indoor.level)?.patrolRoute;
    if (routeId === 'draw') return drawn?.points;
    if (saved) return saved.points;
    const preset = (ROUTES.find((r) => r.id === form.routeId) ?? ROUTES[0]).pts;
    const home = dev.stats?.dock ?? dev.pos;
    const back = planRoute(preset[preset.length - 1], home, { fences: s.geofences, kind: dev.kind as 'ugv' | 'uav' });
    const out: Point[] = [...preset, ...(back.ok ? back.checkpoints : [])];
    return out;
  }, [dev, routeId, form.routeId, s.geofences, drawn, saved]);
  const loopKey = loop ? loop.map((p) => `${p.x},${p.y}`).join(';') : '';
  useEffect(() => {
    onLoop?.(loop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopKey]);
  const times = form.times
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const valid = form.name.trim() && deviceId && operatorId && form.days.length && times.length && times.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)) && loop?.length;

  if (!session) return <PatrolsOffline />;
  if (!manage) return <p className="fine">{t('Only a supervisor or an administrator can set up a patrol schedule.')}</p>;

  return (
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
            if (!r) return;
            if (routeDraft.get()?.purpose === 'patrol') routeDraft.clear();
            onSaved(r);
          });
      }}
    >
      <label className="field">
        <span>{t('Patrol name')}</span>
        <input placeholder={t('Name, e.g. Night perimeter')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
      </label>
      <label className="field">
        <span>{t('Vehicle')}</span>
        <select value={deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}>
          {vehicles.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id} · {d.model}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('Operator')}</span>
        <select value={operatorId} onChange={(e) => setForm({ ...form, operatorId: e.target.value })}>
          {operators.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('Route')}</span>
        {dev?.indoor ? (
          <select value="floor" disabled>
            <option value="floor">{t('Floor patrol · {b} level {n} · {k} checkpoints', { b: dev.indoor.buildingId, n: dev.indoor.level, k: loop?.length ?? 0 })}</option>
          </select>
        ) : (
          <select
            value={routeId}
            onChange={(e) => {
              setForm({ ...form, routeId: e.target.value });
              if (e.target.value === 'draw' && !drawn) drawOnMap();
            }}
          >
            {presets &&
              ROUTES.map((r) => (
                <option key={r.id} value={r.id}>
                  {t(r.label)}
                </option>
              ))}
            {canDraw && <option value="draw">{drawn ? t('Drawn on the map · {k} checkpoints', { k: drawn.points.length }) : t('Draw checkpoints on the map…')}</option>}
            {library.map((r) => (
              <option key={r.id} value={`lib:${r.id}`}>
                {t('Saved: {name} · {k} checkpoints', { name: r.name, k: r.points.length })}
              </option>
            ))}
          </select>
        )}
      </label>
      {routeId === 'draw' &&
        canDraw &&
        (drawingHere ? (
          <small className="muted">{t('Drawing on the map — finish with “Use this route” in the map panel.')}</small>
        ) : (
          <button type="button" className="btn-secondary small" onClick={drawOnMap}>
            <MapPinned size={14} /> {drawn ? t('Change on the map') : t('Draw on the map')}
          </button>
        ))}
      <div className="field">
        <span>{t('Days')}</span>
        <div className="chips">
          {DAYS.map((d, i) => (
            <button
              key={d}
              type="button"
              className={`chip ${form.days.includes(i) ? 'on' : ''}`}
              aria-pressed={form.days.includes(i)}
              onClick={() => setForm({ ...form, days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i].sort() })}
            >
              {t(d)}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>{t('Times')}</span>
        <input placeholder={t('Times, e.g. 22:00, 02:00')} value={form.times} onChange={(e) => setForm({ ...form, times: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={form.autoStart} onChange={(e) => setForm({ ...form, autoStart: e.target.checked })} />{' '}
        {t('Start automatically when the vehicle is ready (the operator keeps control and can pause or stop)')}
      </label>
      <p className="fine">
        {routeId === 'draw' && !dev?.indoor
          ? loop?.length
            ? t('Drawn route: {n} checkpoints, driven as drawn. Standing approval is recorded under your name; the route is checked against keep-out zones on every run.', {
                n: loop.length,
              })
            : t('No checkpoints drawn yet.')
          : saved
            ? t('Saved route “{name}”: {n} checkpoints, driven as saved. Standing approval is recorded under your name; the route is checked against keep-out zones on every run.', {
                name: saved.name,
                n: saved.points.length,
              })
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
        <button className="btn-primary grow" disabled={!valid}>
          {t('Save schedule')}
        </button>
      </div>
    </form>
  );
}
