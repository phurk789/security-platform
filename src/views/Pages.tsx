import { Download, History, Radio, ShieldCheck, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { ageMs, can, currentUser, fmtAge, fmtDate, fmtTime, freshness, userName } from '../domain/policy';
import { missionForIncident } from '../domain/reducer';
import { SITE } from '../domain/scenario';
import type { AppState, Incident } from '../domain/types';
import { useStore } from '../store';
import { CommandBadge, FreshBadge, IncidentBadge, IntegrationBadge, MissionBadge } from '../components/Badges';
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
  return (
    <Page title="Incidents" sub="All incidents in sites you are authorised for. Click a row to open it on the Overview.">
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>ID</th><th>Title</th><th>Status</th><th>Zone</th><th>Source</th><th>Received</th><th>Owner</th><th>Mission</th></tr>
          </thead>
          <tbody>
            {[...s.incidents].sort((a, b) => b.createdAt - a.createdAt).map((i) => {
              const m = missionForIncident(s, i.id);
              return (
                <tr key={i.id} className="click" onClick={() => { dispatch({ type: 'selectIncident', id: i.id }); dispatch({ type: 'setView', view: 'overview' }); }}>
                  <td className="mono">{i.id}</td>
                  <td>{i.title}{i.duplicateOf && <small className="muted"> → {i.duplicateOf}</small>}</td>
                  <td><IncidentBadge status={i.status} /></td>
                  <td>{i.zone}</td>
                  <td>{i.source}</td>
                  <td className="mono">{fmtTime(i.createdAt, true)}</td>
                  <td>{i.owner ?? '—'}</td>
                  <td>{m ? <MissionBadge status={m.status} /> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

export function MissionsPage() {
  const { s, dispatch } = useStore();
  return (
    <Page title="Missions" sub="Plans, approvals and command results. A sent command is not a completed one.">
      {s.missions.length === 0 && <p className="empty">No missions yet. Verify an incident and prepare a mission from the Overview.</p>}
      {s.missions.slice().reverse().map((m) => {
        const cmds = s.commands.filter((c) => c.missionId === m.id);
        return (
          <section key={m.id} className="card">
            <div className="row between wrap">
              <h3 className="mono">{m.id} <small className="muted">· {m.incidentId} · {m.deviceId}</small></h3>
              <MissionBadge status={m.status} />
            </div>
            <dl className="meta cols">
              <div><dt>Operator</dt><dd>{userName(s, m.operatorId)}</dd></div>
              <div><dt>Plan</dt><dd>v{m.planVersion} · {m.checkpoints.length} checkpoints</dd></div>
              <div><dt>Approved</dt><dd>{m.approvedVersion ? `v${m.approvedVersion} by ${userName(s, m.approvedBy)}` : '—'}</dd></div>
              <div><dt>Created</dt><dd>{fmtTime(m.createdAt, true)}</dd></div>
            </dl>
            {cmds.length > 0 && (
              <table className="compact">
                <thead><tr><th>Command</th><th>Type</th><th>Issuer</th><th>Sent</th><th>Expires</th><th>Idempotency key</th><th>Status</th></tr></thead>
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
            <button className="btn-secondary" onClick={() => { dispatch({ type: 'selectIncident', id: m.incidentId }); dispatch({ type: 'setView', view: 'overview' }); }}>Open on map</button>
          </section>
        );
      })}
    </Page>
  );
}

export function DevicesPage() {
  const { s, dispatch } = useStore();
  return (
    <Page title="Devices & integrations" sub="Integration status (Verified / Testing / Simulated) is separate from whether a device is online. Nothing in this prototype is a verified integration.">
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Device</th><th>Type</th><th>Integration</th><th>Link</th><th>Last seen</th><th>Battery</th><th>Control</th><th>Adapter</th><th>Firmware tested</th><th>Commands</th><th>Limitations</th></tr>
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
                  <td className="mono">{fmtAge(ageMs(s, d))} ago</td>
                  <td>{d.battery !== undefined ? `${Math.round(d.battery)}%` : '—'}</td>
                  <td>{userName(s, d.controlOwner)}</td>
                  <td className="mono">{d.adapterVersion}</td>
                  <td>{d.firmwareTested}</td>
                  <td>{d.commands.join(', ') || 'view only'}</td>
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
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const inc = s.incidents.find((i) => i.id === s.selectedIncidentId) ?? s.incidents[0];
  const [note, setNote] = useState('');
  const related = new Set([inc.id, ...s.incidents.filter((i) => i.duplicateOf === inc.id).map((i) => i.id)]);
  const files = s.evidence.filter((e) => related.has(e.incidentId)).filter((e) => !s.replay.active || e.capturedAt <= s.replay.at);
  const start = inc.createdAt - 30_000;
  const end = s.now;
  const at = s.replay.active ? s.replay.at : s.now;
  const cam = inc.cameraId ? s.devices[inc.cameraId] : undefined;

  return (
    <Page
      title="Evidence & replay"
      sub={`${inc.id} · ${inc.title}`}
      actions={
        <div className="row gap-s">
          <select value={inc.id} onChange={(e) => dispatch({ type: 'selectIncident', id: e.target.value })} aria-label="Incident">
            {s.incidents.map((i) => <option key={i.id} value={i.id}>{i.id} · {i.title}</option>)}
          </select>
          {s.replay.active ? (
            <button className="btn-primary" onClick={() => dispatch({ type: 'exitReplay' })}><Radio size={16} /> Return to live</button>
          ) : (
            <button className="btn-secondary" onClick={() => dispatch({ type: 'enterReplay', at: inc.createdAt })}><History size={16} /> Replay this incident</button>
          )}
        </div>
      }
    >
      {s.replay.active && (
        <div className="replay-bar">
          <History size={18} />
          <b>REPLAY</b>
          <span className="mono">{fmtDate(at)} {fmtTime(at, true)}</span>
          <span>You are viewing past data. Device control is off.</span>
          <input
            type="range"
            min={start}
            max={end}
            step={1000}
            value={at}
            onChange={(e) => dispatch({ type: 'seekReplay', at: Number(e.target.value) })}
            aria-label="Replay time"
          />
          <span className="mono muted">−{fmtAge(s.now - at)}</span>
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
            <h3>Files &amp; notes ({files.length})</h3>
            <ul className="files">
              {files.map((e) => (
                <li key={e.id}>
                  <div className="row between"><b>{e.title}</b>{e.simulated && <span className="badge badge-violet solid">SIMULATED</span>}</div>
                  <small className="muted">
                    {e.id} · {e.kind} · {e.source} · captured {fmtTime(e.capturedAt, true)} · by {e.recordedBy}
                    {e.incidentId !== inc.id && ` · from ${e.incidentId} (merged)`}
                  </small>
                  <small className="mono muted">sha-256 {e.checksum ? `${e.checksum.slice(0, 16)}…` : 'computing…'}</small>
                </li>
              ))}
            </ul>
            <p className="fine">Checksums show a file has not changed. They are not, on their own, proof of admissibility.</p>
          </section>
          {!s.replay.active && can(me.role, 'evidence.add') && (
            <section className="card">
              <label className="field">
                <span><StickyNote size={14} /> Add note</span>
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observation, contact made, follow-up…" />
              </label>
              <button className="btn-secondary" disabled={!note.trim()} onClick={() => { dispatch({ type: 'addNote', incidentId: inc.id, text: note }); setNote(''); }}>Attach note</button>
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
  const { s, dispatch } = useStore();
  const me = currentUser(s);
  const inc = s.incidents.find((i) => i.id === s.selectedIncidentId) ?? s.incidents[0];
  const report = buildReport(s, inc);
  const ev = s.timeline.filter((e) => e.incidentId === inc.id);
  const t = (re: RegExp) => ev.find((e) => re.test(e.title))?.at;
  const verified = t(/Verified|Confirmed/);
  const approved = t(/Mission approved/);
  const started = t(/started/);
  const span = (a?: number, b?: number) => (a && b ? fmtAge(b - a) : '—');

  const download = () => {
    dispatch({ type: 'exportReport', incidentId: inc.id });
    if (!can(me.role, 'evidence.export')) return;
    const blob = new Blob([report], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${inc.id}-report-SIMULATED.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Page
      title="Reports"
      sub="Time per stage, approvals, results and evidence references. Downloads are recorded in the audit log."
      actions={
        <div className="row gap-s">
          <select value={inc.id} onChange={(e) => dispatch({ type: 'selectIncident', id: e.target.value })} aria-label="Incident">
            {s.incidents.map((i) => <option key={i.id} value={i.id}>{i.id} · {i.title}</option>)}
          </select>
          <button className="btn-primary" disabled={!can(me.role, 'evidence.export')} onClick={download}><Download size={16} /> Export report</button>
        </div>
      }
    >
      <div className="kpi-row">
        <div className="card stat"><small>Alert → verified</small><b>{span(inc.createdAt, verified)}</b></div>
        <div className="card stat"><small>Verified → approved</small><b>{span(verified, approved)}</b></div>
        <div className="card stat"><small>Approved → started</small><b>{span(approved, started)}</b></div>
        <div className="card stat"><small>Status</small><b><IncidentBadge status={inc.status} /></b></div>
      </div>
      <p className="fine">Baseline measurement only. No reduction target is set until a baseline exists (PRD §9).</p>
      <div className="rep-grid">
        <section className="card">
          <h3>Report preview</h3>
          <pre className="report">{report}</pre>
        </section>
        <section className="card">
          <h3><ShieldCheck size={16} /> Audit log ({s.audit.length})</h3>
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Object</th><th>Result</th></tr></thead>
              <tbody>
                {s.audit.slice().reverse().map((a) => (
                  <tr key={a.id} className={a.result !== 'ok' ? 'denied' : ''}>
                    <td className="mono">{fmtTime(a.at, true)}</td>
                    <td>{a.actor} <small className="muted">{a.role}</small></td>
                    <td className="mono">{a.action}</td>
                    <td className="mono">{a.object}</td>
                    <td>{a.result}{a.detail ? <small className="muted"> · {a.detail}</small> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.audit.length === 0 && <p className="empty">No actions recorded yet.</p>}
          </div>
        </section>
      </div>
    </Page>
  );
}
