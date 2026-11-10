import { ChevronDown, ChevronsUpDown, Download, History, ShieldCheck } from 'lucide-react';
import { Fragment, useState } from 'react';
import { can, currentUser, fmtDate, fmtTime, freshness, userName } from '../domain/policy';
import { missionForIncident } from '../domain/reducer';
import { SITE, componentSummary } from '@13store/shared';
import type { Device, AppState, Incident } from '@13store/shared';
import { useStore } from '../store';
import { age, roleLabel, useT } from '../i18n';
import { lastSeenText } from '../domain/lastSeen';
import { FreshBadge, INCIDENT_LABEL, IncidentBadge, IntegrationBadge, MissionBadge } from '../components/Badges';
import { useCardTable } from '../components/useCardTable';
import { KpiDashboard } from '../components/KpiDashboard';

// The Evidence page has its own file (map, image viewer); App imports every page from here.
export { EvidencePage } from './EvidencePage';

function Page({ title, sub, children, actions }: { title: string; sub?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {sub && <p className="muted">{sub}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function IncidentsPage() {
  const { s, dispatch } = useStore();
  const t = useT();
  const cards = useCardTable();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [zone, setZone] = useState('');
  const [device, setDevice] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const fromMs = from ? new Date(from).getTime() : 0;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const list = [...s.incidents]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((i) => !q || `${i.id} ${i.title} ${i.place} ${i.type} ${i.source}`.toLowerCase().includes(q.toLowerCase()))
    .filter((i) => !status || i.status === status)
    .filter((i) => !zone || i.zone === zone)
    .filter((i) => i.createdAt >= fromMs && i.createdAt <= toMs)
    .filter((i) => !device || i.cameraId === device || s.missions.some((m) => m.incidentId === i.id && m.deviceId === device));
  const zones = [...new Set(s.incidents.map((i) => i.zone))].sort();
  return (
    <Page title={t('Incidents')} sub={t('Search by text, status, zone, time and device. Click a row to open it on the Overview, or replay it from Evidence.')}>
      <div className="filters">
        <input id="f-q" type="search" placeholder={t('Search ID, title, place, source')} value={q} onChange={(e) => setQ(e.target.value)} />
        <select id="f-status" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('Status')}>
          <option value="">{t('Any status')}</option>
          {(['new', 'triaging', 'confirmed', 'responding', 'resolved', 'closed', 'duplicate', 'dismissed'] as const).map((x) => (
            <option key={x} value={x}>
              {t(INCIDENT_LABEL[x][0])}
            </option>
          ))}
        </select>
        <select id="f-zone" value={zone} onChange={(e) => setZone(e.target.value)} aria-label={t('Zone')}>
          <option value="">{t('Any zone')}</option>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <select id="f-device" value={device} onChange={(e) => setDevice(e.target.value)} aria-label={t('Device')}>
          <option value="">{t('Any device')}</option>
          {Object.keys(s.devices).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <label className="date-f">
          {t('From')} <input id="f-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="date-f">
          {t('To')} <input id="f-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <span className="muted">{t('{n} of {total}', { n: list.length, total: s.incidents.length })}</span>
      </div>
      <div className="table-wrap">
        <table ref={cards} className="card-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>{t('Title')}</th>
              <th>{t('Status')}</th>
              <th>{t('Severity')}</th>
              <th>{t('Zone')}</th>
              <th>{t('Source')}</th>
              <th>{t('Received')}</th>
              <th>{t('Owner')}</th>
              <th>{t('Mission')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((i) => {
              const m = missionForIncident(s, i.id);
              return (
                <tr
                  key={i.id}
                  className="click"
                  onClick={() => {
                    dispatch({ type: 'selectIncident', id: i.id });
                    dispatch({ type: 'setView', view: 'overview' });
                  }}
                >
                  <td className="mono">{i.id}</td>
                  <td>
                    {i.title}
                    {i.duplicateOf && <small className="muted"> → {i.duplicateOf}</small>}
                  </td>
                  <td>
                    <IncidentBadge status={i.status} />
                  </td>
                  <td className="cap">{t({ low: 'Low', medium: 'Medium', high: 'High' }[i.severity])}</td>
                  <td>{i.zone}</td>
                  <td>{i.source}</td>
                  <td className="mono">
                    {fmtDate(i.createdAt)} {fmtTime(i.createdAt, true)}
                  </td>
                  <td>{i.owner ?? '—'}</td>
                  <td>{m ? <MissionBadge status={m.status} /> : '—'}</td>
                  <td>
                    <button
                      className="btn-ghost small"
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatch({ type: 'selectIncident', id: i.id });
                        dispatch({ type: 'enterReplay', at: i.createdAt });
                        dispatch({ type: 'setView', view: 'evidence' });
                      }}
                    >
                      <History size={14} /> {t('Replay')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.length === 0 && <p className="empty">{t('No incidents match these filters.')}</p>}
      </div>
    </Page>
  );
}

export function DevicesPage() {
  const { s, dispatch, session } = useStore();
  const t = useT();
  const cards = useCardTable();
  const sites = s.sites ?? [];
  const multi = sites.length > 1;
  const others = sites.filter((x) => x.id !== s.site?.id);
  const devices = Object.values(s.devices);
  // The technical details (adapter, firmware, commands, limitations) open under a row, so the
  // table keeps to what an operator checks at a glance and fits a laptop without scrolling sideways.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const allOpen = devices.length > 0 && devices.every((d) => open.has(d.id));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const cols = multi ? 10 : 9;
  return (
    <Page
      title={t('Devices & integrations')}
      sub={t('Integration status (Verified / Testing / Simulated) is separate from whether a device is online. Nothing in this prototype is a verified integration.')}
      actions={
        devices.length > 0 && (
          <button type="button" className="btn-ghost small dev-all" aria-pressed={allOpen} onClick={() => setOpen(allOpen ? new Set() : new Set(devices.map((d) => d.id)))}>
            <ChevronsUpDown size={14} aria-hidden="true" /> {allOpen ? t('Hide details') : t('Show all details')}
          </button>
        )
      }
    >
      <div className="table-wrap">
        <table ref={cards} className="card-table dev-table">
          <thead>
            <tr>
              <th>{t('Device')}</th>
              {multi && <th>{t('Site')}</th>}
              <th>{t('Link · last seen')}</th>
              <th>{t('Integration')}</th>
              <th>{t('Equipment')}</th>
              <th>{t('Battery')}</th>
              <th>{t('Usage')}</th>
              <th>{t('Service')}</th>
              <th>{t('Control')}</th>
              {/* No visible name: on a phone the button then takes the card's full width. */}
              <th aria-label={t('Details')} />
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 && (
              <tr>
                <td colSpan={cols} className="muted">
                  {t('No devices at this site yet. Register one under Administration, or move one here from another site.')}
                </td>
              </tr>
            )}
            {devices.map((d) => {
              const f = freshness(s, d);
              const isOpen = open.has(d.id);
              return (
                <Fragment key={d.id}>
                  <tr
                    className={`click${isOpen ? ' is-open' : ''}`}
                    onClick={() => {
                      dispatch({ type: 'selectDevice', id: d.id });
                      dispatch({ type: 'setView', view: 'overview' });
                    }}
                  >
                    <td className="dev-cell">
                      <span className="dev-id">
                        <b className="mono">{d.id}</b>
                        <span className="dev-kind">{d.kind.toUpperCase()}</span>
                      </span>
                      {d.model && (
                        <small className="dev-model" title={d.model}>
                          {d.model}
                        </small>
                      )}
                    </td>
                    {multi && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <SiteCell d={d} />
                      </td>
                    )}
                    <td className="dev-link">
                      <FreshBadge f={f} />
                      <small className="muted">{lastSeenText(t, d.lastSeen, s.now)}</small>
                    </td>
                    <td>
                      <IntegrationBadge i={d.integration} />
                    </td>
                    <td>
                      <EquipmentCell d={d} />
                    </td>
                    <td className="dev-num">{d.battery !== undefined ? `${Math.round(d.battery)}%` : '—'}</td>
                    <td>
                      <UsageCell d={d} />
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <ServiceCell d={d} />
                    </td>
                    <td>{userName(s, d.controlOwner)}</td>
                    <td className="dev-more-cell">
                      <button
                        type="button"
                        className="dev-more"
                        aria-expanded={isOpen}
                        aria-controls={`dev-detail-${d.id}`}
                        aria-label={t('Details')}
                        title={t('Details')}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(d.id);
                        }}
                      >
                        <ChevronDown size={14} aria-hidden="true" /> <span className="dev-more-label">{t('Details')}</span>
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="dev-detail" id={`dev-detail-${d.id}`}>
                      <td colSpan={cols}>
                        <dl className="dev-facts">
                          <div>
                            <dt>{t('Adapter')}</dt>
                            <dd className="mono">{d.adapterVersion || '—'}</dd>
                          </div>
                          <div>
                            <dt>{t('Firmware tested')}</dt>
                            <dd>{d.firmwareTested || '—'}</dd>
                          </div>
                          <div>
                            <dt>{t('Commands')}</dt>
                            <dd>
                              {d.commands.length ? (
                                <span className="dev-cmds">
                                  {d.commands.map((c) => (
                                    <code key={c}>{c}</code>
                                  ))}
                                </span>
                              ) : (
                                t('view only')
                              )}
                            </dd>
                          </div>
                          <div className="is-wide">
                            <dt>{t('Limitations')}</dt>
                            <dd>{d.limitations || '—'}</dd>
                          </div>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {multi && (
        <section className="card other-sites">
          <h3>{t('At other sites')}</h3>
          <ul className="list">
            {others.map((x) => (
              <li key={x.id}>
                <span>
                  <b>{x.name}</b> <small className="muted mono">{x.devices?.length ? x.devices.join(', ') : t('No devices yet.')}</small>
                </span>
                <button className="btn-ghost small" onClick={() => session?.switchSite(x.id)}>
                  {t('Open')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

/** Its parts (camera, GNSS, radio …): how many are OK, then how many are down or not checked yet. */
function EquipmentCell({ d }: { d: Device }) {
  const t = useT();
  const q = componentSummary(d.components);
  if (!q.total) return <>—</>;
  const down = q.fault + q.offline;
  return (
    <span className="eq-cell">
      <b className={down ? 'is-bad' : q.pending ? 'is-warn' : 'is-ok'}>{q.ok}/{q.total} OK</b>
      {down > 0 && <small className="is-bad">{down} {t('down')}</small>}
      {q.pending > 0 && <small className="is-warn">{q.pending} {t('pending')}</small>}
    </span>
  );
}

/** Distance, run time and missions, each kept whole on its line. */
function UsageCell({ d }: { d: Device }) {
  const t = useT();
  const st = d.stats;
  if (!st) return <>—</>;
  return (
    <span className="usage-cell">
      <span>{fmtKm(st.odometerM)}</span> · <span>{fmtHours(st.runtimeS)}</span> · <span>{t('{n} missions', { n: st.missions })}</span>
      {st.docked && (
        <>
          <br />
          <span className="badge badge-green">{t('Docked')}</span>
        </>
      )}
    </span>
  );
}

/** The device's site; administrators move an offline device to another one from here. */
function SiteCell({ d }: { d: Device }) {
  const { s, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const others = (s.sites ?? []).filter((x) => x.id !== s.site?.id);
  const name = s.site?.name ?? '—';
  if (!session || !others.length || !can(me.role, 'admin.devices')) return <>{name}</>;
  const offline = freshness(s, d) === 'offline';
  return (
    <span className="site-cell">
      {name}
      <br />
      <select
        className="small"
        value=""
        disabled={!offline}
        title={offline ? t('Move to another site') : t('Only an offline device moves: switch its gateway off first.')}
        aria-label={t('Move {id} to', { id: d.id })}
        onChange={(e) => {
          const to = others.find((x) => x.id === e.target.value);
          if (to && window.confirm(t('Move {id} to {site}? Pair its gateway again at {site} afterwards.', { id: d.id, site: to.name }))) void session.moveDevice(d.id, to.id);
        }}
      >
        <option value="">{t('Move to…')}</option>
        {others.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </span>
  );
}

export function buildReport(s: AppState, inc: Incident) {
  const m = missionForIncident(s, inc.id);
  const ev = s.timeline.filter((e) => e.incidentId === inc.id).sort((a, b) => a.at - b.at);
  const files = s.evidence.filter((e) => e.incidentId === inc.id || s.incidents.find((i) => i.id === e.incidentId)?.duplicateOf === inc.id);
  const cmds = m ? s.commands.filter((c) => c.missionId === m.id) : [];
  const lines = [
    `# Incident report ${inc.id} — ${inc.title}`,
    '',
    `> SIMULATED DATA — generated by the 13STORE Public Security Twin prototype. Not an operational record.`,
    '',
    `- Site: ${SITE.name} · ${inc.zone} · ${inc.place}`,
    `- Status: ${inc.status}`,
    `- Source: ${inc.source}`,
    `- Received: ${fmtDate(inc.createdAt)} ${fmtTime(inc.createdAt, true)} (Asia/Bangkok)`,
    `- Owner: ${inc.owner ?? '—'}`,
    `- Outcome: ${inc.outcome ?? '—'}`,
    '',
    '## Mission',
    m
      ? `- ${m.id} · ${m.deviceId} · operator ${userName(s, m.operatorId)} · plan v${m.planVersion} · approved ${m.approvedVersion ? `v${m.approvedVersion} by ${userName(s, m.approvedBy)}` : 'no'} · status ${m.status}`
      : '- None',
    '',
    '## Commands',
    ...(cmds.length
      ? cmds.map((c) => `- ${c.id} ${c.type} by ${userName(s, c.issuer)} at ${fmtTime(c.issuedAt, true)} → ${c.status}${c.detail ? ` (${c.detail})` : ''}`)
      : ['- None']),
    '',
    '## Timeline (source time · received time)',
    ...ev.map((e) => `- ${fmtTime(e.at, true)} · ${fmtTime(e.receivedAt, true)} — ${e.title} (${e.actor})${e.detail ? `: ${e.detail}` : ''}`),
    '',
    '## Evidence',
    ...(files.length
      ? files.map((f) => `- ${f.id} ${f.title} · ${f.source} · ${fmtTime(f.capturedAt, true)} · sha-256 ${f.checksum ?? 'pending'}${f.simulated ? ' · SIMULATED' : ''}`)
      : ['- None']),
  ];
  return lines.join('\n');
}

export function ReportsPage() {
  const { s, dispatch, mode } = useStore();
  const t = useT();
  const auditCards = useCardTable();
  const me = currentUser(s);
  const inc = s.incidents.find((i) => i.id === s.selectedIncidentId) ?? s.incidents[0];
  if (!inc)
    return (
      <Page title={t('Reports')}>
        <p className="empty">{t('No incidents yet.')}</p>
      </Page>
    );
  const report = buildReport(s, inc);
  const ev = s.timeline.filter((e) => e.incidentId === inc.id);
  const findAt = (re: RegExp) => ev.find((e) => re.test(e.title))?.at;
  const verified = findAt(/Verified|Confirmed/);
  const approved = findAt(/Mission approved/);
  const started = findAt(/started/);
  const span = (a?: number, b?: number) => (a && b ? age(b - a) : '—');

  const download = () => {
    dispatch({ type: 'exportReport', incidentId: inc.id });
    if (mode === 'remote' || !can(me.role, 'evidence.export')) return;
    const blob = new Blob([report], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${inc.id}-report-SIMULATED.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Page
      title={t('Reports')}
      sub={t('Time per stage, approvals, results and evidence references. Downloads are recorded in the audit log.')}
      actions={
        <div className="row gap-s">
          <select value={inc.id} onChange={(e) => dispatch({ type: 'selectIncident', id: e.target.value })} aria-label={t('Incident')}>
            {s.incidents.map((i) => (
              <option key={i.id} value={i.id}>
                {i.id} · {i.title}
              </option>
            ))}
          </select>
          <button className="btn-primary" disabled={!can(me.role, 'evidence.export')} onClick={download}>
            <Download size={16} /> {t('Export report')}
          </button>
        </div>
      }
    >
      <KpiDashboard />
      <h3 style={{ margin: '18px 0 8px' }}>{t('Incident report')}</h3>
      <div className="kpi-row">
        <div className="card stat">
          <small>{t('Alert → verified')}</small>
          <b>{span(inc.createdAt, verified)}</b>
        </div>
        <div className="card stat">
          <small>{t('Verified → approved')}</small>
          <b>{span(verified, approved)}</b>
        </div>
        <div className="card stat">
          <small>{t('Approved → started')}</small>
          <b>{span(approved, started)}</b>
        </div>
        <div className="card stat">
          <small>{t('Status')}</small>
          <b>
            <IncidentBadge status={inc.status} />
          </b>
        </div>
      </div>
      <p className="fine">{t('Baseline measurement only. No reduction target is set until a baseline exists (PRD §9).')}</p>
      <div className="rep-grid">
        <section className="card">
          <h3>{t('Report preview')}</h3>
          <pre className="report">{report}</pre>
        </section>
        <section className="card">
          <h3>
            <ShieldCheck size={16} /> {t('Audit log ({n})', { n: s.audit.length })}
          </h3>
          <div className="table-wrap">
            <table ref={auditCards} className="compact card-table">
              <thead>
                <tr>
                  <th>{t('Time')}</th>
                  <th>{t('Actor')}</th>
                  <th>{t('Action')}</th>
                  <th>{t('Object')}</th>
                  <th>{t('Result')}</th>
                </tr>
              </thead>
              <tbody>
                {s.audit
                  .slice()
                  .reverse()
                  .map((a) => (
                    <tr key={a.id} className={a.result !== 'ok' ? 'denied' : ''}>
                      <td className="mono">{fmtTime(a.at, true)}</td>
                      <td>
                        {a.actor} <small className="muted">{roleLabel(a.role)}</small>
                      </td>
                      <td className="mono">{a.action}</td>
                      <td className="mono">{a.object}</td>
                      <td>
                        {t(a.result)}
                        {a.detail ? <small className="muted"> · {a.detail}</small> : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {s.audit.length === 0 && <p className="empty">{t('No actions recorded yet.')}</p>}
          </div>
        </section>
      </div>
    </Page>
  );
}

function fmtKm(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtHours(sec: number) {
  return sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / 60)} min`;
}

/** Wear since the last service against the interval, with the service button for administrators. */
function ServiceCell({ d }: { d: Device }) {
  const { s, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const st = d.stats;
  if (!st || (d.kind !== 'ugv' && d.kind !== 'uav')) return <>—</>;
  const sinceM = st.odometerM - st.serviceOdometerM;
  const sinceH = (st.runtimeS - st.serviceRuntimeS) / 3600;
  const pctM = st.serviceIntervalM > 0 ? sinceM / st.serviceIntervalM : 0;
  const pctH = st.serviceIntervalH > 0 ? sinceH / st.serviceIntervalH : 0;
  const pct = Math.max(pctM, pctH);
  const due = pct >= 1;
  const soon = pct >= 0.8;
  return (
    <span className="service-cell">
      <span className={`badge ${due ? 'badge-red solid' : soon ? 'badge-amber' : 'badge-green'}`}>{due ? t('Service due') : soon ? t('Service soon') : t('OK')}</span>
      <br />
      <small className="muted">
        {t('{m} · {h} since service', { m: fmtKm(sinceM), h: fmtHours(sinceH * 3600) })}
        {st.lastServiceAt ? ` · ${fmtDate(st.lastServiceAt)}` : ''}
      </small>
      {session && can(me.role, 'device.service') && (
        <>
          <br />
          <button
            className="btn-ghost small"
            onClick={() => {
              const note = window.prompt(t('Service note (what was done)'), '');
              if (note !== null) void session.recordService(d.id, note);
            }}
          >
            {t('Record service')}
          </button>
        </>
      )}
    </span>
  );
}
