// Puts the remote edge kit (SIYI UniRC 7 Pro, Termux) into one folder to copy to the remote:
//   npm run kit:remote   →   deploy/remote/dist/edge-kit/
// Needs the single-file gateway (npm run build:single -w @13store/gateway, which kit:remote runs).
// Text files are written with LF line endings: bash in Termux fails on CRLF ("\r: command not found").
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = 'deploy/remote';
const out = join(src, 'dist', 'edge-kit');
const gateway = 'apps/gateway/dist-single/edge-gateway.mjs';
const probe = 'apps/gateway/dist-single/siyi-probe.mjs';
const text = [
  'install.sh',
  'start.sh',
  'stop.sh',
  'status.sh',
  'probe.sh',
  'mediamtx.android.yml',
  'site.remote.example.json',
  'site.matek-ugv.example.json',
  'README_TH.md',
];

// The read-only bench probe (tools/siyi-bench) as one file, so the remote can check the link
// without a laptop. Same createRequire banner as the gateway bundle.
execSync(
  'npx esbuild tools/siyi-bench/probe.ts --bundle --platform=node --format=esm --target=node22 ' +
    `--outfile=${probe} --external:bufferutil --external:utf-8-validate --log-level=warning ` +
    `"--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"`,
  { stdio: 'inherit' },
);
for (const f of [gateway, probe]) {
  if (!existsSync(f)) {
    console.error(`missing ${f}: run npm run build:single -w @13store/gateway`);
    process.exit(1);
  }
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of text) writeFileSync(join(out, f), readFileSync(join(src, f), 'utf8').replace(/\r\n/g, '\n'));
copyFileSync(gateway, join(out, 'edge-gateway.mjs'));
copyFileSync(probe, join(out, 'siyi-probe.mjs'));

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  if (execSync('git status --porcelain', { encoding: 'utf8' }).trim()) commit += '+changes';
} catch {
  /* not a git checkout */
}
writeFileSync(join(out, 'VERSION'), `${commit} ${new Date().toISOString()}\n`);
console.log(`remote edge kit in ${out} (${commit}): copy the whole folder to the remote's Download folder`);
