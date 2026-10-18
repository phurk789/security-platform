// Glass info card anchored in the 3D twin to the selected building, device or incident, with a
// leader line to the object (CityOS-style). Rendered through a portal into the world's callout
// element; CSS2DRenderer keeps the anchor on the object every frame.
import { Building2, Cctv, Drone, TriangleAlert, Truck } from 'lucide-react';
import { BUILDINGS, VEHICLE_CATALOG, atBuilding, fmtSitePoint, type Building, type Device, type Incident } from '@13store/shared';
import { ageMs, freshness } from '../domain/policy';
import { age, useT } from '../i18n';
import { useStore } from '../store';
import { importedBuildings } from '../twin/world';
import { IncidentBadge } from './Badges';

export function TwinCallout() {
  const { s } = useStore();
  const b = s.selectedBuildingId ? BUILDINGS.find((x) => x.id === s.selectedBuildingId) : undefined;
  if (b) return <BuildingCallout b={b} />;
  const d = s.selectedDeviceId ? s.devices[s.selectedDeviceId] : undefined;
  if (d) return <DeviceCallout d={d} />;
  const i = s.incidents.find((x) => x.id === s.selectedIncidentId);
  if (i) return <IncidentCallout i={i} />;
  return null;
}

function Card({
  icon,
  title,
  sub,
  tone,
  status,
  rows,
  foot,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  tone: 'ok' | 'warn' | 'bad' | 'info';
  status: React.ReactNode;
  rows: [string, React.ReactNode][];
  foot?: React.ReactNode;
}) {
  return (
    <>
      <svg className="co-lead" width="34" height="38" viewBox="0 0 34 38" aria-hidden>
        <line x1="1" y1="37" x2="33" y2="1" />
      </svg>
      <span className="co-dot" />
      <div className={`co-card t-${tone}`}>
        <header>
          <span className="co-ico">{icon}</span>
          <div className="co-title">
            <b>{title}</b>
            {sub && <small>{sub}</small>}
          </div>
        </header>
        <div className={`co-status s-${tone}`}>
          <i />
          {status}
        </div>
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {foot}
      </div>
    </>
  );
}

function BuildingCallout({ b }: { b: Building }) {
  const { s } = useStore();
  const t = useT();
  const cx = b.x + b.w / 2;
  const cy = b.y + b.d / 2;
  const open = s.incidents.filter((i) => atBuilding(b, i.pos) && !['closed', 'duplicate', 'dismissed'].includes(i.status));
  const cams = Object.values(s.devices).filter((d) => d.kind === 'cctv' && Math.hypot(d.pos.x - cx, d.pos.y - cy) < 120);
  const camsLive = cams.filter((d) => freshness(s, d) === 'live').length;
  const indoor = Object.values(s.devices).filter((d) => d.indoor?.buildingId === b.id).length;
  return (
    <Card
      icon={<Building2 size={16} />}
      title={t(b.name)}
      sub={`${b.id} · ${t(b.use)}`}
      tone={open.length ? 'warn' : 'ok'}
      status={open.length ? t('{n} open incident(s)', { n: open.length }) : t('System nominal')}
      rows={[
        [t('Occupancy'), `${b.bim.occupancy.toLocaleString()} ${t('people')}`],
        [t('Levels'), `${b.bim.levels}${b.bim.basementLevels ? ` + ${b.bim.basementLevels}B` : ''} · ${b.h} m`],
        [t('Cameras'), `${camsLive}/${cams.length} ${t('online')}`],
        [t('Devices inside'), String(indoor)],
      ]}
      foot={
        <span className="co-foot">
          {importedBuildings.has(b.id) ? 'BIM MODEL' : t('FOOTPRINT MODEL')} · {b.bim.gfaM2.toLocaleString()} m²
        </span>
      }
    />
  );
}

function DeviceCallout({ d }: { d: Device }) {
  const { s } = useStore();
  const t = useT();
  const f = freshness(s, d);
  const m = s.missions.find((x) => x.deviceId === d.id && ['approved', 'assigned', 'executing', 'paused'].includes(x.status));
  const Icon = d.kind === 'uav' ? Drone : d.kind === 'cctv' ? Cctv : Truck;
  const tone = f === 'live' ? (m ? 'info' : 'ok') : f === 'stale' ? 'warn' : 'bad';
  const state =
    f === 'offline'
      ? `OFFLINE · ${age(ageMs(s, d))}`
      : f === 'stale'
        ? `STALE · ${age(ageMs(s, d))}`
        : m
          ? t('On mission {id}', { id: m.id })
          : s.sim?.[d.id]?.floorPatrol
            ? t('On floor patrol')
            : d.commands.length
              ? t('Standby')
              : t('Display only');
  const cat = d.catalogId ? VEHICLE_CATALOG[d.catalogId] : undefined;
  const rows: [string, React.ReactNode][] =
    d.kind === 'cctv'
      ? [
          [t('Zone'), d.zone],
          [t('Type'), d.capabilities.includes('gimbal') ? 'PTZ' : t('fixed')],
          [t('Pointing'), d.gimbal ? `${Math.round(d.gimbal.yaw)}° / ${Math.round(d.gimbal.pitch)}° · ${(d.gimbal.zoom ?? 1).toFixed(1)}×` : '—'],
          [t('Video'), d.stream ? 'LIVE' : d.integration === 'simulated' ? 'SIMULATED' : '—'],
        ]
      : [
          [t('Battery'), d.battery === undefined || f === 'offline' ? '—' : `${Math.round(d.battery)}%`],
          [d.kind === 'uav' ? t('Altitude') : t('Speed'), f === 'offline' ? '—' : d.kind === 'uav' ? `${(d.alt ?? 0).toFixed(0)} m` : `${d.speed.toFixed(1)} m/s`],
          [t('Link'), d.signal === undefined || f === 'offline' ? '—' : `${Math.round(d.signal)}%`],
          [
            t('Position'),
            d.indoor
              ? `${t(BUILDINGS.find((b) => b.id === d.indoor!.buildingId)?.name ?? d.indoor.buildingId)} L${d.indoor.level}`
              : `${d.pos.x.toFixed(0)}, ${d.pos.y.toFixed(0)} m`,
          ],
          ...(d.indoor ? [] : [[t('Lat / Lon'), fmtSitePoint(s.geo, d.pos, 4)] as [string, string]]),
        ];
  return (
    <Card
      icon={<Icon size={16} />}
      title={d.id}
      sub={cat ? cat.name : d.model}
      tone={tone}
      status={state}
      rows={rows}
      foot={
        d.payloads?.length ? (
          <span className="co-foot">
            {t('Payload')}: {d.payloads.join(', ')}
          </span>
        ) : undefined
      }
    />
  );
}

function IncidentCallout({ i }: { i: Incident }) {
  const { s } = useStore();
  const t = useT();
  const m = s.missions.find((x) => x.incidentId === i.id && !['cancelled', 'rejected', 'completed'].includes(x.status));
  const tone = i.status === 'new' || i.status === 'triaging' ? 'warn' : i.severity === 'high' ? 'bad' : 'info';
  return (
    <Card
      icon={<TriangleAlert size={16} />}
      title={i.id}
      sub={i.title}
      tone={tone}
      status={<IncidentBadge status={i.status} />}
      rows={[
        [t('Where'), `${i.zone} · ${t(i.place)}`],
        [t('Source'), i.source],
        [t('Camera'), i.cameraId ?? '—'],
        [t('Age'), age(Math.max(0, (s.replay.active ? s.replay.at : s.now) - i.createdAt))],
      ]}
      foot={
        m ? (
          <span className="co-foot">
            {t('Mission')} {m.id} · {m.deviceId}
          </span>
        ) : undefined
      }
    />
  );
}
