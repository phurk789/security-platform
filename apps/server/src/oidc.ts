// Single sign-on with OpenID Connect (Authorization Code + PKCE). Works with Microsoft Entra ID,
// Google Workspace, Keycloak and other standard providers. The id_token is verified here against
// the provider's JWKS (RS256 / ES256) or the client secret (HS256); roles come from a claim mapped
// through OIDC_ROLE_MAP. No library: discovery, PKCE and JWT checks are small and auditable.
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { Role } from '@13store/shared';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  name: string;
  roleClaim: string;
  roleMap: Record<string, string>;
  defaultRole?: string;
  orgId: string;
  syncRole: boolean;
  scope?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

export interface SsoIdentity {
  subject: string;
  email?: string;
  name: string;
  role: Role;
  claims: Record<string, unknown>;
}

const ROLES: Role[] = ['dispatcher', 'supervisor', 'operator', 'responder', 'auditor', 'admin'];
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export class OidcError extends Error {
  constructor(
    message: string,
    public code: 'config' | 'provider' | 'token' | 'role' = 'provider',
  ) {
    super(message);
  }
}

export class OidcClient {
  private disc?: Discovery;
  private jwks?: { keys: Jwk[]; at: number };
  constructor(
    readonly cfg: OidcSettings,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = () => Date.now(),
  ) {}

  async discover(): Promise<Discovery> {
    if (this.disc) return this.disc;
    const r = await this.fetchFn(`${this.cfg.issuer}/.well-known/openid-configuration`);
    if (!r.ok) throw new OidcError(`Discovery failed (${r.status}) at ${this.cfg.issuer}`);
    const d = (await r.json()) as Discovery;
    if (!d.authorization_endpoint || !d.token_endpoint) throw new OidcError('Discovery document lacks endpoints');
    this.disc = d;
    return d;
  }

  /** Authorization URL plus the secrets to remember for the callback. */
  async start(): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
    const d = await this.discover();
    const state = b64u(randomBytes(24));
    const nonce = b64u(randomBytes(16));
    const verifier = b64u(randomBytes(32));
    const challenge = b64u(createHash('sha256').update(verifier).digest());
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: this.cfg.scope ?? 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { url: `${d.authorization_endpoint}${d.authorization_endpoint.includes('?') ? '&' : '?'}${q}`, state, nonce, verifier };
  }

  /** Exchange the code, verify the id_token, map the role. */
  async callback(code: string, nonce: string, verifier: string): Promise<SsoIdentity> {
    const d = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code_verifier: verifier,
    });
    const r = await this.fetchFn(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
    if (!r.ok) throw new OidcError(`Token exchange failed (${r.status})`, 'token');
    const tok = (await r.json()) as { id_token?: string };
    if (!tok.id_token) throw new OidcError('Provider returned no id_token', 'token');
    const claims = await this.verifyIdToken(tok.id_token, nonce);
    const sub = String(claims.sub ?? '');
    if (!sub) throw new OidcError('id_token has no subject', 'token');
    const role = this.mapRole(claims);
    if (!role) throw new OidcError('Your account is not assigned a platform role. Ask an administrator to add you to a mapped group.', 'role');
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined;
    const name = String(claims.name ?? claims.preferred_username ?? email ?? sub).slice(0, 80);
    return { subject: sub, email, name, role, claims };
  }

  mapRole(claims: Record<string, unknown>): Role | null {
    const raw = claims[this.cfg.roleClaim];
    const groups = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[ ,]/).filter(Boolean) : [];
    // first mapped group wins, in the order of the map (most privileged first in the config)
    for (const [group, role] of Object.entries(this.cfg.roleMap)) if (groups.includes(group) && ROLES.includes(role as Role)) return role as Role;
    if (this.cfg.defaultRole && ROLES.includes(this.cfg.defaultRole as Role)) return this.cfg.defaultRole as Role;
    return null;
  }

  async verifyIdToken(jwt: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new OidcError('id_token is not a JWT', 'token');
    const header = JSON.parse(fromB64u(parts[0]).toString('utf8')) as { alg: string; kid?: string };
    const payload = JSON.parse(fromB64u(parts[1]).toString('utf8')) as Record<string, unknown>;
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = fromB64u(parts[2]);
    let ok = false;
    if (header.alg === 'HS256') {
      const want = createHmac('sha256', this.cfg.clientSecret).update(signed).digest();
      ok = want.length === sig.length && timingSafeEqual(want, sig);
    } else if (header.alg === 'RS256' || header.alg === 'ES256') {
      const jwk = await this.key(header.kid, header.alg);
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      ok = header.alg === 'RS256' ? verify('sha256', signed, key, sig) : verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } else throw new OidcError(`Unsupported id_token algorithm ${header.alg}`, 'token');
    if (!ok) throw new OidcError('id_token signature does not verify', 'token');
    const now = Math.floor(this.now() / 1000);
    if (payload.iss !== this.cfg.issuer && payload.iss !== `${this.cfg.issuer}/`) throw new OidcError('id_token issuer mismatch', 'token');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.cfg.clientId)) throw new OidcError('id_token audience mismatch', 'token');
    if (typeof payload.exp !== 'number' || payload.exp + 60 < now) throw new OidcError('id_token expired', 'token');
    if (typeof payload.nbf === 'number' && payload.nbf - 60 > now) throw new OidcError('id_token not yet valid', 'token');
    if (payload.nonce !== nonce) throw new OidcError('id_token nonce mismatch', 'token');
    return payload;
  }

  private async key(kid: string | undefined, alg: string): Promise<Jwk> {
    const d = await this.discover();
    if (!d.jwks_uri) throw new OidcError('Provider has no jwks_uri', 'token');
    const fresh = async () => {
      const r = await this.fetchFn(d.jwks_uri!);
      if (!r.ok) throw new OidcError(`JWKS fetch failed (${r.status})`);
      this.jwks = { keys: ((await r.json()) as { keys: Jwk[] }).keys ?? [], at: this.now() };
      return this.jwks;
    };
    const pick = (set: { keys: Jwk[] }) => set.keys.find((k) => (!kid || k.kid === kid) && (!k.alg || k.alg === alg) && (!k.use || k.use === 'sig'));
    let set = this.jwks && this.now() - this.jwks.at < 6 * 3600_000 ? this.jwks : await fresh();
    let k = pick(set);
    if (!k && this.jwks && this.now() - this.jwks.at > 60_000) {
      set = await fresh(); // key rotation
      k = pick(set);
    }
    if (!k) throw new OidcError(`No signing key ${kid ?? ''} in JWKS`, 'token');
    return k;
  }
}
