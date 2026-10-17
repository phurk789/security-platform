// Load test against a running server (TOR §9: event shown ≤ 2 s p95; ≥ 100 cameras / 50 devices per site).
//   npm run loadtest -w @13store/server -- --url http://127.0.0.1:8123 --gateways 4 --devices 120 --ugvs 20 \
//        --consoles 10 --rate-ms 1000 --duration 60 --incidents-per-min 6 --out /tmp/loadtest.json
// Prints the Markdown report on stdout (progress on stderr) and exits 1 when a target is missed or an error occurred.
// Run it against a throwaway data directory: the LT-* devices it registers stay registered.
import { writeFileSync } from 'node:fs';
import { runLoadTest, reportMarkdown, type LoadTestOptions } from '../loadtest';

const args = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const num = (name: string, d: number) => {
  const v = opt(name);
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`--${name} must be a number`);
    process.exit(2);
  }
  return n;
};
const creds = (name: string, d: { username: string; password: string }) => {
  const v = opt(name);
  if (!v) return d;
  const i = v.indexOf(':');
  if (i <= 0) {
    console.error(`--${name} must be user:pass`);
    process.exit(2);
  }
  return { username: v.slice(0, i), password: v.slice(i + 1) };
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      'usage: loadtest.ts [--url http://127.0.0.1:8080] [--gateways 2] [--devices 40] [--ugvs N] [--consoles 4] [--rate-ms 1000]',
      '                   [--duration 30] [--incidents-per-min 6] [--admin user:pass] [--console-user user:pass] [--key gw_key]',
      '                   [--site SITE_ID] [--drain 3] [--out report.json]',
      '',
      '  --devices   load devices in total (cameras + UGVs), shared out between the gateways',
      '  --ugvs      how many of them are UGVs (default devices / 6)',
      '  --admin     registers the LT-* devices and reads /metrics (default ploy:demo1234)',
      '  --console-user  dispatcher for the console sockets and incidents (default alex:demo1234)',
    ].join('\n'),
  );
  process.exit(0);
}

const ugvs = opt('ugvs');
const opts: LoadTestOptions = {
  url: opt('url', 'http://127.0.0.1:8080')!,
  gateways: num('gateways', 2),
  devices: num('devices', 40),
  ugvs: ugvs === undefined ? undefined : num('ugvs', 0),
  consoles: num('consoles', 4),
  rateMs: num('rate-ms', 1000),
  durationS: num('duration', 30),
  incidentsPerMin: num('incidents-per-min', 6),
  drainS: num('drain', 3),
  admin: creds('admin', { username: 'ploy', password: 'demo1234' }),
  consoleUser: creds('console-user', { username: 'alex', password: 'demo1234' }),
  gatewayKey: opt('key', 'gw_demo_local_key'),
  siteId: opt('site'),
  log: (line) => console.error(`[loadtest] ${line}`),
};

// Ctrl-C ends the run early and still prints what was measured.
const ac = new AbortController();
opts.signal = ac.signal;
process.once('SIGINT', () => {
  console.error('[loadtest] interrupted; finishing the run');
  ac.abort();
});

try {
  const report = await runLoadTest(opts);
  const out = opt('out');
  if (out) {
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.error(`[loadtest] JSON written to ${out}`);
  }
  console.log(reportMarkdown(report));
  process.exit(report.targets.pass ? 0 : 1);
} catch (e) {
  console.error(`[loadtest] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
