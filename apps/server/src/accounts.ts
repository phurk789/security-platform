// Users, sessions, API keys (identity layer).
import { STEP_UP_WINDOW_MS, type ApiKeyView, type Role, type SessionUser, type UserAdminView } from '@13store/shared';
import type { DB } from './db';
import { ApiError, type Actor, type Platform } from './platform';
import { LoginThrottle, hashPassword, randomToken, sha256, verifyPassword } from './security';

const ROLES: Role[] = ['dispatcher', 'supervisor', 'operator', 'responder', 'auditor', 'admin'];

interface UserRow {
  id: string;
  org_id: string;
  username: string;
  name: string;
  title: string;
  role: Role;
  pw_hash: string;
  site_ids: string;
  active: number;
}

export class Accounts {
  private throttle = new LoginThrottle();
  constructor(
    private db: DB,
    private p: Platform,
    private ttlMs: number,
  ) {}

  private sessionUser(u: UserRow, stepUpUntil?: number): SessionUser {
    const org = this.db.prepare('SELECT name FROM orgs WHERE id = ?').get(u.org_id) as { name: string };
    return { id: u.id, name: u.name, role: u.role, title: u.title, username: u.username, orgId: u.org_id, orgName: org.name, siteIds: JSON.parse(u.site_ids), stepUpUntil };
  }

  login(username: string, password: string, ip = '') {
    const now = this.p.now();
    const key = `${username.toLowerCase()}|${ip}`;
    if (this.throttle.blocked(key, now)) throw new ApiError(429, 'forbidden', 'Too many failed attempts. Try again in a minute.');
    const u = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase()) as UserRow | undefined;
    if (!u || !u.active || !verifyPassword(password, u.pw_hash)) {
      this.throttle.fail(key, now);
      if (u) this.p.audit(this.p.systemActor(u.org_id), 'auth.login', u.username, 'denied', 'bad password');
      throw new ApiError(401, 'unauthenticated', 'Wrong username or password.');
    }
    this.throttle.ok(key);
    const token = randomToken('ses_');
    const expiresAt = now + this.ttlMs;
    const stepUp = now + STEP_UP_WINDOW_MS;
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, step_up_until) VALUES (?,?,?,?,?)').run(sha256(token), u.id, now, expiresAt, stepUp);
    const user = this.sessionUser(u, stepUp);
    this.p.audit(this.p.userActor(user), 'auth.login', u.username);
    return { token, expiresAt, user };
  }

  /** Resolves a bearer token (session or API key) into an actor. */
  authenticate(token: string | undefined): { actor: Actor; user?: SessionUser; sessionHash?: string; keyKind?: string } | null {
    if (!token) return null;
    const now = this.p.now();
    const h = sha256(token);
    if (token.startsWith('ses_')) {
      const s = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h) as { user_id: string; expires_at: number; step_up_until: number } | undefined;
      if (!s || s.expires_at < now) return null;
      const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) as UserRow | undefined;
      if (!u || !u.active) return null;
      const user = this.sessionUser(u, s.step_up_until);
      return { actor: this.p.userActor(user), user, sessionHash: h };
    }
    const k = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0').get(h) as
      | { id: string; org_id: string; label: string; kind: string; env: string; site_ids: string }
      | undefined;
    if (!k) return null;
    return { actor: { kind: 'apikey', orgId: k.org_id, siteIds: JSON.parse(k.site_ids), name: `API key ${k.label}`, role: k.kind === 'gateway' ? 'gateway' : 'integration' }, keyKind: k.kind };
  }

  logout(sessionHash: string, a: Actor) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash);
    this.p.audit(a, 'auth.logout', a.name);
  }

  stepUp(sessionHash: string, a: Actor, password: string) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(a.userId ?? '') as UserRow | undefined;
    if (!u || !verifyPassword(password, u.pw_hash)) {
      this.p.audit(a, 'auth.step_up', a.name, 'denied');
      throw new ApiError(401, 'unauthenticated', 'Wrong password.');
    }
    const until = this.p.now() + STEP_UP_WINDOW_MS;
    this.db.prepare('UPDATE sessions SET step_up_until = ? WHERE token_hash = ?').run(until, sessionHash);
    this.p.audit(a, 'auth.step_up', a.name);
    return { stepUpUntil: until };
  }

  // ---- admin --------------------------------------------------------------

  listUsers(a: Actor): UserAdminView[] {
    this.p.require(a, 'admin.users', 'users', { mutating: false });
    const rows = this.db.prepare('SELECT * FROM users WHERE org_id = ? ORDER BY name').all(a.orgId) as unknown as UserRow[];
    return rows.map((u) => ({ id: u.id, name: u.name, role: u.role, title: u.title, username: u.username, siteIds: JSON.parse(u.site_ids), active: !!u.active }));
  }

  createUser(a: Actor, input: { username: string; name: string; title?: string; role: Role; password: string; siteIds?: string[] }) {
    this.p.require(a, 'admin.users', input.username);
    if (!/^[a-z0-9._-]{3,32}$/.test(input.username ?? '')) throw new ApiError(400, 'invalid', 'Username: 3–32 lowercase letters, digits, dot, dash or underscore.');
    if (!ROLES.includes(input.role)) throw new ApiError(400, 'invalid', 'Unknown role.');
    if ((input.password ?? '').length < 10) throw new ApiError(400, 'invalid', 'Password must be at least 10 characters.');
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(input.username)) throw new ApiError(409, 'conflict', 'Username already taken.');
    const id = `u-${randomToken('', 6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    this.db
      .prepare('INSERT INTO users (id, org_id, username, name, title, role, pw_hash, site_ids, active, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)')
      .run(id, a.orgId, input.username, input.name.slice(0, 80), (input.title ?? '').slice(0, 80), input.role, hashPassword(input.password), JSON.stringify(input.siteIds ?? []), this.p.now());
    this.p.audit(a, 'admin.user_create', input.username, 'ok', input.role);
    return this.listUsers(a).find((u) => u.id === id)!;
  }

  updateUser(a: Actor, id: string, patch: { role?: Role; active?: boolean; siteIds?: string[]; password?: string; title?: string }) {
    this.p.require(a, 'admin.users', id);
    const u = this.db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(id, a.orgId) as UserRow | undefined;
    if (!u) throw new ApiError(404, 'not_found', 'User not found.');
    if (id === a.userId && (patch.active === false || (patch.role && patch.role !== 'admin'))) throw new ApiError(409, 'conflict', 'You cannot lock yourself out.');
    if (patch.role && !ROLES.includes(patch.role)) throw new ApiError(400, 'invalid', 'Unknown role.');
    if (patch.password !== undefined && patch.password.length < 10) throw new ApiError(400, 'invalid', 'Password must be at least 10 characters.');
    this.db
      .prepare('UPDATE users SET role = ?, active = ?, site_ids = ?, title = ?, pw_hash = ? WHERE id = ?')
      .run(
        patch.role ?? u.role,
        patch.active === undefined ? u.active : patch.active ? 1 : 0,
        JSON.stringify(patch.siteIds ?? JSON.parse(u.site_ids)),
        patch.title ?? u.title,
        patch.password ? hashPassword(patch.password) : u.pw_hash,
        id,
      );
    if (patch.active === false || patch.password || patch.role) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    this.p.audit(a, 'admin.user_update', u.username, 'ok', Object.keys(patch).join(','));
    return this.listUsers(a).find((x) => x.id === id)!;
  }

  listKeys(a: Actor): ApiKeyView[] {
    this.p.require(a, 'admin.keys', 'api_keys', { mutating: false });
    const rows = this.db.prepare('SELECT * FROM api_keys WHERE org_id = ? ORDER BY created_at').all(a.orgId) as {
      id: string;
      label: string;
      kind: ApiKeyView['kind'];
      env: ApiKeyView['env'];
      prefix: string;
      created_at: number;
      revoked: number;
    }[];
    return rows.map((r) => ({ id: r.id, label: r.label, kind: r.kind, env: r.env, prefix: r.prefix, createdAt: r.created_at, revoked: !!r.revoked }));
  }

  /** Returns the secret once. Keys are separated by environment (F16). */
  createKey(a: Actor, input: { label: string; kind: 'integration' | 'gateway'; siteIds?: string[] }, env: ApiKeyView['env']) {
    this.p.require(a, 'admin.keys', input.label);
    if (!['integration', 'gateway'].includes(input.kind)) throw new ApiError(400, 'invalid', 'Kind must be integration or gateway.');
    const secret = randomToken(input.kind === 'gateway' ? `gw_${env}_` : `sk_${env}_`);
    const id = `key-${randomToken('', 6)}`;
    this.db
      .prepare('INSERT INTO api_keys (id, org_id, label, kind, env, prefix, key_hash, site_ids, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, a.orgId, (input.label || 'key').slice(0, 60), input.kind, env, secret.slice(0, 12), sha256(secret), JSON.stringify(input.siteIds ?? []), this.p.now());
    this.p.audit(a, 'admin.key_create', id, 'ok', `${input.kind} ${env}`);
    return { id, secret };
  }

  revokeKey(a: Actor, id: string) {
    this.p.require(a, 'admin.keys', id);
    const r = this.db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND org_id = ?').run(id, a.orgId);
    if (!r.changes) throw new ApiError(404, 'not_found', 'Key not found.');
    this.p.audit(a, 'admin.key_revoke', id);
  }
}
