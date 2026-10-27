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
  /**
   * The platform's own media server, for gateways that push video (stream.push). Both set = push on.
   * mediaIngestUrl: where gateways publish, rtsp://host:port (e.g. rtsp://192.168.20.13:18554).
   * mediaPublicUrl: where browsers play from, http(s)://host:port (e.g. http://192.168.20.13:18889).
   */
  mediaIngestUrl?: string;
  mediaPublicUrl?: string;
  /**
   * Google Maps Platform key for Google basemaps (Map Tiles API, proxied: never sent to browsers).
   * Unset: no Google basemaps. Needs the Map Tiles API enabled, billing, and Google's terms accepted.
   */
  googleMapsApiKey?: string;
  /** Map Tiles API base URL (tests point it at a fake). */
  googleTilesUrl: string;
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

const ENV_MODES: readonly EnvMode[] = ['demo', 'pilot'];

/**
 * ENV_MODE decides whether demo users with the published password are seeded and whether
 * MEDIA_SECRET is required, so an unknown value (a typo, "production") must stop the server
 * instead of quietly running as demo. Unset means demo.
 */
export function parseEnvMode(raw: string | undefined): EnvMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return 'demo';
  if ((ENV_MODES as readonly string[]).includes(v)) return v as EnvMode;
  throw new Error(`ENV_MODE must be "demo" or "pilot" (got "${raw}")`);
}

export function loadConfig(over: Partial<Config> = {}): Config {
  const env = parseEnvMode(process.env.ENV_MODE);
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const cfg: Config = {
    port: Number(process.env.PORT || 8080),
    host: process.env.HOST || '0.0.0.0',
    env,
    dataDir,
    dbFile: process.env.DB_FILE || resolve(dataDir, 'platform.sqlite'),
    mediaSecret: process.env.MEDIA_SECRET || (env === 'demo' ? 'demo-media-secret' : ''),
    mediaIngestUrl: process.env.MEDIA_INGEST_URL || undefined,
    mediaPublicUrl: process.env.MEDIA_PUBLIC_URL || undefined,
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined,
    googleTilesUrl: process.env.GOOGLE_TILES_URL || 'https://tile.googleapis.com',
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
  if (!ENV_MODES.includes(cfg.env)) throw new Error(`env must be "demo" or "pilot" (got "${cfg.env}")`);
  if (cfg.env === 'pilot' && !cfg.mediaSecret) throw new Error('MEDIA_SECRET must be set in pilot mode');
  checkMediaServer(cfg);
  return cfg;
}

/** The two media server URLs come as a pair, each a plain scheme://host:port with nothing after it. */
function checkMediaServer(cfg: Config) {
  const { mediaIngestUrl: ingest, mediaPublicUrl: pub } = cfg;
  if (!ingest && !pub) return;
  if (!ingest || !pub) throw new Error('Set MEDIA_INGEST_URL and MEDIA_PUBLIC_URL together (or neither): pushed video needs both.');
  const plain = (raw: string, schemes: string[], name: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`${name} is not a URL: "${raw}"`);
    }
    if (!schemes.includes(u.protocol)) throw new Error(`${name} must start with ${schemes.join(' or ')}// (got "${raw}")`);
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error(`${name} must be scheme://host:port only (got "${raw}")`);
    return `${u.protocol}//${u.host}`;
  };
  cfg.mediaIngestUrl = plain(ingest, ['rtsp:', 'rtsps:'], 'MEDIA_INGEST_URL');
  cfg.mediaPublicUrl = plain(pub, ['http:', 'https:'], 'MEDIA_PUBLIC_URL');
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
