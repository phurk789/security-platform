import { Download, Eye, History, Radio, ShieldCheck, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { ageMs, can, currentUser, fmtDate, fmtTime, freshness, userName } from '../domain/policy';
import { missionForIncident } from '../domain/reducer';
import { SITE } from '@13store/shared';
import type { AppState, Incident } from '@13store/shared';
import { useStore } from '../store';
import { age, ago, roleLabel, useT } from '../i18n';
import { CommandBadge, FreshBadge, INCIDENT_LABEL, IncidentBadge, IntegrationBadge, MissionBadge } from '../components/Badges';
import { CameraFeed } from '../components/CameraFeed';
import { TwinMap } from '../components/TwinMap';

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
          {(['new', 'triaging', 'confirmed', 'responding', 'resolved', 'closed', 'duplicate', 'dismissed'] as const).map((x) => <option key={x} value={x}>{t(INCIDENT_LABEL[x][0])}</option>)}
        </select>
        <select id="f-zone" value={zone} onChange={(e) => setZone(e.target.value)} aria-label={t('Zone')}>
          <option value="">{t('Any zone')}</option>
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
        <select id="f-device" value={device} onChange={(e) => setDevice(e.target.value)} aria-label={t('Device')}>
          <option value="">{t('Any device')}</option>
          {Object.keys(s.devices).map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <label className="date-f">{t('From')} <input id="f-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="date-f">{t('To')} <input id="f-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="muted">{t('{n} of {total}', { n: list.length, total: s.incidents.length })}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>ID</th><th>{t('Title')}</th><th>{t('Status')}</th><th>{t('Severity')}</th><th>{t('Zone')}</th><th>{t('Source')}</th><th>{t('Received')}</th><th>{t('Owner')}</th><th>{t('Mission')}</th><th /></tr>
          </thead>
          <tbody>
            {list.map((i) => {
              const m = missionForIncident(s, i.id);
              return (
                <tr key={i.id} className="click" onClick={() => { dispatch({ type: 'selectIncident', id: i.id }); dispatch({ type: 'setView', view: 'overview' }); }}>
                  <td className="mono">{i.id}</td>
                  <td>{i.title}{i.duplicateOf && <small className="muted"> → {i.duplicateOf}</small>}</td>
                  <td><IncidentBadge status={i.status} /></td>
                  <td className="cap">{t({ low: 'Low', medium: 'Medium', high: 'High' }[i.severity])}</td>
                  <td>{i.zone}</td>
                  <td>{i.source}</td>
                  <td className="mono">{fmtDate(i.createdAt)} {fmtTime(i.createdAt, true)}</td>
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

export function MissionsPage() {
  const { s, dispatch } = useStore();
  const t = useT();
  return (
    <Page title={t('Missions')} sub={t('Plans, approvals and command results. A sent command is not a completed one.')}>
      {s.missions.length === 0 && <p className="empty">{t('No missions yet. Verify an incident and prepare a mission from the Overview.')}</p>}
      {s.missions.slice().reverse().map((m) => {
        const cmds = s.commands.filter((c) => c.missionId === m.id);
        return (
          <section key={m.id} className="card">
            <div className="row between wrap">
              <h3 className="mono">{m.id} <small className="muted">· {m.incidentId} · {m.deviceId}</small></h3>
              <MissionBadge status={m.status} />
            </div>
            <dl className="meta cols">
              <div><dt>{t('Operator')}</dt><dd>{userName(s, m.operatorId)}</dd></div>
              <div><dt>{t('Plan')}</dt><dd>{t('v{v} · {n} checkpoints', { v: m.planVersion, n: m.checkpoints.length })}</dd></div>
              <div><dt>{t('Approved')}</dt><dd>{m.approvedVersion ? t('v{v} by {name}', { v: m.approvedVersion, name: userName(s, m.approvedBy) }) : '—'}</dd></div>
              <div><dt>{t('Created')}</dt><dd>{fmtTime(m.createdAt, true)}</dd></div>
            </dl>
            {cmds.length > 0 && (
              <table className="compact">
                <thead><tr><th>{t('Command')}</th><th>{t('Type')}</th><th>{t('Issuer')}</th><th>{t('Sent')}</th><th>{t('Expires')}</th><th>{t('Idempotency key')}</th><th>{t('Status')}</th></tr></thead>
                <tbody>
                  {cmds.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.id}</td><td>{c.type}</td><td>{userName(s, c.issuer)}</td>
                      <td className="mono">{fmtTime(c.issuedAt, true)}</td><td className="mono">{fmtTime(c.expiresAt, true)}</td>
                      <td className="mono">{c.idempotencyKey}</td><td><CommandBadge status={c.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <button className="btn-secondary" onClick={() => { dispatch({ type: 'selectIncident', id: m.incidentId }); dispatch({ type: 'setView', view: 'overview' }); }}>{t('Open on map')}</button>
          </section>
        );
      })}
    </Page>
  );
}

export function DevicesPage() {
  const { s, dispatch } = useStore();
  const t = useT();
  return (
    <Page title={t('Devices & integrations')} sub={t('Integration status (Verified / Testing / Simulated) is separate from whether a device is online. Nothing in this prototype is a verified integration.')}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>{t('Device')}</th><th>{t('Type')}</th><th>{t('Integration')}</th><th>{t('Link')}</th><th>{t('Last seen')}</th><th>{t('Battery')}</th><th>{t('Control')}</th><th>{t('Adapter')}</th><th>{t('Firmware tested')}</th><th>{t('Commands')}</th><th>{t('Limitations')}</th></tr>
          </thead>
          <tbody>
            {Object.values(s.devices).map((d) => {
              const f = freshness(s, d);
              return (
                <tr key={d.id} className="click" onClick={() => { dispatch({ type: 'selectDevice', id: d.id }); dispatch({ type: 'setView', view: 'overview' }); }}>
                  <td className="mono">{d.id}<br /><small className="muted">{d.model}</small></td>
                  <td>{d.kind.toUpperCase()}</td>
                  <td><IntegrationBadge i={d.integration} /></td>
                  <td><FreshBadge f={f} /></td>
                  <td className="mono">{ago(ageMs(s, d))}</td>
                  <td>{d.battery !== undefined ? `${Math.round(d.battery)}%` : '—'}</td>
                  <td>{userName(s, d.controlOwner)}</td>
                  <td className="mono">{d.adapterVersion}</td>
                  <td>{d.firmwareTested}</td>
                  <td>{d.commands.join(', ') || t('view only')}</td>
                  <td className="wrap-cell">{d.limitations}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

export function EvidencePage() {
  const { s, dispatch, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const inc = s.incidents.find((i) => i.id === s.selectedIncidentId) ?? s.incidents[0];
  const [note, setNote] = useState('');
  if (!inc) return <Page title={t('Evidence & replay')}><p className="empty">{t('No incidents yet.')}</p></Page>;
  const related = new Set([inc.id, ...s.incidents.filter((i) => i.duplicateOf === inc.id).map((i) => i.id)]);
  const files = s.evidence.filter((e) => related.has(e.incidentId)).filter((e) => !s.replay.active || e.capturedAt <= s.replay.at);
  const start = inc.createdAt - 30_000;
  const end = s.now;
  const at = s.replay.active ? s.replay.at : s.now;
  const cam = inc.cameraId ? s.devices[inc.cameraId] : undefined;

  return (
    <Page
      title={t('Evidence & replay')}
      sub={`${inc.id} · ${inc.title}`}
      actions={
        <div className="row gap-s">
          <select value={inc.id} onChange={(e) => dispatch({ type: 'selectIncident', id: e.target.value })} aria-label={t('Incident')}>
            {s.incidents.map((i) => <option key={i.id} value={i.id}>{i.id} · {i.title}</option>)}
          </select>
          {s.replay.active ? (
            <button className="btn-primary" onClick={() => dispatch({ type: 'exitReplay' })}><Radio size={16} /> {t('Return to live')}</button>
          ) : (
            <button className="btn-secondary" onClick={() => dispatch({ type: 'enterReplay', at: inc.createdAt })}><History size={16} /> {t('Replay this incident')}</button>
          )}
        </div>
      }
    >
      {s.replay.active && (
        <div className="replay-bar">
          <History size={18} />
          <b>REPLAY</b>
          <span className="mono">{fmtDate(at)} {fmtTime(at, true)}</span>
          <span>{t('You are viewing past data. Device control is off.')}</span>
          <input
            type="range"
            min={start}
            max={end}
            step={1000}
            value={at}
            onChange={(e) => dispatch({ type: 'seekReplay', at: Number(e.target.value) })}
            aria-label={t('Replay time')}
          />
          <span className="mono muted">−{age(s.now - at)}</span>
        </div>
      )}
      <div className="ev-grid">
        <div className="ev-map card">
          <TwinMap />
        </div>
        <div className="ev-side">
          {cam && (
            <CameraFeed scene={cam.view ?? 'gate'} label={`${cam.id} ${inc.place}`} time={at} freshness={s.replay.active ? 'live' : freshness(s, cam)} replay={s.replay.active} />
          )}
          <section className="card">
            <h3>{t('Files & notes ({n})', { n: files.length })}</h3>
            <ul className="files">
              {files.map((e) => (
                <li key={e.id}>
                  <div className="row between"><b>{e.title}</b>{e.simulated && <span className="badge badge-violet solid">SIMULATED</span>}</div>
                  <small className="muted">
                    {t('{id} · {kind} · {source} · captured {time} · by {who}', { id: e.id, kind: t(e.kind), source: e.source, time: fmtTime(e.capturedAt, true), who: e.recordedBy })}
                    {e.incidentId !== inc.id && ` · ${t('from {id} (merged)', { id: e.incidentId })}`}
                  </small>
                  <small className="mono muted">sha-256 {e.checksum ? `${e.checksum.slice(0, 16)}…` : t('computing…')}</small>
                  {session && e.kind !== 'note' && (
                    <div className="row gap-s">
                      <button className="btn-ghost small" onClick={() => session.openEvidence(e.id)}><Eye size={14} /> {t('Open')}</button>
                      {can(me.role, 'evidence.export') && <button className="btn-ghost small" onClick={() => session.openEvidence(e.id, true)}><Download size={14} /> {t('Download (logged)')}</button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="fine">{t('Checksums show a file has not changed. They are not, on their own, proof of admissibility.')}</p>
          </section>
          {!s.replay.active && can(me.role, 'evidence.add') && (
            <section className="card">
              <label className="field">
                <span><StickyNote size={14} /> {t('Add note')}</span>
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Observation, contact made, follow-up…')} />
              </label>
              <button className="btn-secondary" disabled={!note.trim()} onClick={() => { dispatch({ type: 'addNote', incidentId: inc.id, text: note }); setNote(''); }}>{t('Attach note')}</button>
            </section>
          )}
        </div>
      </div>
    </Page>
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
    ...(cmds.length ? cmds.map((c) => `- ${c.id} ${c.type} by ${userName(s, c.issuer)} at ${fmtTime(c.issuedAt, true)} → ${c.status}${c.detail ? ` (${c.detail})` : ''}`) : ['- None']),
    '',
    '## Timeline (source time · received time)',
    ...ev.map((e) => `- ${fmtTime(e.at, true)} · ${fmtTime(e.receivedAt, true)} — ${e.title} (${e.actor})${e.detail ? `: ${e.detail}` : ''}`),
    '',
    '## Evidence',
    ...(files.length ? files.map((f) => `- ${f.id} ${f.title} · ${f.source} · ${fmtTime(f.capturedAt, true)} · sha-256 ${f.checksum ?? 'pending'}${f.simulated ? ' · SIMULATED' : ''}`) : ['- None']),
  ];
  return lines.join('\n');
}

export function ReportsPage() {
  const { s, dispatch, mode } = useStore();
  const t = useT();
  const me = currentUser(s);
  const inc = s.incidents.find((i) => i.id === s.selectedIncidentId) ?? s.incidents[0];
  if (!inc) return <Page title={t('Reports')}><p className="empty">{t('No incidents yet.')}</p></Page>;
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
            {s.incidents.map((i) => <option key={i.id} value={i.id}>{i.id} · {i.title}</option>)}
          </select>
          <button className="btn-primary" disabled={!can(me.role, 'evidence.export')} onClick={download}><Download size={16} /> {t('Export report')}</button>
        </div>
      }
    >
      <div className="kpi-row">
        <div className="card stat"><small>{t('Alert → verified')}</small><b>{span(inc.createdAt, verified)}</b></div>
        <div className="card stat"><small>{t('Verified → approved')}</small><b>{span(verified, approved)}</b></div>
        <div className="card stat"><small>{t('Approved → started')}</small><b>{span(approved, started)}</b></div>
        <div className="card stat"><small>{t('Status')}</small><b><IncidentBadge status={inc.status} /></b></div>
      </div>
      <p className="fine">{t('Baseline measurement only. No reduction target is set until a baseline exists (PRD §9).')}</p>
      <div className="rep-grid">
        <section className="card">
          <h3>{t('Report preview')}</h3>
          <pre className="report">{report}</pre>
        </section>
        <section className="card">
          <h3><ShieldCheck size={16} /> {t('Audit log ({n})', { n: s.audit.length })}</h3>
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>{t('Time')}</th><th>{t('Actor')}</th><th>{t('Action')}</th><th>{t('Object')}</th><th>{t('Result')}</th></tr></thead>
              <tbody>
                {s.audit.slice().reverse().map((a) => (
                  <tr key={a.id} className={a.result !== 'ok' ? 'denied' : ''}>
                    <td className="mono">{fmtTime(a.at, true)}</td>
                    <td>{a.actor} <small className="muted">{roleLabel(a.role)}</small></td>
                    <td className="mono">{a.action}</td>
                    <td className="mono">{a.object}</td>
                    <td>{t(a.result)}{a.detail ? <small className="muted"> · {a.detail}</small> : null}</td>
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
