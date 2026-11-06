// The route editor beside the map (mission planning page): what is being drawn and its name, how
// long it is, what is wrong with it, the checkpoints (click one to name it and set its speed, a
// wait, a photo), the tools, and Cancel / Save at the bottom. The map stays clear for clicking:
// while a page docks the editor, the floating panel on the map is not shown.
import { useRef } from 'react';
import { Camera, Check, CircleAlert, Eraser, Hourglass, MousePointerClick, Undo2, X } from 'lucide-react';
import { routeTimeS, type RoutePoint } from '@13store/shared';
import { maxPoints, routeDraft, type LibraryMeta, type RouteDraft } from '../domain/routeDraft';
import { useT } from '../i18n';
import { PointEditor, RouteTools, fmtDuration, useDraftActions, useDraftKeys } from './RouteDraftPanel';

export function RouteEditorDock({ d, msg }: { d: RouteDraft; msg?: { ok: boolean; text: string } | null }) {
  const t = useT();
  const { from, c, speed, library, title, done, cancel } = useDraftActions(d);
  const keys = useRef<{ done: () => void; cancel: () => void } | null>(null);
  keys.current = { done, cancel };
  useDraftKeys(keys);
  const max = maxPoints(d.purpose);
  const n = d.points.length;
  const outside = new Set(c.outside);
  const eyebrow = library ? (library.id ? 'EDIT ROUTE' : 'NEW ROUTE') : d.purpose === 'patrol' ? 'PATROL ROUTE' : 'MISSION ROUTE';

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

      <div className="route-dock-body">
        {library && (
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

        {n === 0 ? (
          <p className="route-dock-hint">
            <MousePointerClick size={18} /> {t('Click the map where the vehicle should go first. Keep clicking to add the next checkpoints, in order.')}
          </p>
        ) : c.ok ? (
          <p className="route-dock-ok">
            <Check size={15} /> {library ? t('Ready to save. Keep clicking the map to add more checkpoints.') : t('Ready to use. Keep clicking the map to add more checkpoints.')}
          </p>
        ) : null}
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
        {c.full && <p className="route-dock-warn">{t('{n} points is the most this can have.', { n: max })}</p>}
        {!library && !from && <p className="route-dock-warn">{t('{id} has no position yet, so the distance starts at the first checkpoint.', { id: d.deviceId })}</p>}
        {msg && <p className={msg.ok ? 'route-dock-ok' : 'route-dock-bad'}>{msg.text}</p>}

        {n > 0 && (
          <ol className="route-dock-cps" aria-label={t('Checkpoints')}>
            {d.points.map((p, i) => (
              <li key={i} className={d.selected === i ? 'on' : ''}>
                <CheckpointRow i={i} p={p} speed={speed} selected={d.selected === i} bad={outside.has(i + 1)} />
                {d.selected === i && <PointEditor i={i} p={p} speed={speed} />}
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

        <p className="route-dock-help">{t('On the map: drag a checkpoint to move it, drag the dot between two checkpoints to add one there, right-click a checkpoint to remove it.')}</p>
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

/** One checkpoint in the list: its number (red when outside the area), name and settings; click to set it up. */
function CheckpointRow({ i, p, speed, selected, bad }: { i: number; p: RoutePoint; speed: number; selected: boolean; bad: boolean }) {
  const t = useT();
  return (
    <button type="button" className="route-dock-cp" aria-expanded={selected} onClick={() => routeDraft.select(selected ? undefined : i)}>
      <span className={`route-cp-n${bad ? ' bad' : ''}`}>{i + 1}</span>
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
  );
}
