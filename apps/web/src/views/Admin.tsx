import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  BadgeCheck,
  DatabaseBackup,
  Download,
  Eraser,
  Globe2,
  KeyRound,
  Lock,
  MapPinned,
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
  X,
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
  type GeofenceKind,
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
import { SiteAccess, SitesCard } from '../components/SitesCard';
import { EdgeAppCard } from '../components/EdgeAppCard';
import { CardHead } from '../components/CardHead';
import { finishedDraft, routeDraft, useRouteDraft } from '../domain/routeDraft';

interface ZoneForm {
  name: string;
  kind: GeofenceKind;
  x: string;
  y: string;
  w: string;
  d: string;
  uav: boolean;
  reason: string;
}

/** The zone form as it was when the admin went to the map to draw its outline, if coming back from it. */
const returningZone = () => {
  const d = routeDraft.get();
  return d?.purpose === 'zone' && d.state === 'done' ? (d.meta as ZoneForm | undefined) : undefined;
};

interface Backup {
  id: string;
  createdAt: number;
  createdBy: string;
  counts: Record<string, number>;
  files: unknown[];
}

const ROLES: Role[] = ['dispatcher', 'supervisor', 'operator', 'responder', 'auditor', 'admin'];

/** One line per role for the users card, so it is clear who may do what. */
const ROLE_HINT: Record<Role, string> = {
  dispatcher: 'Receives and verifies alerts, prepares missions, watches and turns cameras.',
  supervisor: 'Everything a dispatcher and an operator do, plus approving missions, putting vehicles live, patrols, zones, exporting evidence and the audit log.',
  operator: 'Accepts missions and commands the vehicle: start, pause, stop, drive, camera.',
  responder: 'Field team: sees only the incidents assigned to them, in the field app.',
  auditor: 'Sees every page, video, reports, evidence and the audit log; changes nothing.',
  admin: 'Everything a supervisor does, plus users, devices, keys, settings and backups.',
};

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

/** Lists the server hides until the administrator confirms their password again. */
type LockedList = 'users' | 'keys' | 'backups';

const KEY_KIND_LABEL: Record<ApiKeyView['kind'], string> = { integration: 'Integration (alerts)', gateway: 'Edge gateway' };
const KEY_ENV_LABEL: Record<ApiKeyView['env'], string> = { sandbox: 'Sandbox', pilot: 'Pilot', demo: 'Demo' };

/** The page as tabs, one group of cards each. `locks`: lists in that tab the server may hold back. */
const GROUPS = [
  { id: 'admin-people', Icon: UserPlus, locks: ['users', 'keys'], title: 'People and access', hint: 'Who can sign in, what each role may do, and keys for other systems.' },
  { id: 'admin-devices', Icon: Router, locks: ['keys'], title: 'Devices and connections', hint: 'Register devices, pair remotes and Pis, allow their video, and publish edge app updates.' },
  { id: 'admin-site', Icon: MapPinned, locks: [], title: 'Sites and map', hint: 'The sites, where each one sits on the map, and the zones vehicles must respect.' },
  { id: 'admin-alerts', Icon: ScanEye, locks: [], title: 'Detection and alerts', hint: 'What raises an incident, and where alerts are sent.' },
  { id: 'admin-system', Icon: DatabaseBackup, locks: ['backups'], title: 'System and data', hint: 'License, audit log, backups, how long data is kept, and personal-data requests.' },
] as const satisfies readonly { id: string; Icon: typeof UserPlus; locks: readonly LockedList[]; title: string; hint: string }[];
type GroupId = (typeof GROUPS)[number]['id'];

const TAB_KEY = 'ps.admin.tab';
/** The tab this viewer had open last time (a per-browser convenience; the first tab if unknown). */
function savedTab(): GroupId {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return GROUPS.find((g) => g.id === v)?.id ?? GROUPS[0].id;
  } catch {
    return GROUPS[0].id;
  }
}

/** One tab's cards. Hidden tabs stay mounted, so a half-filled form or a pairing QR survives a tab switch. */
function AdminGroup({ id, tab, children }: { id: GroupId; tab: GroupId; children: ReactNode }) {
  const t = useT();
  const g = GROUPS.find((x) => x.id === id)!;
  return (
    <section className="admin-group" id={id} role="tabpanel" aria-labelledby={`${id}-tab`} hidden={tab !== id}>
      <p className="muted admin-tab-hint">{t(g.hint)}</p>
      {children}
    </section>
  );
}

/** In place of a list the server hides until the password is confirmed again. */
function LockedNote({ text, onUnlock }: { text: string; onUnlock: () => void }) {
  const t = useT();
  return (
    <div className="admin-locked">
      <Lock size={16} aria-hidden />
      <span>{text}</span>
      <button type="button" className="btn-secondary small" onClick={onUnlock}>
        <ShieldCheck size={14} /> {t('Confirm password')}
      </button>
    </div>
  );
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
  const sites = useStore().s.sites ?? [];
  const site = useStore().s.site;
  // Site-scoped calls go to the site on screen ('default' before the site list has loaded).
  const siteKey = encodeURIComponent(site?.id ?? 'default');
  const [reloads, setReloads] = useState(0);
  const [ga, setGa] = useState<{ lat: string; lon: string; rot: string } | null>(null);
  const gaForm = ga ?? { lat: String(geo.originLat), lon: String(geo.originLon), rot: String(geo.rotationDeg ?? 0) };
  const [imp, setImp] = useState<{ imported: number; errors: string[] } | null>(null);
  const [ng, setNg] = useState<ZoneForm>(() => returningZone() ?? { name: '', kind: 'keep_out', x: '200', y: '120', w: '40', d: '30', uav: true, reason: '' });
  // A zone outline drawn on the real map (overview), used instead of the rectangle.
  const outline = finishedDraft(useRouteDraft(), 'zone', '');
  const dispatch = useStore().dispatch;
  const drawZone = () => {
    routeDraft.start({ purpose: 'zone', deviceId: '', points: outline?.points ?? [], returnTo: 'admin', meta: ng });
    dispatch({ type: 'setView', view: 'overview' });
  };
  useEffect(() => {
    if (returningZone()) document.getElementById('admin-geofences')?.scrollIntoView({ block: 'start' });
  }, []);
  const [rules, setRules] = useState<DetectionRule[]>(DEFAULT_DETECTION_RULES);
  const [rulesDirty, setRulesDirty] = useState(false);
  const [pq, setPq] = useState('');
  const [hits, setHits] = useState<PrivacyMatch[] | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<null | (() => void)>(null);
  const [nu, setNu] = useState({ username: '', name: '', role: 'dispatcher' as Role, password: '', siteIds: [] as string[] });
  const [nk, setNk] = useState({ label: '', kind: 'integration' as 'integration' | 'gateway' });
  const [nd, setNd] = useState({ id: '', kind: 'ugv' as 'ugv' | 'uav' | 'cctv', model: '', siteId: '' });
  const ndSite = sites.some((x) => x.id === nd.siteId) ? nd.siteId : site?.id;
  const [origins, setOrigins] = useState<EdgeOrigin[]>([]);
  const [no, setNo] = useState('');
  const orgOrigins = origins.filter((o) => !o.siteId).map((o) => o.origin);

  // One tab at a time; coming back from drawing a zone on the map opens the map tab.
  const [tab, setTab] = useState<GroupId>(() => (returningZone() ? 'admin-site' : savedTab()));
  const pickTab = (id: GroupId) => {
    setTab(id);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      /* private window: the tab is simply not remembered */
    }
  };
  // Add/edit forms stay closed behind a button in the card header until needed.
  type FormKey = 'user' | 'key' | 'device' | 'video' | 'zone' | 'anchor';
  const [forms, setForms] = useState<Partial<Record<FormKey, boolean>>>(() => (returningZone() ? { zone: true } : {}));
  const openForm = (k: FormKey, on = true) => setForms((f) => ({ ...f, [k]: on }));
  const addButton = (k: FormKey, label: string) =>
    !forms[k] && (
      <button type="button" className="btn-secondary small" onClick={() => openForm(k)}>
        <Plus size={14} /> {label}
      </button>
    );
  const cancelButton = (k: FormKey, reset?: () => void) => (
    <button
      type="button"
      className="btn-ghost"
      onClick={() => {
        openForm(k, false);
        reset?.();
      }}
    >
      {t('Cancel')}
    </button>
  );

  // The server shows users, keys (with pairing codes and app updates) and backups only within 15 minutes
  // of a password check (step-up). Until then those lists are locked, not empty.
  const [locked, setLocked] = useState<LockedList[]>([]);

  const load = useCallback(async () => {
    const nowLocked: LockedList[] = [];
    const errors: string[] = [];
    // Each list on its own, so one refusal does not leave the whole page empty or showing defaults.
    const get = <T,>(path: string, use: (v: T) => void, lock?: LockedList) =>
      api.get<T>(path).then(use, (e: unknown) => {
        if (lock && e instanceof ApiError && e.code === 'step_up_required') nowLocked.push(lock);
        else errors.push(e instanceof Error ? e.message : String(e));
      });
    await Promise.all([
      get<UserAdminView[]>('/admin/users', setUsers, 'users'),
      get<ApiKeyView[]>('/admin/keys', setKeys, 'keys'),
      get<{ gatewayId: string; devices: string[] }[]>('/admin/gateways', setGws),
      get<Backup[]>('/admin/backups', setBackups, 'backups'),
      get<{ ok: boolean; count: number; brokenAt?: number }>('/audit/verify', setAudit),
      get<LicenseStatus>('/license', setLic),
      get<OrgSettings>('/admin/settings', (st) => {
        setSettings(st);
        setRules(st.detection.rules);
        setRulesDirty(false);
        setRet({
          telemetryDays: String(st.retention.telemetryDays),
          closedIncidentDays: String(st.retention.closedIncidentDays),
          evidenceDays: String(st.retention.evidenceDays),
          detectionDays: String(st.retention.detectionDays),
        });
      }),
      get<EdgeOrigin[]>('/admin/edge-origins', setOrigins),
    ]);
    setLocked(nowLocked);
    setReloads((n) => n + 1);
    if (errors.length) throw new Error(errors[0]);
  }, [api]);

  useEffect(() => {
    load().catch((e) => setMsg({ tone: 'warn', text: e.message }));
  }, [load]);

  /** Asks for the password, then shows the locked lists. */
  const unlock = () =>
    setStepUp(() => () => {
      load().catch((e) => setMsg({ tone: 'warn', text: e.message }));
    });
  const lockNote = (text: string) => <LockedNote text={text} onUnlock={unlock} />;

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

  // What the new-user form still needs, so a grey "Add user" button says why.
  const nuMissing = [
    !nu.name && t('full name'),
    !nu.username && t('username'),
    nu.password.length < 10 &&
      (nu.password ? t('{n} more password characters', { n: 10 - nu.password.length }) : t('a temporary password (10+ characters)')),
  ].filter(Boolean);

  const nuReset = () => setNu({ username: '', name: '', role: 'dispatcher', password: '', siteIds: [] });
  const usersCard = (
    <section className="card">
      <CardHead
        icon={<UserPlus size={16} />}
        title={locked.includes('users') ? t('Users') : t('Users ({n})', { n: users.length })}
        action={addButton('user', t('Add user'))}
      />
      {forms.user && (
        <div className="card-form">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              // The form is cleared and closed only when the user was created; a refusal keeps what was typed.
              void act(async () => {
                await api.post('/admin/users', nu);
                nuReset();
                openForm('user', false);
              }, t('User {name} created.', { name: nu.username }));
            }}
          >
            <input id="nu-name" placeholder={t('Full name')} value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} autoFocus />
            <input id="nu-user" placeholder={t('username')} value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value.toLowerCase() })} />
            <select id="nu-role" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as Role })} aria-label={t('Role')}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
            {sites.length > 1 && (
              <select id="nu-site" value={nu.siteIds[0] ?? ''} onChange={(e) => setNu({ ...nu, siteIds: e.target.value ? [e.target.value] : [] })} aria-label={t('Sites')}>
                <option value="">{t('All sites')}</option>
                {sites.map((x) => (
                  <option key={x.id} value={x.id}>
                    {t('Only {site}', { site: x.name })}
                  </option>
                ))}
              </select>
            )}
            <input id="nu-pw" type="password" placeholder={t('Temporary password (10+ chars)')} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
            <button className="btn-primary" disabled={nuMissing.length > 0}>
              <Plus size={16} /> {t('Add user')}
            </button>
            {cancelButton('user', nuReset)}
          </form>
          {nuMissing.length > 0 && <p className="fine form-hint">{t('To add a user, fill in: {list}', { list: nuMissing.join(', ') })}</p>}
        </div>
      )}
      {locked.includes('users') ? (
        lockNote(t('The user list is hidden until you confirm your password.'))
      ) : (
        <div className="table-wrap">
          <table className="compact">
            <thead>
              <tr>
                <th>{t('Name')}</th>
                <th>{t('Username')}</th>
                <th>{t('Role')}</th>
                {sites.length > 1 && <th>{t('Sites')}</th>}
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
                  {sites.length > 1 && (
                    <td>
                      <SiteAccess
                        id={`sites-${u.id}`}
                        value={u.siteIds ?? []}
                        sites={sites}
                        onChange={(ids) => act(() => api.patch(`/admin/users/${u.id}`, { siteIds: ids }), t('Site access changed for {name}. Their sessions were ended.', { name: u.name }))}
                      />
                    </td>
                  )}
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
      )}
      <details className="role-guide">
        <summary>{t('What each role can do')}</summary>
        <dl className="meta">
          {ROLES.map((r) => (
            <div key={r}>
              <dt>{roleLabel(r)}</dt>
              <dd>{t(ROLE_HINT[r])}</dd>
            </div>
          ))}
        </dl>
        <p className="fine">{t('Two-person rule: whoever approves a mission does not operate it, and whoever sets up a patrol is not its operator.')}</p>
      </details>
    </section>
  );

  const keysCard = (
    <section className="card">
      <CardHead
        icon={<KeyRound size={16} />}
        title={t('API keys')}
        help={t('Integration keys push alerts. Gateway keys connect edge gateways. Keys are tied to this environment.')}
        action={addButton('key', t('Create key'))}
      />
      {forms.key && (
        <div className="card-form">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const r = await api.post<{ secret: string }>('/admin/keys', nk);
                setSecret(r.secret);
                setNk({ label: '', kind: 'integration' });
                openForm('key', false);
              });
            }}
          >
            <input id="nk-label" placeholder={t('Label, e.g. Gate sensors')} value={nk.label} onChange={(e) => setNk({ ...nk, label: e.target.value })} autoFocus />
            <select id="nk-kind" value={nk.kind} onChange={(e) => setNk({ ...nk, kind: e.target.value as 'integration' | 'gateway' })} aria-label={t('Kind')}>
              <option value="integration">{t('Integration (alerts)')}</option>
              <option value="gateway">{t('Edge gateway')}</option>
            </select>
            <button className="btn-primary" disabled={!nk.label}>
              <Plus size={16} /> {t('Create key')}
            </button>
            {cancelButton('key', () => setNk({ label: '', kind: 'integration' }))}
          </form>
          {!nk.label && <p className="fine form-hint">{t('Name the key first, then choose its kind.')}</p>}
        </div>
      )}
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
      {locked.includes('keys') && lockNote(t('The key list is hidden until you confirm your password.'))}
      <ul className="list">
        {!locked.includes('keys') && keys.map((k) => (
          <li key={k.id} className={k.revoked ? 'dim' : ''}>
            <span>
              <b>{k.label}</b>{' '}
              <small className="muted">
                {t(KEY_KIND_LABEL[k.kind] ?? k.kind)} · {t(KEY_ENV_LABEL[k.env] ?? k.env)} · <span className="mono">{k.prefix}…</span> · {fmtDate(k.createdAt)}
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
      {!locked.includes('keys') && keys.length === 0 && <p className="muted">{t('No keys yet.')}</p>}
    </section>
  );

  const ndReset = () => setNd({ id: '', kind: 'ugv', model: '', siteId: nd.siteId });
  const gatewaysCard = (
    <section className="card">
      <CardHead
        icon={<Router size={16} />}
        title={t('Edge gateways and devices')}
        help={t('Register a device before its adapter connects. Until an adapter declares capabilities, the device has no commands.')}
        action={addButton('device', t('Register a device'))}
      />
      {forms.device && (
        <div className="card-form">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const at = sites.find((x) => x.id === ndSite);
              void act(
                async () => {
                  await api.post('/devices', { id: nd.id, kind: nd.kind, model: nd.model, siteId: ndSite });
                  ndReset();
                  openForm('device', false);
                },
                at && sites.length > 1 ? t('{id} registered at {site}.', { id: nd.id, site: at.name }) : t('{id} registered.', { id: nd.id }),
              ).then(() => session!.refreshSites());
            }}
          >
            <input id="nd-id" placeholder={t('Device ID, e.g. UGV-02')} value={nd.id} onChange={(e) => setNd({ ...nd, id: e.target.value.toUpperCase() })} autoFocus />
            <select id="nd-kind" value={nd.kind} onChange={(e) => setNd({ ...nd, kind: e.target.value as 'ugv' | 'uav' | 'cctv' })} aria-label={t('Kind')}>
              <option value="ugv">UGV</option>
              <option value="uav">UAV</option>
              <option value="cctv">CCTV</option>
            </select>
            <input id="nd-model" placeholder={t('Model')} value={nd.model} onChange={(e) => setNd({ ...nd, model: e.target.value })} />
            {sites.length > 1 && (
              <select id="nd-site" value={ndSite} onChange={(e) => setNd({ ...nd, siteId: e.target.value })} aria-label={t('Site')}>
                {sites.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
            <button className="btn-primary" disabled={!nd.id}>
              <Plus size={16} /> {t('Register')}
            </button>
            {cancelButton('device', ndReset)}
          </form>
          {!nd.id && <p className="fine form-hint">{t('Type the device ID to register it.')}</p>}
        </div>
      )}
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
    </section>
  );

  const videoCard = (
    <section className="card">
      <CardHead
        icon={<Video size={16} />}
        title={t('Allowed video sources')}
        help={t(
          'Gateways may only send browsers to media servers on this list: scheme, address and port, for example the edge PC running MediaMTX. Loopback addresses (localhost, 127.x) are refused. A gateway picks up a change when it reconnects.',
        )}
        action={addButton('video', t('Allow a source'))}
      />
      {forms.video && (
        <div className="card-form">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const origin = edgeOriginOf(no);
              if (!origin) {
                setMsg({ tone: 'warn', text: t('Enter an address such as http://192.168.10.50:8889 (a full video link works too).') });
                return;
              }
              void act(async () => {
                await api.put('/admin/edge-origins', { origins: [...new Set([...orgOrigins, origin])] });
                setNo('');
                openForm('video', false);
              }, t('{origin} allowed. Restart the gateway so it declares its video again.', { origin }));
            }}
          >
            <input id="eo-origin" placeholder="http://192.168.10.50:8889" value={no} onChange={(e) => setNo(e.target.value)} aria-label={t('Video source address')} autoFocus />
            <button className="btn-primary" disabled={!no.trim()} title={no.trim() ? undefined : t('Type the media server address first.')}>
              <Plus size={16} /> {t('Allow')}
            </button>
            {cancelButton('video', () => setNo(''))}
          </form>
        </div>
      )}
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
    </section>
  );

  const backupsCard = (
    <section className="card">
      <CardHead
        icon={<DatabaseBackup size={16} />}
        title={t('Backups')}
        help={
          <>
            {t('A backup is a consistent database copy plus evidence files, with checksums. Restore with the server stopped:')}{' '}
            <code>npm run restore -w @13store/server -- &lt;id&gt;</code>.
          </>
        }
        action={
          <button type="button" className="btn-secondary small" onClick={() => act(() => api.post('/admin/backups'), t('Backup created.'))}>
            <DatabaseBackup size={14} /> {t('Back up now')}
          </button>
        }
      />
      {locked.includes('backups')
        ? lockNote(t('The backup list is hidden until you confirm your password.'))
        : backups.length === 0 && <p className="muted">{t('No backups yet.')}</p>}
      <ul className="list">
        {!locked.includes('backups') && backups.map((b) => (
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
    </section>
  );

  const auditCard = (
    <section className="card">
      <CardHead
        icon={<ShieldCheck size={16} />}
        title={t('Audit log integrity')}
        action={
          <button type="button" className="btn-secondary small" onClick={() => act(async () => setAudit(await api.get('/audit/verify')))}>
            {t('Verify again')}
          </button>
        }
      />
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
    </section>
  );

  const licenseCard = (
    <section className="card">
      <CardHead
        icon={<BadgeCheck size={16} />}
        title={t('License')}
        help={t(
          'Install a license by setting LICENSE_FILE on the server and restarting. Licenses are signed; the server only accepts files issued for this organisation.',
        )}
      />
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
        </>
      )}
    </section>
  );

  const retentionCard = (
    <section className="card">
      <CardHead
        icon={<Timer size={16} />}
        title={t('Data retention')}
        help={t('How long personal and operational data is kept, per PDPA. 0 keeps the data. Deletions run every hour and are written to the audit log.')}
      />
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
            {t('Apply retention now')}
          </button>
        </div>
      </form>
    </section>
  );

  const privacyCard = (
    <section className="card">
      <CardHead
        icon={<Eraser size={16} />}
        title={t('Privacy requests')}
        help={t(
          'Find where a name appears in incident titles, timelines, evidence notes and field reports (PDPA access request), then redact it. Erasure keeps the audit trail and needs a request reference.',
        )}
      />
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
  );

  const gisCard = (
    <section className="card">
      <CardHead
        icon={<Globe2 size={16} />}
        title={
          <>
            {t('Site & GIS')}
            {site && sites.length > 1 && <span className="muted"> · {site.name}</span>}
          </>
        }
        help={
          <>
            <p>
              {t(
                'Where the site grid sits on Earth (WGS 84). Positions from real devices are converted with this anchor, every position in the console can be read as latitude/longitude, and the whole site exports as GeoJSON for a city GIS.',
              )}
            </p>
            <p>
              {t(
                "The grid origin is the north-west corner of the site drawing; rotation is how far the drawing's east axis turns clockwise from true east. Take both from a survey or by matching two known points in the GIS.",
              )}
            </p>
          </>
        }
        action={
          !forms.anchor && (
            <button type="button" className="btn-secondary small" onClick={() => openForm('anchor')}>
              {t('Edit anchor')}
            </button>
          )
        }
      />
      <p>
        <b>{t('Anchor')}</b> <span className="mono">{fmtLatLon({ lat: geo.originLat, lon: geo.originLon }, 6)}</span>
        {geo.rotationDeg ? <span className="muted"> · {t('grid rotated {d}°', { d: geo.rotationDeg })}</span> : null}
      </p>
      {forms.anchor && (
        <div className="card-form">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const body: GeoAnchor = { originLat: Number(gaForm.lat), originLon: Number(gaForm.lon), rotationDeg: Number(gaForm.rot || 0) };
              void act(async () => {
                await api.patch(`/sites/${siteKey}/geo`, body);
                setGa(null);
                openForm('anchor', false);
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
            {cancelButton('anchor', () => setGa(null))}
          </form>
        </div>
      )}
      <div className="row gap-s wrap">
        <button
          className="btn-secondary small"
          onClick={() =>
            act(async () => {
              const blob = await api.blob(`/sites/${siteKey}/geojson?download=1`);
              saveBlob(blob, `${site?.id ?? 'site'}-${new Date().toISOString().slice(0, 10)}.geojson`);
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
                const r = await api.post<{ imported: number; errors: string[] }>(site ? `/geofences/import?siteId=${siteKey}` : '/geofences/import', fc);
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
  );

  const zoneFormOpen = !!forms.zone || !!outline;
  const geofencesCard = (
    <section className="card" id="admin-geofences">
      <CardHead
        icon={<Octagon size={16} />}
        title={t('Geofences')}
        help={
          <>
            <p>
              {t(
                'Keep-out zones refuse routes and raise a breach when a vehicle enters; caution zones are noted on the timeline; no-fly zones apply to aircraft. Supervisors can change them too.',
              )}
            </p>
            <p>{t('An operating area is where vehicles may work: once the site has one, routes must stay inside it and leaving it during a mission raises a breach.')}</p>
          </>
        }
        action={!zoneFormOpen && addButton('zone', t('Add a zone'))}
      />
      {zoneFormOpen && (
        <div className="card-form">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const x = Number(ng.x);
              const y = Number(ng.y);
              const w = Number(ng.w);
              const d = Number(ng.d);
              void act(async () => {
                await session!.saveGeofence({
                  name: ng.name.trim(),
                  kind: ng.kind,
                  appliesTo: ng.kind === 'no_fly' ? ['uav'] : ng.uav ? ['ugv', 'uav'] : ['ugv'],
                  reason: ng.reason.trim() || undefined,
                  poly: outline
                    ? outline.points
                    : [
                        { x, y },
                        { x: x + w, y },
                        { x: x + w, y: y + d },
                        { x, y: y + d },
                      ],
                });
                setNg({ ...ng, name: '', reason: '' });
                if (outline) routeDraft.clear();
                openForm('zone', false);
              }, t('Geofence {name} saved.', { name: ng.name.trim() }));
            }}
          >
            <input placeholder={t('Name, e.g. Stage build-up')} value={ng.name} onChange={(e) => setNg({ ...ng, name: e.target.value })} aria-label={t('Name')} />
            <select value={ng.kind} onChange={(e) => setNg({ ...ng, kind: e.target.value as GeofenceKind })} aria-label={t('Kind')}>
              <option value="keep_out">{t('Keep-out')}</option>
              <option value="caution">{t('Caution')}</option>
              <option value="no_fly">{t('No-fly')}</option>
              <option value="operating_area">{t('Operating area')}</option>
            </select>
            {!outline && (
              <>
                <input className="num" placeholder="x" value={ng.x} onChange={(e) => setNg({ ...ng, x: e.target.value })} aria-label="x" />
                <input className="num" placeholder="y" value={ng.y} onChange={(e) => setNg({ ...ng, y: e.target.value })} aria-label="y" />
                <input className="num" placeholder={t('width')} value={ng.w} onChange={(e) => setNg({ ...ng, w: e.target.value })} aria-label={t('width')} />
                <input className="num" placeholder={t('depth')} value={ng.d} onChange={(e) => setNg({ ...ng, d: e.target.value })} aria-label={t('depth')} />
              </>
            )}
            {ng.kind !== 'no_fly' && (
              <label className="check">
                <input type="checkbox" checked={ng.uav} onChange={(e) => setNg({ ...ng, uav: e.target.checked })} /> {t('also aircraft')}
              </label>
            )}
            <input placeholder={t('Reason shown to operators')} value={ng.reason} onChange={(e) => setNg({ ...ng, reason: e.target.value })} aria-label={t('Reason shown to operators')} />
            {outline ? (
              <>
                <button className="btn-primary" disabled={!ng.name.trim()}>
                  <Plus size={16} /> {t('Add drawn zone · {n} corners', { n: outline.points.length })}
                </button>
                <button type="button" className="btn-secondary" onClick={drawZone}>
                  <MapPinned size={16} /> {t('Change on the map')}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    routeDraft.clear();
                    openForm('zone', false);
                  }}
                >
                  {t('Discard outline')}
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn-primary"
                  disabled={!ng.name.trim() || ![ng.x, ng.y, ng.w, ng.d].every((v) => v !== '' && Number.isFinite(Number(v))) || Number(ng.w) <= 0 || Number(ng.d) <= 0}
                >
                  <Plus size={16} /> {t('Add rectangle (site metres)')}
                </button>
                <button type="button" className="btn-secondary" onClick={drawZone}>
                  <MapPinned size={16} /> {t('Draw on the map')}
                </button>
                {cancelButton('zone')}
              </>
            )}
          </form>
          {!ng.name.trim() && <p className="fine form-hint">{t('Name the zone first.')}</p>}
        </div>
      )}
      {geofences.length === 0 && <p className="muted">{t('No zones yet.')}</p>}
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
    </section>
  );

  const rulesCard = (
    <section className="card rules-card">
      <CardHead
        icon={<ScanEye size={16} />}
        title={t('Detection rules')}
        help={t(
          'What AI video analytics, thermal cameras and sensors may raise. Rules are tried top to bottom; the first match decides: raise an incident, log only, or ignore. A repeat from the same camera within the cooldown joins the open incident.',
        )}
      />
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
                        <option value="low">{t('Low')}</option>
                        <option value="medium">{t('Medium')}</option>
                        <option value="high">{t('High')}</option>
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
  );

  return (
    <div className="page admin-page">
      <div className="page-head">
        <div>
          <h1>{t('Administration')}</h1>
          <p className="muted">{t('Users, access, connections and backups. Administrators can also do everything a supervisor can.')}</p>
        </div>
        <button className="btn-secondary" onClick={() => act(load)}>
          <RefreshCw size={16} /> {t('Refresh')}
        </button>
      </div>
      <div className="admin-tabs" role="tablist" aria-label={t('Sections of this page')}>
        {GROUPS.map((g) => {
          const lockedHere = (g.locks as readonly LockedList[]).some((k) => locked.includes(k));
          return (
            <button
              key={g.id}
              id={`${g.id}-tab`}
              type="button"
              role="tab"
              aria-selected={tab === g.id}
              aria-controls={g.id}
              className={`admin-tab ${tab === g.id ? 'on' : ''}`}
              onClick={() => pickTab(g.id)}
            >
              <g.Icon size={16} aria-hidden /> {t(g.title)}
              {lockedHere && <Lock size={13} className="tab-lock" aria-label={t('Some lists here need your password')} />}
            </button>
          );
        })}
      </div>
      {msg && (
        // Stays at the top of the window while scrolling, so the result of a change far down the page is seen.
        <div className={`banner admin-msg ${msg.tone === 'ok' ? 'info' : 'warn'}`} role="status">
          {/* Server messages arrive in English; messages made here are already translated (t leaves them as they are). */}
          <span>{t(msg.text)}</span>
          <button type="button" className="icon-btn" title={t('Close')} aria-label={t('Close')} onClick={() => setMsg(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <AdminGroup id="admin-people" tab={tab}>
        {usersCard}
        {keysCard}
      </AdminGroup>

      <AdminGroup id="admin-devices" tab={tab}>
        <div className="admin-cols">
          <div className="admin-col">
            {gatewaysCard}
            {videoCard}
          </div>
          <div className="admin-col">
            <EdgePairingCard api={api} act={act} registered={Object.keys(devices)} reloadKey={reloads} sites={sites} currentSiteId={site?.id} />
            <EdgeAppCard
              api={api}
              act={act}
              reloadKey={reloads}
              lockNote={locked.includes('keys') ? lockNote(t('The published version is hidden until you confirm your password.')) : undefined}
            />
          </div>
        </div>
      </AdminGroup>

      <AdminGroup id="admin-site" tab={tab}>
        <div className="admin-cols">
          <div className="admin-col">
            <SitesCard act={act} limit={lic?.limits.sites} />
            {gisCard}
          </div>
          <div className="admin-col">{geofencesCard}</div>
        </div>
      </AdminGroup>

      <AdminGroup id="admin-alerts" tab={tab}>
        <NotificationChannels onStepUp={(retry) => setStepUp(() => retry)} />
        {rulesCard}
      </AdminGroup>

      <AdminGroup id="admin-system" tab={tab}>
        <div className="admin-cols">
          <div className="admin-col">
            {licenseCard}
            {auditCard}
            {privacyCard}
          </div>
          <div className="admin-col">
            {backupsCard}
            {retentionCard}
          </div>
        </div>
      </AdminGroup>
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
