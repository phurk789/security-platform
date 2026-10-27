// End-to-end check of pushed video on one machine, without a camera or ffmpeg:
//   test platform server (push on) + the real MediaMTX with deploy/office-13/mediamtx.yml
//   + a gateway hello + a raw RTSP publish exactly as ffmpeg does it (ANNOUNCE, SETUP, RECORD).
// It shows that MediaMTX accepts the config and that the platform allows the right publish and
// refuses the wrong ones, and that a viewer token opens the WHEP page.
//   npx tsx scripts/check-media-push.ts <mediamtx executable> <this machine's LAN IP>
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { SANDBOX_GATEWAY_KEY } from '../apps/server/src/seed';
import { Client, startServer } from '../apps/server/test/helpers';

const [mtxBin, lanIp] = process.argv.slice(2);
if (!mtxBin || !lanIp) {
  console.error('usage: npx tsx scripts/check-media-push.ts <mediamtx executable> <LAN IP of this machine>');
  process.exit(2);
}
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed++;
};

/** One RTSP request on an open socket; resolves with status code, headers and body. */
function rtsp(sock: net.Socket, lines: string[], body = '') {
  return new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const [statusLine, ...hs] = buf.slice(0, end).split('\r\n');
      const headers: Record<string, string> = {};
      for (const h of hs) headers[h.slice(0, h.indexOf(':')).toLowerCase()] = h.slice(h.indexOf(':') + 1).trim();
      const len = Number(headers['content-length'] ?? 0);
      if (buf.length < end + 4 + len) return;
      sock.off('data', onData);
      resolve({ status: Number(statusLine.split(' ')[1]), headers });
    };
    sock.on('data', onData);
    sock.once('error', reject);
    sock.write([...lines, ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []), '', ''].join('\r\n') + body);
  });
}

const SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=Stream',
  'c=IN IP4 0.0.0.0',
  't=0 0',
  'm=video 0 RTP/AVP 96',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 packetization-mode=1; sprop-parameter-sets=Z0LAH9oBQBbpqAgICgAAAwACAAADAHkeMGVA,aM48gA==',
  'a=control:trackID=0',
  '',
].join('\r\n');

/** Publish like ffmpeg: ANNOUNCE (asks for credentials first), SETUP over TCP, RECORD. Returns the last status. */
async function publish(url: string, user?: string, pass?: string) {
  const u = new URL(url);
  const sock = net.connect(Number(u.port), u.hostname);
  await new Promise((r) => sock.once('connect', r));
  const auth = user ? [`Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`] : [];
  try {
    const a = await rtsp(sock, [`ANNOUNCE ${url} RTSP/1.0`, 'CSeq: 1', 'Content-Type: application/sdp', ...auth], SDP);
    if (a.status !== 200) return { step: 'ANNOUNCE', status: a.status, challenge: a.headers['www-authenticate'] };
    const s = await rtsp(sock, [`SETUP ${url}/trackID=0 RTSP/1.0`, 'CSeq: 2', 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1;mode=record', ...auth]);
    if (s.status !== 200) return { step: 'SETUP', status: s.status };
    const r = await rtsp(sock, [`RECORD ${url} RTSP/1.0`, 'CSeq: 3', `Session: ${s.headers.session?.split(';')[0]}`, ...auth]);
    return { step: 'RECORD', status: r.status, sock };
  } finally {
    // the caller keeps a successful publish open
  }
}

const srv = await startServer({ gateway: false, cfg: { mediaIngestUrl: `rtsp://${lanIp}:18554`, mediaPublicUrl: `http://${lanIp}:18889` } });
const dir = mkdtempSync(join(tmpdir(), 'mtx-check-'));
const conf = readFileSync(new URL('../deploy/office-13/mediamtx.yml', import.meta.url), 'utf8')
  .replace('http://server:8080/api/v1/media/auth', `${srv.url}/api/v1/media/auth`)
  .replace('webrtcAdditionalHosts: [192.168.20.13]', `webrtcAdditionalHosts: [${lanIp}]`);
writeFileSync(join(dir, 'mediamtx.yml'), conf);
const mtx = spawn(mtxBin, [join(dir, 'mediamtx.yml')], { stdio: ['ignore', 'pipe', 'pipe'] });
let mtxLog = '';
mtx.stdout.on('data', (d) => (mtxLog += d));
mtx.stderr.on('data', (d) => (mtxLog += d));
const t0 = Date.now();
while (!/listener opened on :18554/.test(mtxLog) && mtx.exitCode === null && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
check('MediaMTX 1.9.3 starts with deploy/office-13/mediamtx.yml', /listener opened on :18554/.test(mtxLog), mtx.exitCode !== null ? mtxLog.trim().split('\n').slice(-3).join(' | ') : '');

try {
  const ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${SANDBOX_GATEWAY_KEY}` } });
  await new Promise((r) => ws.on('open', r));
  const welcome = new Promise<any>((r) => ws.once('message', (m) => r(JSON.parse(String(m)))));
  ws.send(
    JSON.stringify({
      t: 'hello',
      protocol: GATEWAY_PROTOCOL,
      gatewayId: 'check-edge',
      adapters: [
        {
          deviceId: 'SBX-ROVER-01',
          kind: 'ugv',
          model: 'check',
          integration: 'testing',
          capabilities: ['video'],
          commands: [],
          rateMs: 1000,
          limitations: '',
          linkLossBehavior: '',
          stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true },
        },
      ],
    }),
  );
  const w = await welcome;
  const pub = new URL(w.media?.[0]?.publish ?? 'rtsp://x/');
  check('welcome carries a publish address on the ingest port', pub.port === '18554' && pub.pathname === '/sbx-rover-01', `${pub.protocol}//pub:***@${pub.host}${pub.pathname}`);
  const token = decodeURIComponent(pub.password);
  const url = `rtsp://${lanIp}:18554/sbx-rover-01`;

  const anon = await publish(url);
  check('publish without credentials is challenged for basic auth', anon.status === 401 && /basic/i.test(anon.challenge ?? ''), `${anon.step} ${anon.status} ${anon.challenge ?? ''}`);
  const wrong = await publish(url, 'pub', `${token.slice(0, -3)}xyz`);
  check('publish with a tampered token is refused', wrong.status === 401, `${wrong.step} ${wrong.status}`);
  const other = await publish(`rtsp://${lanIp}:18554/someone-else`, 'pub', token);
  check('publish to another path with a valid token is refused', other.status === 401, `${other.step} ${other.status}`);
  const ok = await publish(url, 'pub', token);
  check('publish with the gateway credential is accepted (ANNOUNCE, SETUP, RECORD)', ok.step === 'RECORD' && ok.status === 200, `${ok.step} ${ok.status}`);
  await new Promise((r) => setTimeout(r, 300));
  check('MediaMTX shows the stream as published', /is publishing to path 'sbx-rover-01'/.test(mtxLog));

  // A viewer: the console's 60 s token opens the media server's WebRTC page for this path only.
  const devop = await Client.login(srv.url, 'devop');
  const s = await devop.post('/media/SBX-ROVER-01/session');
  const whep = new URL(s.body.whep ?? 'http://x/');
  check('viewer link points at the platform media server', whep.origin === `http://${lanIp}:18889` && whep.pathname === '/sbx-rover-01/whep', whep.origin + whep.pathname);
  const page = (q: string) => fetch(`http://${lanIp}:18889/sbx-rover-01/${q}`).then((r) => r.status);
  check('WebRTC page opens with the viewer token', (await page(`?token=${whep.searchParams.get('token')}`)) === 200);
  check('WebRTC page is refused without a token', (await page('')) === 401);
  ok.sock?.destroy();
  ws.close();
} catch (e) {
  check('no exception', false, (e as Error).message);
} finally {
  mtx.kill();
  await srv.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
// Let sockets finish closing before exiting (an immediate exit trips a libuv assertion on Windows).
setTimeout(() => process.exit(failed ? 1 : 0), 200);
