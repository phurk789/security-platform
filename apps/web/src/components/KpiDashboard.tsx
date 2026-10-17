// Operational KPIs for a period: counts, response times per SLA stage, compliance and simple
// bar charts. Online the server computes them over everything it holds; offline the console
// computes the same figures from what it has in memory.
import { useEffect, useMemo, useState } from 'react';
import { Download, Gauge } from 'lucide-react';
import { SLA_STAGES, SLA_STAGE_LABEL, computeKpi, kpiMarkdown, fmtDate, type Kpi } from '@13store/shared';
import { can, currentUser } from '../domain/policy';
import { ApiError, saveBlob } from '../api';
import { useStore } from '../store';
import { useT } from '../i18n';

type Period = '7d' | '30d' | 'month';

function range(p: Period, now: number): { from: number; to: number } {
  if (p === 'month') {
    const d = new Date(now);
    return { from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 7 * 3600_000, to: now };
  }
  return { from: now - (p === '7d' ? 7 : 30) * 86_400_000, to: now };
}

const fmtMin = (v: number | null) => (v === null ? '—' : v < 1 ? `${Math.round(v * 60)} s` : `${v.toFixed(1)} min`);

export function KpiDashboard() {
  const { s, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const [period, setPeriod] = useState<Period>('30d');
  const [remote, setRemote] = useState<Kpi | null>(null);
  const [err, setErr] = useState('');
  const { from, to } = range(period, s.now);
  const local = useMemo(
    () => computeKpi({ from, to, incidents: s.incidents, timeline: s.timeline, missions: s.missions, playbooks: s.playbooks, now: s.now }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period, Math.floor(s.now / 60_000), s.incidents, s.timeline, s.missions, s.playbooks],
  );
  useEffect(() => {
    if (!session) return;
    let gone = false;
    session.api
      .get<Kpi>(`/kpi?from=${from}&to=${to}`)
      .then((k) => !gone && setRemote(k))
      .catch((e) => !gone && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, period, Math.floor(s.now / 60_000), s.incidents.length, s.timeline.length]);
  const k = (session ? remote : local) ?? local;
  const maxDay = Math.max(1, ...k.incidents.perDay.map((d) => d.n));
  const maxHour = Math.max(1, ...k.incidents.byHour);
  const maxType = Math.max(1, ...k.incidents.byType.map((x) => x.n));

  const exportReport = async () => {
    if (session) {
      try {
        const blob = await session.api.blob(`/kpi/report?from=${from}&to=${to}&download=1`);
        saveBlob(blob, `operations-report-${new Date(from).toISOString().slice(0, 10)}.md`);
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : String(e));
      }
      return;
    }
    const md = kpiMarkdown(local, { title: `Operations report ${fmtDate(from)} – ${fmtDate(to)}`, org: '13STORE Demo Org', generatedBy: me.name, dataLabel: s.dataLabel, fmtDate });
    saveBlob(new Blob([md], { type: 'text/markdown' }), `operations-report-${new Date(from).toISOString().slice(0, 10)}-SIMULATED.md`);
  };

  return (
    <section className="card kpi-dash">
      <div className="row between wrap">
        <h3>
          <Gauge size={16} /> {t('Operations KPIs')}{' '}
          <small className="muted">
            · {fmtDate(k.from)} – {fmtDate(k.to)}
          </small>
        </h3>
        <div className="row gap-s">
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label={t('Period')}>
            <option value="7d">{t('Last 7 days')}</option>
            <option value="30d">{t('Last 30 days')}</option>
            <option value="month">{t('This month')}</option>
          </select>
          <button className="btn-secondary small" disabled={!can(me.role, 'evidence.export')} onClick={() => void exportReport()}>
            <Download size={14} /> {t('Export period report')}
          </button>
        </div>
      </div>
      {err && <p className="warn-text">{err}</p>}
      <div className="kpi-tiles">
        <Tile label={t('Alerts')} value={String(k.incidents.total)} sub={t('{n} open', { n: k.incidents.open })} />
        <Tile
          label={t('SLA compliance')}
          value={k.sla.compliancePct === null ? '—' : `${k.sla.compliancePct}%`}
          sub={t('{m} met · {b} breached', { m: k.sla.met, b: k.sla.breached })}
          tone={k.sla.compliancePct === null ? undefined : k.sla.compliancePct >= 90 ? 'ok' : k.sla.compliancePct >= 75 ? 'warn' : 'bad'}
        />
        <Tile label={t('Verify (median)')} value={fmtMin(k.response.verify.p50)} sub={t('90th {v}', { v: fmtMin(k.response.verify.p90) })} />
        <Tile label={t('Respond (median)')} value={fmtMin(k.response.respond.p50)} sub={t('90th {v}', { v: fmtMin(k.response.respond.p90) })} />
        <Tile label={t('False alarms')} value={`${k.incidents.falseAlarmPct}%`} sub={t('dismissed or duplicate')} />
        <Tile label={t('Missions')} value={String(k.missions.total)} sub={t('{c} completed · {p} patrols', { c: k.missions.completed, p: k.missions.patrols })} />
        {k.detections && <Tile label={t('AI detections')} value={String(k.detections.total)} sub={t('{i} became incidents', { i: k.detections.byOutcome.incident ?? 0 })} />}
        {k.patrols && <Tile label={t('Patrol runs')} value={String(k.patrols.runs)} sub={t('{n} skipped', { n: k.patrols.skipped })} />}
      </div>
      <div className="kpi-charts">
        <div className="chart">
          <h4>{t('Alerts per day')}</h4>
          <svg viewBox={`0 0 ${Math.max(1, k.incidents.perDay.length) * 12} 60`} preserveAspectRatio="none" className="bars">
            {k.incidents.perDay.map((d, i) => (
              <rect key={d.day} x={i * 12 + 1} y={56 - (d.n / maxDay) * 52} width={10} height={(d.n / maxDay) * 52 + 1} className="bar">
                <title>
                  {d.day}: {d.n}
                </title>
              </rect>
            ))}
          </svg>
          <div className="axis">
            <small>{k.incidents.perDay[0]?.day}</small>
            <small>{k.incidents.perDay[k.incidents.perDay.length - 1]?.day}</small>
          </div>
        </div>
        <div className="chart">
          <h4>{t('By hour of day')}</h4>
          <svg viewBox="0 0 288 60" preserveAspectRatio="none" className="bars">
            {k.incidents.byHour.map((n, h) => (
              <rect key={h} x={h * 12 + 1} y={56 - (n / maxHour) * 52} width={10} height={(n / maxHour) * 52 + 1} className="bar alt">
                <title>
                  {String(h).padStart(2, '0')}:00 · {n}
                </title>
              </rect>
            ))}
          </svg>
          <div className="axis">
            <small>00</small>
            <small>12</small>
            <small>23</small>
          </div>
        </div>
        <div className="chart">
          <h4>{t('By type')}</h4>
          <ul className="hbars">
            {k.incidents.byType.length === 0 && <li className="muted">—</li>}
            {k.incidents.byType.map((x) => (
              <li key={x.type}>
                <span className="lbl">{x.type}</span>
                <i>
                  <b style={{ width: `${(x.n / maxType) * 100}%` }} />
                </i>
                <small>{x.n}</small>
              </li>
            ))}
          </ul>
        </div>
        <div className="chart">
          <h4>{t('Response time by stage')}</h4>
          <table className="compact">
            <thead>
              <tr>
                <th>{t('Stage')}</th>
                <th>{t('Median')}</th>
                <th>{t('90th')}</th>
                <th>{t('Met / breached')}</th>
              </tr>
            </thead>
            <tbody>
              {SLA_STAGES.map((st) => (
                <tr key={st}>
                  <td>{t(SLA_STAGE_LABEL[st])}</td>
                  <td className="mono">{fmtMin(k.response[st].p50)}</td>
                  <td className="mono">{fmtMin(k.response[st].p90)}</td>
                  <td className="mono">
                    {k.sla.byStage[st].met} / {k.sla.byStage[st].breached}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="fine">
        {t(
          'Times run from the alert to the first timeline entry of each stage; limits come from the playbook matched to each incident. Scheduled patrols are not counted as alerts.',
        )}
      </p>
    </section>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`tile${tone ? ` ${tone}` : ''}`}>
      <small>{label}</small>
      <b>{value}</b>
      {sub && <span className="muted">{sub}</span>}
    </div>
  );
}
