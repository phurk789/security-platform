// Puts the event kit (the platform on one Windows PC, without Docker) into one folder and one zip:
//   npm run kit:event                    →  deploy/event/dist/13store-event/  and  13store-event.zip
//   npm run kit:event -- --with-13-data  →  also the office server's newest data backup in import/ (needs ~/.ssh/lcot)
// The kit holds: node\node.exe (this PC's Node), app\ (server, console, field app and gateway bundles plus the few
// runtime packages they leave external), media\mediamtx.exe when deploy/event/cache has one (else SETUP.cmd fetches
// it), event.ps1 with START/STOP/MENU/SETUP.cmd, the MediaMTX template and the Thai guide.
// With --with-13-data the zip holds the real platform's data (accounts, keys, secrets.key): hand it over in person.
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = 'deploy/event';
const dist = join(src, 'dist');
const name = '13store-event';
const out = join(dist, name);
const withData = process.argv.includes('--with-13-data');
const skipBuild = process.argv.includes('--skip-build');
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

// 1. The bundles, exactly as the server image builds them (Dockerfile).
if (!skipBuild) {
  for (const w of ['web', 'field', 'server', 'gateway']) sh(`npm run build -w @13store/${w}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 2. app\: the same layout as /app in the image, so the server finds ../../web/dist and ../../field/dist.
for (const a of ['server', 'web', 'field', 'gateway']) cpSync(join('apps', a, 'dist'), join(out, 'app', 'apps', a, 'dist'), { recursive: true });
// The runtime packages the server bundle leaves external, at the versions this repository was tested with.
const version = (p) => JSON.parse(readFileSync(join('node_modules', p, 'package.json'), 'utf8')).version;
const deps = Object.fromEntries(['fastify', '@fastify/websocket', '@fastify/static', 'ws'].map((p) => [p, version(p)]));
writeFileSync(join(out, 'app', 'package.json'), JSON.stringify({ name: '13store-event-app', private: true, type: 'module', dependencies: deps }, null, 2) + '\n');
sh('npm install --omit=dev --no-audit --no-fund --no-package-lock', { cwd: join(out, 'app') });

// 3. node\node.exe: the Node that runs this script (the server needs node:sqlite, Node 22.5 or newer).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) throw new Error(`Node ${process.versions.node} is too old for the server (needs 22.5+)`);
mkdirSync(join(out, 'node'));
copyFileSync(process.execPath, join(out, 'node', 'node.exe'));

// 4. media\: MediaMTX for Windows when a copy was put in deploy/event/cache (git-ignored); else SETUP.cmd downloads it.
mkdirSync(join(out, 'media'));
const cachedMedia = join(src, 'cache', 'mediamtx.exe');
if (existsSync(cachedMedia)) copyFileSync(cachedMedia, join(out, 'media', 'mediamtx.exe'));

// 5. Scripts and guide. Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI (Thai would break); cmd wants CRLF.
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
writeFileSync(join(out, 'event.ps1'), '\ufeff' + crlf(readFileSync(join(src, 'event.ps1'), 'utf8').replace(/^\ufeff/, '')));
for (const f of ['START.cmd', 'STOP.cmd', 'MENU.cmd', 'SETUP.cmd']) writeFileSync(join(out, f), crlf(readFileSync(join(src, f), 'utf8')));
for (const f of ['mediamtx.template.yml', 'README_TH.md']) writeFileSync(join(out, f), crlf(readFileSync(join(src, f), 'utf8')));

// 6. The office server's data (optional): its newest volume backup, taken with the server stopped at each deploy.
if (withData) {
  mkdirSync(join(out, 'import'));
  const ssh = ['-i', join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.ssh', 'lcot'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const list = execFileSync(
    'ssh',
    [...ssh, 'phurk@192.168.20.13', 'powershell -NoProfile -Command "(Get-ChildItem C:\\Server\\thermal\\backups -Filter thermal_pilot-data-*.tgz | Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name"'],
    { encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^thermal_pilot-data-[\w.-]+\.tgz$/.test(l));
  if (!list.length) throw new Error('No thermal_pilot-data-*.tgz backup found on 192.168.20.13');
  execFileSync('scp', [...ssh, `phurk@192.168.20.13:/C:/Server/thermal/backups/${list[0]}`, join(out, 'import', list[0])], { stdio: 'inherit' });
  console.log(`Office data: import/${list[0]} (${(statSync(join(out, 'import', list[0])).size / 1e6).toFixed(1)} MB)`);
}

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  if (execSync('git status --porcelain', { encoding: 'utf8' }).trim()) commit += '+changes';
} catch {
  /* not a git checkout */
}
writeFileSync(join(out, 'VERSION'), `${commit} ${new Date().toISOString()} node ${process.versions.node}${existsSync(cachedMedia) ? ' mediamtx' : ''}\r\n`);

// 7. One zip to copy to the event PC (Windows' own Compress-Archive keeps it dependency-free).
const zip = join(dist, `${name}.zip`);
rmSync(zip, { force: true });
execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' });
console.log(`Event kit (${commit}): ${zip} (${(statSync(zip).size / 1e6).toFixed(0)} MB)${withData ? ' — holds the office data: hand it over in person' : ''}`);
console.log('On the event PC: unzip, run SETUP.cmd once (internet needed for the video server), then START.cmd.');
