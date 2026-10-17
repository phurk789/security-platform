// Web Push (RFC 8030 / 8291 / 8292) so field responders and supervisors are alerted on their phones
// while the app is closed. A signed-in user registers the browser's push subscription here; the
// platform sends short alerts (new task, high-severity incident, SLA breach) to every device the
// user registered. Each request is VAPID-signed and the payload is aes128gcm-encrypted by the
// `web-push` package; the HTTP call itself is made here so the endpoint can be plain http on
// loopback in tests. Subscriptions a push service reports gone (404/410) are deleted; other
// failures are counted. Sending never throws into the caller's flow.
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import webpush from 'web-push';
import type { Config } from './config';
import type { DB } from './db';
import type { Metrics } from './metrics';
import { ApiError, type Actor } from './platform';

// ---------------------------------------------------------------------------
// VAPID keys
// ---------------------------------------------------------------------------

export interface Vapid {
  publicKey: string;
  privateKey: string;
  /** Contact for the push services: mailto: address or https: URL. */
  subject: string;
}

export const DEFAULT_VAPID_SUBJECT = 'mailto:security-ops@example.com';

/** Keys from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or generated once into DATA_DIR/vapid.json (mode 0600). */
export function initVapid(cfg: Pick<Config, 'dataDir' | 'vapidPublicKey' | 'vapidPrivateKey' | 'vapidSubject'>): Vapid & { source: 'env' | 'file' | 'generated'; file?: string } {
  const subject = cfg.vapidSubject || DEFAULT_VAPID_SUBJECT;
  if (!/^(mailto:|https:)/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto: address or an https: URL.');
  if (cfg.vapidPublicKey || cfg.vapidPrivateKey) {
    if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) throw new Error('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither.');
    if (Buffer.from(cfg.vapidPublicKey, 'base64url').length !== 65) throw new Error('VAPID_PUBLIC_KEY must be a 65-byte P-256 point, base64url.');
    if (Buffer.from(cfg.vapidPrivateKey, 'base64url').length !== 32) throw new Error('VAPID_PRIVATE_KEY must be 32 bytes, base64url.');
    return { publicKey: cfg.vapidPublicKey, privateKey: cfg.vapidPrivateKey, subject, source: 'env' };
  }
  const file = join(cfg.dataDir, 'vapid.json');
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Vapid>;
    if (!j.publicKey || !j.privateKey) throw new Error(`${file} must contain publicKey and privateKey.`);
    return { publicKey: j.publicKey, privateKey: j.privateKey, subject: cfg.vapidSubject || j.subject || DEFAULT_VAPID_SUBJECT, source: 'file', file };
  }
  mkdirSync(dirname(file), { recursive: true });
  const k = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify({ publicKey: k.publicKey, privateKey: k.privateKey, subject, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without modes */
  }
  return { publicKey: k.publicKey, privateKey: k.privateKey, subject, source: 'generated', file };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
  keys TEXT NOT NULL, ua TEXT, created_at INTEGER NOT NULL, last_ok_at INTEGER, failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(org_id, user_id);
`;

type Row = {
  id: string;
  org_id: string;
  user_id: string;
  endpoint: string;
  keys: string;
  ua: string | null;
  created_at: number;
  last_ok_at: number | null;
  failures: number;
};

export interface PushKeys {
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap takes the user (same origin), e.g. `/field/#task/ASG-12`. */
  url?: string;
  /** Notifications with the same tag replace each other on the phone. */
  tag?: string;
  incidentId?: string;
}

export interface PushSubscriptionInfo {
  id: string;
  /** Masked: origin and the start of the path only. */
  endpoint: string;
  ua?: string;
  createdAt: number;
  lastOkAt?: number;
  failures: number;
}

export interface SendStats {
  subscriptions: number;
  sent: number;
  failed: number;
  removed: number;
}

export const MAX_SUBSCRIPTIONS_PER_USER = 10;
/** Push services keep an undelivered alert this long (seconds). */
export const PUSH_TTL_S = 300;
export const PUSH_TIMEOUT_MS = 8_000;
export const MAX_TITLE = 60;
export const MAX_BODY = 140;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Push endpoints are https URLs. Plain http is accepted for loopback only (local tests). */
export function validateEndpoint(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 2000) throw new ApiError(400, 'invalid', 'endpoint must be the subscription URL.');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ApiError(400, 'invalid', 'endpoint must be a valid URL.');
  }
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  if (!ok || u.username || u.password) throw new ApiError(400, 'invalid', 'The push endpoint must be an https URL.');
  return u.href;
}

function decode(s: string): Buffer | null {
  if (s.length > 200 || !/^[A-Za-z0-9_+/-]+={0,2}$/.test(s)) return null;
  return Buffer.from(s, 'base64');
}

/** `keys` as the browser's PushSubscription.toJSON() gives them; returned normalised to base64url. */
export function validateKeys(v: unknown): PushKeys {
  const k = (v ?? {}) as { p256dh?: unknown; auth?: unknown };
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') throw new ApiError(400, 'invalid', 'keys.p256dh and keys.auth are required.');
  const p = decode(k.p256dh);
  const a = decode(k.auth);
  if (!p || p.length !== 65 || p[0] !== 0x04) throw new ApiError(400, 'invalid', 'keys.p256dh must be a 65-byte uncompressed P-256 point (base64url).');
  if (!a || a.length < 16 || a.length > 32) throw new ApiError(400, 'invalid', 'keys.auth must be the 16-byte auth secret (base64url).');
  return { p256dh: p.toString('base64url'), auth: a.toString('base64url') };
}

export function maskEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint);
    return `${u.origin}${u.pathname.slice(0, 12)}${u.pathname.length > 12 || u.search ? '…' : ''}`;
  } catch {
    return endpoint.slice(0, 24) + '…';
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function clipPayload(p: PushPayload): PushPayload {
  const out: PushPayload = { title: clip(String(p.title ?? '').trim(), MAX_TITLE), body: clip(String(p.body ?? '').trim(), MAX_BODY) };
  if (p.url && p.url.startsWith('/')) out.url = p.url.slice(0, 200);
  if (p.tag) out.tag = String(p.tag).slice(0, 60);
  if (p.incidentId) out.incidentId = String(p.incidentId).slice(0, 40);
  return out;
}

/** One HTTP(S) request to a push service; resolves with the status code, rejects on network errors. */
function request(endpoint: string, method: string, headers: Record<string, string | number>, body: Buffer | null, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('push service timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PushService {
  readonly publicKey: string;
  readonly subject: string;
  private readonly now: () => number;
  private inflight = 0;

  constructor(
    private readonly db: DB,
    private readonly vapid: Vapid,
    private readonly opts: { now?: () => number; metrics?: Metrics } = {},
  ) {
    db.exec(SCHEMA);
    this.publicKey = vapid.publicKey;
    this.subject = vapid.subject;
    this.now = opts.now ?? Date.now;
  }

  /** Deliveries still in flight (tests). */
  get pending() {
    return this.inflight;
  }

  private user(a: Actor): string {
    if (a.kind !== 'user' || !a.userId) throw new ApiError(403, 'forbidden', 'Only a signed-in user can register a phone for notifications.');
    return a.userId;
  }

  private row(id: string) {
    return this.db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as Row | undefined;
  }

  private info(r: Row): PushSubscriptionInfo {
    return { id: r.id, endpoint: maskEndpoint(r.endpoint), ua: r.ua ?? undefined, createdAt: r.created_at, lastOkAt: r.last_ok_at ?? undefined, failures: r.failures };
  }

  /** Registers (or refreshes) the calling user's browser subscription. At most 10 devices per user. */
  subscribe(a: Actor, input: { endpoint?: unknown; keys?: unknown; ua?: unknown }): PushSubscriptionInfo & { created: boolean } {
    const userId = this.user(a);
    const endpoint = validateEndpoint(input.endpoint);
    const keys = validateKeys(input.keys);
    const ua = typeof input.ua === 'string' && input.ua.trim() ? input.ua.trim().slice(0, 200) : null;
    const existing = this.db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as { id: string } | undefined;
    if (existing) {
      // Same browser, possibly another user signed in: the device follows the current user.
      this.db
        .prepare('UPDATE push_subscriptions SET org_id = ?, user_id = ?, keys = ?, ua = COALESCE(?, ua), failures = 0 WHERE id = ?')
        .run(a.orgId, userId, JSON.stringify(keys), ua, existing.id);
      return { ...this.info(this.row(existing.id)!), created: false };
    }
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }).n;
    if (n >= MAX_SUBSCRIPTIONS_PER_USER) throw new ApiError(409, 'limit', `At most ${MAX_SUBSCRIPTIONS_PER_USER} devices per user. Turn notifications off on an old device first.`);
    const id = `PSH-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare('INSERT INTO push_subscriptions (id, org_id, user_id, endpoint, keys, ua, created_at, last_ok_at, failures) VALUES (?,?,?,?,?,?,?,NULL,0)')
      .run(id, a.orgId, userId, endpoint, JSON.stringify(keys), ua, this.now());
    return { ...this.info(this.row(id)!), created: true };
  }

  /** Removes one of the caller's subscriptions. Another user's endpoint is simply not found (removed: 0). */
  unsubscribe(a: Actor, endpoint: unknown): { ok: true; removed: number } {
    const userId = this.user(a);
    if (typeof endpoint !== 'string' || !endpoint) throw new ApiError(400, 'invalid', 'endpoint is required.');
    let href = endpoint;
    try {
      href = new URL(endpoint).href;
    } catch {
      /* compare as given */
    }
    const r = this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND (endpoint = ? OR endpoint = ?)').run(userId, href, endpoint);
    return { ok: true, removed: Number(r.changes) };
  }

  /** The caller's devices, endpoints masked. */
  listMine(a: Actor): PushSubscriptionInfo[] {
    if (a.kind !== 'user' || !a.userId) return [];
    const rows = this.db.prepare('SELECT * FROM push_subscriptions WHERE org_id = ? AND user_id = ? ORDER BY created_at').all(a.orgId, a.userId) as Row[];
    return rows.map((r) => this.info(r));
  }

  /** Active users of the org with one of the roles whose site list covers the site (empty list = every site). */
  usersForRoles(orgId: string, roles: string[], siteId?: string): string[] {
    if (!roles.length) return [];
    const ph = roles.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT id, site_ids FROM users WHERE org_id = ? AND active = 1 AND role IN (${ph})`).all(orgId, ...roles) as { id: string; site_ids: string }[];
    return rows
      .filter((r) => {
        if (!siteId) return true;
        try {
          const sites = JSON.parse(r.site_ids) as string[];
          return sites.length === 0 || sites.includes(siteId);
        } catch {
          return true;
        }
      })
      .map((r) => r.id);
  }

  /** Fire-and-forget to everyone with one of the roles at the site. */
  pushForRoles(orgId: string, roles: string[], siteId: string | undefined, payload: PushPayload) {
    try {
      const ids = this.usersForRoles(orgId, roles, siteId);
      if (ids.length) this.toUsers(orgId, ids, payload);
    } catch (e) {
      console.error('[push] role lookup failed', e);
    }
  }

  /** Platform.push: fire-and-forget to a list of users. */
  toUsers(orgId: string, userIds: string[], payload: PushPayload) {
    void this.sendToUsers(orgId, userIds, payload).catch((e) => console.error('[push]', e));
  }

  /** Platform.push: fire-and-forget by role. */
  toRoles(orgId: string, roles: string[], siteId: string | undefined, payload: PushPayload) {
    this.pushForRoles(orgId, roles, siteId, payload);
  }

  /** Sends to every device of the users. Never throws; resolves when all deliveries are settled. */
  async sendToUsers(orgId: string, userIds: string[], payload: PushPayload): Promise<SendStats> {
    const stats: SendStats = { subscriptions: 0, sent: 0, failed: 0, removed: 0 };
    if (!userIds.length) return stats;
    let rows: Row[] = [];
    try {
      const ph = userIds.map(() => '?').join(',');
      rows = this.db.prepare(`SELECT * FROM push_subscriptions WHERE org_id = ? AND user_id IN (${ph})`).all(orgId, ...userIds) as Row[];
    } catch (e) {
      console.error('[push] lookup failed', e);
      return stats;
    }
    stats.subscriptions = rows.length;
    if (!rows.length) return stats;
    const message = JSON.stringify(clipPayload(payload));
    this.inflight += rows.length;
    try {
      await Promise.all(
        rows.map(async (r) => {
          const result = await this.deliver(r, message);
          stats[result]++;
          this.opts.metrics?.inc('ps_push_total', { status: result });
        }),
      );
    } finally {
      this.inflight -= rows.length;
    }
    return stats;
  }

  private async deliver(r: Row, message: string): Promise<'sent' | 'failed' | 'removed'> {
    let status = 0;
    let detail = '';
    try {
      const keys = JSON.parse(r.keys) as PushKeys;
      const d = webpush.generateRequestDetails({ endpoint: r.endpoint, keys }, message, {
        vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
        TTL: PUSH_TTL_S,
        urgency: 'high',
        contentEncoding: 'aes128gcm',
      });
      status = await request(d.endpoint, d.method, d.headers, d.body, PUSH_TIMEOUT_MS);
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    try {
      if (status >= 200 && status < 300) {
        this.db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?').run(this.now(), r.id);
        return 'sent';
      }
      if (status === 404 || status === 410) {
        this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(r.id);
        console.log(`[push] subscription ${r.id} gone (${status}); removed ${maskEndpoint(r.endpoint)}`);
        return 'removed';
      }
      this.db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').run(r.id);
    } catch (e) {
      console.error('[push] bookkeeping failed', e);
    }
    console.warn(`[push] delivery to ${maskEndpoint(r.endpoint)} failed: ${status ? `HTTP ${status}` : detail}`);
    return 'failed';
  }

  /** Sends a test message to every device of the caller and reports what happened. */
  async test(a: Actor): Promise<SendStats & { status: 'sent' | 'failed' | 'none' }> {
    const userId = this.user(a);
    const s = await this.sendToUsers(a.orgId, [userId], {
      title: 'Test notification',
      body: `Alerts reach this device. Sent by ${a.name}.`,
      url: a.role === 'responder' ? '/field/' : '/',
      tag: 'push-test',
    });
    return { ...s, status: s.subscriptions === 0 ? 'none' : s.sent > 0 ? 'sent' : 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Audit = (a: Actor, action: string, object: string, result?: 'ok' | 'denied' | 'error', detail?: string) => void;

/** `/api/v1/push/*` — every route needs a user session (the API's preHandler enforces that). */
export function registerPushRoutes(app: FastifyInstance, deps: { push: PushService; audit?: Audit }) {
  const { push, audit } = deps;
  const A = (req: FastifyRequest) => (req as FastifyRequest & { actor?: Actor }).actor!;
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

  app.get('/api/v1/push/vapid', async () => ({ publicKey: push.publicKey, subject: push.subject }));
  app.post('/api/v1/push/subscribe', async (req) => {
    const s = push.subscribe(A(req), body(req));
    if (s.created) audit?.(A(req), 'push.subscribe', s.id, 'ok', s.endpoint);
    return s;
  });
  app.delete('/api/v1/push/subscribe', async (req) => {
    const r = push.unsubscribe(A(req), body(req).endpoint);
    if (r.removed) audit?.(A(req), 'push.unsubscribe', maskEndpoint(String(body(req).endpoint)), 'ok');
    return r;
  });
  app.get('/api/v1/push/subscriptions', async (req) => push.listMine(A(req)));
  app.post('/api/v1/push/test', async (req) => {
    const r = await push.test(A(req));
    audit?.(A(req), 'push.test', A(req).userId ?? '-', r.status === 'failed' ? 'error' : 'ok', `${r.sent}/${r.subscriptions} sent, ${r.removed} removed`);
    return r;
  });
}
