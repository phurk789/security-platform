import { resolve } from 'node:path';
import type { EnvMode } from '@13store/shared';

export interface Config {
  port: number;
  host: string;
  env: EnvMode;
  dataDir: string;
  dbFile: string;
  /** Secret used to sign short-lived media URLs. */
  mediaSecret: string;
  /** Password given to seeded demo users (demo env only). */
  seedPassword: string;
  sessionTtlMs: number;
  /** Run the simulated edge gateway inside the server process (demo convenience). */
  embedGateway: boolean;
  webDist?: string;
  fieldDist?: string;
  version: string;
  /** Signed license file and the vendor public key (PEM). Demo needs neither. */
  licenseFile?: string;
  licensePublicKey?: string;
  /** Single sign-on (OpenID Connect). All four must be set to enable it. */
  oidc?: {
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
  };
  /** Bearer token that may scrape /api/v1/metrics without a user session. */
  metricsToken?: string;
  /** Automatic backups: every N hours (0 = off), keeping the newest K. */
  backupIntervalH: number;
  backupKeep: number;
  /** How often expired data is purged (ms). */
  purgeIntervalMs: number;
  /** Key for secrets at rest (32 bytes, hex/base64). Unset: generated once into DATA_DIR/secrets.key. */
  secretsKey?: string;
  /** Sign-in and step-up attempts allowed per client address per minute (0 = unlimited). */
  rateLimitAuthPerMin: number;
  /** API requests allowed per client address per minute (0 = unlimited). */
  rateLimitPerMin: number;
  /** Send Strict-Transport-Security on HTTPS responses. */
  hsts: boolean;
  /** Extra connect-src / media-src origins for the console's Content-Security-Policy (media servers). */
  cspConnectSrc: string[];
  /** Origins allowed to open the console WebSocket (empty = any). */
  allowedOrigins: string[];
  /** Trust X-Forwarded-* from the reverse proxy: false, true, or a comma list of proxy addresses/CIDRs. Default: on in pilot (behind TLS proxy), off in demo. */
  trustProxy: boolean | string;
  /** Web Push (VAPID) key pair, base64url. Unset: generated once into DATA_DIR/vapid.json. */
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  /** Contact the push services may use: mailto: address or https: URL. */
  vapidSubject?: string;
}

export function loadConfig(over: Partial<Config> = {}): Config {
  const env = (process.env.ENV_MODE as EnvMode) || 'demo';
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const cfg: Config = {
    port: Number(process.env.PORT || 8080),
    host: process.env.HOST || '0.0.0.0',
    env,
    dataDir,
    dbFile: process.env.DB_FILE || resolve(dataDir, 'platform.sqlite'),
    mediaSecret: process.env.MEDIA_SECRET || (env === 'demo' ? 'demo-media-secret' : ''),
    seedPassword: process.env.SEED_PASSWORD || 'demo1234',
    sessionTtlMs: Number(process.env.SESSION_TTL_MS || 12 * 60 * 60_000),
    embedGateway: (process.env.EMBED_GATEWAY ?? (env === 'demo' ? '1' : '0')) === '1',
    webDist: process.env.WEB_DIST,
    fieldDist: process.env.FIELD_DIST,
    version: '0.3.0',
    licenseFile: process.env.LICENSE_FILE || undefined,
    licensePublicKey: process.env.LICENSE_PUBLIC_KEY ? process.env.LICENSE_PUBLIC_KEY.replace(/\\n/g, '\n') : undefined,
    oidc: oidcFromEnv(),
    metricsToken: process.env.METRICS_TOKEN || undefined,
    backupIntervalH: Number(process.env.BACKUP_INTERVAL_H || (env === 'pilot' ? 24 : 0)),
    backupKeep: Number(process.env.BACKUP_KEEP || 14),
    purgeIntervalMs: Number(process.env.PURGE_INTERVAL_MS || 60 * 60_000),
    secretsKey: process.env.SECRETS_KEY || undefined,
    rateLimitAuthPerMin: Number(process.env.RATE_LIMIT_AUTH_PER_MIN ?? 60),
    rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 0),
    hsts: (process.env.HSTS ?? (env === 'pilot' ? '1' : '0')) === '1',
    cspConnectSrc: (process.env.CSP_CONNECT_SRC ?? '').split(/[\s,]+/).filter(Boolean),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(/[\s,]+/).filter(Boolean),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, env === 'pilot'),
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || undefined,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || undefined,
    vapidSubject: process.env.VAPID_SUBJECT || undefined,
    ...over,
  };
  if (cfg.env === 'pilot' && !cfg.mediaSecret) throw new Error('MEDIA_SECRET must be set in pilot mode');
  return cfg;
}

function oidcFromEnv(): Config['oidc'] {
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret, OIDC_REDIRECT_URI: redirectUri } = process.env;
  if (!issuer || !clientId || !clientSecret || !redirectUri) return undefined;
  let roleMap: Record<string, string> = {};
  try {
    roleMap = JSON.parse(process.env.OIDC_ROLE_MAP || '{}');
  } catch {
    throw new Error('OIDC_ROLE_MAP must be JSON, e.g. {"SecurityOps":"dispatcher"}');
  }
  return {
    issuer: issuer.replace(/\/$/, ''),
    clientId,
    clientSecret,
    redirectUri,
    name: process.env.OIDC_NAME || 'Single sign-on',
    roleClaim: process.env.OIDC_ROLE_CLAIM || 'groups',
    roleMap,
    defaultRole: process.env.OIDC_DEFAULT_ROLE || undefined,
    orgId: process.env.OIDC_ORG || 'org-demo',
    syncRole: (process.env.OIDC_SYNC_ROLE ?? '1') === '1',
  };
}

function parseTrustProxy(v: string | undefined, def: boolean): boolean | string {
  if (v === undefined || v === '') return def;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return v; // comma-separated addresses / CIDRs
}
