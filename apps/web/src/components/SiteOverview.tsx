// Site overview cards for the right column when nothing is selected (CityOS-style dashboard):
// site status, fleet link quality over the last 10 minutes, coverage health bars and the
// device state distribution. Everything comes from the live app state — nothing is mocked.
import { useMemo } from 'react';
import { Activity, Building2, Cctv, ShieldCheck, TriangleAlert } from 'lucide-react';
import { BUILDINGS, SITE, polygonArea, siteVariant, type AppState, type Device } from '@13store/shared';
import { freshness, isReady } from '../domain/policy';
import { useT } from '../i18n';
import { useStore } from '../store';
import './overview.css';

const OPEN = (st: string) => !['closed', 'duplicate', 'dismissed'].includes(st);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Mean link quality of the fleet per bucket over the last `n × stepMs` of telemetry. */
function linkSeries(s: AppState, n: number, stepMs: number) {
  const start = s.now - n * stepMs;
  const sum = new Array<number>(n).fill(0);
  const cnt = new Array<number>(n).fill(0);
  for (let i = s.telemetry.length - 1; i >= 0; i--) {
    const t = s.telemetry[i];
    if (t.at < start) break;
    if (t.signal === undefined) continue;
    const k = Math.min(n - 1, Math.floor((t.at - start) / stepMs));
    sum[k] += t.signal;
    cnt[k]++;
  }
  return sum.map((v, i) => (cnt[i] ? v / cnt[i] : null));
}

export function SiteOverview() {
  const { s } = useStore();
  const t = useT();
  const devs = Object.values(s.devices);
  const fr = devs.map((d) => ({ d, f: freshness(s, d) }));
  const live = fr.filter((x) => x.f === 'live');
  const stale = fr.filter((x) => x.f === 'stale').length;
  const offline = fr.filter((x) => x.f === 'offline').length;
  const open = s.incidents.filter((i) => OPEN(i.status));
  const unverified = open.filter((i) => i.status === 'new').length;
  const vehicles = devs.filter((d) => d.kind !== 'cctv');
  const cams = devs.filter((d) => d.kind === 'cctv');
  const camsOnline = cams.filter((d) => freshness(s, d) === 'live').length;
  const ready = vehicles.filter((d) => isReady(s, d)).length;
  const liveDevs = live.map((x) => x.d);
  const link = avg(liveDevs.map((d) => d.signal).filter((n): n is number => n !== undefined));
  const accurate = liveDevs.length ? liveDevs.filter((d) => d.accuracyM <= 1).length / liveDevs.length : null;
  const battery = avg(vehicles.filter((d) => freshness(s, d) !== 'offline' && d.battery !== undefined).map((d) => d.battery!));
  // The demo site has a drawn plan (buildings, occupancy); a real site is described by its zones.
  const demo = !s.site || s.site.demo;
  const areas = s.geofences.filter((g) => g.active && g.kind === 'operating_area');
  const areaM2 = Math.round(areas.reduce((a, g) => a + polygonArea(g.poly), 0));
  const zones = s.geofences.filter((g) => g.active && g.kind !== 'operating_area').length;
  const gfa = BUILDINGS.reduce((a, b) => a + b.bim.gfaM2, 0);
  const occ = BUILDINGS.reduce((a, b) => a + b.bim.occupancy, 0);
  const indoor = devs.filter((d) => d.indoor).length;
  const active = s.missions.filter((m) => ['approved', 'assigned', 'executing', 'paused'].includes(m.status)).length;
  const series = useMemo(() => linkSeries(s, 30, 10_000), [s.telemetry.length, s.now]); // eslint-disable-line react-hooks/exhaustive-deps
  const peak = series.reduce<number | null>((a, v) => (v === null ? a : a === null ? v : Math.max(a, v)), null);
  const weak = liveDevs.filter((d) => d.signal !== undefined && d.signal < 60);

  return (
    <div className="so-stack">
      <aside className="panel so-card">
        <div className="panel-head">
          <h2>{t('Site status')}</h2>
        </div>
        <dl className="so-rows">
          <div>
            <dt>{t('Site')}</dt>
            <dd>{demo ? `${s.site?.name ?? t(SITE.name)} · ${t(siteVariant === 'civic' ? 'Civic campus' : 'Industrial estate')}` : s.site!.name}</dd>
          </div>
          {demo ? (
            <>
              <div>
                <dt>{t('Buildings')}</dt>
                <dd>
                  {BUILDINGS.length} · {gfa.toLocaleString()} m²
                </dd>
              </div>
              <div>
                <dt>{t('Occupancy')}</dt>
                <dd>
                  {occ.toLocaleString()} {t('people')}
                </dd>
              </div>
            </>
          ) : (
            <>
              <div>
                <dt>{t('Operating area')}</dt>
                <dd className={areas.length ? '' : 'warn'}>
                  {areas.length ? `${areaM2.toLocaleString()} m² · ${(areaM2 / 1600).toFixed(1)} ${t('rai')}` : t('not drawn yet')}
                </dd>
              </div>
              <div>
                <dt>{t('Zones')}</dt>
                <dd>{zones}</dd>
              </div>
            </>
          )}
          <div>
            <dt>{t('Devices online')}</dt>
            <dd>
              {live.length} / {devs.length}
              {indoor ? ` · ${t('{n} indoor', { n: indoor })}` : ''}
            </dd>
          </div>
          <div>
            <dt>{t('Open incidents')}</dt>
            <dd className={open.length ? 'warn' : ''}>
              {open.length}
              {unverified ? ` · ${t('{n} unverified', { n: unverified })}` : ''}
            </dd>
          </div>
          <div>
            <dt>{t('Active missions')}</dt>
            <dd>{active}</dd>
          </div>
        </dl>
      </aside>

      <aside className="panel so-card">
        <div className="panel-head">
          <h2>{t('Fleet link, last 5 min')}</h2>
          <span className="so-live">
            <Activity size={13} /> {t('Real time')}
          </span>
        </div>
        <div className="so-big">
          <div>
            <b>{link === null ? '—' : `${Math.round(link)}%`}</b>
            <small>{t('Link now')}</small>
          </div>
          <div>
            <b>{peak === null ? '—' : `${Math.round(peak)}%`}</b>
            <small>{t('Peak')}</small>
          </div>
          <div>
            <b className={weak.length ? 'warn' : ''}>{weak.length}</b>
            <small>{t('Weak links')}</small>
          </div>
        </div>
        <LinkChart series={series} />
        {weak.length ? (
          <p className="so-note warn">
            <TriangleAlert size={14} /> {t('{n} device(s) below 60% link: {ids}', { n: weak.length, ids: weak.map((d) => d.id).join(', ') })}
          </p>
        ) : (
          <p className="so-note">{t('All reporting devices have a usable link.')}</p>
        )}
      </aside>

      <aside className="panel so-card">
        <div className="panel-head">
          <h2>{t('Coverage health')}</h2>
          <ShieldCheck size={15} className="muted" />
        </div>
        <div className="so-bars">
          <Bar label={t('Camera coverage')} value={cams.length ? camsOnline / cams.length : null} detail={`${camsOnline}/${cams.length}`} />
          <Bar label={t('Fleet readiness')} value={vehicles.length ? ready / vehicles.length : null} detail={`${ready}/${vehicles.length}`} />
          <Bar label={t('Link quality')} value={link === null ? null : link / 100} />
          <Bar label={t('Position accuracy ≤ 1 m')} value={accurate} />
          <Bar label={t('Fleet battery')} value={battery === null ? null : battery / 100} />
        </div>
      </aside>

      <aside className="panel so-card">
        <div className="panel-head">
          <h2>{t('Device states')}</h2>
          <Cctv size={15} className="muted" />
        </div>
        <div className="so-donut-row">
          <Donut
            parts={[
              { n: live.length, cls: 'ok' },
              { n: stale, cls: 'warn' },
              { n: offline, cls: 'bad' },
            ]}
            total={devs.length}
          />
          <ul className="so-legend">
            <li>
              <i className="ok" /> LIVE <b>{live.length}</b>
            </li>
            <li>
              <i className="warn" /> STALE <b>{stale}</b>
            </li>
            <li>
              <i className="bad" /> OFFLINE <b>{offline}</b>
            </li>
            <li className="sub">
              <Building2 size={12} />{' '}
              {t('UGV {a} · UAV {b} · CCTV {c}', { a: devs.filter((d) => d.kind === 'ugv').length, b: devs.filter((d) => d.kind === 'uav').length, c: cams.length })}
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function LinkChart({ series }: { series: (number | null)[] }) {
  const w = 300;
  const h = 72;
  const n = series.length;
  const bw = w / n;
  return (
    <svg className="so-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      {[25, 50, 75].map((g) => (
        <line key={g} x1={0} x2={w} y1={h - (g / 100) * h} y2={h - (g / 100) * h} className="grid" />
      ))}
      {series.map((v, i) => {
        const bh = v === null ? 0 : Math.max(2, (v / 100) * h);
        return <rect key={i} x={i * bw + 1} y={h - bh} width={Math.max(1, bw - 2)} height={bh} className={v === null ? 'none' : v < 60 ? 'low' : i === n - 1 ? 'now' : ''} />;
      })}
    </svg>
  );
}

function Bar({ label, value, detail }: { label: string; value: number | null; detail?: string }) {
  const pct = value === null ? 0 : Math.round(value * 100);
  const tone = value === null ? 'none' : pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'bad';
  return (
    <div className={`so-bar t-${tone}`}>
      <div className="so-bar-top">
        <span>{label}</span>
        <b>
          {value === null ? '—' : `${pct}%`}
          {detail ? <small> {detail}</small> : null}
        </b>
      </div>
      <div className="so-bar-track">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Donut({ parts, total }: { parts: { n: number; cls: string }[]; total: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg className="so-donut" viewBox="0 0 90 90" aria-hidden>
      <circle cx={45} cy={45} r={r} className="track" />
      {parts.map((p, i) => {
        const len = total ? (p.n / total) * c : 0;
        const el = <circle key={i} cx={45} cy={45} r={r} className={p.cls} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} />;
        off += len;
        return el;
      })}
      <text x={45} y={43} textAnchor="middle" className="big">
        {total}
      </text>
      <text x={45} y={57} textAnchor="middle" className="small">
        DEVICES
      </text>
    </svg>
  );
}

export type { Device };
