// Helper for a computer on the vehicle (Raspberry Pi, deploy/pi). The kit's `13store-edge` command runs it:
//   pair [server] [code]  get this vehicle's settings and gateway key with a one-time code from Admin
//                         → "Pair an edge remote" (the same code flow as the Android edge app). Nobody types the key.
//   status                what the gateway is doing now, from the status file it writes every second
//   ports                 serial ports on this computer, to find the flight controller
// Messages are in Thai: the people who set up the vehicles read Thai (deploy/pi/README_TH.md).
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parsePairingLink, type EdgePairResponse } from '@13store/shared';
import type { GatewayStatus } from '../gateway';

export const DEFAULT_CONFIG = '/etc/13store-edge/site.json';
export const DEFAULT_STATUS = '/run/13store-edge/status.json';

/** "192.168.20.13:8090", "http://host:8090/admin" → "http://192.168.20.13:8090"; null when it is not a web address. */
export function normalizeServer(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export interface PairResult {
  ok: boolean;
  /** Thai text for the person at the terminal. */
  message: string;
  site?: SiteFile;
}

/** What /etc/13store-edge/site.json holds (apps/gateway/src/real/config.ts SiteConfig). */
export interface SiteFile {
  gatewayId: string;
  serverUrl: string;
  key: string;
  geo: EdgePairResponse['geo'];
  devices: unknown[];
  /** For people reading the file; the gateway ignores it. */
  site?: { id: string; name: string };
}

type Post = (url: string, body: unknown) => Promise<{ status: number; json: unknown }>;

/** Sends the code; never prints or returns the key in `message`. */
export async function pair(origin: string, code: string, client: string, post: Post = postJson): Promise<PairResult> {
  let res: { status: number; json: unknown };
  try {
    res = await post(`${origin}/api/v1/edge/pair`, { code, client });
  } catch (e) {
    return { ok: false, message: `ติดต่อเซิร์ฟเวอร์ ${origin} ไม่ได้ (${(e as Error).message}) เช็คว่าเครื่องนี้ต่อเน็ตแล้ว และที่อยู่ถูกต้อง` };
  }
  const j = (res.json ?? {}) as Partial<EdgePairResponse> & { code?: string; message?: string };
  if (res.status === 200 && typeof j.key === 'string' && typeof j.gatewayId === 'string' && typeof j.serverUrl === 'string' && j.geo && Array.isArray(j.devices)) {
    const site: SiteFile = { gatewayId: j.gatewayId, serverUrl: j.serverUrl, key: j.key, geo: j.geo, devices: j.devices, ...(j.site ? { site: j.site } : {}) };
    return { ok: true, message: `จับคู่แล้ว: ${j.gatewayId}${j.site?.name ? ` · ไซต์ ${j.site.name}` : ''}`, site };
  }
  if (res.status === 429) return { ok: false, message: `ลองผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่ (${j.message ?? 'HTTP 429'})` };
  if (j.code === 'invalid_code' || res.status === 400 || res.status === 404 || res.status === 410)
    return { ok: false, message: 'รหัสไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว: สร้างรหัสใหม่ที่หน้าแอดมิน › "จับคู่รีโมต (Edge)"' };
  return { ok: false, message: `เซิร์ฟเวอร์ตอบ ${res.status}: ${j.message ?? 'ไม่ทราบสาเหตุ'}` };
}

/** Serial devices the vehicle settings name that this computer does not have (yet). */
export function missingPorts(site: SiteFile, exists: (p: string) => boolean = existsSync): string[] {
  return site.devices
    .map((d) => (d as { link?: { mode?: string; path?: string } }).link)
    .filter((l): l is { mode: string; path: string } => l?.mode === 'serial' && typeof l.path === 'string')
    .map((l) => l.path)
    .filter((p) => !exists(p));
}

/** Written whole or not at all, readable by its owner only: it holds the gateway key. */
export function writeSiteFile(path: string, site: SiteFile) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(site, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const VIDEO: Record<string, string> = {
  pushing: 'กำลังส่ง',
  starting: 'กำลังเริ่ม',
  retrying: 'ลองใหม่',
  missing: 'ไม่พบ ffmpeg',
  stopped: 'หยุด',
};

/** Lines for `13store-edge status`, and whether everything is fine. */
export function formatStatus(s: GatewayStatus | null, now: number): { ok: boolean; lines: string[] } {
  if (!s) return { ok: false, lines: ['Gateway ไม่ได้ทำงาน (ยังไม่มีไฟล์สถานะ) ดู: 13store-edge logs'] };
  const age = (now - s.at) / 1000;
  if (age > 5) return { ok: false, lines: [`Gateway ไม่ได้ทำงาน: สถานะล่าสุดเมื่อ ${Math.round(age)} วินาทีก่อน ดู: 13store-edge logs`] };
  let ok = true;
  const lines = [`Gateway ${s.gatewayId}`];
  if (s.server.connected) lines.push(`เซิร์ฟเวอร์   เชื่อมต่อแล้ว · ${s.server.url}`);
  else {
    ok = false;
    lines.push(
      s.server.refused
        ? 'เซิร์ฟเวอร์   ไม่รับกุญแจของเครื่องนี้: จับคู่ใหม่ (sudo 13store-edge pair)'
        : `เซิร์ฟเวอร์   ยังต่อไม่ได้ · ${s.server.url} (เช็คเน็ต 4G / Wi-Fi)`,
    );
  }
  for (const d of s.devices) {
    const parts: string[] = [];
    if (d.rejected) {
      ok = false;
      parts.push(`เซิร์ฟเวอร์ไม่รับ: ${d.rejected}`);
    }
    const quiet = d.lastTelemetryAt === undefined ? undefined : (now - d.lastTelemetryAt) / 1000;
    if (quiet !== undefined && quiet <= 5) parts.push(`รถส่งข้อมูลอยู่ (ล่าสุด ${quiet.toFixed(1)} วินาที)`);
    else {
      ok = false;
      parts.push('ไม่ได้ยินรถ (เช็คสาย TELEM1 กับไฟบอร์ด, 13store-edge ports)');
    }
    if (d.video) {
      if (d.video.status !== 'pushing') ok = false;
      parts.push(`วิดีโอ ${VIDEO[d.video.status] ?? d.video.status}${d.video.codec ? ` (${d.video.codec})` : ''}${d.video.status === 'pushing' ? '' : `: ${d.video.detail}`}`);
    }
    lines.push(`${d.deviceId.padEnd(12)} ${parts.join(' · ')}`);
  }
  return { ok, lines };
}

/** Serial ports, with what each probably is. `dev` is /dev (tests use a folder). */
export function listPorts(dev = '/dev'): { path: string; target: string; note: string }[] {
  const out: { path: string; target: string; note: string }[] = [];
  const add = (path: string, note: string) => {
    let target = path;
    try {
      target = realpathSync(path);
    } catch {
      return;
    }
    out.push({ path, target, note });
  };
  // After install.sh, GPIO 14/15 is ttyAMA0 on Pi 3, 4 and 5, and the Pi 5's 3-pin UART connector is ttyAMA10 (no
  // console on it any more). serial0 is only an alias: on a Pi 5 it points at the 3-pin connector.
  const uarts: Record<string, string> = {
    ttyAMA0: 'UART ขา GPIO14/15: ต่อ TELEM1 ที่นี่',
    ttyAMA10: 'ช่อง UART 3 ขาของ Pi 5 (หัว JST-SH): ต่อ TELEM1 ที่นี่ได้ ขา 1 RX, 2 GND, 3 TX',
    ttyS0: 'mini UART (Pi 3/4 ที่ยังเปิด Bluetooth)',
    serial0: 'ชื่อแทนของ UART หลัก',
    serial1: 'ชื่อแทนของ UART ตัวที่สอง',
  };
  for (const [n, note] of Object.entries(uarts)) if (existsSync(join(dev, n))) add(join(dev, n), note);
  const byId = join(dev, 'serial', 'by-id');
  if (existsSync(byId))
    for (const n of readdirSync(byId).sort())
      add(join(byId, n), /ardupilot|px4|unifc|siyi|cubepilot|matek|holybro/i.test(n) ? 'บอร์ดควบคุมทางสาย USB (ใช้ชื่อนี้ได้ ไม่เปลี่ยนเมื่อเสียบใหม่)' : 'อุปกรณ์ USB (โมเด็ม 4G ก็อยู่ตรงนี้ได้)');
  for (const n of readdirSync(dev).sort()) if (/^tty(ACM|USB)\d+$/.test(n)) add(join(dev, n), n.startsWith('ttyACM') ? 'USB (บอร์ดควบคุมมักเป็น ttyACM0)' : 'USB-serial หรือโมเด็ม');
  return out;
}

function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const u = new URL(url);
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, accept: 'application/json' }, timeout: 15_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* not JSON: a proxy page, say */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('ไม่ตอบใน 15 วินาที')));
    req.on('error', reject);
    req.end(data);
  });
}

function readText(path: string) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** "Pi edge kit 1a2b3c4 · Raspberry Pi 5 Model B Rev 1.0 · Debian GNU/Linux 12 (bookworm)" for the audit log. */
function describeClient(kitDir: string) {
  const version = readText(join(kitDir, 'VERSION')).split(' ')[0].trim() || '?';
  const model = readText('/proc/device-tree/model').replace(/\0/g, '').trim() || 'Linux computer';
  const os = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(readText('/etc/os-release'))?.[1] ?? process.platform;
  return `Pi edge kit ${version} · ${model} · ${os}`;
}

async function main(argv: string[]) {
  const config = process.env.GATEWAY_CONFIG || DEFAULT_CONFIG;
  const [cmd, ...args] = argv;
  if (cmd === 'pair') {
    let server = args[0] ?? '';
    let code = args[1] ?? '';
    const link = parsePairingLink(server);
    if (link?.server) [server, code] = [link.server, link.code];
    if (!server || !code) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      if (!server) server = await rl.question('ที่อยู่เซิร์ฟเวอร์ (เช่น 192.168.20.13:8090): ');
      if (!code) code = await rl.question('รหัสจับคู่ 6 หลัก: ');
      rl.close();
    }
    const origin = normalizeServer(server);
    code = code.replace(/[\s-]/g, '');
    if (!origin) return fail(`"${server}" ไม่ใช่ที่อยู่เว็บ ใส่แบบ 192.168.20.13:8090`);
    if (!/^\d{6}$/.test(code)) return fail('รหัสต้องเป็นตัวเลข 6 หลัก');
    const r = await pair(origin, code, describeClient(dirname(new URL(import.meta.url).pathname)));
    if (!r.ok || !r.site) return fail(r.message);
    writeSiteFile(config, r.site);
    console.log(r.message);
    console.log(`บันทึกการตั้งค่าไว้ที่ ${config}`);
    for (const d of r.site.devices as { deviceId?: string; link?: { mode?: string; path?: string } }[])
      console.log(`  ${d.deviceId ?? '?'}: ${d.link?.mode === 'serial' ? `สาย ${d.link.path}` : d.link?.mode ? `UDP (${d.link.mode})` : 'ลิงก์ของรีโมต UniRC'}`);
    for (const p of missingPorts(r.site)) console.log(`คำเตือน: ยังไม่เห็น ${p} บนเครื่องนี้ (UART ต้องรีบูตหนึ่งครั้งหลังติดตั้ง, USB ต้องเสียบสาย) ดู: 13store-edge ports`);
    return 0;
  }
  if (cmd === 'status') {
    let s: GatewayStatus | null = null;
    try {
      s = JSON.parse(readFileSync(process.env.GATEWAY_STATUS_FILE || DEFAULT_STATUS, 'utf8')) as GatewayStatus;
    } catch {
      /* not running */
    }
    const r = formatStatus(s, Date.now());
    console.log(r.lines.join('\n'));
    return r.ok ? 0 : 1;
  }
  if (cmd === 'ports') {
    const ports = listPorts();
    if (!ports.length) console.log('ไม่พบพอร์ต serial: UART ต้องรีบูตหนึ่งครั้งหลังติดตั้ง, USB ต้องเสียบสายและเปิดไฟบอร์ด');
    for (const p of ports) console.log(`${p.path}${p.target !== p.path ? ` → ${p.target}` : ''}\n    ${p.note}`);
    try {
      const site = JSON.parse(readFileSync(config, 'utf8')) as SiteFile;
      for (const d of site.devices as { deviceId?: string; link?: { mode?: string; path?: string } }[])
        if (d.link?.mode === 'serial') console.log(`${d.deviceId} ใช้ ${d.link.path}${existsSync(d.link.path!) ? '' : ' (ไม่มีบนเครื่องนี้)'}`);
    } catch {
      /* not paired yet */
    }
    return 0;
  }
  console.log('ใช้: 13store-edge pair [ที่อยู่เซิร์ฟเวอร์] [รหัส] | status | ports | logs | restart | stop | start');
  return cmd ? 2 : 0;
}

function fail(message: string) {
  console.error(message);
  return 1;
}

// Run only as the kit's script, not when a test imports this file.
if (process.argv[1] && /edge-tool\.m?js$/.test(process.argv[1]))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error((e as Error).message);
      process.exit(1);
    },
  );
