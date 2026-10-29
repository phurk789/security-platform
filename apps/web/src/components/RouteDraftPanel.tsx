// Floating panel on the real map while a route or zone is being drawn: what is being drawn, how
// long it is, what is wrong with it, and the buttons to finish or give up.
import { Check, Eraser, MapPinned, Undo2, X } from 'lucide-react';
import { MIN_ZONE_POINTS, checkDraft, maxPoints, routeDraft, useRouteDraft } from '../domain/routeDraft';
import { useStore } from '../store';
import { useT } from '../i18n';

export function RouteDraftPanel() {
  const { s, dispatch } = useStore();
  const t = useT();
  const d = useRouteDraft();
  if (!d || d.state !== 'drawing') return null;
  const zone = d.purpose === 'zone';
  const dev = zone ? undefined : s.devices[d.deviceId];
  const from = dev && !dev.noFix ? dev.pos : undefined;
  const c = checkDraft(d.points, from, s.geofences, dev?.kind === 'uav' ? 'uav' : 'ugv', d.purpose);
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

  return (
    <div className="route-draft" role="dialog" aria-label={title}>
      <div className="route-draft-head">
        <MapPinned size={15} /> <b>{title}</b>
      </div>
      <p className="fine">
        {zone
          ? t('Click the map at each corner of the zone. Drag a corner to move it; right-click it to remove it.')
          : t('Click the map to add a checkpoint. Drag a checkpoint to move it; right-click it to remove it.')}
      </p>
      <div className="route-draft-stats">
        <span>
          <b>{d.points.length}</b> {zone ? t('corners') : t('checkpoints')}
        </span>
        <span>
          <b>{c.lengthM}</b> m{zone ? ` ${t('around')}` : from ? ` ${t('from the vehicle')}` : ''}
        </span>
      </div>
      {c.outside.length > 0 && <p className="route-draft-bad">{t('Checkpoints {list} are outside the site boundary.', { list: c.outside.join(', ') })}</p>}
      {c.fences.length > 0 && <p className="route-draft-bad">{t('The route crosses keep-out zone {names}.', { names: c.fences.map((f) => f.name).join(', ') })}</p>}
      {zone && d.points.length < MIN_ZONE_POINTS && <p className="route-draft-warn">{t('A zone needs at least {n} corners.', { n: MIN_ZONE_POINTS })}</p>}
      {c.full && <p className="route-draft-warn">{t('{n} points is the most this can have.', { n: maxPoints(d.purpose) })}</p>}
      {!zone && !from && <p className="route-draft-warn">{t('{id} has no position yet, so the distance starts at the first checkpoint.', { id: d.deviceId })}</p>}
      <div className="route-draft-actions">
        <button className="btn-ghost small" disabled={!d.points.length} onClick={() => routeDraft.setPoints(d.points.slice(0, -1))}>
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
