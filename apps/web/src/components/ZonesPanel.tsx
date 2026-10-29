// Zones on the map: every zone of the site grouped by kind, with show/hide on this console and
// zoom to it, and for supervisors and administrators a new zone and reshaping an existing one.
import { useState } from 'react';
import { Eye, EyeOff, Focus, Octagon, Pencil, Plus, Search } from 'lucide-react';
import { GEOFENCE_KIND_LABEL, type Geofence, type GeofenceKind, type Point } from '@13store/shared';
import { can, currentUser } from '../domain/policy';
import { routeDraft, useRouteDraft, type ZoneMeta } from '../domain/routeDraft';
import { useHiddenZones, zoneVisibility } from '../domain/zoneVisibility';
import { GEOFENCE_COLOR } from '../lib/overlays';
import { useStore } from '../store';
import { useT } from '../i18n';

/** The order the groups are listed in: the site's own area first, then what blocks vehicles. */
const ORDER: GeofenceKind[] = ['operating_area', 'keep_out', 'no_fly', 'caution'];
/** Show the search box once the list gets long. */
const SEARCH_FROM = 7;

/** Open the editor on the map: a new zone, or an existing one to reshape. */
export function editZone(g?: Geofence) {
  const meta: ZoneMeta = g
    ? { id: g.id, name: g.name, kind: g.kind, appliesTo: [...g.appliesTo], reason: g.reason ?? '', active: g.active, mode: 'edit', shape: 'polygon' }
    : { name: '', kind: 'keep_out', appliesTo: ['ugv', 'uav'], reason: '', active: true, mode: 'draw', shape: 'polygon' };
  routeDraft.start({ purpose: 'geofence', deviceId: '', points: g ? g.poly : [], meta });
}

export function ZonesPanel({ onZoom }: { onZoom: (poly: Point[]) => void }) {
  const { s } = useStore();
  const t = useT();
  const canEdit = can(currentUser(s).role, 'site.geofences') && !s.replay.active;
  const hidden = useHiddenZones();
  const busy = useRouteDraft()?.state === 'drawing';
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const zones = s.geofences;
  const shown = zones.filter((g) => g.active && !hidden.has(g.id)).length;
  const query = q.trim().toLowerCase();
  const start = (g?: Geofence) => {
    editZone(g);
    setOpen(false);
    if (g) onZoom(g.poly);
  };

  return (
    <div className="zones">
      <button className="btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={t('Zones on this site')}>
        <Octagon size={16} /> {t('Zones')}{' '}
        <small className="muted">
          {shown}/{zones.length}
        </small>
      </button>
      {open && (
        <div className="pop zones-pop" role="dialog" aria-label={t('Zones on this site')}>
          <div className="zones-head">
            <b>{t('Zones on this site')}</b>
            {canEdit && (
              <button className="btn-secondary small" disabled={busy} onClick={() => start()}>
                <Plus size={14} /> {t('New zone')}
              </button>
            )}
          </div>
          {zones.length >= SEARCH_FROM && (
            <label className="zones-search">
              <Search size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search zones')} />
            </label>
          )}
          {zones.length === 0 && <p className="fine">{canEdit ? t('No zones yet. Press New zone, then click the corners on the map.') : t('No zones on this site yet.')}</p>}
          {ORDER.map((kind) => {
            const list = zones.filter((g) => g.kind === kind && (!query || g.name.toLowerCase().includes(query)));
            if (!list.length) return null;
            return (
              <section key={kind}>
                <h5>
                  <span className="swatch" style={{ background: GEOFENCE_COLOR[kind] }} /> {t(GEOFENCE_KIND_LABEL[kind])} <small className="muted">{list.length}</small>
                </h5>
                <ul>
                  {list.map((g) => {
                    const off = hidden.has(g.id);
                    return (
                      <li key={g.id} className={!g.active ? 'inactive' : off ? 'hidden' : undefined}>
                        <button
                          className="icon-btn"
                          onClick={() => zoneVisibility.toggle(g.id)}
                          title={off ? t('Show on my map') : t('Hide on my map')}
                          aria-label={off ? t('Show on my map') : t('Hide on my map')}
                          aria-pressed={!off}
                        >
                          {off ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        <span className="name" title={g.reason || g.name}>
                          {g.name}
                          {!g.active && <small className="tag">{t('Off')}</small>}
                        </span>
                        <small className="muted">{g.appliesTo.map((k) => k.toUpperCase()).join('/')}</small>
                        <button className="icon-btn" onClick={() => onZoom(g.poly)} title={t('Zoom to')} aria-label={t('Zoom to')}>
                          <Focus size={14} />
                        </button>
                        {canEdit && (
                          <button className="icon-btn" disabled={busy} onClick={() => start(g)} title={t('Edit')} aria-label={t('Edit')}>
                            <Pencil size={14} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          <p className="fine">{t('The eye hides a zone on this screen only. Switching a zone off in its editor turns its rules off for everyone.')}</p>
        </div>
      )}
    </div>
  );
}
