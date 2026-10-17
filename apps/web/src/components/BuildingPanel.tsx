// Building panel: BIM / facility-register data for a building picked on the map — levels,
// entrances and fire exits, systems, cameras that can see it, open incidents there.
import { Building2, Cctv, Crosshair, DoorOpen, Droplets, Flame, X } from 'lucide-react';
import { BUILDINGS, atBuilding, pickCamera, type Building, type Point } from '@13store/shared';
import { can, currentUser, freshness } from '../domain/policy';
import { useT } from '../i18n';
import { useStore } from '../store';
import { importedBuildings } from '../twin/world';
import { Badge, FreshBadge, IncidentBadge } from './Badges';
import './building.css';

const KIND: Record<Building['bim']['entrances'][number]['kind'], string> = { main: 'Main entrance', service: 'Service entrance', fire: 'Fire exit' };

export function BuildingPanel({ b }: { b: Building }) {
  const { s, dispatch, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.d / 2;
  const cams = Object.values(s.devices)
    .filter((d) => d.kind === 'cctv')
    .map((d) => ({ d, dist: Math.hypot(d.pos.x - cx, d.pos.y - cy) }))
    .filter((c) => c.dist < 120)
    .sort((a, c) => a.dist - c.dist);
  const incs = s.incidents.filter((i) => atBuilding(b, i.pos) && !['closed', 'duplicate', 'dismissed'].includes(i.status));
  const canAim = can(me.role, 'camera.control') && !s.replay.active;
  const imported = importedBuildings.has(b.id);

  const aim = (p: Point) => {
    const pick = pickCamera(Object.values(s.devices), p, BUILDINGS, (d) => freshness(s, d) !== 'offline');
    if (!pick) return dispatch({ type: 'toast', tone: 'warn', text: t('No camera can see that point.') });
    if (session) void session.aimCamera(pick.device.id, p).then((r) => dispatch({ type: 'toast', tone: r.ok ? 'ok' : 'warn', text: `${pick.device.id}: ${r.detail}` }));
    else dispatch({ type: 'aimCamera', deviceId: pick.device.id, target: p });
  };

  return (
    <aside className="panel right">
      <div className="panel-head">
        <h2>{t('Building')}</h2>
        <button className="icon-btn" aria-label={t('Close building')} onClick={() => dispatch({ type: 'selectBuilding', id: null })}><X size={18} /></button>
      </div>
      <div className="inc-head">
        <div className="row gap">
          <span className="inc-big-id">{b.id}</span>
          <Badge tone={imported ? 'green' : 'grey'} title={imported ? t('3D model imported from BIM (glTF)') : t('3D model drawn from the footprint; import a BIM model to replace it')}>
            <Building2 size={13} /> {imported ? 'BIM MODEL' : t('FOOTPRINT MODEL')}
          </Badge>
        </div>
        <h3>{t(b.name)} · {t(b.use)}</h3>
        <div className="muted">{b.zone} · {t(b.bim.structure)}</div>
      </div>
      <div className="panel-body">
        <section className="step">
          <dl className="meta cols">
            <div><dt>{t('Levels')}</dt><dd>{b.bim.levels}{b.bim.basementLevels ? ` + ${b.bim.basementLevels} ${t('basement')}` : ''} · {b.bim.levelHeightM} m</dd></div>
            <div><dt>{t('Height')}</dt><dd>{b.h} m</dd></div>
            <div><dt>{t('Gross floor area')}</dt><dd>{b.bim.gfaM2.toLocaleString()} m²</dd></div>
            <div><dt>{t('Occupancy')}</dt><dd>{b.bim.occupancy.toLocaleString()} {t('people')}</dd></div>
            <div><dt>{t('Footprint')}</dt><dd>{b.w} × {b.d} m</dd></div>
            <div><dt>{t('Year built')}</dt><dd>{b.bim.yearBuilt ?? '—'}</dd></div>
          </dl>
        </section>

        <section className="step">
          <h4>{t('Entrances and exits')}</h4>
          <ul className="bld-list">
            {b.bim.entrances.map((e) => (
              <li key={e.id}>
                <span className={`bld-ico k-${e.kind}`}>{e.kind === 'fire' ? <Flame size={14} /> : <DoorOpen size={14} />}</span>
                <span className="bld-txt">
                  <b>{t(KIND[e.kind])}</b>
                  <small>{t(e.name)} · {e.x.toFixed(0)}, {e.y.toFixed(0)} m</small>
                </span>
                {canAim && (
                  <button className="link" onClick={() => aim({ x: e.x, y: e.y })} title={t('Point the nearest camera here')}>
                    <Crosshair size={13} /> {t('Camera')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="fine"><Droplets size={12} /> {t('{n} fire hydrants on the plan.', { n: b.bim.hydrants.length })}</p>
        </section>

        <section className="step">
          <h4>{t('Systems and assets')}</h4>
          <ul className="bld-assets">
            {b.bim.assets.map((a) => (
              <li key={a}>{t(a)}</li>
            ))}
          </ul>
        </section>

        <section className="step">
          <h4>{t('Cameras nearby')}</h4>
          {cams.length ? (
            <ul className="bld-list">
              {cams.map(({ d, dist }) => (
                <li key={d.id} className="click" onClick={() => dispatch({ type: 'selectDevice', id: d.id })}>
                  <span className="bld-ico"><Cctv size={14} /></span>
                  <span className="bld-txt">
                    <b>{d.id}</b>
                    <small>{Math.round(dist)} m · {d.capabilities.includes('gimbal') ? 'PTZ' : t('fixed')}</small>
                  </span>
                  <FreshBadge f={freshness(s, d)} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('None')}</p>
          )}
        </section>

        <section className="step">
          <h4>{t('Incidents here')}</h4>
          {incs.length ? (
            <ul className="bld-list">
              {incs.map((i) => (
                <li key={i.id} className="click" onClick={() => dispatch({ type: 'selectIncident', id: i.id })}>
                  <span className="bld-txt">
                    <b>{i.id}</b>
                    <small>{i.title}</small>
                  </span>
                  <IncidentBadge status={i.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('None open')}</p>
          )}
        </section>
      </div>
    </aside>
  );
}
