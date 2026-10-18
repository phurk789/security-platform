// Device panel (ROBOTICS COMMAND layout): header with the control row, then Live Feed /
// Telemetry / Equipment / Mission tabs. Equipment lists the parts the adapter declared with
// their interface status; a TESTING device shows "Interface verification pending" until every
// part has answered on real hardware.
import { useState } from 'react';
import { Battery, Boxes, Camera, Cpu, Gamepad2, Hand, ListChecks, Navigation, Package, Radio, RotateCcw, Satellite, ScanLine, ShieldAlert, Video, Wifi, X } from 'lucide-react';
import {
  BUILDINGS,
  COMPONENT_KIND_LABEL,
  COMPONENT_STATUS_LABEL,
  VEHICLE_CATALOG,
  cameraComponents,
  componentSummary,
  floorPlan,
  roomAt,
  verificationPending,
  type ComponentKind,
  type Device,
  type DeviceComponent,
  type Mission,
} from '@13store/shared';
import { ageMs, can, currentUser, fmtTime, freshness, userName } from '../domain/policy';
import { isTerminal } from '../domain/reducer';
import { ago, useT, type T } from '../i18n';
import { useStore } from '../store';
import { VehicleSpecs } from '../views/CommandCenter';
import { Badge, CommandBadge, FreshBadge, IntegrationBadge, MissionBadge } from './Badges';
import { CameraFeed } from './CameraFeed';
import { LiveMission } from './IncidentPanel';
import { TelemetryPanel } from './TelemetryPanel';
import { LatLon } from './LatLon';
import './device.css';

type Tab = 'feed' | 'telemetry' | 'equipment' | 'mission';

const KIND_ICON: Record<ComponentKind, typeof Cpu> = {
  flight_controller: Cpu,
  computer: Cpu,
  camera: Camera,
  gimbal: RotateCcw,
  radio: Radio,
  remote: Gamepad2,
  gnss: Satellite,
  lidar: ScanLine,
  battery: Battery,
  payload: Package,
  network: Wifi,
  other: Boxes,
};

export function DevicePanel({ d }: { d: Device }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const me = currentUser(s);
  const f = freshness(s, d);
  const hasCamera = d.kind === 'cctv' || d.capabilities.includes('camera');
  const tabs: Tab[] = [...(hasCamera ? (['feed'] as Tab[]) : []), 'telemetry', 'equipment', ...(d.kind !== 'cctv' ? (['mission'] as Tab[]) : [])];
  const [tab, setTab] = useState<Tab>(tabs[0]);
  const active = tabs.includes(tab) ? tab : tabs[0];
  const remote = d.components?.find((c) => c.kind === 'remote');
  const holder = d.controlOwner;
  const canTake = !!holder && holder !== me.id && can(me.role, 'control.handover') && !s.replay.active;
  const sum = componentSummary(d.components);
  const cat = d.catalogId ? VEHICLE_CATALOG[d.catalogId] : undefined;
  const TAB_LABEL: Record<Tab, string> = { feed: t('Live feed'), telemetry: t('Telemetry'), equipment: t('Equipment'), mission: t('Mission') };

  return (
    <aside className="panel right device-panel">
      <div className="panel-head">
        <h2>{t('Device')}</h2>
        <button className="icon-btn" aria-label={t('Close device')} onClick={() => dispatch({ type: 'selectDevice', id: null })}>
          <X size={18} />
        </button>
      </div>
      <div className="inc-head">
        <div className="row gap">
          <span className="inc-big-id">{d.id}</span>
          <IntegrationBadge i={d.integration} />
          <FreshBadge f={f} age={ago(ageMs(s, d))} />
        </div>
        <h3>{cat ? cat.name : d.model}</h3>
        {cat && <div className="muted">{d.model}</div>}
        <div className="dp-control">
          <span className="dp-ctl-ico">
            <Gamepad2 size={16} />
          </span>
          <span className="dp-ctl-item">
            <small>{t('Control')}</small>
            <b>{remote ? remote.name : d.commands.length ? t('Platform commands') : t('View only')}</b>
          </span>
          <span className="dp-ctl-item">
            <small>{t('Operator')}</small>
            <b>{holder ? userName(s, holder) : '—'}</b>
          </span>
          {canTake && (
            <button className="btn-outline small" onClick={() => dispatch({ type: 'handover', deviceId: d.id, toUserId: me.id })} title={t('Take over control (logged)')}>
              <Hand size={13} /> {t('Change')}
            </button>
          )}
        </div>
      </div>
      <div className="dp-tabs" role="tablist">
        {tabs.map((k) => (
          <button key={k} role="tab" aria-selected={active === k} className={active === k ? 'on' : ''} onClick={() => setTab(k)}>
            {TAB_LABEL[k]}
            {k === 'equipment' && sum.pending + sum.fault + sum.offline > 0 && <i className={`dp-dot ${sum.fault + sum.offline ? 'bad' : 'warn'}`} />}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {active === 'feed' && <FeedTab d={d} />}
        {active === 'telemetry' && <TelemetryTab d={d} />}
        {active === 'equipment' && <EquipmentTab d={d} />}
        {active === 'mission' && <MissionTab d={d} />}
      </div>
    </aside>
  );
}

function FeedTab({ d }: { d: Device }) {
  const { s } = useStore();
  const t = useT();
  const f = freshness(s, d);
  const cams = cameraComponents(d);
  const [idx, setIdx] = useState(0);
  const cam: DeviceComponent | undefined = cams[Math.min(idx, Math.max(0, cams.length - 1))];
  const facing = cam?.facing ?? 'front';
  const short = (c: DeviceComponent) => c.name.replace(/^SIYI\s+/, '').replace(/\s*\(.*$/, '');
  return (
    <section className="step">
      {cams.length > 1 && (
        <div className="dp-cams" role="tablist" aria-label={t('Cameras')}>
          {cams.map((c, i) => (
            <button key={c.id} role="tab" aria-selected={i === idx} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>
              <Video size={13} /> {short(c)}
              <small>{c.facing ? t(c.facing) : ''}</small>
            </button>
          ))}
        </div>
      )}
      <div className="feed-wrap flush">
        {d.kind === 'cctv' ? (
          <CameraFeed scene={d.view ?? 'plaza'} label={d.id} time={f === 'live' ? s.now : d.lastSeen} freshness={f} replay={s.replay.active} controls />
        ) : (
          <CameraFeed
            key={facing}
            scene="ugv"
            label={t('{id} onboard', { id: d.id })}
            deviceId={d.id}
            time={f === 'live' ? s.now : d.lastSeen}
            freshness={f}
            replay={s.replay.active}
            controls={facing === 'front'}
            facing={facing}
          />
        )}
      </div>
      {cam && (
        <p className="dp-caption">
          <Camera size={12} /> {cam.name}
          {cam.version ? ` · ${cam.version}` : ''} · <EqStatus st={cam.status} short />
        </p>
      )}
      {!cams.length && <p className="fine">{t('No camera declared by the adapter; the picture comes from the device model.')}</p>}
      {d.analytics && (
        <p className={`dp-caption${d.analytics.running ? '' : ' dim'}`}>
          <ScanLine size={12} /> {t('Analytics')} · {d.analytics.provider}
          {d.analytics.model ? ` · ${d.analytics.model.split(/[\\/]/).pop()}` : ''}
          {d.analytics.detectors ? ` · ${Object.keys(d.analytics.detectors).join(', ')}` : ''}
          {d.analytics.fps !== undefined ? ` · ${d.analytics.fps} fps` : ''}
          {d.analytics.detections !== undefined ? ` · ${t('{n} detections', { n: d.analytics.detections })}` : ''}
          {d.analytics.lastError ? ` · ${d.analytics.lastError}` : ''}
          {!d.analytics.running ? ` · ${t('stopped')}` : ''}
        </p>
      )}
    </section>
  );
}

function TelemetryTab({ d }: { d: Device }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const f = freshness(s, d);
  const known = f !== 'offline';
  return (
    <section className="step">
      <dl className="meta">
        <div>
          <dt>{t('Zone')}</dt>
          <dd>{d.zone}</dd>
        </div>
        <div>
          <dt>{t('Position')}</dt>
          <dd>
            {d.pos.x.toFixed(0)}, {d.pos.y.toFixed(0)} m ± {d.accuracyM} m
            <br />
            <LatLon p={d.pos} />
          </dd>
        </div>
        {d.indoor && (
          <div>
            <dt>{t('Indoor')}</dt>
            <dd>
              {t(BUILDINGS.find((b) => b.id === d.indoor!.buildingId)?.name ?? d.indoor.buildingId)} · {t('Level {n}', { n: d.indoor.level })}
              {d.indoor.positioning && d.indoor.positioning !== 'fixed' ? ` · ${{ slam: t('LiDAR SLAM'), uwb: 'UWB', vision: t('visual SLAM') }[d.indoor.positioning]}` : ''}
              {(() => {
                const r = roomAt(
                  floorPlan(d.indoor.buildingId, d.indoor.level) ?? { walls: [], rooms: [], doors: [], noGo: [], patrolRoute: [], buildingId: '', level: 0, name: '' },
                  d.pos,
                );
                const aisle = r?.name.match(/^Aisle (\w)$/)?.[1];
                return r ? ` · ${aisle ? t('Aisle {x}', { x: aisle }) : t(r.name.replace(/ \d+\.\d+$/, ''))}` : '';
              })()}{' '}
              <button className="link" onClick={() => dispatch({ type: 'setIndoor', view: { buildingId: d.indoor!.buildingId, level: d.indoor!.level } })}>
                {t('Floor plan')}
              </button>
            </dd>
          </div>
        )}
        {d.alt !== undefined && (
          <div>
            <dt>{t('Altitude')}</dt>
            <dd>{t('{alt} m (site datum, simulated)', { alt: d.alt })}</dd>
          </div>
        )}
        {d.battery !== undefined && (
          <div>
            <dt>{t('Battery')}</dt>
            <dd>{known ? `${Math.round(d.battery)}%` : '—'}</dd>
          </div>
        )}
        {d.kind !== 'cctv' && (
          <div>
            <dt>{t('Speed')}</dt>
            <dd>{known ? `${d.speed.toFixed(1)} m/s` : '—'}</dd>
          </div>
        )}
        {d.heading !== undefined && (
          <div>
            <dt>{t('Heading')}</dt>
            <dd>{known ? `${Math.round(d.heading)}°` : '—'}</dd>
          </div>
        )}
        {d.signal !== undefined && (
          <div>
            <dt>{t('Link')}</dt>
            <dd>{known ? `${Math.round(d.signal)}%` : '—'}</dd>
          </div>
        )}
        {d.satellites !== undefined && (
          <div>
            <dt>GNSS</dt>
            <dd>{known ? t('{n} satellites', { n: d.satellites }) : '—'}</dd>
          </div>
        )}
        {d.latencyMs !== undefined && (
          <div>
            <dt>{t('Latency')}</dt>
            <dd>{known ? `${Math.round(d.latencyMs)} ms` : '—'}</dd>
          </div>
        )}
        {d.temperatureC !== undefined && (
          <div>
            <dt>{t('Temperature')}</dt>
            <dd>{known ? `${Math.round(d.temperatureC)} °C` : '—'}</dd>
          </div>
        )}
        {d.gimbal && (
          <div>
            <dt>{t('Gimbal')}</dt>
            <dd>
              {Math.round(d.gimbal.yaw)}° / {Math.round(d.gimbal.pitch)}° · {(d.gimbal.zoom ?? 1).toFixed(1)}×
            </dd>
          </div>
        )}
        <div>
          <dt>{t('Telemetry rate')}</dt>
          <dd>
            {(1000 / d.rateMs).toFixed(d.rateMs >= 1000 ? 0 : 1)} Hz · {t('last {ago}', { ago: ago(ageMs(s, d)) })}
          </dd>
        </div>
      </dl>
      {d.kind !== 'cctv' && <TelemetryPanel deviceId={d.id} />}
      <p className="muted">{d.limitations}</p>
    </section>
  );
}

function EquipmentTab({ d }: { d: Device }) {
  const t = useT();
  const cs = d.components ?? [];
  const sum = componentSummary(cs);
  const pending = verificationPending(d);
  return (
    <>
      <section className="step">
        {pending ? (
          <p className="banner warn">
            <ShieldAlert size={15} /> <b>{t('Interface verification pending')}</b>
            <span>
              {t('{n} of {total} parts have not answered on real hardware yet. Adapter {adapter}; firmware tested: {fw}.', {
                n: sum.pending,
                total: sum.total,
                adapter: d.adapterVersion,
                fw: d.firmwareTested,
              })}
            </span>
          </p>
        ) : d.integration === 'simulated' ? (
          <p className="banner info">{t('Simulated device: parts are listed from the catalogue; versions are placeholders, not read from hardware.')}</p>
        ) : (
          <p className="banner info">
            {t('All declared parts have answered. Adapter {adapter} · protocol tested with firmware {fw}.', { adapter: d.adapterVersion, fw: d.firmwareTested })}
          </p>
        )}
        {cs.length ? (
          <ul className="eq-list">
            {cs.map((c) => {
              const I = KIND_ICON[c.kind] ?? Boxes;
              return (
                <li key={c.id} className={`eq-row s-${c.status}`}>
                  <span className="eq-ico">
                    <I size={15} />
                  </span>
                  <span className="eq-txt">
                    <b>{c.name}</b>
                    <small>
                      {t(COMPONENT_KIND_LABEL[c.kind])}
                      {c.version ? (
                        <>
                          {' '}
                          · <span className="mono">{c.version}</span>
                        </>
                      ) : null}
                      {c.detail ? ` · ${t(c.detail)}` : ''}
                    </small>
                  </span>
                  <EqStatus st={c.status} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">{t('The adapter has not declared any parts.')}</p>
        )}
        <dl className="meta">
          <div>
            <dt>{t('Adapter')}</dt>
            <dd>{d.adapterVersion}</dd>
          </div>
          <div>
            <dt>{t('Firmware tested')}</dt>
            <dd>{d.firmwareTested}</dd>
          </div>
          <div>
            <dt>{t('Commands')}</dt>
            <dd>{d.commands.length ? d.commands.join(', ') : t('none (view only)')}</dd>
          </div>
          <div>
            <dt>{t('Capabilities')}</dt>
            <dd>{d.capabilities.join(', ')}</dd>
          </div>
        </dl>
      </section>
      {d.catalogId && VEHICLE_CATALOG[d.catalogId] && (
        <section className="step">
          <h4>{t('Catalogue specifications')}</h4>
          <VehicleSpecs d={d} />
        </section>
      )}
    </>
  );
}

export function EqStatus({ st, short }: { st: DeviceComponent['status']; short?: boolean }) {
  const t = useT();
  const tone = st === 'ok' ? 'green' : st === 'warn' || st === 'pending' ? 'amber' : st === 'fault' || st === 'offline' ? 'red' : 'grey';
  return <Badge tone={tone}>{short && st === 'pending' ? t('PENDING') : t(COMPONENT_STATUS_LABEL[st])}</Badge>;
}

const STEPS: { key: string; label: string }[] = [
  { key: 'received', label: 'Received' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'inspecting', label: 'Inspecting' },
  { key: 'review', label: 'Review' },
];

/** Which of the four mission steps is reached: 0 none … 4 all. */
export function missionStep(m: Mission | undefined) {
  if (!m) return 0;
  if (m.status === 'completed') return 4;
  if (['executing', 'paused'].includes(m.status)) return 3;
  if (['approved', 'assigned'].includes(m.status)) return 2;
  if (['cancelled', 'rejected'].includes(m.status)) return 1;
  return 1;
}

function stepTimes(s: ReturnType<typeof useStore>['s'], m: Mission | undefined, t: T) {
  if (!m) return ['', '', '', ''];
  const ev = s.timeline.filter((e) => e.incidentId === m.incidentId);
  const at = (re: RegExp) => ev.find((e) => re.test(e.title))?.at;
  return [
    fmtTime(m.createdAt, true),
    at(/Mission approved/) ? fmtTime(at(/Mission approved/)!, true) : '',
    at(/started/) ? fmtTime(at(/started/)!, true) : '',
    m.status === 'completed' ? t('Evidence ready') : '',
  ];
}

function MissionTab({ d }: { d: Device }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const live = s.missions.find((x) => x.deviceId === d.id && ['approved', 'assigned', 'executing', 'paused'].includes(x.status));
  const last = live ?? [...s.missions].reverse().find((x) => x.deviceId === d.id);
  const step = missionStep(last);
  const times = stepTimes(s, last, t);
  const cmds = s.commands
    .filter((c) => c.deviceId === d.id)
    .slice(-5)
    .reverse();
  return (
    <>
      <section className="step">
        <div className="row between">
          <h4>{last ? `${t('Mission')} ${last.id}` : t('No mission')}</h4>
          {last && <MissionBadge status={last.status} />}
        </div>
        <ol className="dp-steps">
          {STEPS.map((st, i) => (
            <li key={st.key} className={i + 1 < step ? 'done' : i + 1 === step ? 'on' : ''}>
              <span className="dp-step-dot">{i + 1 < step ? <ListChecks size={12} /> : i + 1}</span>
              <b>{t(st.label)}</b>
              <small>{times[i] || (i + 1 === step ? t('now') : '—')}</small>
            </li>
          ))}
        </ol>
        {last && (
          <p className="fine">
            <Navigation size={12} /> {t('Incident {id} · {n} checkpoints · plan v{v}', { id: last.incidentId, n: last.checkpoints.length, v: last.planVersion })}{' '}
            <button className="link" onClick={() => dispatch({ type: 'selectIncident', id: last.incidentId })}>
              {t('Open incident')}
            </button>
          </p>
        )}
        {!last && <p className="muted">{t('Plan a mission from an incident: verify it, then choose this vehicle in the planner.')}</p>}
      </section>
      {live && ['assigned', 'executing', 'paused'].includes(live.status) && <LiveMission m={live} />}
      {cmds.length > 0 && (
        <section className="step">
          <h4>{t('Recent commands')}</h4>
          <ul className="cmds">
            {cmds.map((c) => (
              <li key={c.id}>
                <div className="row between">
                  <b>{c.type}</b>
                  <CommandBadge status={c.status} />
                </div>
                <small className="muted">
                  {fmtTime(c.issuedAt, true)} · {isTerminal(c) ? t('final') : t('in progress')}
                  {c.detail ? ` · ${c.detail}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
