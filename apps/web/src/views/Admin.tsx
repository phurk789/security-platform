import { useCallback, useEffect, useState } from 'react';
import {
  BadgeCheck,
  DatabaseBackup,
  Download,
  Eraser,
  Globe2,
  KeyRound,
  Octagon,
  Plus,
  RefreshCw,
  Router,
  ScanEye,
  Search,
  ShieldCheck,
  Timer,
  Trash2,
  Upload,
  UserPlus,
  Video,
} from 'lucide-react';
import {
  GEOFENCE_KIND_LABEL,
  DEFAULT_DETECTION_RULES,
  DEFAULT_ORG_SETTINGS,
  DETECTION_LABEL,
  DETECTION_TYPES,
  fmtDate,
  fmtLatLon,
  fmtTime,
  type ApiKeyView,
  type GeoAnchor,
  type DetectionRule,
  type LicenseStatus,
  type OrgSettings,
  type Role,
  type UserAdminView,
} from '@13store/shared';
import { ApiError, saveBlob } from '../api';
import { useStore } from '../store';
import { roleLabel, useT } from '../i18n';
import { StepUpDialog } from '../components/StepUp';
import { NotificationChannels } from '../components/NotificationChannels';
import { EdgePairingCard } from '../components/EdgePairingCard';
import { EdgeAppCard } from '../components/EdgeAppCard';

interface Backup {
  id: string;
  createdAt: number;
  createdBy: string;
  counts: Record<string, number>;
  files: unknown[];
}

const ROLES: Role[] = ['dispatcher', 'supervisor', 'operator', 'responder', 'auditor', 'admin'];

interface PrivacyMatch {
  table: 'incidents' | 'timeline' | 'evidence' | 'assignments';
  id: string;
  incidentId: string;
  field: string;
  excerpt: string;
}

const LICENSE_TONE: Record<LicenseStatus['state'], string> = {
  valid: 'badge-green',
  expiring: 'badge-amber',
  grace: 'badge-amber',
  expired: 'badge-red solid',
  evaluation: 'badge-grey',
};
export const LICENSE_LABEL: Record<LicenseStatus['state'], string> = {
  valid: 'Licensed',
  expiring: 'Expiring soon',
  grace: 'Grace period',
  expired: 'License expired',
  evaluation: 'Evaluation',
};
const LIMIT_LABEL = { sites: 'Sites', devices: 'Devices', users: 'Users' } as const;

interface EdgeOrigin {
  siteId: string | null;
  origin: string;
}

/**
 * The origin (scheme, host, port) of what the administrator typed, so a pasted WHEP URL such as
 * http://192.168.10.50:8889/ugv-01/whep works too. The server checks the rest (loopback, metadata).
 */
export function edgeOriginOf(input: string): string | null {
  try {
    const u = new URL(input.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export function AdminPage() {
  const { session } = useStore();
  const t = useT();
  if (!session)
    return (
      <div className="page">
        <p className="empty">{t('Administration needs a connection to the platform server.')}</p>
      </div>
    );
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
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  const [settings, setSettings] = useState<OrgSettings>(DEFAULT_ORG_SETTINGS);
  const [ret, setRet] = useState<Record<keyof OrgSettings['retention'], string>>({ telemetryDays: '90', closedIncidentDays: '0', evidenceDays: '0', detectionDays: '90' });
  const geofences = useStore().s.geofences;
  const geo = useStore().s.geo;
  const devices = useStore().s.devices;
  const [reloads, setReloads] = useState(0);
  const [ga, setGa] = useState<{ lat: string; lon: string; rot: string } | null>(null);
  const gaForm = ga ?? { lat: String(geo.originLat), lon: String(geo.originLon), rot: String(geo.rotationDeg ?? 0) };
  const [imp, setImp] = useState<{ imported: number; errors: string[] } | null>(null);
  const [ng, setNg] = useState({ name: '', kind: 'keep_out' as 'keep_out' | 'caution' | 'no_fly', x: '200', y: '120', w: '40', d: '30', uav: true, reason: '' });
  const [rules, setRules] = useState<DetectionRule[]>(DEFAULT_DETECTION_RULES);
  const [rulesDirty, setRulesDirty] = useState(false);
  const [pq, setPq] = useState('');
  const [hits, setHits] = useState<PrivacyMatch[] | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<null | (() => void)>(null);
  const [nu, setNu] = useState({ username: '', name: '', role: 'dispatcher' as Role, password: '' });
  const [nk, setNk] = useState({ label: '', kind: 'integration' as 'integration' | 'gateway' });
  const [nd, setNd] = useState({ id: '', kind: 'ugv' as 'ugv' | 'uav' | 'cctv', model: '' });
  const [origins, setOrigins] = useState<EdgeOrigin[]>([]);
  const [no, setNo] = useState('');
  const orgOrigins = origins.filter((o) => !o.siteId).map((o) => o.origin);

  const load = useCallback(async () => {
    const [u, k, g, b, a, l, st, eo] = await Promise.all([
      api.get<UserAdminView[]>('/admin/users'),
      api.get<ApiKeyView[]>('/admin/keys'),
      api.get<{ gatewayId: string; devices: string[] }[]>('/admin/gateways'),
      api.get<Backup[]>('/admin/backups'),
      api.get<{ ok: boolean; count: number; brokenAt?: number }>('/audit/verify'),
      api.get<LicenseStatus>('/license'),
      api.get<OrgSettings>('/admin/settings'),
      api.get<EdgeOrigin[]>('/admin/edge-origins'),
    ]);
    setUsers(u);
    setKeys(k);
    setReloads((n) => n + 1);
    setGws(g);
    setOrigins(eo);
    setBackups(b);
    setAudit(a);
    setLic(l);
    setSettings(st);
    setRules(st.detection.rules);
    setRulesDirty(false);
    setRet({
      telemetryDays: String(st.retention.telemetryDays),
      closedIncidentDays: String(st.retention.closedIncidentDays),
      evidenceDays: String(st.retention.evidenceDays),
      detectionDays: String(st.retention.detectionDays),
    });
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

  const testDetection = (type: 'person' | 'thermal_hotspot') =>
    act(async () => {
      const d = await api.post<{ outcome: string; incidentId?: string }>('/demo/inject-detection', { type });
      setMsg({ tone: 'ok', text: t('Test detection sent: {outcome}{inc}', { outcome: d.outcome, inc: d.incidentId ? ` → ${d.incidentId}` : '' }) });
    });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Administration')}</h1>
          <p className="muted">{t('Users, access, connections and backups. Being an administrator does not give device control or access to incident data.')}</p>
        </div>
        <button className="btn-secondary" onClick={() => act(load)}>
          <RefreshCw size={16} /> {t('Refresh')}
        </button>
      </div>
      {msg && (
        <p className={`banner ${msg.tone === 'ok' ? 'info' : 'warn'}`} style={{ margin: '0 0 12px' }}>
          {msg.text}
        </p>
      )}

      <div className="admin-grid">
        <section className="card">
          <h3>
            <UserPlus size={16} /> {t('Users ({n})', { n: users.length })}
          </h3>
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('Username')}</th>
                  <th>{t('Role')}</th>
                  <th>{t('Status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.name}
                      <br />
                      <small className="muted">{u.title}</small>
                    </td>
                    <td className="mono">{u.username}</td>
                    <td>
                      <select
                        id={`role-${u.id}`}
                        value={u.role}
                        onChange={(e) =>
                          act(() => api.patch(`/admin/users/${u.id}`, { role: e.target.value }), t('Role changed for {name}. Their sessions were ended.', { name: u.name }))
                        }
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{u.active ? <span className="badge badge-green">{t('Active')}</span> : <span className="badge badge-grey">{t('Disabled')}</span>}</td>
                    <td>
                      <button
                        className="btn-ghost small"
                        onClick={() =>
                          act(
                            () => api.patch(`/admin/users/${u.id}`, { active: !u.active }),
                            u.active ? t('{name} disabled.', { name: u.name }) : t('{name} enabled.', { name: u.name }),
                          )
                        }
                      >
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
              act(() => api.post('/admin/users', nu), t('User {name} created.', { name: nu.username })).then(() =>
                setNu({ username: '', name: '', role: 'dispatcher', password: '' }),
              );
            }}
          >
            <input id="nu-name" placeholder={t('Full name')} value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
            <input id="nu-user" placeholder={t('username')} value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value.toLowerCase() })} />
            <select id="nu-role" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
            <input id="nu-pw" type="password" placeholder={t('Temporary password (10+ chars)')} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
            <button className="btn-primary" disabled={!nu.name || !nu.username || nu.password.length < 10}>
              <Plus size={16} /> {t('Add user')}
            </button>
          </form>
        </section>

        <section className="card">
          <h3>
            <KeyRound size={16} /> {t('API keys')}
          </h3>
          <p className="fine" style={{ marginTop: 0 }}>
            {t('Integration keys push alerts. Gateway keys connect edge gateways. Keys are tied to this environment.')}
          </p>
          {secret && (
            <div className="banner warn">
              <span>{t('New key — copy it now, it will not be shown again:')}</span>
              <code className="secret">{secret}</code>
              <button className="btn-ghost small" onClick={() => navigator.clipboard?.writeText(secret).catch(() => {})}>
                {t('Copy')}
              </button>
              <button className="btn-ghost small" onClick={() => setSecret(null)}>
                {t('Done')}
              </button>
            </div>
          )}
          <ul className="list">
            {keys.map((k) => (
              <li key={k.id} className={k.revoked ? 'dim' : ''}>
                <span>
                  <b>{k.label}</b>{' '}
                  <small className="muted">
                    {k.kind} · {k.env} · {k.prefix}… · {fmtDate(k.createdAt)}
                  </small>
                </span>
                {k.revoked ? (
                  <span className="badge badge-grey">{t('Revoked')}</span>
                ) : (
                  <button className="btn-ghost small" onClick={() => act(() => api.del(`/admin/keys/${k.id}`), t('{name} revoked.', { name: k.label }))}>
                    {t('Revoke')}
                  </button>
                )}
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
            <button className="btn-primary" disabled={!nk.label}>
              <Plus size={16} /> {t('Create key')}
            </button>
          </form>
        </section>

        <EdgePairingCard api={api} act={act} registered={Object.keys(devices)} reloadKey={reloads} />

        <EdgeAppCard api={api} act={act} reloadKey={reloads} />

        <section className="card">
          <h3>
            <Router size={16} /> {t('Edge gateways and devices')}
          </h3>
          {gws.length === 0 && <p className="muted">{t('No edge gateway connected.')}</p>}
          <ul className="list">
            {gws.map((g) => (
              <li key={g.gatewayId}>
                <span>
                  <span className="dot" /> <b>{g.gatewayId}</b>
                </span>
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
            <button className="btn-primary" disabled={!nd.id}>
              <Plus size={16} /> {t('Register')}
            </button>
          </form>
        </section>

        <section className="card">
          <h3>
            <Video size={16} /> {t('Allowed video sources')}
          </h3>
          <p className="fine">
            {t(
              'Gateways may only send browsers to media servers on this list: scheme, address and port, for example the edge PC running MediaMTX. Loopback addresses (localhost, 127.x) are refused. A gateway picks up a change when it reconnects.',
            )}
          </p>
          {origins.length === 0 && <p className="muted">{t('Nothing allowed yet: real cameras and vehicles show no video.')}</p>}
          <ul className="list">
            {origins.map((o) => (
              <li key={`${o.siteId ?? ''}|${o.origin}`}>
                <span className="mono">{o.origin}</span>
                <span className="row gap-s">
                  <small className="muted">{o.siteId ? t('Site {id}', { id: o.siteId }) : t('Whole organisation')}</small>
                  {!o.siteId && (
                    <button
                      className="icon-btn"
                      title={t('Remove')}
                      aria-label={t('Remove {origin}', { origin: o.origin })}
                      onClick={() => act(() => api.put('/admin/edge-origins', { origins: orgOrigins.filter((x) => x !== o.origin) }), t('{origin} removed.', { origin: o.origin }))}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const origin = edgeOriginOf(no);
              if (!origin) {
                setMsg({ tone: 'warn', text: t('Enter an address such as http://192.168.10.50:8889 (a full video link works too).') });
                return;
              }
              act(
                () => api.put('/admin/edge-origins', { origins: [...new Set([...orgOrigins, origin])] }),
                t('{origin} allowed. Restart the gateway so it declares its video again.', { origin }),
              ).then(() => setNo(''));
            }}
          >
            <input id="eo-origin" placeholder="http://192.168.10.50:8889" value={no} onChange={(e) => setNo(e.target.value)} aria-label={t('Video source address')} />
            <button className="btn-primary" disabled={!no.trim()}>
              <Plus size={16} /> {t('Allow')}
            </button>
          </form>
        </section>

        <section className="card">
          <h3>
            <DatabaseBackup size={16} /> {t('Backups')}
          </h3>
          <p className="fine" style={{ marginTop: 0 }}>
            {t('A backup is a consistent database copy plus evidence files, with checksums. Restore with the server stopped:')}{' '}
            <code>npm run restore -w @13store/server -- &lt;id&gt;</code>.
          </p>
          <ul className="list">
            {backups.map((b) => (
              <li key={b.id}>
                <span>
                  <b className="mono">{b.id}</b>
                  <small className="muted">
                    {' '}
                    · {fmtDate(b.createdAt)} {fmtTime(b.createdAt)} · {b.createdBy} ·{' '}
                    {t('{i} incidents · {e} evidence · {f} files', { i: b.counts.incidents, e: b.counts.evidence, f: b.files.length })}
                  </small>
                </span>
                <button
                  className="btn-ghost small"
                  onClick={() =>
                    act(async () => {
                      const r = await api.post<{ ok: boolean; problems: string[] }>(`/admin/backups/${b.id}/verify`);
                      setMsg(
                        r.ok
                          ? { tone: 'ok', text: t('Backup {id} verified: all files and the audit chain match.', { id: b.id }) }
                          : { tone: 'warn', text: t('Backup {id} failed: {problems}', { id: b.id, problems: r.problems.join('; ') }) },
                      );
                    })
                  }
                >
                  {t('Verify')}
                </button>
              </li>
            ))}
          </ul>
          <button className="btn-primary" onClick={() => act(() => api.post('/admin/backups'), t('Backup created.'))}>
            <DatabaseBackup size={16} /> {t('Back up now')}
          </button>
        </section>

        <section className="card">
          <h3>
            <ShieldCheck size={16} /> {t('Audit log integrity')}
          </h3>
          {audit &&
            (audit.ok ? (
              <p>
                <span className="badge badge-green">{t('Intact')}</span>{' '}
                {t('{n} entries. Each entry is chained to the previous one, so edits or deletions are detected.', { n: audit.count })}
              </p>
            ) : (
              <p>
                <span className="badge badge-red solid">{t('Broken')}</span> {t('Chain fails at entry {n}. Investigate before relying on the log.', { n: audit.brokenAt })}
              </p>
            ))}
          <button className="btn-secondary" onClick={() => act(async () => setAudit(await api.get('/audit/verify')))}>
            {t('Verify again')}
          </button>
        </section>

        <section className="card">
          <h3>
            <BadgeCheck size={16} /> {t('License')}
          </h3>
          {lic && (
            <>
              <p style={{ marginTop: 0 }}>
                <span className={`badge ${LICENSE_TONE[lic.state]}`}>{t(LICENSE_LABEL[lic.state])}</span> <b>{lic.customer}</b>
                {lic.expiresAt && (
                  <small className="muted">
                    {' '}
                    · {t('until {date}', { date: fmtDate(lic.expiresAt) })}
                    {lic.daysLeft !== undefined && ` (${t('{n} days', { n: lic.daysLeft })})`}
                  </small>
                )}
              </p>
              {lic.problem && (
                <p className="banner warn" style={{ margin: '0 0 10px' }}>
                  {lic.problem}
                </p>
              )}
              {lic.state === 'grace' && (
                <p className="fine">{t('The license has expired. Everything keeps working for 14 days; after that new devices and users cannot be added.')}</p>
              )}
              {lic.state === 'expired' && (
                <p className="fine">{t('The license has expired. Existing operations continue; adding devices or users is blocked until a new license file is installed.')}</p>
              )}
              <div className="lic-bars">
                {(['sites', 'devices', 'users'] as const).map((k) => {
                  const used = lic.usage[k];
                  const max = lic.limits[k];
                  const unlimited = !Number.isFinite(max) || max >= 1000;
                  const pct = unlimited ? Math.min(100, used) : Math.min(100, Math.round((used / Math.max(1, max)) * 100));
                  return (
                    <div key={k} className={`lic-bar ${!unlimited && used >= max ? 'over' : ''}`}>
                      <span>{t(LIMIT_LABEL[k])}</span>
                      <i>
                        <b style={{ width: `${pct}%` }} />
                      </i>
                      <small>
                        {used} / {unlimited ? '∞' : max}
                      </small>
                    </div>
                  );
                })}
              </div>
              {lic.features.length > 0 && (
                <p className="fine">
                  {t('Features')}: {lic.features.includes('*') ? t('all') : lic.features.join(', ')}
                </p>
              )}
              <p className="fine">
                {t('Install a license by setting LICENSE_FILE on the server and restarting. Licenses are signed; the server only accepts files issued for this organisation.')}
              </p>
            </>
          )}
        </section>

        <section className="card">
          <h3>
            <Timer size={16} /> {t('Data retention')}
          </h3>
          <p className="fine" style={{ marginTop: 0 }}>
            {t('How long personal and operational data is kept, per PDPA. 0 keeps the data. Deletions run every hour and are written to the audit log.')}
          </p>
          <form
            className="retention-form"
            onSubmit={(e) => {
              e.preventDefault();
              const retention = {
                telemetryDays: Number(ret.telemetryDays),
                closedIncidentDays: Number(ret.closedIncidentDays),
                evidenceDays: Number(ret.evidenceDays),
                detectionDays: Number(ret.detectionDays),
              };
              act(() => api.patch('/admin/settings', { retention }), t('Retention policy saved.'));
            }}
          >
            <label htmlFor="ret-tel">{t('Telemetry samples (days)')}</label>
            <input id="ret-tel" type="number" min={0} max={3650} value={ret.telemetryDays} onChange={(e) => setRet({ ...ret, telemetryDays: e.target.value })} />
            <label htmlFor="ret-inc">{t('Closed incidents with missions and evidence (days after closing)')}</label>
            <input id="ret-inc" type="number" min={0} max={3650} value={ret.closedIncidentDays} onChange={(e) => setRet({ ...ret, closedIncidentDays: e.target.value })} />
            <label htmlFor="ret-ev">{t('Evidence files regardless of incident (days)')}</label>
            <input id="ret-ev" type="number" min={0} max={3650} value={ret.evidenceDays} onChange={(e) => setRet({ ...ret, evidenceDays: e.target.value })} />
            <label htmlFor="ret-det">{t('Logged detections that did not become incidents (days)')}</label>
            <input id="ret-det" type="number" min={0} max={3650} value={ret.detectionDays} onChange={(e) => setRet({ ...ret, detectionDays: e.target.value })} />
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn-primary"
                disabled={(['telemetryDays', 'closedIncidentDays', 'evidenceDays', 'detectionDays'] as const).every((k) => ret[k] === String(settings.retention[k]))}
              >
                {t('Save policy')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  act(async () => {
                    const r = await api.post<{ telemetry: number; incidents: number; evidence: number }>('/admin/retention/run');
                    setMsg({
                      tone: 'ok',
                      text: t('Retention run: {t} telemetry rows, {i} incidents, {e} evidence files removed.', { t: r.telemetry, i: r.incidents, e: r.evidence }),
                    });
                  })
                }
              >
                {t('Run now')}
              </button>
            </div>
          </form>
        </section>

        <section className="card">
          <h3>
            <Eraser size={16} /> {t('Privacy requests')}
          </h3>
          <p className="fine" style={{ marginTop: 0 }}>
            {t(
              'Find where a name appears in incident titles, timelines, evidence notes and field reports (PDPA access request), then redact it. Erasure keeps the audit trail and needs a request reference.',
            )}
          </p>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => setHits(await api.get<PrivacyMatch[]>(`/admin/privacy?q=${encodeURIComponent(pq.trim())}`)));
            }}
          >
            <input
              id="pq"
              placeholder={t('Name or text (3+ characters)')}
              value={pq}
              onChange={(e) => {
                setPq(e.target.value);
                setHits(null);
              }}
            />
            <button className="btn-secondary" disabled={pq.trim().length < 3}>
              <Search size={16} /> {t('Search')}
            </button>
          </form>
          {hits && (
            <>
              <p className="muted" style={{ margin: '8px 0 4px' }}>
                {hits.length === 0 ? t('No matches.') : t('{n} matches', { n: hits.length })}
              </p>
              {hits.length > 0 && (
                <>
                  <ul className="list privacy-hits">
                    {hits.map((h, i) => (
                      <li key={i}>
                        <span>
                          <b className="mono">{h.incidentId}</b>{' '}
                          <small className="muted">
                            {h.table}.{h.field}
                            {h.table !== 'incidents' && ` · ${h.id}`}
                          </small>
                          <br />
                          <small>…{h.excerpt}…</small>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      act(async () => {
                        const r = await api.post<{ changed: number; ids: string[] }>('/admin/privacy/erase', { q: pq.trim(), reason: reason.trim() });
                        setHits(null);
                        setReason('');
                        setMsg({ tone: 'ok', text: t('Redacted {n} fields in {ids}.', { n: r.changed, ids: r.ids.join(', ') }) });
                      });
                    }}
                  >
                    <input id="p-reason" placeholder={t('Request reference / legal basis')} value={reason} onChange={(e) => setReason(e.target.value)} />
                    <button className="btn-danger" disabled={!reason.trim()}>
                      <Eraser size={16} /> {t('Redact everywhere')}
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </section>
        <NotificationChannels onStepUp={(retry) => setStepUp(() => retry)} />

        <section className="card">
          <h3>
            <Globe2 size={16} /> {t('Site & GIS')}
          </h3>
          <p className="fine" style={{ marginTop: 0 }}>
            {t(
              'Where the site grid sits on Earth (WGS 84). Positions from real devices are converted with this anchor, every position in the console can be read as latitude/longitude, and the whole site exports as GeoJSON for a city GIS.',
            )}
          </p>
          <p>
            <b>{t('Anchor')}</b> <span className="mono">{fmtLatLon({ lat: geo.originLat, lon: geo.originLon }, 6)}</span>
            {geo.rotationDeg ? <span className="muted"> · {t('grid rotated {d}°', { d: geo.rotationDeg })}</span> : null}
          </p>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const body: GeoAnchor = { originLat: Number(gaForm.lat), originLon: Number(gaForm.lon), rotationDeg: Number(gaForm.rot || 0) };
              void act(async () => {
                await api.patch('/sites/default/geo', body);
                setGa(null);
              }, t('Site anchor saved. Positions now map to the new coordinates.'));
            }}
          >
            <input
              className="num wide"
              placeholder={t('Latitude of grid origin')}
              value={gaForm.lat}
              onChange={(e) => setGa({ ...gaForm, lat: e.target.value })}
              aria-label={t('Latitude of grid origin')}
            />
            <input
              className="num wide"
              placeholder={t('Longitude of grid origin')}
              value={gaForm.lon}
              onChange={(e) => setGa({ ...gaForm, lon: e.target.value })}
              aria-label={t('Longitude of grid origin')}
            />
            <input
              className="num"
              placeholder={t('rotation °')}
              value={gaForm.rot}
              onChange={(e) => setGa({ ...gaForm, rot: e.target.value })}
              aria-label={t('Grid rotation, degrees')}
            />
            <button
              className="btn-primary"
              disabled={![gaForm.lat, gaForm.lon].every((v) => v !== '' && Number.isFinite(Number(v))) || Math.abs(Number(gaForm.lat)) > 90 || Math.abs(Number(gaForm.lon)) > 180}
            >
              {t('Save anchor')}
            </button>
          </form>
          <p className="fine">
            {t(
              "The grid origin is the north-west corner of the site drawing; rotation is how far the drawing's east axis turns clockwise from true east. Take both from a survey or by matching two known points in the GIS.",
            )}
          </p>
          <div className="row gap-s wrap">
            <button
              className="btn-secondary small"
              onClick={() =>
                act(async () => {
                  const blob = await api.blob('/sites/default/geojson?download=1');
                  saveBlob(blob, `site-${new Date().toISOString().slice(0, 10)}.geojson`);
                }, t('GeoJSON exported (buildings, zones, entrances, hydrants, geofences, devices).'))
              }
            >
              <Download size={14} /> {t('Export GeoJSON')}
            </button>
            <label className="btn-secondary small file-btn">
              <Upload size={14} /> {t('Import geofences (GeoJSON)')}
              <input
                type="file"
                accept=".geojson,.json,application/geo+json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  void act(async () => {
                    let fc: unknown;
                    try {
                      fc = JSON.parse(await f.text());
                    } catch {
                      throw new Error(t('{name} is not valid JSON.', { name: f.name }));
                    }
                    const r = await api.post<{ imported: number; errors: string[] }>('/geofences/import', fc);
                    setImp(r);
                    setMsg({
                      tone: r.imported ? 'ok' : 'warn',
                      text: t('{n} geofences imported from {name}{err}', {
                        n: r.imported,
                        name: f.name,
                        err: r.errors.length ? ` · ${t('{n} features skipped', { n: r.errors.length })}` : '',
                      }),
                    });
                  });
                }}
              />
            </label>
          </div>
          {imp && imp.errors.length > 0 && (
            <ul className="fine import-errors">
              {imp.errors.slice(0, 8).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
              {imp.errors.length > 8 && <li>…</li>}
            </ul>
          )}
        </section>

        <section className="card">
          <h3>
            <Octagon size={16} /> {t('Geofences')}
          </h3>
          <p className="fine" style={{ marginTop: 0 }}>
            {t(
              'Keep-out zones refuse routes and raise a breach when a vehicle enters; caution zones are noted on the timeline; no-fly zones apply to aircraft. Supervisors can change them too.',
            )}
          </p>
          <ul className="list">
            {geofences.map((g) => (
              <li key={g.id} className={g.active ? '' : 'dim'}>
                <span>
                  <b>{g.name}</b>{' '}
                  <small className="muted">
                    · {t(GEOFENCE_KIND_LABEL[g.kind])} · {g.appliesTo.map((k) => k.toUpperCase()).join('/')}
                  </small>
                  {g.reason && (
                    <>
                      <br />
                      <small className="muted">{g.reason}</small>
                    </>
                  )}
                </span>
                <span className="row gap-s">
                  <button className="btn-ghost small" onClick={() => act(() => session!.saveGeofence({ active: !g.active }, g.id))}>
                    {g.active ? t('Deactivate') : t('Activate')}
                  </button>
                  <button className="btn-ghost small" onClick={() => act(() => session!.deleteGeofence(g.id), t('{name} removed.', { name: g.name }))} aria-label={t('Remove')}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const x = Number(ng.x);
              const y = Number(ng.y);
              const w = Number(ng.w);
              const d = Number(ng.d);
              act(
                () =>
                  session!.saveGeofence({
                    name: ng.name.trim(),
                    kind: ng.kind,
                    appliesTo: ng.kind === 'no_fly' ? ['uav'] : ng.uav ? ['ugv', 'uav'] : ['ugv'],
                    reason: ng.reason.trim() || undefined,
                    poly: [
                      { x, y },
                      { x: x + w, y },
                      { x: x + w, y: y + d },
                      { x, y: y + d },
                    ],
                  }),
                t('Geofence {name} saved.', { name: ng.name.trim() }),
              ).then(() => setNg({ ...ng, name: '', reason: '' }));
            }}
          >
            <input placeholder={t('Name, e.g. Stage build-up')} value={ng.name} onChange={(e) => setNg({ ...ng, name: e.target.value })} />
            <select value={ng.kind} onChange={(e) => setNg({ ...ng, kind: e.target.value as 'keep_out' | 'caution' | 'no_fly' })}>
              <option value="keep_out">{t('Keep-out')}</option>
              <option value="caution">{t('Caution')}</option>
              <option value="no_fly">{t('No-fly')}</option>
            </select>
            <input className="num" placeholder="x" value={ng.x} onChange={(e) => setNg({ ...ng, x: e.target.value })} aria-label="x" />
            <input className="num" placeholder="y" value={ng.y} onChange={(e) => setNg({ ...ng, y: e.target.value })} aria-label="y" />
            <input className="num" placeholder={t('width')} value={ng.w} onChange={(e) => setNg({ ...ng, w: e.target.value })} aria-label={t('width')} />
            <input className="num" placeholder={t('depth')} value={ng.d} onChange={(e) => setNg({ ...ng, d: e.target.value })} aria-label={t('depth')} />
            {ng.kind !== 'no_fly' && (
              <label className="check">
                <input type="checkbox" checked={ng.uav} onChange={(e) => setNg({ ...ng, uav: e.target.checked })} /> {t('also aircraft')}
              </label>
            )}
            <input placeholder={t('Reason shown to operators')} value={ng.reason} onChange={(e) => setNg({ ...ng, reason: e.target.value })} />
            <button
              className="btn-primary"
              disabled={!ng.name.trim() || ![ng.x, ng.y, ng.w, ng.d].every((v) => v !== '' && Number.isFinite(Number(v))) || Number(ng.w) <= 0 || Number(ng.d) <= 0}
            >
              <Plus size={16} /> {t('Add rectangle (site metres)')}
            </button>
          </form>
        </section>

        <section className="card rules-card">
          <h3>
            <ScanEye size={16} /> {t('Detection rules')}
          </h3>
          <p className="fine" style={{ marginTop: 0 }}>
            {t(
              'What AI video analytics, thermal cameras and sensors may raise. Rules are tried top to bottom; the first match decides: raise an incident, log only, or ignore. A repeat from the same camera within the cooldown joins the open incident.',
            )}
          </p>
          <div className="rules">
            {rules.map((r, i) => {
              const upd = (patch: Partial<DetectionRule>) => {
                setRules(rules.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                setRulesDirty(true);
              };
              return (
                <div key={r.id} className={`rule ${r.enabled ? '' : 'dim'}`}>
                  <div className="rule-head">
                    <label className="check">
                      <input type="checkbox" checked={r.enabled} onChange={(e) => upd({ enabled: e.target.checked })} /> <span className="mono">{r.id}</span>
                    </label>
                    <input className="rule-name" value={r.name} onChange={(e) => upd({ name: e.target.value })} aria-label={t('Rule name')} />
                    <button
                      className="btn-ghost small"
                      onClick={() => {
                        setRules(rules.filter((_, j) => j !== i));
                        setRulesDirty(true);
                      }}
                      aria-label={t('Remove rule')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="chips">
                    {DETECTION_TYPES.map((ty) => (
                      <button
                        key={ty}
                        type="button"
                        className={`chip ${r.types.includes(ty) ? 'on' : ''}`}
                        onClick={() => upd({ types: r.types.includes(ty) ? r.types.filter((x) => x !== ty) : [...r.types, ty] })}
                      >
                        {t(DETECTION_LABEL[ty])}
                      </button>
                    ))}
                  </div>
                  <div className="rule-row">
                    <label>
                      {t('Min. confidence')}
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={Math.round(r.minConfidence * 100)}
                        onChange={(e) => upd({ minConfidence: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })}
                      />{' '}
                      %
                    </label>
                    {r.types.includes('thermal_hotspot') && (
                      <label>
                        {t('Min. temperature')}
                        <input
                          type="number"
                          min={-50}
                          max={2000}
                          value={r.minTemperatureC ?? ''}
                          placeholder="—"
                          onChange={(e) => upd({ minTemperatureC: e.target.value === '' ? undefined : Number(e.target.value) })}
                        />{' '}
                        °C
                      </label>
                    )}
                    <label>
                      {t('Action')}
                      <select value={r.action} onChange={(e) => upd({ action: e.target.value as DetectionRule['action'] })}>
                        <option value="incident">{t('Raise incident')}</option>
                        <option value="log">{t('Log only')}</option>
                        <option value="ignore">{t('Ignore')}</option>
                      </select>
                    </label>
                    {r.action === 'incident' && (
                      <>
                        <label>
                          {t('Severity')}
                          <select value={r.severity} onChange={(e) => upd({ severity: e.target.value as DetectionRule['severity'] })}>
                            <option value="low">{t('low')}</option>
                            <option value="medium">{t('medium')}</option>
                            <option value="high">{t('high')}</option>
                          </select>
                        </label>
                        <label>
                          {t('Cooldown')}
                          <input
                            type="number"
                            min={0}
                            max={86400}
                            step={30}
                            value={r.cooldownS}
                            onChange={(e) => upd({ cooldownS: Math.max(0, Math.round(Number(e.target.value))) })}
                          />{' '}
                          s
                        </label>
                      </>
                    )}
                    <label>
                      {t('Hours')}
                      <input
                        type="time"
                        value={r.hours?.from ?? ''}
                        onChange={(e) => upd({ hours: e.target.value ? { from: e.target.value, to: r.hours?.to ?? '06:00' } : undefined })}
                      />
                      –
                      <input
                        type="time"
                        value={r.hours?.to ?? ''}
                        onChange={(e) => upd({ hours: e.target.value ? { from: r.hours?.from ?? '22:00', to: e.target.value } : undefined })}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="row gap-s wrap">
            <button
              className="btn-secondary small"
              onClick={() => {
                setRules([
                  ...rules,
                  {
                    id: `rule-${Date.now().toString(36)}`,
                    name: t('New rule'),
                    enabled: true,
                    types: ['person'],
                    minConfidence: 0.6,
                    action: 'incident',
                    severity: 'medium',
                    cooldownS: 300,
                  },
                ]);
                setRulesDirty(true);
              }}
            >
              <Plus size={14} /> {t('Add rule')}
            </button>
            <button
              className="btn-ghost small"
              onClick={() => {
                setRules(DEFAULT_DETECTION_RULES);
                setRulesDirty(true);
              }}
            >
              {t('Reset to defaults')}
            </button>
            <button
              className="btn-primary small"
              disabled={!rulesDirty || rules.some((r) => !r.types.length || !r.name.trim())}
              onClick={() => act(() => api.patch('/admin/settings', { detection: { rules, timezone: settings.detection.timezone } }), t('Detection rules saved.'))}
            >
              {t('Save rules')}
            </button>
            <span className="muted fine">
              {t('Time zone')}: {settings.detection.timezone}
            </span>
          </div>
          {session!.meta.env === 'demo' && (
            <p className="fine">
              {t('Try it:')}{' '}
              <button className="btn-ghost small" onClick={() => testDetection('person')}>
                {t('person at the gate')}
              </button>{' '}
              <button className="btn-ghost small" onClick={() => testDetection('thermal_hotspot')}>
                {t('thermal hotspot 78 °C')}
              </button>
            </p>
          )}
        </section>
      </div>
      {stepUp && (
        <StepUpDialog
          api={api}
          onClose={() => setStepUp(null)}
          onDone={() => {
            const r = stepUp;
            setStepUp(null);
            r();
          }}
        />
      )}
    </div>
  );
}
