// Administration: the organisation's sites, which devices are on each, and moving a device to
// another site. A device moves only while offline; its gateway is then paired again at the new
// site (positions are converted with each site's own anchor). More than one site needs a licence.
import { useState } from 'react';
import { ArrowRightLeft, Check, MapPin, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { SiteRef } from '@13store/shared';
import { useStore } from '../store';
import { useT } from '../i18n';
import { nextSiteAccess, parseLatLon } from '../domain/sites';

/** The sites a user may see, as a small tick list. [] = every site. */
export function SiteAccess({ value, sites, onChange, id }: { value: string[]; sites: SiteRef[]; onChange: (ids: string[]) => void; id?: string }) {
  const t = useT();
  const all = sites.map((x) => x.id);
  const names = value.map((v) => sites.find((x) => x.id === v)?.name ?? v);
  return (
    <details className="site-access" id={id}>
      <summary>{value.length === 0 ? t('All sites') : names.join(', ')}</summary>
      <div className="site-access-menu">
        <label>
          <input type="checkbox" checked={value.length === 0} onChange={() => onChange(nextSiteAccess(value, all, 'all'))} /> {t('All sites')}
          <small className="muted"> {t('(also sites added later)')}</small>
        </label>
        {sites.map((x) => {
          const on = value.length === 0 || value.includes(x.id);
          return (
            <label key={x.id}>
              <input type="checkbox" checked={on} disabled={on && value.length === 1} onChange={() => onChange(nextSiteAccess(value, all, x.id))} /> {x.name}
            </label>
          );
        })}
      </div>
    </details>
  );
}

export function SitesCard({
  act,
  limit,
}: {
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  /** Sites the licence allows (undefined until the licence status has loaded). */
  limit?: number;
}) {
  const { s, session } = useStore();
  const t = useT();
  const api = session!.api;
  const sites: SiteRef[] = s.sites ?? [];
  const [name, setName] = useState('');
  const [where, setWhere] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const pos = parseLatLon(where);
  const done = async (fn: () => Promise<unknown>, ok: string) => {
    await act(fn, ok);
    await session!.refreshSites();
  };

  return (
    <section className="card sites-card">
      <h3>
        <MapPin size={16} /> {limit !== undefined && limit < 1000 ? t('Sites ({n} of {max})', { n: sites.length, max: limit }) : t('Sites ({n})', { n: sites.length })}
      </h3>
      <p className="fine" style={{ marginTop: 0 }}>
        {t('Each device belongs to one site. Move a device while it is offline, then pair its gateway again at the new site: positions are converted with each site’s own map anchor.')}
      </p>
      <ul className="list sites-list">
        {sites.map((x) => (
          <li key={x.id}>
            <div className="site-row">
              {renaming?.id === x.id ? (
                <form
                  className="row gap-s grow"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void done(() => api.patch(`/sites/${encodeURIComponent(x.id)}`, { name: renaming.name }), t('Site renamed.')).then(() => setRenaming(null));
                  }}
                >
                  <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: x.id, name: e.target.value })} aria-label={t('Site name')} maxLength={80} />
                  <button className="btn-primary small" disabled={!renaming.name.trim()} aria-label={t('Save')}>
                    <Check size={14} />
                  </button>
                  <button type="button" className="btn-ghost small" onClick={() => setRenaming(null)} aria-label={t('Cancel')}>
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <span className="grow">
                  <b>{x.name}</b> <span className="mono muted">{x.id}</span>
                  {x.id === s.site?.id && <small className="badge badge-blue">{t('On screen')}</small>}
                  {x.demo && <small className="badge badge-grey">{t('Demo plan')}</small>}
                </span>
              )}
              {renaming?.id !== x.id && (
                <span className="row gap-s">
                  {x.id !== s.site?.id && (
                    <button className="btn-ghost small" onClick={() => session!.switchSite(x.id)}>
                      {t('Open')}
                    </button>
                  )}
                  <button className="btn-ghost small" onClick={() => setRenaming({ id: x.id, name: x.name })} aria-label={t('Rename')} title={t('Rename')}>
                    <Pencil size={14} />
                  </button>
                  {sites.length > 1 && (
                    <button
                      className="btn-ghost small"
                      disabled={!!x.devices?.length}
                      title={x.devices?.length ? t('Move its devices first') : t('Remove')}
                      aria-label={t('Remove')}
                      onClick={() => done(() => api.del(`/sites/${encodeURIComponent(x.id)}`), t('{name} removed.', { name: x.name }))}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </span>
              )}
            </div>
            <div className="site-devices">
              {(x.devices ?? []).length === 0 && <small className="muted">{t('No devices yet.')}</small>}
              {(x.devices ?? []).map((id) => (
                <span key={id} className="site-device">
                  <span className="mono">{id}</span>
                  {sites.length > 1 && (
                    <label className="site-move" title={t('Move to another site')}>
                      <ArrowRightLeft size={12} />
                      <select
                        value=""
                        aria-label={t('Move {id} to', { id })}
                        onChange={(e) => {
                          const to = sites.find((y) => y.id === e.target.value);
                          if (to) void done(() => api.patch(`/devices/${encodeURIComponent(id)}/site`, { siteId: to.id }), t('{id} moved to {site}. Pair its gateway again there.', { id, site: to.name }));
                        }}
                      >
                        <option value="">{t('Move to…')}</option>
                        {sites
                          .filter((y) => y.id !== x.id)
                          .map((y) => (
                            <option key={y.id} value={y.id}>
                              {y.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pos) return;
          void done(() => api.post('/sites', { name: name.trim(), originLat: pos.lat, originLon: pos.lon, rotationDeg: 0 }), t('Site {name} added.', { name: name.trim() })).then(() => {
            setName('');
            setWhere('');
          });
        }}
      >
        <input placeholder={t('New site name, e.g. Event hall A')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <input placeholder={t('Anchor: latitude, longitude')} value={where} onChange={(e) => setWhere(e.target.value)} />
        <button className="btn-primary" disabled={!name.trim() || !pos}>
          <Plus size={16} /> {t('Add site')}
        </button>
      </form>
      <p className="fine">{t('The anchor is the north-west corner of the site, as latitude, longitude (copy it from Google Maps). Then open the site and draw its operating area on the map.')}</p>
      {limit !== undefined && sites.length >= limit && (
        <p className="fine warn-text">
          {t('The licence allows {n} sites and all are in use. For more, install a licence file with a higher site limit (see License below).', { n: limit })}
        </p>
      )}
    </section>
  );
}
