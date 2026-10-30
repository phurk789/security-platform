// The Command Centre's stage: one main view with a small inset view (picture in picture).
// Map first puts the system map in front with the camera in the corner and a strip of key
// numbers. The cockpit (ห้องบังคับ) puts the onboard camera in front with a driving HUD over it
// and the map in the corner, following the vehicle.
// Both views stay mounted in a fixed order, so swapping them never restarts the video stream
// or the map. Driving controls are NOT here: DrivePanel stays in the right column.
import { useState, type ReactNode } from 'react';
import { Activity, Battery, Camera, Gauge, History, MapPinned, Maximize2, Navigation, Radio, Signal, Thermometer, Timer, X, type LucideIcon } from 'lucide-react';
import { MISSION_BATTERY_HOLD_PCT, MISSION_BATTERY_WARN_PCT, checkpointLabel, dist, routeSpeedOf, type Device, type Mission } from '@13store/shared';
import { fmtTime, freshness } from '../domain/policy';
import { displayNumber } from '../domain/liquidPresentation';
import { ago, useT, type T } from '../i18n';
import { useStore } from '../store';
import { FreshBadge, ModeBadge } from '../components/Badges';
import { CameraFeed } from '../components/CameraFeed';
import { MainMap } from '../components/MainMap';
import { TelemetryPanel } from '../components/TelemetryPanel';

export type StageFocus = 'map' | 'cockpit';

/** Distance (m) from the vehicle through the checkpoints it has still to reach. */
export function remaining(d: Device, m: Mission) {
  let total = 0;
  let from = d.pos;
  for (const cp of m.checkpoints.slice(m.nextCp)) {
    total += dist(from, cp);
    from = cp;
  }
  return total;
}

export function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function CockpitStage({ d, m, focus, onFocus, canViewMedia }: { d: Device; m?: Mission; focus: StageFocus; onFocus: (f: StageFocus) => void; canViewMedia: boolean }) {
  const { s } = useStore();
  const t = useT();
  const [graphs, setGraphs] = useState(false);
  const f = freshness(s, d);
  // Replay shows recorded values as they were; otherwise only live data is shown as a number.
  const usable = s.replay.active || f === 'live';
  const cockpit = canViewMedia && focus === 'cockpit';
  const toggleGraphs = () => setGraphs((g) => !g);
  return (
    <div className="lg-stage" data-focus={cockpit ? 'cockpit' : 'map'}>
      {/* Fixed order: map, then camera. Only classes change when the views swap. */}
      <div className={`lg-stage-map${cockpit ? ' is-pip' : ''}`}>
        <MainMap follow={cockpit ? d.id : undefined} />
        {!cockpit && (
          <div className="lg-map-label">
            <MapPinned size={16} />
            <div>
              <b>{t('Site map')}</b>
              <small>{t('{id} selected', { id: d.id })}</small>
            </div>
          </div>
        )}
        {cockpit && (
          <button type="button" className="lg-pip-hit" onClick={() => onFocus('map')} aria-label={t('Show the map large')} title={t('Show the map large')}>
            <span><MapPinned size={12} /> {t('Map')} <Maximize2 size={11} /></span>
          </button>
        )}
      </div>
      {canViewMedia && (
        <div className={`lg-stage-cam${cockpit ? '' : ' is-pip'}`} aria-label={t('Onboard camera')} role="region">
          <CameraFeed scene="ugv" label={t('{id} onboard', { id: d.id })} deviceId={d.id} time={f === 'live' ? s.now : d.lastSeen} freshness={f} replay={s.replay.active} />
          {!cockpit && (
            <button type="button" className="lg-pip-hit" onClick={() => onFocus('cockpit')} aria-label={t('Open the cockpit')} title={t('Open the cockpit')}>
              <span><Camera size={12} /> {t('Camera')} <Maximize2 size={11} /></span>
            </button>
          )}
        </div>
      )}

      {cockpit ? (
        <div className={`lg-hud${usable ? '' : ' is-nodata'}`} aria-label={t('Driving HUD')} role="group">
          <div className="lg-hud-tl">
            <div className="lg-hud-glass lg-hud-id">
              <b>{d.id}</b>
              <span className="lg-hud-badges">
                {s.replay.active ? <span className="badge badge-grey"><History size={11} /> REPLAY</span> : <FreshBadge f={f} />}
                <ModeBadge d={d} />
              </span>
            </div>
            <ControlMode d={d} m={m} usable={usable} />
          </div>
          <VTape value={usable ? d.speed : undefined} step={1} label="SPD" unit="m/s" side="left" />
          {d.kind === 'uav' && <VTape value={usable ? d.alt : undefined} step={5} label="ALT" unit="m" side="right" />}
          <HudBar d={d} usable={usable} items={['battery', 'gnss', 'link', 'latency', 'temp']} graphs={graphs} onGraphs={toggleGraphs} />
        </div>
      ) : (
        <div className="lg-hud lg-hud-map">
          <HudBar d={d} usable={usable} items={['speed', 'battery', 'gnss', 'link']} graphs={graphs} onGraphs={toggleGraphs} unit />
        </div>
      )}

      <div className="lg-stage-top">
        {cockpit && <HeadingTape heading={usable ? d.heading : undefined} />}
        <NoData d={d} />
        {cockpit && m && <MissionChip d={d} m={m} usable={usable} />}
      </div>

      {graphs && (
        <section className="lg-graphs" aria-label={t('Telemetry graphs')}>
          <div className="lg-graphs-head">
            <b><Activity size={15} /> {t('Last 60 s')} · {d.id}</b>
            <button type="button" className="lg-graphs-x" onClick={() => setGraphs(false)} aria-label={t('Close the graphs')} title={t('Close the graphs')}>
              <X size={15} />
            </button>
          </div>
          <TelemetryPanel deviceId={d.id} />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HUD parts
// ---------------------------------------------------------------------------

/** What is steering the vehicle (from the platform), and the autopilot's own mode and arming as it reports them. */
function ControlMode({ d, m, usable }: { d: Device; m?: Mission; usable: boolean }) {
  const t = useT();
  const [code, label, tone] = controlMode(d, m, usable, t);
  const board = d.flightMode !== undefined || d.armed !== undefined;
  return (
    <div className={`lg-hud-glass lg-hud-mode tone-${tone}`}>
      <b>{code}</b>
      <small>{label}</small>
      {board && (
        <span className="lg-hud-fc" title={t('As the autopilot reports it')}>
          {t('Autopilot')} {usable ? (d.flightMode ?? '—') : '—'}
          {usable && d.armed !== undefined && <em className={d.armed ? 'armed' : ''}>{d.armed ? 'ARMED' : 'DISARMED'}</em>}
        </span>
      )}
    </div>
  );
}

function controlMode(d: Device, m: Mission | undefined, usable: boolean, t: T): [string, string, 'auto' | 'hold' | 'manual' | 'idle'] {
  // A running or held route is the platform's own state, so it stays shown without vehicle data.
  if (m?.status === 'executing') return ['AUTO', t('Route running'), 'auto'];
  if (m?.status === 'paused') return ['HOLD', t('Holding'), 'hold'];
  // Otherwise do not claim the vehicle is ready or being driven when its data is not current.
  if (!usable) return ['—', t('No current data'), 'idle'];
  if (d.drivenBy) return ['DRIVE', t('Driven from the web'), 'manual'];
  if (d.commands.length) return ['STANDBY', t('Ready for commands'), 'idle'];
  return ['MONITOR', t('Watch only'), 'idle'];
}

type HudItem = 'speed' | 'battery' | 'gnss' | 'link' | 'latency' | 'temp';

function HudBar({ d, usable, items, graphs, onGraphs, unit }: { d: Device; usable: boolean; items: HudItem[]; graphs: boolean; onGraphs: () => void; unit?: boolean }) {
  const { s } = useStore();
  const t = useT();
  const val = (v: number | undefined, digits = 0, min = 0, max = Infinity) => displayNumber(usable ? v : undefined, digits, min, max);
  const bat = usable ? d.battery : undefined;
  const sig = usable ? d.signal : undefined;
  const stats: Record<HudItem, () => ReactNode> = {
    speed: () => <HudStat key="speed" Icon={Gauge} label={t('Speed')} value={val(d.speed, 1)} unit="m/s" />,
    battery: () => (
      <HudStat key="battery" Icon={Battery} label={t('Battery')} value={val(d.battery, 0, 0, 100)} unit="%"
        tone={bat === undefined ? undefined : bat <= MISSION_BATTERY_HOLD_PCT ? 'bad' : bat <= MISSION_BATTERY_WARN_PCT ? 'warn' : undefined} />
    ),
    gnss: () => (
      <HudStat key="gnss" Icon={Navigation} label="GNSS"
        value={usable && d.noFix ? t('No fix') : val(d.satellites)}
        unit={usable && d.noFix ? undefined : `${t('sats')}${usable ? ` ±${d.accuracyM.toFixed(1)} m` : ''}`}
        tone={!usable ? undefined : d.noFix ? 'bad' : (d.satellites ?? 99) < 8 || d.accuracyM > 2 ? 'warn' : undefined} />
    ),
    link: () => <HudStat key="link" Icon={Signal} label={t('Link')} value={val(d.signal, 0, 0, 100)} unit="%" tone={sig === undefined ? undefined : sig < 40 ? 'bad' : sig < 60 ? 'warn' : undefined} />,
    latency: () => <HudStat key="latency" Icon={Timer} label={t('Latency')} value={val(d.latencyMs)} unit="ms" tone={usable && (d.latencyMs ?? 0) > 250 ? 'warn' : undefined} />,
    temp: () =>
      d.temperatureC === undefined ? null : (
        <HudStat key="temp" Icon={Thermometer} label={d.kind === 'uav' ? t('Airframe temp') : t('Motor temp')} value={val(d.temperatureC, 1, -100)} unit="°C" tone={usable && d.temperatureC > 55 ? 'warn' : undefined} />
      ),
  };
  return (
    <div className="lg-hud-glass lg-hud-bar">
      {unit && (
        <span className="lg-hud-unit">
          <b>{d.id}</b>
          {s.replay.active ? <span className="badge badge-grey">REPLAY</span> : <FreshBadge f={freshness(s, d)} />}
        </span>
      )}
      {items.map((k) => stats[k]())}
      <button type="button" className={`lg-hud-btn${graphs ? ' on' : ''}`} aria-pressed={graphs} onClick={onGraphs} aria-label={t('Telemetry graphs')} title={t('Telemetry graphs')}>
        <Activity size={14} aria-hidden="true" /> {t('60 s')}
      </button>
    </div>
  );
}

function HudStat({ Icon, label, value, unit, tone }: { Icon: LucideIcon; label: string; value: string; unit?: string; tone?: 'warn' | 'bad' }) {
  return (
    <span className={`lg-hud-stat${tone ? ` is-${tone}` : ''}`} title={label}>
      <Icon size={15} aria-hidden="true" />
      <span className="lg-hud-k">{label}</span>
      <b>{value}</b>
      {unit && <small>{unit}</small>}
    </span>
  );
}

/** Checkpoint, distance left and ETA of the route being driven. */
function MissionChip({ d, m, usable }: { d: Device; m: Mission; usable: boolean }) {
  const t = useT();
  if (!['assigned', 'executing', 'paused'].includes(m.status) || !m.checkpoints.length) return null;
  const total = m.checkpoints.length;
  const next = Math.min(m.nextCp, total - 1);
  const left = usable ? remaining(d, m) : undefined;
  const moving = m.status === 'executing';
  // Live speed while moving, else the speed the vehicle drives routes at (its autopilot setting).
  const eta = moving && left !== undefined ? left / Math.max(d.speed > 0.5 ? d.speed : routeSpeedOf(d), 0.3) : undefined;
  return (
    <div className={`lg-hud-glass lg-hud-mission is-${m.status}`}>
      <b>{moving ? 'AUTO' : m.status === 'paused' ? 'HOLD' : t('Waiting to start')}</b>
      <span>{t('Checkpoint {n} of {total}', { n: checkpointLabel(m.checkpoints, next), total })}</span>
      <span>{t('{m} m left', { m: left === undefined ? '—' : Math.round(left) })}</span>
      <span>ETA {eta === undefined ? '—' : fmtDuration(eta)}</span>
    </div>
  );
}

/** A big banner when the vehicle's data is late or missing. Every value then shows as "—". */
function NoData({ d }: { d: Device }) {
  const { s } = useStore();
  const t = useT();
  if (s.replay.active) return null;
  const f = freshness(s, d);
  if (f === 'live') return null;
  const age = Math.max(0, s.now - d.lastSeen);
  return (
    <div className={`lg-nodata${f === 'offline' ? ' is-offline' : ''}`} role="status">
      <Radio size={20} aria-hidden="true" />
      <div>
        <b>{f === 'offline' ? t('No data from the vehicle') : t('Vehicle data is late')}</b>
        <span>
          {d.lastSeen > 0
            ? t('Last received {time} ({age}). Values show as —.', { time: fmtTime(d.lastSeen, true), age: ago(age) })
            : t('Nothing received from the vehicle yet. Values show as —.')}
        </span>
      </div>
    </div>
  );
}

/** Compass tape: ±48° across the tape, the heading in the box under the caret. */
function HeadingTape({ heading }: { heading?: number }) {
  const known = heading !== undefined && Number.isFinite(heading);
  const hdg = known ? ((heading % 360) + 360) % 360 : 0;
  const ticks = [];
  if (known) {
    for (let a = Math.ceil((hdg - 48) / 5) * 5; a <= hdg + 48; a += 5) {
      const x = 150 + (a - hdg) * 3;
      const n = ((a % 360) + 360) % 360;
      const major = n % 30 === 0;
      ticks.push(<line key={`h${a}`} x1={x} x2={x} y1={major ? 20 : 25} y2={31} className="t-tick" />);
      if (major)
        ticks.push(
          <text key={`l${a}`} x={x} y={15} className="t-lbl" textAnchor="middle">
            {({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[n] ?? String(n).padStart(3, '0')}
          </text>,
        );
    }
  }
  return (
    <div className="lg-hud-glass lg-tape-h">
      <svg viewBox="0 0 300 58" aria-hidden="true">
        <line x1={6} x2={294} y1={31} y2={31} className="t-tick" />
        {ticks}
        <path d="M144 39 L150 32 L156 39" className="t-caret" />
        <rect x={122} y={39} width={56} height={18} rx={5} className="t-box" />
        <text x={150} y={52.5} className="t-val" textAnchor="middle">
          {known ? `${String(Math.round(hdg) % 360).padStart(3, '0')}°` : '—'}
        </text>
      </svg>
    </div>
  );
}

/** Vertical tape (speed on the left, altitude on the right): ±5 steps around the value. */
function VTape({ value, step, label, unit, side }: { value?: number; step: number; label: string; unit: string; side: 'left' | 'right' }) {
  const known = value !== undefined && Number.isFinite(value);
  const C = 132;
  const px = 20 / step;
  const lineX = side === 'left' ? 70 : 18;
  const dir = side === 'left' ? -1 : 1;
  const marks = [];
  if (known) {
    for (let v = Math.ceil((value - 5 * step) / step) * step; v <= value + 5 * step; v += step) {
      if (v < 0) continue;
      const y = C - (v - value) * px;
      const major = Math.round(v / step) % 2 === 0;
      marks.push(<line key={`t${v}`} x1={lineX} x2={lineX + dir * (major ? 12 : 7)} y1={y} y2={y} className="t-tick" />);
      if (major)
        marks.push(
          <text key={`v${v}`} x={lineX + dir * 17} y={y + 4} className="t-lbl" textAnchor={side === 'left' ? 'end' : 'start'}>
            {Number(v.toFixed(1))}
          </text>,
        );
    }
  }
  const bx = side === 'left' ? 8 : 16;
  return (
    <div className={`lg-hud-glass lg-tape-v ${side}`}>
      <svg viewBox="0 0 88 252" aria-hidden="true">
        <text x={44} y={16} className="t-sm" textAnchor="middle">
          {label} {unit}
        </text>
        <line x1={lineX} x2={lineX} y1={30} y2={236} className="t-tick" />
        {marks}
        <rect x={bx} y={C - 13} width={64} height={26} rx={6} className="t-box" />
        <text x={bx + 32} y={C + 5.5} className="t-val big" textAnchor="middle">
          {known ? value.toFixed(1) : '—'}
        </text>
      </svg>
    </div>
  );
}
