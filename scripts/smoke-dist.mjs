// Smoke test for the built bundles (run after `npm run build`):
// start apps/server/dist with a fresh data directory, wait for /api/v1/health, then start
// apps/gateway/dist against it and wait until it registers its simulated devices.
// It catches problems that only exist in the bundled files, such as a CommonJS require inside
// an ESM bundle, which the unit tests (running the TypeScript sources) never see.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.SMOKE_PORT ?? '18089';
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 30_000;
const SERVER = 'apps/server/dist/index.js';
const GATEWAY = 'apps/gateway/dist/index.js';

const children = [];
let finished = false;
let dataDir;

function cleanup() {
  finished = true;
  for (const child of children) child.kill();
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A locked SQLite file on Windows: the temp folder is left behind, which is harmless.
    }
  }
}

function fail(message) {
  console.error(`smoke: FAIL: ${message}`);
  cleanup();
  process.exit(1);
}

function start(name, file, env) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  const onData = (chunk) => {
    child.output += chunk;
    process.stdout.write(`[${name}] ${chunk}`);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    if (!finished) fail(`${name} exited early with code ${code}`);
  });
  children.push(child);
  return child;
}

async function waitFor(what, check) {
  const until = Date.now() + TIMEOUT_MS;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`timed out after ${TIMEOUT_MS / 1000} s waiting for ${what}`);
}

for (const file of [SERVER, GATEWAY]) {
  if (!existsSync(file)) fail(`${file} not found; run npm run build first`);
}
dataDir = mkdtempSync(join(tmpdir(), 'ps-smoke-'));

start('server', SERVER, { PORT, HOST: '127.0.0.1', DATA_DIR: dataDir, ENV_MODE: 'demo', EMBED_GATEWAY: '0' });
await waitFor('the server health check', () =>
  fetch(`${BASE}/api/v1/health`)
    .then((r) => r.ok)
    .catch(() => false),
);

const gateway = start('gateway', GATEWAY, {
  SERVER_URL: `ws://127.0.0.1:${PORT}`,
  GATEWAY_KEY: 'gw_demo_local_key',
  GATEWAY_ID: 'edge-civic-01',
});
await waitFor('the gateway to register its devices', () => /registered \d+ device/.test(gateway.output));

const devices = gateway.output.match(/registered (\d+) device/)[1];
console.log(`smoke: OK: server healthy, standalone gateway registered ${devices} devices`);
cleanup();
process.exit(0);
