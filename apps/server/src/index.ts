// Platform server entry point.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { openDb } from './db';
import { buildApp } from './http';
import { DEMO_GATEWAY_KEY, seed } from './seed';

const here = fileURLToPath(new URL('.', import.meta.url));
const cfg = loadConfig({
  webDist: process.env.WEB_DIST ?? resolve(here, '../../web/dist'),
  fieldDist: process.env.FIELD_DIST ?? resolve(here, '../../field/dist'),
});
const db = openDb(cfg.dbFile);
const seeded = seed(db, cfg);
if (seeded.created) {
  console.log(`[server] first run: seeded ${cfg.env} data in ${cfg.dataDir}`);
  for (const line of seeded.printed ?? []) console.log(`[server] ${line}  ← shown once, store it safely`);
}

const { app, platform } = await buildApp(db, cfg, { logger: process.env.LOG === '1' });
platform.start();
await app.listen({ port: cfg.port, host: cfg.host });
console.log(`[server] ${cfg.env} environment on http://localhost:${cfg.port}  (console /, field app /field/, API /api/v1)`);

let stopGateway: (() => Promise<void>) | undefined;
if (cfg.embedGateway) {
  const gw = await import('@13store/gateway');
  const handle = gw.startGateway({
    serverUrl: `ws://127.0.0.1:${cfg.port}`,
    key: process.env.GATEWAY_KEY ?? DEMO_GATEWAY_KEY,
    gatewayId: 'edge-embedded',
    adapters: gw.defaultAdapters(),
  });
  stopGateway = () => handle.stop();
  console.log('[server] embedded simulated edge gateway started');
}

const shutdown = async () => {
  await stopGateway?.();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
