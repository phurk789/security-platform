import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  BellOff,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  CloudOff,
  Copy,
  Hand,
  ImageOff,
  LogOut,
  MapPin,
  Phone,
  RefreshCw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import type { Assignment, AssignmentStatus, ConsoleMessage, Incident, LoginResponse, Meta, SessionUser, TimelineEvent } from '@13store/shared';
import { ApiFailure, api, store } from './api';
import { ASSIGNMENT_LABEL, INCIDENT_LABEL, OUTBOX_LABEL, fmtAgo, fmtClock, t, type Key, type Lang } from './i18n';
import { downscale } from './image';
import { outbox, type OutboxItem } from './outbox';

const SESSION_KEY = 'ps-field.session.v1';
const LANG_KEY = 'ps-field.lang';
const CONTROL_ROOM = '02-000-0000';

interface Session {
  token: string;
  user: SessionUser;
}

function loadSession(): Session | null {
  try {
    const s = JSON.parse(store.get(SESSION_KEY) ?? 'null') as Session | null;
    return s?.token && s.user ? s : null;
  } catch {
    return null;
  }
}

export function App() {
  const [lang, setLang] = useState<Lang>(() => (store.get(LANG_KEY) === 'en' ? 'en' : 'th'));
  const [session, setSession] = useState<Session | null>(loadSession);
  const [notice, setNotice] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const L = useCallback((k: Key) => t(lang, k), [lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
    store.set(LANG_KEY, lang);
  }, [lang]);

  useEffect(() => {
    api<Meta>(null, 'GET', '/meta').then(setMeta, () => undefined);
  }, []);

  const signOut = useCallback(
    async (opts: { expired?: boolean } = {}) => {
      if (session && !opts.expired) {
        await forgetPushOnServer(session.token);
        api(session.token, 'POST', '/auth/logout').catch(() => undefined);
      }
      store.del(SESSION_KEY);
      setSession(null);
      if (opts.expired) setNotice(t(lang, 'sessionEnded'));
    },
    [session, lang],
  );

  const top = <TopBar lang={lang} setLang={setLang} meta={meta} L={L} />;

  if (!session)
    return (
      <div className="app">
        {top}
        <Login
          L={L}
          notice={notice}
          onLogin={(r) => {
            const s = { token: r.token, user: r.user };
            store.set(SESSION_KEY, JSON.stringify(s));
            setNotice(null);
            setSession(s);
          }}
        />
      </div>
    );

  return <Main session={session} lang={lang} L={L} top={top} onSignOut={signOut} />;
}

// ---------------------------------------------------------------------------

function TopBar({ lang, setLang, meta, L }: { lang: Lang; setLang: (l: Lang) => void; meta: Meta | null; L: (k: Key) => string }) {
  return (
    <header className="top">
      <div className="brand">
        <span className="logo">
          13<b>STORE</b>
        </span>
        <span className="app-name">{L('appName')}</span>
      </div>
      <div className="top-right">
        {meta && <span className={`env env-${meta.dataLabel === 'LIVE' ? 'live' : 'sim'}`}>{meta.dataLabel}</span>}
        <div className="lang" role="group" aria-label="Language">
          <button className={lang === 'th' ? 'on' : ''} onClick={() => setLang('th')}>
            TH
          </button>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>
            EN
          </button>
        </div>
      </div>
    </header>
  );
}

function Login({ L, onLogin, notice }: { L: (k: Key) => string; onLogin: (r: LoginResponse) => void; notice: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <main className="login">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await api<LoginResponse>(null, 'POST', '/auth/login', { username: username.trim(), password });
            if (r.user.role !== 'responder') {
              setErr('This app is for field responders. Use the command centre console for other roles.');
              api(r.token, 'POST', '/auth/logout').catch(() => undefined);
            } else onLogin(r);
          } catch (e) {
            const f = e as ApiFailure;
            setErr(f.network ? L('offlineLogin') : `${L('loginFailed')}: ${f.message}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>{L('signIn')}</h1>
        {notice && <p className="banner warn">{notice}</p>}
        <label className="field">
          <span>{L('username')}</span>
          <input id="username" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span>{L('password')}</span>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {err && (
          <p className="banner error" role="alert">
            {err}
          </p>
        )}
        <button className="btn primary big" disabled={busy || !username || !password}>
          {busy ? L('signingIn') : L('signIn')}
        </button>
        <p className="fine">{L('noDeviceControl')}</p>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------

type Conn = 'live' | 'connecting' | 'offline';

function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function useOutbox(userId: string) {
  const [items, setItems] = useState<OutboxItem[]>(() => outbox.list(userId));
  useEffect(() => {
    const off = outbox.subscribe(() => setItems(outbox.list(userId)));
    setItems(outbox.list(userId));
    return () => {
      off();
    };
  }, [userId]);
  return items;
}

// ---------------------------------------------------------------------------
// Web Push: the service worker (public/sw.js) shows alerts while the app is closed.

type PushState = 'unsupported' | 'off' | 'on' | 'denied' | 'busy';
interface PushControl {
  state: PushState;
  error: boolean;
  toggle: () => Promise<void>;
}

const SW_URL = `${import.meta.env.BASE_URL}sw.js`;

function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function base64UrlToBytes(s: string) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function subscriptionBody(sub: PushSubscription) {
  return { endpoint: sub.endpoint, keys: sub.toJSON().keys, ua: navigator.userAgent.slice(0, 200) };
}

/** Sign-out: stop alerts for this user on the server; the browser subscription stays for the next sign-in. */
async function forgetPushOnServer(token: string) {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await api(token, 'DELETE', '/push/subscribe', { endpoint: sub.endpoint });
  } catch {
    /* best effort */
  }
}

function usePush(token: string, onOpen: (url: string) => void): PushControl {
  const supported = pushSupported();
  const [state, setState] = useState<PushState>(supported ? 'busy' : 'unsupported');
  const [error, setError] = useState(false);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    if (!supported) return;
    let gone = false;
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; url?: string } | null;
      if (d?.type === 'open' && typeof d.url === 'string') openRef.current(d.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register(SW_URL, { scope: import.meta.env.BASE_URL });
        regRef.current = reg;
        const sub = await reg.pushManager.getSubscription();
        if (gone) return;
        if (sub && Notification.permission === 'granted') {
          setState('on');
          // Keep the server's copy current for this user (idempotent).
          api(token, 'POST', '/push/subscribe', subscriptionBody(sub)).catch(() => undefined);
        } else setState(Notification.permission === 'denied' ? 'denied' : 'off');
      } catch {
        if (!gone) setState('unsupported');
      }
    })();
    return () => {
      gone = true;
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, [token, supported]);

  const toggle = useCallback(async () => {
    const reg = regRef.current;
    if (!reg || state === 'busy') return;
    setError(false);
    setState('busy');
    try {
      const current = await reg.pushManager.getSubscription();
      if (current) {
        await api(token, 'DELETE', '/push/subscribe', { endpoint: current.endpoint }).catch(() => undefined);
        await current.unsubscribe();
        setState('off');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const { publicKey } = await api<{ publicKey: string }>(token, 'GET', '/push/vapid');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
      try {
        await api(token, 'POST', '/push/subscribe', subscriptionBody(sub));
      } catch (e) {
        await sub.unsubscribe().catch(() => undefined);
        throw e;
      }
      setState('on');
    } catch {
      setError(true);
      setState(Notification.permission === 'denied' ? 'denied' : 'off');
    }
  }, [token, state]);

  return { state, error, toggle };
}

interface Cache {
  assignments: Assignment[];
  incidents: Incident[];
  at: number;
}

function Main({ session, lang, L, top, onSignOut }: { session: Session; lang: Lang; L: (k: Key) => string; top: React.ReactNode; onSignOut: (o?: { expired?: boolean }) => void }) {
  const { token, user } = session;
  const cacheKey = `ps-field.cache.${user.id}`;
  const [data, setData] = useState<Cache | null>(() => {
    try {
      return JSON.parse(store.get(cacheKey) ?? 'null');
    } catch {
      return null;
    }
  });
  const [timelines, setTimelines] = useState<Record<string, TimelineEvent[]>>({});
  const [conn, setConn] = useState<Conn>('connecting');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(() => decodeURIComponent(location.hash.match(/^#task\/(.+)$/)?.[1] ?? '') || null);
  const items = useOutbox(user.id);
  const now = useNow();
  // A tapped notification tells the service worker which task to open.
  const push = usePush(token, (url) => {
    location.hash = url.split('#')[1] ?? '';
  });

  const expired = useCallback(() => onSignOut({ expired: true }), [onSignOut]);

  const refresh = useCallback(async () => {
    try {
      const [assignments, incidents] = await Promise.all([api<Assignment[]>(token, 'GET', '/assignments'), api<Incident[]>(token, 'GET', '/incidents')]);
      const next = { assignments, incidents, at: Date.now() };
      setData(next);
      store.set(cacheKey, JSON.stringify(next));
    } catch (e) {
      if ((e as ApiFailure).status === 401) expired();
    }
  }, [token, cacheKey, expired]);

  const loadTimeline = useCallback(
    async (incidentId: string) => {
      try {
        const tl = await api<TimelineEvent[]>(token, 'GET', `/incidents/${encodeURIComponent(incidentId)}/timeline`);
        setTimelines((m) => ({ ...m, [incidentId]: tl }));
      } catch (e) {
        if ((e as ApiFailure).status === 401) expired();
      }
    },
    [token, expired],
  );

  const flush = useCallback(async () => {
    if (!outbox.list(user.id).some((i) => i.state === 'pending')) return;
    setSyncing(true);
    const r = await outbox.flush(token, user.id);
    setSyncing(false);
    if (r === 'auth') expired();
    if (r === 'sent') refresh();
  }, [token, user.id, refresh, expired]);

  // Initial load, periodic retry, and online/offline tracking.
  useEffect(() => {
    refresh();
    flush();
    const id = setInterval(() => flush(), 10_000);
    const on = () => {
      setOnline(true);
      flush();
      refresh();
    };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      clearInterval(id);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [refresh, flush]);

  // Live updates over WebSocket, with backoff.
  const dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      setConn('connecting');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws`);
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (ev) => {
        let m: ConsoleMessage;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.type === 'hello') {
          delay = 1000;
          setConn('live');
          refresh();
          flush();
          return;
        }
        if (m.type === 'assignment') {
          setData((d) => (d ? { ...d, assignments: upsert(d.assignments, m.assignment) } : d));
          if (!dataRef.current?.incidents.some((i) => i.id === m.assignment.incidentId)) refresh();
        } else if (m.type === 'incident') {
          setData((d) => (d ? { ...d, incidents: upsert(d.incidents, m.incident) } : d));
        } else if (m.type === 'timeline') {
          setTimelines((tl) => (tl[m.event.incidentId] ? { ...tl, [m.event.incidentId]: upsert(tl[m.event.incidentId], m.event) } : tl));
        } else if (m.type === 'resync') {
          refresh();
        }
      };
      ws.onclose = (ev) => {
        setConn('offline');
        if (stopped) return;
        if (ev.code === 4401) {
          // Session no longer valid; confirm with a normal request before signing out.
          api(token, 'GET', '/auth/me').catch((e) => (e as ApiFailure).status === 401 && expired());
        }
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15_000);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [token]);

  // Hash routing so the phone's back button works.
  useEffect(() => {
    const onHash = () => setOpenId(decodeURIComponent(location.hash.match(/^#task\/(.+)$/)?.[1] ?? '') || null);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const open = (id: string | null) => {
    location.hash = id ? `task/${encodeURIComponent(id)}` : '';
  };

  const incidents = useMemo(() => new Map((data?.incidents ?? []).map((i) => [i.id, i])), [data]);
  const assignment = openId ? data?.assignments.find((a) => a.id === openId) : undefined;

  useEffect(() => {
    if (assignment) loadTimeline(assignment.incidentId);
  }, [assignment?.incidentId, loadTimeline]);

  return (
    <div className="app">
      {top}
      <div className="subbar">
        <span className={`conn conn-${online ? conn : 'offline'}`}>
          <span className="dot" /> {L(online ? conn : 'offline')}
        </span>
        <span className="who">
          {user.name} · {user.title}
        </span>
        {push.state !== 'unsupported' && (
          <button
            className="icon-btn"
            style={push.state === 'on' ? { color: 'var(--accent)' } : undefined}
            aria-label={push.state === 'on' ? L('notifDisable') : L('notifEnable')}
            aria-pressed={push.state === 'on'}
            title={push.state === 'on' ? L('notifDisable') : L('notifEnable')}
            disabled={push.state === 'busy'}
            onClick={() => push.toggle()}
          >
            {push.state === 'on' ? <Bell size={20} /> : <BellOff size={20} />}
          </button>
        )}
        <button
          className="icon-btn"
          aria-label={L('signOut')}
          title={L('signOut')}
          onClick={() => {
            if (items.length && !confirmInline(L('signOutPending'))) return;
            onSignOut();
          }}
        >
          <LogOut size={20} />
        </button>
      </div>
      <SyncBanner items={items} online={online} syncing={syncing} L={L} lang={lang} onSync={flush} />
      {!outbox.persisted && <p className="banner warn">{L('storageFull')}</p>}
      {assignment ? (
        <TaskDetail
          a={assignment}
          inc={incidents.get(assignment.incidentId)}
          timeline={timelines[assignment.incidentId]}
          items={items.filter((i) => i.assignmentId === assignment.id)}
          userId={user.id}
          L={L}
          lang={lang}
          now={now}
          onBack={() => open(null)}
          onQueued={flush}
        />
      ) : (
        <TaskList data={data} incidents={incidents} userId={user.id} items={items} L={L} lang={lang} now={now} onOpen={open} push={push} />
      )}
    </div>
  );
}

/** The app frame has no confirm() dialog in some webviews; fall back to allowing the action. */
function confirmInline(message: string) {
  try {
    return window.confirm(message);
  } catch {
    return true;
  }
}

function upsert<T extends { id: string }>(list: T[], x: T): T[] {
  const i = list.findIndex((y) => y.id === x.id);
  if (i === -1) return [...list, x];
  const next = list.slice();
  next[i] = x;
  return next;
}

// ---------------------------------------------------------------------------

function SyncBanner({
  items,
  online,
  syncing,
  L,
  lang,
  onSync,
}: {
  items: OutboxItem[];
  online: boolean;
  syncing: boolean;
  L: (k: Key) => string;
  lang: Lang;
  onSync: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const pending = items.filter((i) => i.state === 'pending').length;
  const failed = items.length - pending;
  return (
    <section className={`sync ${failed ? 'has-failed' : ''}`} aria-live="polite">
      <div className="sync-row">
        <CloudOff size={20} />
        <button className="sync-txt" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <b>
            {L('waitingSync')} ({pending})
          </b>
          {failed > 0 && (
            <span className="failed-count">
              {L('failed')} {failed}
            </span>
          )}
          <small>{online ? '' : L('offlineNote')}</small>
        </button>
        <button className="btn small" onClick={onSync} disabled={syncing || !pending}>
          <RefreshCw size={16} className={syncing ? 'spin' : ''} /> {syncing ? L('syncing') : L('syncNow')}
        </button>
      </div>
      {(open || failed > 0) && (
        <ul className="outbox">
          {items.map((i) => (
            <li key={i.id} className={i.state}>
              <span className="ob-kind">
                {OUTBOX_LABEL[i.kind][lang]} · {i.incidentId}
              </span>
              <span className={`pill ${i.state === 'failed' ? 'red' : 'amber'}`}>{i.state === 'failed' ? L('failed') : L('pending')}</span>
              {i.error && <small className="err">{i.error}</small>}
              {i.state === 'failed' && (
                <span className="ob-actions">
                  <button className="btn small" onClick={() => outbox.retry(i.id)}>
                    <RefreshCw size={14} /> {L('retry')}
                  </button>
                  <button className="btn small danger" onClick={() => outbox.discard(i.id)}>
                    <Trash2 size={14} /> {L('discard')}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskList({
  data,
  incidents,
  userId,
  items,
  L,
  lang,
  now,
  onOpen,
  push,
}: {
  data: Cache | null;
  incidents: Map<string, Incident>;
  userId: string;
  items: OutboxItem[];
  L: (k: Key) => string;
  lang: Lang;
  now: number;
  onOpen: (id: string) => void;
  push: PushControl;
}) {
  if (!data) return <p className="empty">{L('loading')}</p>;
  void items;
  const order: Record<AssignmentStatus, number> = { assigned: 0, accepted: 1, on_scene: 2, reported: 3, cancelled: 4 };
  const list = data.assignments.map((a) => ({ a, s: outbox.effectiveStatus(a, userId) })).sort((x, y) => order[x.s] - order[y.s] || y.a.updatedAt - x.a.updatedAt);
  return (
    <main className="list">
      <h1>{L('myTasks')}</h1>
      {list.length === 0 && <p className="empty">{L('noTasks')}</p>}
      {list.map(({ a, s }) => {
        const inc = incidents.get(a.incidentId);
        const queued = s !== a.status;
        return (
          <button key={a.id} className={`task st-${s}`} onClick={() => onOpen(a.id)}>
            <div className="task-main">
              <div className="row between">
                <b className="mono">{a.incidentId}</b>
                <span className={`pill ${pillTone(s)}`}>
                  {ASSIGNMENT_LABEL[s][lang]}
                  {queued ? ` · ${L('pending')}` : ''}
                </span>
              </div>
              <div className="task-title">{inc?.title ?? '—'}</div>
              <div className="muted row gap">
                <MapPin size={16} /> {inc ? `${inc.place} · ${inc.zone}` : ''}
              </div>
              {inc && (
                <div className="muted row gap">
                  <Clock size={16} /> {fmtClock(inc.createdAt, lang)} · {fmtAgo(inc.createdAt, now, lang)}
                </div>
              )}
            </div>
            <ChevronRight size={22} className="chev" />
          </button>
        );
      })}
      <NotificationsCard push={push} L={L} />
      <Contact L={L} />
    </main>
  );
}

/** Settings card: turn Web Push alerts for this phone on or off. */
function NotificationsCard({ push, L }: { push: PushControl; L: (k: Key) => string }) {
  const on = push.state === 'on';
  return (
    <section className="card notif" aria-labelledby="notif-title">
      <h2 id="notif-title">
        {on ? <Bell size={18} /> : <BellOff size={18} />} {L('notifications')}
      </h2>
      {push.state === 'unsupported' ? (
        <small className="muted">{L('notifUnsupported')}</small>
      ) : (
        <>
          <div className="row between gap">
            <small className="muted">{L('notifHint')}</small>
            <button className={`btn small ${on ? 'primary' : ''}`} aria-pressed={on} disabled={push.state === 'busy' || push.state === 'denied'} onClick={() => push.toggle()}>
              {on ? <Bell size={16} /> : <BellOff size={16} />} {push.state === 'busy' ? L('notifBusy') : on ? L('notifOn') : L('notifOff')}
            </button>
          </div>
          {push.state === 'denied' && <p className="banner warn">{L('notifDenied')}</p>}
          {push.error && <p className="banner error">{L('notifFailed')}</p>}
        </>
      )}
    </section>
  );
}

function pillTone(s: AssignmentStatus) {
  return s === 'assigned' ? 'amber' : s === 'reported' ? 'green' : s === 'cancelled' ? 'grey' : 'cyan';
}

function Contact({ L }: { L: (k: Key) => string }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <section className="contact card">
      <h2>
        <Phone size={18} /> {L('contact')}
      </h2>
      <p className="phone">
        <span ref={ref} className="mono sel">
          {CONTROL_ROOM}
        </span>
        <button
          className="btn small"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(CONTROL_ROOM);
              setCopied(true);
            } catch {
              const r = document.createRange();
              if (ref.current) {
                r.selectNodeContents(ref.current);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(r);
              }
            }
          }}
        >
          <Copy size={14} /> {copied ? L('copied') : L('copy')}
        </button>
      </p>
      <small className="muted">{L('contactHint')}</small>
    </section>
  );
}

// ---------------------------------------------------------------------------

function TaskDetail({
  a,
  inc,
  timeline,
  items,
  userId,
  L,
  lang,
  now,
  onBack,
  onQueued,
}: {
  a: Assignment;
  inc?: Incident;
  timeline?: TimelineEvent[];
  items: OutboxItem[];
  userId: string;
  L: (k: Key) => string;
  lang: Lang;
  now: number;
  onBack: () => void;
  onQueued: () => void;
}) {
  const s = outbox.effectiveStatus(a, userId);
  const queued = s !== a.status;
  const [reporting, setReporting] = useState(false);
  const queue = (kind: 'accept' | 'arrive') => {
    outbox.add({ userId, kind, assignmentId: a.id, incidentId: a.incidentId });
    onQueued();
  };
  return (
    <main className="detail">
      <button className="back" onClick={onBack}>
        <ArrowLeft size={20} /> {L('back')}
      </button>
      <section className="card head">
        <div className="row between">
          <b className="mono big-id">{a.incidentId}</b>
          <span className={`pill ${queued ? 'amber' : pillTone(s)}`}>
            {ASSIGNMENT_LABEL[s][lang]}
            {queued ? ` · ${L('pending')}` : ''}
          </span>
        </div>
        <h1>{inc?.title ?? '—'}</h1>
        {inc && (
          <dl className="meta">
            <div>
              <dt>{L('place')}</dt>
              <dd>{inc.place}</dd>
            </div>
            <div>
              <dt>{L('zone')}</dt>
              <dd>{inc.zone}</dd>
            </div>
            <div>
              <dt>{L('received')}</dt>
              <dd>
                {fmtClock(inc.createdAt, lang)} · {fmtAgo(inc.createdAt, now, lang)}
              </dd>
            </div>
            <div>
              <dt>{L('incidentStatus')}</dt>
              <dd>{INCIDENT_LABEL[inc.status][lang]}</dd>
            </div>
          </dl>
        )}
        {items.length > 0 && (
          <p className="banner warn">
            <CloudOff size={16} /> {L('waitingSync')}: {items.map((i) => OUTBOX_LABEL[i.kind][lang]).join(', ')}
          </p>
        )}
      </section>

      <section className="action">
        {s === 'assigned' && (
          <button className="btn primary big" onClick={() => queue('accept')}>
            <Hand size={22} /> {L('accept')}
          </button>
        )}
        {s === 'accepted' && (
          <button className="btn primary big" onClick={() => queue('arrive')}>
            <MapPin size={22} /> {L('arrive')}
          </button>
        )}
        {s === 'on_scene' && !reporting && (
          <button className="btn primary big" onClick={() => setReporting(true)}>
            <Send size={22} /> {L('report')}
          </button>
        )}
        {s === 'on_scene' && reporting && (
          <ReportForm
            L={L}
            onCancel={() => setReporting(false)}
            onSubmit={(note, photos) => {
              for (const p of photos) outbox.add({ userId, kind: 'evidence', assignmentId: a.id, incidentId: a.incidentId, photo: p });
              outbox.add({ userId, kind: 'report', assignmentId: a.id, incidentId: a.incidentId, note });
              setReporting(false);
              onQueued();
            }}
          />
        )}
        {s === 'reported' && queued && (
          <p className="banner warn">
            <CloudOff size={18} /> {L('savedOnPhone')}
          </p>
        )}
        {s === 'reported' && !queued && (
          <p className="banner ok">
            <Check size={18} /> {L('done')}
          </p>
        )}
        {s === 'cancelled' && <p className="banner warn">{L('cancelledTask')}</p>}
      </section>

      <section className="card">
        <h2>{L('timeline')}</h2>
        {!timeline && <p className="muted">{L('loading')}</p>}
        <ol className="tl">
          {(timeline ?? [])
            .slice()
            .sort((x, y) => y.at - x.at)
            .map((e) => (
              <li key={e.id} className={`tone-${e.tone ?? 'info'}`}>
                <span className="mono tl-time">{fmtClock(e.at, lang)}</span>
                <div>
                  <b>{e.title}</b>
                  <small className="muted">
                    {e.actor}
                    {e.detail ? ` — ${e.detail}` : ''}
                  </small>
                </div>
              </li>
            ))}
        </ol>
      </section>
      <Contact L={L} />
    </main>
  );
}

type Photo = NonNullable<OutboxItem['photo']>;

function ReportForm({ L, onSubmit, onCancel }: { L: (k: Key) => string; onSubmit: (note: string, photos: Photo[]) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<(Photo & { preview: string })[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card report"
      onSubmit={(e) => {
        e.preventDefault();
        if (!note.trim()) return setErr(L('noteRequired'));
        onSubmit(
          note.trim(),
          photos.map(({ preview: _p, ...rest }) => rest),
        );
      }}
    >
      <label className="field">
        <span>{L('note')}</span>
        <textarea id="report-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder={L('notePlaceholder')} />
      </label>
      <div className="photos">
        {photos.map((p, i) => (
          <figure key={i}>
            <img src={p.preview} alt={p.title} />
            <button type="button" className="icon-btn rm" aria-label={L('removePhoto')} onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))}>
              <X size={16} />
            </button>
          </figure>
        ))}
      </div>
      <label className={`btn big file ${busy ? 'busy' : ''}`}>
        <Camera size={22} /> {L('addPhoto')}
        <input
          id="report-photo"
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            setBusy(true);
            setErr(null);
            for (const f of files) {
              try {
                const d = await downscale(f);
                setPhotos((ps) => [
                  ...ps,
                  {
                    mime: d.mime,
                    base64: d.base64,
                    title: `${L('photo')} ${ps.length + 1}`,
                    capturedAt: f.lastModified || Date.now(),
                    preview: `data:${d.mime};base64,${d.base64}`,
                  },
                ]);
              } catch {
                setErr(L('photoFailed'));
              }
            }
            setBusy(false);
          }}
        />
      </label>
      {err && (
        <p className="banner error">
          {err === L('photoFailed') ? <ImageOff size={16} /> : <CircleAlert size={16} />} {err}
        </p>
      )}
      <div className="row gap">
        <button type="button" className="btn big grow" onClick={onCancel}>
          {L('cancel')}
        </button>
        <button className="btn primary big grow" disabled={busy}>
          <Send size={20} /> {L('sendReport')}
        </button>
      </div>
    </form>
  );
}
