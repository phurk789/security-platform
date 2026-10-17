// Live telemetry for one vehicle: last ~60 s of speed, link quality and battery as sparklines,
// plus heading, GNSS satellites and accuracy, link latency and motor temperature.
// When the data is stale or offline the lines grey out and the panel says since when.
import { fmtTime, type TelemetrySample } from '@13store/shared';
import { freshness } from '../domain/policy';
import { ago, useT } from '../i18n';
import { useStore } from '../store';
import './telemetry.css';

const WINDOW_MS = 60_000;

type Metric = 'speed' | 'signal' | 'battery';

export function TelemetryPanel({ deviceId }: { deviceId: string }) {
  const { s } = useStore();
  const t = useT();
  const d = s.devices[deviceId];
  if (!d || d.kind === 'cctv') return null;

  const replay = s.replay.active;
  const end = replay ? s.replay.at : s.now;
  const samples = s.telemetry.filter((x) => x.deviceId === deviceId && x.at > end - WINDOW_MS && x.at <= end);
  const f = replay ? 'live' : freshness(s, d);
  const live = f === 'live';
  const age = Math.max(0, s.now - d.lastSeen);
  const tempLabel = d.kind === 'uav' ? t('Airframe temp') : t('Motor temp');

  return (
    <div className={`tlm${live ? '' : ' tlm-dim'}`} aria-label={t('Live telemetry')}>
      <div className="tlm-head">
        <span className="tlm-title">{t('Live telemetry')}</span>
        <span className="tlm-window">{t('Last 60 s')}</span>
        {!live && d.lastSeen > 0 && <span className="tlm-nodata">{t('No data since {time}', { time: fmtTime(d.lastSeen, true) })} · {ago(age)}</span>}
      </div>
      <div className="tlm-sparks">
        <Spark label={t('Speed')} unit="m/s" metric="speed" value={live ? d.speed : undefined} digits={1} samples={samples} end={end} min={0} max={Math.max(6, ...samples.map((x) => x.speed ?? 0))} tone="cyan" />
        <Spark
          label={t('Link')}
          unit="%"
          metric="signal"
          value={live ? d.signal : undefined}
          digits={0}
          samples={samples}
          end={end}
          min={0}
          max={100}
          tone={(d.signal ?? 100) < 40 ? 'red' : (d.signal ?? 100) < 60 ? 'amber' : 'green'}
        />
        <Spark label={t('Battery')} unit="%" metric="battery" value={d.battery} digits={1} samples={samples} end={end} autoRange minSpan={3} tone={(d.battery ?? 100) < 30 ? 'amber' : 'green'} />
      </div>
      <dl className="tlm-stats">
        <div className="tlm-heading">
          <Compass heading={d.heading} dim={!live} />
          <div>
            <dt>{t('Heading')}</dt>
            <dd>{d.heading !== undefined ? `${Math.round(d.heading)}° ${cardinal(d.heading)}` : '—'}</dd>
          </div>
        </div>
        <Stat label={t('Satellites')} value={d.satellites !== undefined ? String(d.satellites) : '—'} warn={(d.satellites ?? 99) < 8} />
        <Stat label={t('Accuracy')} value={`± ${d.accuracyM.toFixed(1)} m`} warn={d.accuracyM > 2} />
        <Stat label={t('Latency')} value={d.latencyMs !== undefined ? `${d.latencyMs} ms` : '—'} warn={(d.latencyMs ?? 0) > 250} />
        <Stat label={tempLabel} value={d.temperatureC !== undefined ? `${d.temperatureC.toFixed(1)} °C` : '—'} warn={(d.temperatureC ?? 0) > 55} />
      </dl>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={warn ? 'warn' : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const W = 120;
const H = 34;

function Spark({
  label,
  unit,
  metric,
  value,
  digits,
  samples,
  end,
  min = 0,
  max = 100,
  autoRange,
  minSpan = 1,
  tone,
}: {
  label: string;
  unit: string;
  metric: Metric;
  value?: number;
  digits: number;
  samples: TelemetrySample[];
  end: number;
  min?: number;
  max?: number;
  autoRange?: boolean;
  minSpan?: number;
  tone: 'cyan' | 'green' | 'amber' | 'red';
}) {
  const pts = samples.filter((x) => typeof x[metric] === 'number').map((x) => ({ at: x.at, v: x[metric] as number }));
  let lo = min;
  let hi = max;
  if (autoRange && pts.length) {
    const vs = pts.map((p) => p.v);
    const mid = (Math.max(...vs) + Math.min(...vs)) / 2;
    const span = Math.max(minSpan, Math.max(...vs) - Math.min(...vs)) * 1.2;
    lo = mid - span / 2;
    hi = mid + span / 2;
  }
  const xOf = (at: number) => ((at - (end - WINDOW_MS)) / WINDOW_MS) * W;
  const yOf = (v: number) => H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6);
  const line = pts.map((p) => `${xOf(p.at).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <div className={`tlm-spark tone-${tone}`}>
      <div className="tlm-spark-top">
        <span className="tlm-label">{label}</span>
        <span className="tlm-value">
          {value !== undefined ? value.toFixed(digits) : '—'}
          <small> {unit}</small>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label} trend`}>
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} className="tlm-grid" />
        {pts.length > 1 && <polygon points={`${xOf(pts[0].at).toFixed(1)},${H} ${line} ${xOf(last.at).toFixed(1)},${H}`} className="tlm-area" />}
        {pts.length > 1 && <polyline points={line} className="tlm-line" />}
        {last && <circle cx={xOf(last.at)} cy={yOf(last.v)} r="2.2" className="tlm-dot" />}
      </svg>
    </div>
  );
}

function Compass({ heading, dim }: { heading?: number; dim?: boolean }) {
  return (
    <svg viewBox="-20 -20 40 40" className={`tlm-compass${dim ? ' dim' : ''}`} aria-hidden>
      <circle r="17" className="ring" />
      <text y="-10" textAnchor="middle" className="n">N</text>
      {heading !== undefined && (
        <g transform={`rotate(${heading})`}>
          <path d="M0 -13 L4 4 L0 1 L-4 4 Z" className="needle" />
        </g>
      )}
    </svg>
  );
}

function cardinal(h: number) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((h % 360) + 360) % 360 / 45) % 8];
}

