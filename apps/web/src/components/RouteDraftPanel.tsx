// Floating panel on the real map while a route or zone is being drawn: what is being drawn, how
// long it is, what is wrong with it, and the buttons to finish or give up. A route also lists its
// checkpoints: click one (here or on the map) to name it and set the speed of the leg to it, a wait
// there, and whether to keep the camera view there as evidence. Routes can be reversed, closed into
// a loop, and kept in the site's route library.
import { useEffect, useRef, useState } from 'react';
import { ArrowDownUp, Camera, Check, Eraser, FolderOpen, Hourglass, MapPinned, Repeat, Save, Trash2, Undo2, X } from 'lucide-react';
import { ROUTE_LIMITS, routeSpeedOf, routeTimeS, type RoutePoint } from '@13store/shared';
import { MIN_ZONE_POINTS, checkDraft, closeLoop, isLoop, maxPoints, removePoint, reverseRoute, routeDraft, setPointSettings, useRouteDraft } from '../domain/routeDraft';
import { savedRoutes, useSavedRoutes } from '../domain/savedRoutes';
import { useStore } from '../store';
import { useT } from '../i18n';
import { ZoneEditor } from './ZoneEditor';

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** "3 min 20 s" / "45 s". */
export function fmtDuration(sec: number) {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`;
}

export function RouteDraftPanel() {
  const { s, dispatch } = useStore();
  const t = useT();
  const d = useRouteDraft();
  const keys = useRef<{ done: () => void; cancel: () => void } | null>(null);
  // Esc cancels, Backspace undoes, Enter uses the route (the zone editor has its own keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (!k || typing(e.target)) return;
      if (e.key === 'Escape') k.cancel();
      else if (e.key === 'Enter') k.done();
      else if (e.key === 'Backspace' || e.key === 'Delete') routeDraft.undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!d || d.state !== 'drawing') {
    keys.current = null;
    return null;
  }
  if (d.purpose === 'geofence') {
    keys.current = null;
    return <ZoneEditor d={d} />;
  }
  const zone = d.purpose === 'zone';
  const dev = zone ? undefined : s.devices[d.deviceId];
  const from = dev && !dev.noFix ? dev.pos : undefined;
  const c = checkDraft(d.points, from, s.geofences, dev?.kind === 'uav' ? 'uav' : 'ugv', d.purpose);
  const speed = dev ? routeSpeedOf(dev) : 1;
  const title = zone
    ? t('Zone outline')
    : d.purpose === 'mission-edit'
      ? t('Edit the route of {id}', { id: d.missionId ?? '' })
      : d.purpose === 'patrol'
        ? t('Patrol route for {id}', { id: d.deviceId })
        : t('Mission route for {id}', { id: d.deviceId });
  const back = () => d.returnTo && dispatch({ type: 'setView', view: d.returnTo });
  const done = () => {
    if (!c.ok) return;
    if (d.purpose === 'mission-edit' && d.missionId) {
      dispatch({ type: 'editRoute', missionId: d.missionId, checkpoints: d.points });
      routeDraft.clear();
    } else routeDraft.finish();
    back();
  };
  const cancel = () => {
    // A mission's route stays as it was on the server; the other forms get their earlier points back.
    if (d.purpose === 'mission-edit') routeDraft.clear();
    else routeDraft.cancel();
    back();
  };
  keys.current = { done, cancel };

  return (
    <div className={`route-draft${zone ? '' : ' route-plan'}`} role="dialog" aria-label={title}>
      <div className="route-draft-head">
        <MapPinned size={15} /> <b>{title}</b>
      </div>
      <p className="fine">
        {zone
          ? t('Click the map at each corner of the zone. Drag a corner to move it; right-click it to remove it.')
          : t('Click the map to add a checkpoint. Drag a checkpoint to move it, drag a midpoint to insert one, right-click to remove. Click a checkpoint to set it up.')}
      </p>
      <div className="route-draft-stats">
        <span>
          <b>{d.points.length}</b> {zone ? t('corners') : t('checkpoints')}
        </span>
        <span>
          <b>{c.lengthM}</b> m{zone ? ` ${t('around')}` : from ? ` ${t('from the vehicle')}` : ''}
        </span>
        {!zone && d.points.length > 0 && (
          <span title={t('At {v} m/s, the waits included', { v: speed })}>
            <b>~{fmtDuration(routeTimeS(d.points, from, speed))}</b>
          </span>
        )}
      </div>
      {c.outside.length > 0 && <p className="route-draft-bad">{t('Checkpoints {list} are outside the site boundary.', { list: c.outside.join(', ') })}</p>}
      {c.fences.length > 0 && <p className="route-draft-bad">{t('The route crosses keep-out zone {names}.', { names: c.fences.map((f) => f.name).join(', ') })}</p>}
      {zone && d.points.length < MIN_ZONE_POINTS && <p className="route-draft-warn">{t('A zone needs at least {n} corners.', { n: MIN_ZONE_POINTS })}</p>}
      {c.full && <p className="route-draft-warn">{t('{n} points is the most this can have.', { n: maxPoints(d.purpose) })}</p>}
      {!zone && !from && <p className="route-draft-warn">{t('{id} has no position yet, so the distance starts at the first checkpoint.', { id: d.deviceId })}</p>}
      {!zone && d.points.length > 0 && <Checkpoints points={d.points} selected={d.selected} speed={speed} />}
      {!zone && d.selected !== undefined && d.points[d.selected] && <PointEditor i={d.selected} p={d.points[d.selected]} speed={speed} />}
      {!zone && <RouteTools points={d.points} max={maxPoints(d.purpose)} />}
      <div className="route-draft-actions">
        <button className="btn-ghost small" disabled={!d.past.length} onClick={() => routeDraft.undo()} title={t('Undo (Backspace)')}>
          <Undo2 size={14} /> {t('Undo')}
        </button>
        <button className="btn-ghost small" disabled={!d.points.length} onClick={() => routeDraft.setPoints([])}>
          <Eraser size={14} /> {t('Clear')}
        </button>
        <span className="grow" />
        <button className="btn-secondary small" onClick={cancel}>
          <X size={14} /> {t('Cancel')}
        </button>
        <button className="btn-primary small" disabled={!c.ok} onClick={done}>
          <Check size={14} /> {zone ? t('Use this outline') : t('Use this route')}
        </button>
      </div>
    </div>
  );
}

/** The route's checkpoints in order, with what is set at each; click one to set it up. */
function Checkpoints({ points, selected, speed }: { points: RoutePoint[]; selected?: number; speed: number }) {
  const t = useT();
  return (
    <ol className="route-cps" aria-label={t('Checkpoints')}>
      {points.map((p, i) => (
        <li key={i}>
          <button type="button" className={selected === i ? 'on' : ''} onClick={() => routeDraft.select(selected === i ? undefined : i)}>
            <span className="route-cp-n">{i + 1}</span>
            <span className="grow">{p.name || t('Checkpoint {n}', { n: i + 1 })}</span>
            {p.speed !== undefined && p.speed !== speed && <span className="route-cp-tag">{t('{v} m/s', { v: p.speed })}</span>}
            {p.holdS ? (
              <span className="route-cp-tag">
                <Hourglass size={11} /> {t('{n} s', { n: p.holdS })}
              </span>
            ) : null}
            {p.capture && (
              <span className="route-cp-tag" title={t('The view here is kept as evidence')}>
                <Camera size={11} />
              </span>
            )}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Name, leg speed, wait and capture for one checkpoint. */
function PointEditor({ i, p, speed }: { i: number; p: RoutePoint; speed: number }) {
  const t = useT();
  const set = (patch: Partial<Omit<RoutePoint, 'x' | 'y'>>) => {
    const d = routeDraft.get();
    if (d) routeDraft.setPoints(setPointSettings(d.points, i, patch));
  };
  const num = (v: string, lo: number, hi: number) => {
    if (v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
  };
  return (
    <div className="route-cp-edit" aria-label={t('Checkpoint {n}', { n: i + 1 })}>
      <label>
        <span>{t('Name')}</span>
        <input value={p.name ?? ''} maxLength={ROUTE_LIMITS.nameLen} placeholder={t('Checkpoint {n}', { n: i + 1 })} onChange={(e) => set({ name: e.target.value || undefined })} />
      </label>
      <label>
        <span>{t('Speed to here (m/s)')}</span>
        <input
          type="number"
          min={ROUTE_LIMITS.minSpeed}
          max={ROUTE_LIMITS.maxSpeed}
          step={0.1}
          value={p.speed ?? ''}
          placeholder={String(speed)}
          onChange={(e) => set({ speed: num(e.target.value, ROUTE_LIMITS.minSpeed, ROUTE_LIMITS.maxSpeed) })}
        />
      </label>
      <label>
        <span>{t('Wait here (s)')}</span>
        <input type="number" min={0} max={ROUTE_LIMITS.maxHoldS} step={1} value={p.holdS ?? ''} placeholder="0" onChange={(e) => set({ holdS: num(e.target.value, 0, ROUTE_LIMITS.maxHoldS) })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={!!p.capture} onChange={(e) => set({ capture: e.target.checked })} />
        <Camera size={13} /> {t('Keep the view here as evidence')}
      </label>
      <div className="route-draft-actions">
        <button
          className="btn-ghost small danger"
          onClick={() => {
            const d = routeDraft.get();
            if (d) routeDraft.setPoints(removePoint(d.points, i));
          }}
        >
          <Trash2 size={13} /> {t('Remove checkpoint')}
        </button>
        <span className="grow" />
        <button className="btn-ghost small" onClick={() => routeDraft.select(undefined)}>
          {t('Close')}
        </button>
      </div>
    </div>
  );
}

/** Reverse, close the loop, and the site's route library (load one, keep this one). */
function RouteTools({ points, max }: { points: RoutePoint[]; max: number }) {
  const { s, session } = useStore();
  const t = useT();
  const library = useSavedRoutes(session?.api, s.site?.id);
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    if (!session || !name?.trim()) return;
    const same = library.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
    try {
      if (same) await session.api.patch(`/saved-routes/${encodeURIComponent(same.id)}`, { points });
      else await session.api.post('/saved-routes', { siteId: s.site?.id, name: name.trim(), points });
      await savedRoutes.refresh(session.api, s.site?.id);
      setMsg({ ok: true, text: t('Saved as “{name}”.', { name: name.trim() }) });
      setName(null);
    } catch (e) {
      setMsg({ ok: false, text: t(e instanceof Error ? e.message : String(e)) });
    }
  };
  return (
    <>
      <div className="route-draft-actions">
        <button className="btn-ghost small" disabled={points.length < 2} onClick={() => routeDraft.setPoints(reverseRoute(points))} title={t('Drive it the other way round')}>
          <ArrowDownUp size={14} /> {t('Reverse')}
        </button>
        <button
          className="btn-ghost small"
          disabled={points.length < 2 || isLoop(points) || points.length >= max}
          onClick={() => routeDraft.setPoints(closeLoop(points, max))}
          title={t('End where the route began')}
        >
          <Repeat size={14} /> {t('Close the loop')}
        </button>
        {session && (
          <>
            <span className="grow" />
            {library.length > 0 && (
              <label className="route-lib" title={t('Load a saved route')}>
                <FolderOpen size={14} />
                <select
                  value=""
                  aria-label={t('Load a saved route')}
                  onChange={(e) => {
                    const r = library.find((x) => x.id === e.target.value);
                    if (r) routeDraft.setPoints(r.points.map((p) => ({ ...p })));
                  }}
                >
                  <option value="">{t('Saved routes…')}</option>
                  {library.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} · {t('{n} checkpoints', { n: r.points.length })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="btn-ghost small" disabled={!points.length} onClick={() => setName(name === null ? '' : null)}>
              <Save size={14} /> {t('Save route')}
            </button>
          </>
        )}
      </div>
      {name !== null && (
        <form
          className="route-draft-actions"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input autoFocus className="grow" value={name} maxLength={60} placeholder={t('Route name, e.g. Night loop')} onChange={(e) => setName(e.target.value)} aria-label={t('Route name')} />
          <button className="btn-secondary small" disabled={!name.trim()}>
            {library.some((r) => r.name.toLowerCase() === name.trim().toLowerCase()) ? t('Replace') : t('Save')}
          </button>
        </form>
      )}
      {msg && <p className={msg.ok ? 'fine' : 'route-draft-bad'}>{msg.text}</p>}
    </>
  );
}
