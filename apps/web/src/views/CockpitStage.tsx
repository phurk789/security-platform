// The Command Centre's stage: one main view with a small inset view (picture in picture).
// Map first puts the system map in front with the camera in the corner and a strip of key
// numbers. The cockpit (ห้องบังคับ) puts the onboard camera in front with a thin, see-through
// HUD over it and the map in the corner, following the vehicle. When the vehicle is offline the
// HUD drops its instruments (they would all read "—") and one card in the middle says what is
// lost: the vehicle's data, its live picture, or both.
// Both views stay mounted in a fixed order, so swapping them never restarts the video stream
// or the map. Driving controls are NOT here: DrivePanel stays in the right column. The unit's
// name and badges are in the workspace header above the stage, so the HUD does not repeat them.
import { useState, type ReactNode } from 'react';
import { Activity, Battery, Camera, Gauge, LoaderCircle, MapPinned, Maximize2, Navigation, Radio, RotateCw, ScanEye, Signal, Thermometer, Timer, VideoOff, X, type LucideIcon } from 'lucide-react';
import { MISSION_BATTERY_HOLD_PCT, MISSION_BATTERY_WARN_PCT, checkpointLabel, dist, routeSpeedOf, type Device, type Mission } from '@13store/shared';
import { fmtTime, freshness } from '../domain/policy';
import { displayNumber } from '../domain/liquidPresentation';
import { ago, useT, type T } from '../i18n';
import { useStore } from '../store';
import { FreshBadge } from '../components/Badges';
import { CameraFeed } from '../components/CameraFeed';
import { MainMap } from '../components/MainMap';
import { TelemetryPanel } from '../components/TelemetryPanel';
import { AiSwitch } from '../components/AiSwitch';
import { useLiveTracks } from '../domain/visionTracks';
import { aiSources, aiWaiting } from '../domain/deviceAi';
import { useLiveVideo, type LiveVideoStatus } from '../domain/liveVideo';

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
  // The AI watching this vehicle's video: an AI box (switched on here), its own analytics, or camera AIs that follow it.
  const aiIds = aiSources(d, s.devices);
  // Offline: no data for a while, so the instruments go and the card says so. Late data is
  // usually back within seconds, so the instruments stay (reading "—") with a small note instead.
  const offline = !s.replay.active && f === 'offline';
  const late = !s.replay.active && f === 'stale';
  // The live picture's own state, from its player: lost, reconnecting, refused…
  const video = useLiveVideo(canViewMedia ? d.id : undefined);
  const card = cockpit && (offline || !!video?.message);
  return (
    <div className="lg-stage" data-focus={cockpit ? 'cockpit' : 'map'} data-card={card || undefined} data-offline={(cockpit && offline) || undefined}>
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
        // One grid, so the parts share the room and never land on each other on a short screen:
        // top = status chips (left), the compass line (centre), the map inset's room (right);
        // bottom = the big speed with the route beside it, then the light number chips.
        // The unit and its badges are in the header above the stage, so the HUD does not repeat them.
        <div className={`lg-hud${usable ? '' : ' is-nodata'}${offline ? ' is-offline' : ''}`} aria-label={t('Driving HUD')} role="group">
          <div className="lg-ck">
            <div className="lg-ck-chips">
              <ModeChips d={d} m={m} usable={usable} />
              <AiRow d={d} ids={aiIds} />
            </div>
            {!offline && (
              <div className="lg-ck-top">
                <HeadingLine heading={usable ? d.heading : undefined} />
                {late && <LateNote d={d} />}
              </div>
            )}
            {!offline && (
              <div className="lg-ck-speed">
                <BigNumber label={t('Speed')} value={usable ? d.speed : undefined} unit="m/s" />
                {d.kind === 'uav' && <BigNumber label={t('Altitude')} value={usable ? d.alt : undefined} unit="m" digits={0} />}
                {m && <MissionChip d={d} m={m} usable={usable} />}
              </div>
            )}
            {!offline && <HudBar d={d} usable={usable} items={['battery', 'gnss', 'link', 'latency', 'temp']} graphs={graphs} onGraphs={toggleGraphs} />}
          </div>
          {card && <StageCard d={d} offline={offline} video={video} onMap={() => onFocus('map')} />}
        </div>
      ) : (
        <>
          <div className="lg-hud lg-hud-map">
            <HudBar d={d} usable={usable} items={['speed', 'battery', 'gnss', 'link']} graphs={graphs} onGraphs={toggleGraphs} unit />
          </div>
          <div className="lg-stage-top">
            <NoData d={d} />
          </div>
        </>
      )}

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

/**
 * What is steering the vehicle (from the platform), then the autopilot's own mode and arming as it
 * reports them, as small chips. Nothing is claimed without current data, except a running or held
 * route, which is the platform's own state.
 */
function ModeChips({ d, m, usable }: { d: Device; m?: Mission; usable: boolean }) {
  const t = useT();
  const [code, label, tone] = controlMode(d, m, usable, t);
  const board = usable && (d.flightMode !== undefined || d.armed !== undefined);
  return (
    <>
      {code !== '—' && (
        <span className={`lg-chip lg-chip-mode tone-${tone}`}>
          <i aria-hidden="true" />
          <b>{code}</b>
          <small>{label}</small>
        </span>
      )}
      {board && (
        <span className="lg-chip lg-chip-fc" title={t('As the autopilot reports it')}>
          <small>{t('Autopilot')}</small>
          <b>{d.flightMode ?? '—'}</b>
          {d.armed !== undefined && <em className={d.armed ? 'armed' : ''}>{d.armed ? 'ARMED' : 'DISARMED'}</em>}
        </span>
      )}
    </>
  );
}

/**
 * The AI at a glance, with its switch on the same row: who it sees now, that it is watching, that it
 * gets no pictures, why it has not started, or that it is off.
 */
function AiRow({ d, ids }: { d: Device; ids: string[] }) {
  const { s, session } = useStore();
  const t = useT();
  const live = useLiveTracks(ids);
  // The switch needs the server (not the offline demo) and live time (not replay).
  const canSwitch = !!session && !s.replay.active;
  if (!ids.length && !canSwitch) return null;
  const off = !ids.length && !d.ai?.on;
  // Switched on, but no AI box has it yet: say why instead of "no pictures".
  const waiting = aiWaiting(d);
  const ai = ids.map((id) => s.devices[id]).filter((x): x is Device => !!x);
  // A camera AI reports in every few seconds; it gets frames while its signal is up.
  const watching = ai.some((x) => freshness(s, x) === 'live' && (x.signal ?? 0) > 0 && x.analytics?.running !== false);
  const fps = ai.find((x) => x.analytics?.fps)?.analytics?.fps;
  // Frames can keep coming while the model fails (its service down, its runtime missing): say so.
  const modelError = ai
    .flatMap((x) => Object.values(x.analytics?.detectors ?? {}))
    .map((v) => (v && typeof v === 'object' ? (v as { error?: unknown }).error : undefined))
    .find((e): e is string => typeof e === 'string' && !!e);
  const intruders = live?.boxes.filter((b) => b.type === 'intrusion').length ?? 0;
  const people = live?.boxes.filter((b) => b.type === 'person' || b.type === 'loitering').length ?? 0;
  // The nearest person, when the camera's ranging gives distances.
  const nearest = (live?.boxes ?? []).reduce<number | undefined>((m, b) => (b.distM !== undefined && b.type !== 'vehicle' && (m === undefined || b.distM < m) ? b.distM : m), undefined);
  const [tone, text] =
    intruders > 0
      ? ['bad', t('Intruders: {n}', { n: intruders })]
      : people > 0
        ? ['warn', t('People in view: {n}', { n: people })]
        : waiting
          ? ['idle', t(waiting)]
          : off
            ? ['idle', t('Off')]
            : watching && modelError
              ? ['idle', t('AI model not answering')]
              : watching
                ? ['ok', t('AI is watching')]
                : ['idle', t('AI gets no pictures')];
  return (
    <div className={`lg-chip lg-hud-ai tone-${tone}`} title={modelError ?? (ai.map((x) => x.analytics?.model ?? x.model).join(' · ') || undefined)}>
      <ScanEye size={15} aria-hidden="true" />
      <b>AI</b>
      <span>{text}</span>
      {nearest !== undefined && (intruders > 0 || people > 0) && <em className="lg-hud-ai-dist">{t('≈ {m} m', { m: nearest })}</em>}
      {watching && fps ? <small>{fps.toFixed(1)} fps</small> : null}
      <AiSwitch d={d} hud />
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
    <div className={`lg-chip lg-hud-mission is-${m.status}`}>
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

/** Data a few seconds late: a small note under the compass, with how long ago. The values then read "—". */
function LateNote({ d }: { d: Device }) {
  const { s } = useStore();
  const t = useT();
  return (
    <div className="lg-late" role="status">
      <Radio size={14} aria-hidden="true" />
      <b>{t('Vehicle data is late')}</b>
      {d.lastSeen > 0 && <span>{ago(Math.max(0, s.now - d.lastSeen))}</span>}
    </div>
  );
}

/**
 * The one card in the middle of the cockpit. The vehicle offline: since when, and what its live
 * picture is doing (reconnect attempt, lost, or the last frame on screen). Data current but the
 * picture lost: the player's own message. Its buttons try the video again and show the map large.
 */
function StageCard({ d, offline, video, onMap }: { d: Device; offline: boolean; video?: LiveVideoStatus; onMap: () => void }) {
  const { s } = useStore();
  const t = useT();
  const msg = video?.message;
  // The very first connect is not a loss: a quiet note, no alarm.
  if (!offline && msg && video.phase === 'connecting' && video.attempt === 0)
    return (
      <div className="lg-card is-note" role="status">
        <LoaderCircle size={16} className="lg-spin" aria-hidden="true" />
        <span>{msg.main}</span>
      </div>
    );
  const age = Math.max(0, s.now - d.lastSeen);
  return (
    <div className={`lg-card${offline ? ' is-offline' : ' is-video'}`} role="status" aria-live="polite">
      <span className="lg-card-icon" aria-hidden="true">
        {offline ? <Radio size={22} /> : <VideoOff size={22} />}
      </span>
      <b className="lg-card-title">{offline ? t('{id} is offline', { id: d.id }) : msg?.main}</b>
      {offline ? (
        <span className="lg-card-line">
          {d.lastSeen > 0 ? t('Last data {time} ({age})', { time: fmtTime(d.lastSeen, true), age: ago(age) }) : t('Nothing received from the vehicle yet.')}
        </span>
      ) : (
        msg?.sub && <span className="lg-card-line">{msg.sub}</span>
      )}
      {offline && (msg || !video) && (
        <span className="lg-card-video">
          {msg ? <VideoOff size={14} aria-hidden="true" /> : <Camera size={14} aria-hidden="true" />}
          <span>
            {msg ? msg.main : t('The picture on screen is the last one received.')}
            {msg?.sub && <small>{msg.sub}</small>}
          </span>
        </span>
      )}
      <div className="lg-card-acts">
        {video?.retry && (
          <button type="button" className="lg-card-btn is-primary" onClick={video.retry}>
            <RotateCw size={14} aria-hidden="true" /> {t('Try again')}
          </button>
        )}
        <button type="button" className="lg-card-btn" onClick={onMap}>
          <MapPinned size={14} aria-hidden="true" /> {t('Show the map large')}
        </button>
      </div>
    </div>
  );
}

/** A big number with its name and unit: the speed (and altitude) at the bottom left. */
function BigNumber({ label, value, unit, digits = 1 }: { label: string; value?: number; unit: string; digits?: number }) {
  const known = value !== undefined && Number.isFinite(value);
  return (
    <div className="lg-big">
      <small>{label}</small>
      <b className={known ? undefined : 'is-none'}>{known ? value.toFixed(digits) : '—'}</b>
      <span>{unit}</span>
    </div>
  );
}

/** Compass as a thin line across the top: ±48° shown, fading at the ends, the heading in a pill under the caret. */
function HeadingLine({ heading }: { heading?: number }) {
  const known = heading !== undefined && Number.isFinite(heading);
  const hdg = known ? ((heading % 360) + 360) % 360 : 0;
  const ticks = [];
  if (known) {
    for (let a = Math.ceil((hdg - 48) / 5) * 5; a <= hdg + 48; a += 5) {
      const x = 150 + (a - hdg) * 3;
      const n = ((a % 360) + 360) % 360;
      const major = n % 30 === 0;
      ticks.push(<line key={`h${a}`} x1={x} x2={x} y1={major ? 15 : 19} y2={23} className="t-tick" />);
      if (major)
        ticks.push(
          <text key={`l${a}`} x={x} y={11} className={`t-lbl${n % 90 === 0 ? ' is-card' : ''}`} textAnchor="middle">
            {({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[n] ?? String(n).padStart(3, '0')}
          </text>,
        );
    }
  }
  return (
    <div className="lg-tape-h">
      <svg viewBox="0 0 300 30" aria-hidden="true">
        <line x1={0} x2={300} y1={23} y2={23} className="t-base" />
        {ticks}
        <path d="M145 30 L150 24 L155 30" className="t-caret" />
      </svg>
      <span className="lg-hdg">{known ? `${String(Math.round(hdg) % 360).padStart(3, '0')}°` : '—'}</span>
    </div>
  );
}
