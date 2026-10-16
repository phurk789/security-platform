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
    version: '0.2.0',
    ...over,
  };
  if (cfg.env === 'pilot' && !cfg.mediaSecret) throw new Error('MEDIA_SECRET must be set in pilot mode');
  return cfg;
}
