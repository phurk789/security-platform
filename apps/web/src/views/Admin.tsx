import { useCallback, useEffect, useState } from 'react';
import { DatabaseBackup, KeyRound, Plus, RefreshCw, Router, ShieldCheck, UserPlus } from 'lucide-react';
import { fmtDate, fmtTime, type ApiKeyView, type Role, type UserAdminView } from '@13store/shared';
import { ApiError } from '../api';
import { useStore } from '../store';
import { roleLabel, useT } from '../i18n';
import { StepUpDialog } from '../components/StepUp';

interface Backup {
  id: string;
  createdAt: number;
  createdBy: string;
  counts: Record<string, number>;
  files: unknown[];
}

const ROLES: Role[] = ['dispatcher', 'supervisor', 'operator', 'responder', 'auditor', 'admin'];

export function AdminPage() {
  const { session } = useStore();
  const t = useT();
  if (!session) return <div className="page"><p className="empty">{t('Administration needs a connection to the platform server.')}</p></div>;
  return <Admin />;
}

function Admin() {
  const { session } = useStore();
  const t = useT();
  const api = session!.api;
  const [users, setUsers] = useState<UserAdminView[]>([]);
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [gws, setGws] = useState<{ gatewayId: string; devices: string[] }[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [audit, setAudit] = useState<{ ok: boolean; count: number; brokenAt?: number } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<null | (() => void)>(null);
  const [nu, setNu] = useState({ username: '', name: '', role: 'dispatcher' as Role, password: '' });
  const [nk, setNk] = useState({ label: '', kind: 'integration' as 'integration' | 'gateway' });
  const [nd, setNd] = useState({ id: '', kind: 'ugv' as 'ugv' | 'uav' | 'cctv', model: '' });

  const load = useCallback(async () => {
    const [u, k, g, b, a] = await Promise.all([
      api.get<UserAdminView[]>('/admin/users'),
      api.get<ApiKeyView[]>('/admin/keys'),
      api.get<{ gatewayId: string; devices: string[] }[]>('/admin/gateways'),
      api.get<Backup[]>('/admin/backups'),
      api.get<{ ok: boolean; count: number; brokenAt?: number }>('/audit/verify'),
    ]);
    setUsers(u);
    setKeys(k);
    setGws(g);
    setBackups(b);
    setAudit(a);
  }, [api]);

  useEffect(() => {
    load().catch((e) => setMsg({ tone: 'warn', text: e.message }));
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: 'ok', text: ok });
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'step_up_required') setStepUp(() => () => act(fn, ok));
      else setMsg({ tone: 'warn', text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Administration')}</h1>
          <p className="muted">{t('Users, access, connections and backups. Being an administrator does not give device control or access to incident data.')}</p>
        </div>
        <button className="btn-secondary" onClick={() => act(load)}><RefreshCw size={16} /> {t('Refresh')}</button>
      </div>
      {msg && <p className={`banner ${msg.tone === 'ok' ? 'info' : 'warn'}`} style={{ margin: '0 0 12px' }}>{msg.text}</p>}

      <div className="admin-grid">
        <section className="card">
          <h3><UserPlus size={16} /> {t('Users ({n})', { n: users.length })}</h3>
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>{t('Name')}</th><th>{t('Username')}</th><th>{t('Role')}</th><th>{t('Status')}</th><th /></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}<br /><small className="muted">{u.title}</small></td>
                    <td className="mono">{u.username}</td>
                    <td>
                      <select id={`role-${u.id}`} value={u.role} onChange={(e) => act(() => api.patch(`/admin/users/${u.id}`, { role: e.target.value }), t('Role changed for {name}. Their sessions were ended.', { name: u.name }))}>
                        {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                      </select>
                    </td>
                    <td>{u.active ? <span className="badge badge-green">{t('Active')}</span> : <span className="badge badge-grey">{t('Disabled')}</span>}</td>
                    <td>
                      <button className="btn-ghost small" onClick={() => act(() => api.patch(`/admin/users/${u.id}`, { active: !u.active }), u.active ? t('{name} disabled.', { name: u.name }) : t('{name} enabled.', { name: u.name }))}>
                        {u.active ? t('Disable') : t('Enable')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => api.post('/admin/users', nu), t('User {name} created.', { name: nu.username })).then(() => setNu({ username: '', name: '', role: 'dispatcher', password: '' }));
            }}
          >
            <input id="nu-name" placeholder={t('Full name')} value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
            <input id="nu-user" placeholder={t('username')} value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value.toLowerCase() })} />
            <select id="nu-role" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as Role })}>
              {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
            <input id="nu-pw" type="password" placeholder={t('Temporary password (10+ chars)')} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
            <button className="btn-primary" disabled={!nu.name || !nu.username || nu.password.length < 10}><Plus size={16} /> {t('Add user')}</button>
          </form>
        </section>

        <section className="card">
          <h3><KeyRound size={16} /> {t('API keys')}</h3>
          <p className="fine" style={{ marginTop: 0 }}>{t('Integration keys push alerts. Gateway keys connect edge gateways. Keys are tied to this environment.')}</p>
          {secret && (
            <div className="banner warn">
              <span>{t('New key — copy it now, it will not be shown again:')}</span>
              <code className="secret">{secret}</code>
              <button className="btn-ghost small" onClick={() => navigator.clipboard?.writeText(secret).catch(() => {})}>{t('Copy')}</button>
              <button className="btn-ghost small" onClick={() => setSecret(null)}>{t('Done')}</button>
            </div>
          )}
          <ul className="list">
            {keys.map((k) => (
              <li key={k.id} className={k.revoked ? 'dim' : ''}>
                <span><b>{k.label}</b> <small className="muted">{k.kind} · {k.env} · {k.prefix}… · {fmtDate(k.createdAt)}</small></span>
                {k.revoked ? <span className="badge badge-grey">{t('Revoked')}</span> : <button className="btn-ghost small" onClick={() => act(() => api.del(`/admin/keys/${k.id}`), t('{name} revoked.', { name: k.label }))}>{t('Revoke')}</button>}
              </li>
            ))}
          </ul>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => {
                const r = await api.post<{ secret: string }>('/admin/keys', nk);
                setSecret(r.secret);
                setNk({ label: '', kind: 'integration' });
              });
            }}
          >
            <input id="nk-label" placeholder={t('Label, e.g. Gate sensors')} value={nk.label} onChange={(e) => setNk({ ...nk, label: e.target.value })} />
            <select id="nk-kind" value={nk.kind} onChange={(e) => setNk({ ...nk, kind: e.target.value as 'integration' | 'gateway' })}>
              <option value="integration">{t('Integration (alerts)')}</option>
              <option value="gateway">{t('Edge gateway')}</option>
            </select>
            <button className="btn-primary" disabled={!nk.label}><Plus size={16} /> {t('Create key')}</button>
          </form>
        </section>

        <section className="card">
          <h3><Router size={16} /> {t('Edge gateways and devices')}</h3>
          {gws.length === 0 && <p className="muted">{t('No edge gateway connected.')}</p>}
          <ul className="list">
            {gws.map((g) => (
              <li key={g.gatewayId}>
                <span><span className="dot" /> <b>{g.gatewayId}</b></span>
                <small className="muted">{g.devices.join(', ') || t('no devices accepted')}</small>
              </li>
            ))}
          </ul>
          <p className="fine">{t('Register a device before its adapter connects. Until an adapter declares capabilities, the device has no commands.')}</p>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => api.post('/devices', nd), t('{id} registered.', { id: nd.id })).then(() => setNd({ id: '', kind: 'ugv', model: '' }));
            }}
          >
            <input id="nd-id" placeholder={t('Device ID, e.g. UGV-02')} value={nd.id} onChange={(e) => setNd({ ...nd, id: e.target.value.toUpperCase() })} />
            <select id="nd-kind" value={nd.kind} onChange={(e) => setNd({ ...nd, kind: e.target.value as 'ugv' | 'uav' | 'cctv' })}>
              <option value="ugv">UGV</option>
              <option value="uav">UAV</option>
              <option value="cctv">CCTV</option>
            </select>
            <input id="nd-model" placeholder={t('Model')} value={nd.model} onChange={(e) => setNd({ ...nd, model: e.target.value })} />
            <button className="btn-primary" disabled={!nd.id}><Plus size={16} /> {t('Register')}</button>
          </form>
        </section>

        <section className="card">
          <h3><DatabaseBackup size={16} /> {t('Backups')}</h3>
          <p className="fine" style={{ marginTop: 0 }}>{t('A backup is a consistent database copy plus evidence files, with checksums. Restore with the server stopped:')} <code>npm run restore -w @13store/server -- &lt;id&gt;</code>.</p>
          <ul className="list">
            {backups.map((b) => (
              <li key={b.id}>
                <span>
                  <b className="mono">{b.id}</b>
                  <small className="muted"> · {fmtDate(b.createdAt)} {fmtTime(b.createdAt)} · {b.createdBy} · {t('{i} incidents · {e} evidence · {f} files', { i: b.counts.incidents, e: b.counts.evidence, f: b.files.length })}</small>
                </span>
                <button
                  className="btn-ghost small"
                  onClick={() =>
                    act(async () => {
                      const r = await api.post<{ ok: boolean; problems: string[] }>(`/admin/backups/${b.id}/verify`);
                      setMsg(r.ok ? { tone: 'ok', text: t('Backup {id} verified: all files and the audit chain match.', { id: b.id }) } : { tone: 'warn', text: t('Backup {id} failed: {problems}', { id: b.id, problems: r.problems.join('; ') }) });
                    })
                  }
                >
                  {t('Verify')}
                </button>
              </li>
            ))}
          </ul>
          <button className="btn-primary" onClick={() => act(() => api.post('/admin/backups'), t('Backup created.'))}><DatabaseBackup size={16} /> {t('Back up now')}</button>
        </section>

        <section className="card">
          <h3><ShieldCheck size={16} /> {t('Audit log integrity')}</h3>
          {audit && (audit.ok ? <p><span className="badge badge-green">{t('Intact')}</span> {t('{n} entries. Each entry is chained to the previous one, so edits or deletions are detected.', { n: audit.count })}</p> : <p><span className="badge badge-red solid">{t('Broken')}</span> {t('Chain fails at entry {n}. Investigate before relying on the log.', { n: audit.brokenAt })}</p>)}
          <button className="btn-secondary" onClick={() => act(async () => setAudit(await api.get('/audit/verify')))}>{t('Verify again')}</button>
        </section>
      </div>
      {stepUp && <StepUpDialog api={api} onClose={() => setStepUp(null)} onDone={() => { const r = stepUp; setStepUp(null); r(); }} />}
    </div>
  );
}
