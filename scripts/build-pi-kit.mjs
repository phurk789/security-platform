// Puts the Raspberry Pi edge kit (a computer on the vehicle) into one folder and one archive:
//   npm run kit:pi   →   deploy/pi/dist/13store-edge-pi/  and  deploy/pi/dist/13store-edge-pi.tar.gz
// The gateway and the helper are built for Node 18 (Raspberry Pi OS Bookworm's apt package; Trixie has 20).
// Text files get LF line endings: bash fails on CRLF ("\r: command not found").
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = 'deploy/pi';
const dist = join(src, 'dist');
const name = '13store-edge-pi';
const out = join(dist, name);
const scripts = ['install.sh', '13store-edge'];
const text = ['13store-edge.service', 'site.pi-ugv.example.json', 'README_TH.md'];

const bundle = (entry, file) =>
  execSync(
    `npx esbuild ${entry} --bundle --platform=node --format=esm --target=node18 --outfile=${join(out, file)} ` +
      `--external:bufferutil --external:utf-8-validate --log-level=warning ` +
      `"--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"`,
    { stdio: 'inherit' },
  );

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
bundle('apps/gateway/src/cli.ts', 'edge-gateway.mjs');
bundle('apps/gateway/src/onboard/tool.ts', 'edge-tool.mjs');
for (const f of [...scripts, ...text]) writeFileSync(join(out, f), readFileSync(join(src, f), 'utf8').replace(/\r\n/g, '\n'));
for (const f of scripts) chmodSync(join(out, f), 0o755);

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  if (execSync('git status --porcelain', { encoding: 'utf8' }).trim()) commit += '+changes';
} catch {
  /* not a git checkout */
}
writeFileSync(join(out, 'VERSION'), `${commit} ${new Date().toISOString()}\n`);

// One file to copy. Built on Windows it may lose the executable bits, so the guide runs `sudo bash install.sh`
// (install.sh sets the bits it needs itself).
execSync(`tar -czf ${name}.tar.gz ${name}`, { cwd: dist, stdio: 'inherit' });
console.log(`Pi edge kit (${commit}): ${join(dist, `${name}.tar.gz`)}`);
console.log(`On the Pi:  tar xzf ${name}.tar.gz && cd ${name} && sudo bash install.sh`);
