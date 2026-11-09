// The route editor beside the map (mission planning page), in two steps:
//   1. Checkpoints: click the map to place them; the list, the length, what is wrong, the tools.
//   2. What happens at each: one speed for the whole route, then each checkpoint's own speed, a
//      wait, and the camera's jobs there (turn it, sweep, a photo, a clip). The map picks
//      checkpoints in this step instead of adding them.
// Cancel / Save stay at the bottom in both steps. The map stays clear for clicking: while a page
// docks the editor, the floating panel on the map is not shown.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, Eraser, MousePointerClick, Undo2, X } from 'lucide-react';
import { ROUTE_LIMITS, pointActs, routeTimeS, type RoutePoint } from '@13store/shared';
import { maxPoints, routeDraft, setAllSpeeds, type LibraryMeta, type RouteDraft } from '../domain/routeDraft';
import { useT } from '../i18n';
import { PointEditor, RouteTools, fmtDuration, useDraftActions, useDraftKeys } from './RouteDraftPanel';
import { PointChips } from './RouteActions';

export function RouteEditorDock({ d, msg }: { d: RouteDraft; msg?: { ok: boolean; text: string } | null }) {
  const t = useT();
  const { from, c, speed, library, title, done, cancel } = useDraftActions(d);
  const keys = useRef<{ done: () => void; cancel: () => void } | null>(null);
  keys.current = { done, cancel };
  useDraftKeys(keys);
  const max = maxPoints(d.purpose);
  const n = d.points.length;
  const outside = new Set(c.outside);
  const step = d.step === 'actions' && n > 0 ? 'actions' : 'points';
  const eyebrow = library ? (library.id ? 'EDIT ROUTE' : 'NEW ROUTE') : d.purpose === 'patrol' ? 'PATROL ROUTE' : 'MISSION ROUTE';
  // Picking a checkpoint (in the list or on the map) opens its settings, in the second step.
  useEffect(() => {
    if (d.selected !== undefined && d.step !== 'actions') routeDraft.setStep('actions');
  }, [d.selected, d.step]);

  return (
    <section className="panel mp-box route-dock" aria-label={title}>
      <div className="panel-head">
        <div>
          <span className="lg-eyebrow">{eyebrow}</span>
          <h2>{library ? (library.id ? t('Change the route') : t('Draw the route')) : title}</h2>
        </div>
        <button type="button" className="btn-ghost small" onClick={cancel} aria-label={t('Cancel')} title={t('Cancel (Esc)')}>
          <X size={16} />
        </button>
      </div>

      <div className="route-steps seg" role="tablist" aria-label={t('Route editor steps')}>
        <button type="button" role="tab" aria-selected={step === 'points'} className={step === 'points' ? 'on' : ''} onClick={() => routeDraft.setStep('points')}>
          <span className="route-step-n">1</span> {t('Checkpoints')}
        </button>
        <button type="button" role="tab" aria-selected={step === 'actions'} className={step === 'actions' ? 'on' : ''} disabled={!n} onClick={() => routeDraft.setStep('actions')}>
          <span className="route-step-n">2</span> {t('What happens at each')}
        </button>
      </div>

      <div className="route-dock-body">
        {library && step === 'points' && (
          <label className="field">
            <span>{t('Route name')}</span>
            <input
              type="text"
              value={library.name}
              maxLength={60}
              placeholder={t('Route name, e.g. Night loop')}
              onChange={(e) => routeDraft.setMeta({ ...library, name: e.target.value } satisfies LibraryMeta)}
            />
          </label>
        )}

        <div className="route-dock-stats">
          <span>
            <b>{n}</b>
            <small>{t('checkpoints')}</small>
          </span>
          <span>
            <b>{c.lengthM}</b>
            <small>{from ? t('m from the vehicle') : t('metres')}</small>
          </span>
          <span title={t('At {v} m/s, the waits included', { v: speed })}>
            <b>{n ? fmtDuration(routeTimeS(d.points, from, speed)) : '—'}</b>
            <small>{t('at {v} m/s', { v: speed })}</small>
          </span>
        </div>

        {c.outside.length > 0 && (
          <p className="route-dock-bad">
            <CircleAlert size={15} /> {t('Checkpoints {list} are outside the site boundary.', { list: c.outside.join(', ') })} {t('Drag them inside the area, or right-click to remove them.')}
          </p>
        )}
        {c.fences.length > 0 && (
          <p className="route-dock-bad">
            <CircleAlert size={15} /> {t('The route crosses keep-out zone {names}.', { names: c.fences.map((f) => f.name).join(', ') })}
          </p>
        )}
        {msg && <p className={msg.ok ? 'route-dock-ok' : 'route-dock-bad'}>{msg.text}</p>}

        {step === 'points' ? (
          <>
            {n === 0 ? (
              <p className="route-dock-hint">
                <MousePointerClick size={18} /> {t('Click the map where the vehicle should go first. Keep clicking to add the next checkpoints, in order.')}
              </p>
            ) : c.ok ? (
              <p className="route-dock-ok">
                <Check size={15} /> {t('Keep clicking the map to add checkpoints. Then set what the vehicle does at each one.')}
              </p>
            ) : null}
            {c.full && <p className="route-dock-warn">{t('{n} points is the most this can have.', { n: max })}</p>}
            {!library && !from && <p className="route-dock-warn">{t('{id} has no position yet, so the distance starts at the first checkpoint.', { id: d.deviceId })}</p>}

            {n > 0 && (
              <ol className="route-dock-cps" aria-label={t('Checkpoints')}>
                {d.points.map((p, i) => (
                  <li key={i}>
                    <CheckpointRow i={i} p={p} speed={speed} selected={false} bad={outside.has(i + 1)} />
                  </li>
                ))}
              </ol>
            )}

            {n > 0 && (
              <div className="route-dock-tools">
                <button type="button" className="btn-ghost small" disabled={!d.past.length} onClick={() => routeDraft.undo()} title={t('Undo (Backspace)')}>
                  <Undo2 size={14} /> {t('Undo')}
                </button>
                <button type="button" className="btn-ghost small" onClick={() => routeDraft.setPoints([])}>
                  <Eraser size={14} /> {t('Clear')}
                </button>
                <RouteTools points={d.points} max={max} canSave={!library} />
              </div>
            )}

            {n > 0 && (
              <button type="button" className="btn-secondary route-next" onClick={() => routeDraft.setStep('actions')}>
                {t('Next: what happens at each checkpoint')} <ArrowRight size={15} />
              </button>
            )}
            <p className="route-dock-help">{t('On the map: drag a checkpoint to move it, drag the dot between two checkpoints to add one there, right-click a checkpoint to remove it.')}</p>
          </>
        ) : (
          <>
            <RouteSpeed points={d.points} speed={speed} />
            <p className="route-dock-note">
              <MousePointerClick size={15} /> {t('Pick a checkpoint here or on the map to set its speed, a wait and the camera there.')}
            </p>
            <ol className="route-dock-cps route-dock-acts" aria-label={t('Checkpoints')}>
              {d.points.map((p, i) => (
                <li key={i} className={d.selected === i ? 'on' : pointActs(p) ? 'acts' : ''}>
                  <CheckpointRow i={i} p={p} speed={speed} selected={d.selected === i} bad={outside.has(i + 1)} />
                  {d.selected === i && <PointEditor i={i} p={p} speed={speed} />}
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="btn-ghost small route-back"
              onClick={() => {
                routeDraft.select(undefined);
                routeDraft.setStep('points');
              }}
            >
              <ArrowLeft size={14} /> {t('Back to the checkpoints')}
            </button>
          </>
        )}
      </div>

      <div className="route-dock-foot">
        <button type="button" className="btn-secondary" onClick={cancel}>
          {t('Cancel')}
        </button>
        <button type="button" className="btn-primary grow" disabled={!c.ok || (!!library && !library.name.trim())} onClick={done}>
          <Check size={16} /> {library ? t('Save route') : t('Use this route')}
        </button>
      </div>
    </section>
  );
}

/** One speed for the whole route: fills every checkpoint's leg speed (empty: the vehicle's own). */
function RouteSpeed({ points, speed }: { points: RoutePoint[]; speed: number }) {
  const t = useT();
  // The speed every leg already shares, if they do.
  const shared = points.every((p) => p.speed === points[0]?.speed) ? points[0]?.speed : undefined;
  const [v, setV] = useState(shared === undefined ? '' : String(shared));
  const value = v.trim() === '' ? undefined : Number(v);
  const valid = value === undefined || (Number.isFinite(value) && value >= ROUTE_LIMITS.minSpeed && value <= ROUTE_LIMITS.maxSpeed);
  return (
    <div className="route-speed">
      <label>
        <span>{t('Speed for the whole route (m/s)')}</span>
        <input type="number" min={ROUTE_LIMITS.minSpeed} max={ROUTE_LIMITS.maxSpeed} step={0.1} value={v} placeholder={String(speed)} onChange={(e) => setV(e.target.value)} />
      </label>
      <button type="button" className="btn-secondary small" disabled={!valid} onClick={() => routeDraft.setPoints(setAllSpeeds(points, value === undefined ? undefined : Math.round(value * 10) / 10))}>
        {t('Use at every checkpoint')}
      </button>
      <small>{valid ? t('Empty: the vehicle’s own route speed ({v} m/s).', { v: speed }) : t('{lo}–{hi} m/s', { lo: ROUTE_LIMITS.minSpeed, hi: ROUTE_LIMITS.maxSpeed })}</small>
    </div>
  );
}

/** One checkpoint in the list: its number (red when outside the area), name and what happens there; click to set it up. */
function CheckpointRow({ i, p, speed, selected, bad }: { i: number; p: RoutePoint; speed: number; selected: boolean; bad: boolean }) {
  const t = useT();
  return (
    <button type="button" className="route-dock-cp" aria-expanded={selected} onClick={() => routeDraft.select(selected ? undefined : i)}>
      <span className={`route-cp-n${bad ? ' bad' : ''}`}>{i + 1}</span>
      <span className="grow">{p.name || t('Checkpoint {n}', { n: i + 1 })}</span>
      <span className="route-cp-tags">
        <PointChips p={p} speed={speed} />
      </span>
    </button>
  );
}
