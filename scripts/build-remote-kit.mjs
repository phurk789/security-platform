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
const text = ['install.sh', 'start.sh', 'stop.sh', 'status.sh', 'mediamtx.android.yml', 'site.remote.example.json', 'README_TH.md'];

if (!existsSync(gateway)) {
  console.error(`missing ${gateway}: run npm run build:single -w @13store/gateway`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of text) writeFileSync(join(out, f), readFileSync(join(src, f), 'utf8').replace(/\r\n/g, '\n'));
copyFileSync(gateway, join(out, 'edge-gateway.mjs'));

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  if (execSync('git status --porcelain', { encoding: 'utf8' }).trim()) commit += '+changes';
} catch {
  /* not a git checkout */
}
writeFileSync(join(out, 'VERSION'), `${commit} ${new Date().toISOString()}\n`);
console.log(`remote edge kit in ${out} (${commit}): copy the whole folder to the remote's Download folder`);
