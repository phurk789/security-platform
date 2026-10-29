// The zone editor on the map: draw a new zone (polygon or north-up rectangle) or reshape an existing
// one, say what it is, and save it. Nothing changes on the server until Save: an unreviewed shape
// must not start refusing routes. Keys: Enter closes the outline / saves, Esc cancels, Backspace undoes.
import { useEffect, useRef, useState } from 'react';
import { Check, Eraser, Pentagon, RectangleHorizontal, Trash2, Undo2, X } from 'lucide-react';
import { GEOFENCE_KINDS, GEOFENCE_KIND_LABEL, type FencedKind } from '@13store/shared';
import { MAX_ZONE_POINTS, MIN_ZONE_POINTS, checkDraft, routeDraft, type RouteDraft, type ZoneMeta } from '../domain/routeDraft';
import { GEOFENCE_COLOR } from '../lib/overlays';
import { useStore } from '../store';
import { useT } from '../i18n';

/** 1 rai = 1,600 m². */
const RAI_M2 = 1600;

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export function ZoneEditor({ d }: { d: RouteDraft }) {
  const { session } = useStore();
  const t = useT();
  const meta = d.meta as ZoneMeta;
  const c = checkDraft(d.points, undefined, [], 'ugv', 'geofence');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<ZoneMeta>) => routeDraft.setMeta({ ...(routeDraft.get()?.meta as ZoneMeta), ...patch });
  // No-fly zones are for aircraft only.
  const appliesTo: FencedKind[] = meta.kind === 'no_fly' ? ['uav'] : meta.appliesTo;
  const valid = c.ok && meta.name.trim().length > 0 && appliesTo.length > 0;
  const drawing = meta.mode === 'draw';

  const undo = () => {
    routeDraft.undo();
    const n = routeDraft.get();
    // A new outline taken back below three corners goes back to adding corners.
    if (n && !meta.id && n.points.length < MIN_ZONE_POINTS && (n.meta as ZoneMeta).mode === 'edit') routeDraft.setMeta({ ...(n.meta as ZoneMeta), mode: 'draw' });
  };
  const close = () => {
    if (c.ok) set({ mode: 'edit' });
  };
  const save = async () => {
    if (!valid || saving || !session) return;
    setSaving(true);
    const r = await session.saveGeofence(
      { name: meta.name.trim(), kind: meta.kind, appliesTo, reason: meta.reason.trim() || undefined, poly: d.points, active: meta.active },
      meta.id,
    );
    setSaving(false);
    if (r) routeDraft.clear();
  };
  const remove = async () => {
    if (!meta.id || !session) return;
    const r = await session.deleteGeofence(meta.id);
    if (r !== undefined) routeDraft.clear();
  };
  const latest = useRef({ undo, close, save, drawing, valid, points: d.points.length });
  latest.current = { undo, close, save, drawing, valid, points: d.points.length };

  // A new outline gets its name once its corners are down.
  useEffect(() => {
    if (!drawing && !meta.id) nameRef.current?.focus();
  }, [drawing, meta.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = latest.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        routeDraft.clear();
      } else if (e.key === 'Enter' && !typing(e.target)) {
        e.preventDefault();
        if (k.drawing && k.points >= MIN_ZONE_POINTS) k.close();
        else if (k.valid) void k.save();
        else nameRef.current?.focus();
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && !typing(e.target)) {
        e.preventDefault();
        k.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const title = meta.id ? t('Edit zone {name}', { name: meta.name || meta.id }) : t('New zone');
  return (
    <form
      className="route-draft zone-editor"
      role="dialog"
      aria-label={title}
      style={{ ['--zone-color' as string]: GEOFENCE_COLOR[meta.kind] }}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="route-draft-head">
        <span className="swatch" /> <b>{title}</b>
      </div>
      {drawing ? (
        <>
          <div className="zone-shapes" role="group" aria-label={t('Shape')}>
            <button type="button" className={meta.shape === 'polygon' ? 'on' : ''} onClick={() => meta.shape !== 'polygon' && (set({ shape: 'polygon' }), routeDraft.setPoints([]))}>
              <Pentagon size={14} /> {t('Polygon')}
            </button>
            <button type="button" className={meta.shape === 'rect' ? 'on' : ''} onClick={() => meta.shape !== 'rect' && (set({ shape: 'rect' }), routeDraft.setPoints([]))}>
              <RectangleHorizontal size={14} /> {t('Rectangle')}
            </button>
          </div>
          <p className="fine">
            {meta.shape === 'rect'
              ? t('Click one corner on the map, then the opposite corner.')
              : t('Click the map at each corner. Click the first corner or press Enter to close the outline.')}
          </p>
        </>
      ) : (
        <p className="fine">{t('Drag a corner to move it. Drag or click a midpoint to add a corner. Right-click a corner to remove it.')}</p>
      )}
      <div className="route-draft-stats">
        <span>
          <b>{d.points.length}</b> {t('corners')}
        </span>
        {(c.areaM2 ?? 0) > 0 && (
          <span>
            <b>{c.areaM2!.toLocaleString()}</b> m² · {(c.areaM2! / RAI_M2).toFixed(1)} {t('rai')}
          </span>
        )}
        {d.points.length > 1 && (
          <span>
            <b>{c.lengthM.toLocaleString()}</b> m {t('around')}
          </span>
        )}
      </div>
      {c.crosses && <p className="route-draft-bad">{t('The outline crosses itself. Move the corners so no two edges cross.')}</p>}
      {!drawing && d.points.length < MIN_ZONE_POINTS && <p className="route-draft-warn">{t('A zone needs at least {n} corners.', { n: MIN_ZONE_POINTS })}</p>}
      {c.full && <p className="route-draft-warn">{t('{n} points is the most this can have.', { n: MAX_ZONE_POINTS })}</p>}

      {!drawing && (
        <div className="zone-fields">
          <input ref={nameRef} value={meta.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('Zone name, e.g. Fuel store')} aria-label={t('Zone name')} maxLength={80} />
          <select value={meta.kind} onChange={(e) => set({ kind: e.target.value as ZoneMeta['kind'] })} aria-label={t('Kind')}>
            {GEOFENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(GEOFENCE_KIND_LABEL[k])}
              </option>
            ))}
          </select>
          <div className="zone-applies">
            {(['ugv', 'uav'] as FencedKind[]).map((k) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={appliesTo.includes(k)}
                  disabled={meta.kind === 'no_fly'}
                  onChange={(e) => set({ appliesTo: e.target.checked ? [...new Set([...meta.appliesTo, k])] : meta.appliesTo.filter((x) => x !== k) })}
                />{' '}
                {k === 'ugv' ? t('Ground vehicles') : t('Aircraft')}
              </label>
            ))}
            <label className="check">
              <input type="checkbox" checked={meta.active} onChange={(e) => set({ active: e.target.checked })} /> {t('Rules on')}
            </label>
          </div>
          <input value={meta.reason} onChange={(e) => set({ reason: e.target.value })} placeholder={t('Reason shown to operators')} aria-label={t('Reason shown to operators')} maxLength={160} />
        </div>
      )}

      <div className="route-draft-actions">
        <button type="button" className="btn-ghost small" disabled={!d.past.length} onClick={undo} title={t('Undo (Backspace)')}>
          <Undo2 size={14} /> {t('Undo')}
        </button>
        {drawing && (
          <button type="button" className="btn-ghost small" disabled={!d.points.length} onClick={() => routeDraft.setPoints([])}>
            <Eraser size={14} /> {t('Clear')}
          </button>
        )}
        {meta.id && !confirmDelete && (
          <button type="button" className="btn-ghost small danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} /> {t('Delete')}
          </button>
        )}
        {meta.id && confirmDelete && (
          <button type="button" className="btn-danger small" onClick={() => void remove()}>
            <Trash2 size={14} /> {t('Delete {name}?', { name: meta.name || meta.id })}
          </button>
        )}
        <span className="grow" />
        <button type="button" className="btn-secondary small" onClick={() => routeDraft.clear()} title={t('Cancel (Esc)')}>
          <X size={14} /> {t('Cancel')}
        </button>
        {drawing ? (
          <button type="button" className="btn-primary small" disabled={!c.ok} onClick={close} title={t('Close the outline (Enter)')}>
            <Check size={14} /> {t('Close outline')}
          </button>
        ) : (
          <button type="submit" className="btn-primary small" disabled={!valid || saving}>
            <Check size={14} /> {saving ? t('Saving…') : t('Save zone')}
          </button>
        )}
      </div>
    </form>
  );
}
