// Web Push: subscriptions per user, VAPID-signed aes128gcm deliveries to a fake push service,
// dead-endpoint cleanup, and the platform triggers (assignment → responder, high severity →
// dispatchers/supervisors, SLA breach → supervisors).
import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, sleep, startServer, waitFor, type TestServer } from './helpers';

interface Hit {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let srv: TestServer;
let fake: http.Server;
let fakeUrl: string;
const hits: Hit[] = [];
let alex: Client;
let kitti: Client;
let nida: Client;
let ploy: Client;

beforeAll(async () => {
  // A fake push service: records every request, answers 201; /gone/* answers 410 (subscription expired).
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url?.startsWith('/gone/') ? 410 : 201);
      res.end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  srv = await startServer({ gateway: false });
  [alex, kitti, nida, ploy] = await Promise.all(['alex', 'kitti', 'nida', 'ploy'].map((u) => Client.login(srv.url, u)));
}, 30_000);
afterAll(async () => {
  await srv?.close();
  await new Promise((r) => fake?.close(r));
});

/** A browser-side subscription: real P-256 key pair plus the 16-byte auth secret. */
function receiver() {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } };
}

/** Decrypts an aes128gcm body (RFC 8188 header + RFC 8291 key derivation) the way a browser would. */
function decrypt(rcv: ReturnType<typeof receiver>, body: Buffer): { title: string; body: string; url?: string; tag?: string; incidentId?: string } {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const serverPub = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const shared = rcv.ecdh.computeSecret(serverPub);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), rcv.ecdh.getPublicKey(), serverPub]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, rcv.auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
}

const kittiRcv = receiver();
const nidaRcv = receiver();
const kittiId = randomUUID();
const nidaId = randomUUID();
const kittiPath = () => `/sub/kitti/${kittiId}`;
const nidaPath = () => `/sub/nida/${nidaId}`;
const since = (n: number, path: string) => hits.slice(n).filter((h) => h.path === path);

describe('Web Push', () => {
  it('publishes the VAPID public key; keys are generated once into DATA_DIR/vapid.json (0600)', async () => {
    const r = await kitti.get('/push/vapid');
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body.publicKey, 'base64url').length).toBe(65);
    expect(r.body.subject).toMatch(/^mailto:/);
    const file = join(srv.cfg.dataDir, 'vapid.json');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).publicKey).toBe(r.body.publicKey);
  });

  it('validates subscriptions; a user sees only their own devices, endpoints masked', async () => {
    expect((await kitti.post('/push/subscribe', { endpoint: 'http://push.example.com/x', keys: kittiRcv.keys })).status).toBe(400);
    expect((await kitti.post('/push/subscribe', { endpoint: `${fakeUrl}${kittiPath()}`, keys: { p256dh: 'AAAA', auth: kittiRcv.keys.auth } })).status).toBe(400);
    expect((await kitti.post('/push/subscribe', { endpoint: `${fakeUrl}${kittiPath()}`, keys: { p256dh: kittiRcv.keys.p256dh, auth: 'short' } })).status).toBe(400);
    const r = await kitti.post('/push/subscribe', { endpoint: `${fakeUrl}${kittiPath()}`, keys: kittiRcv.keys, ua: 'vitest' });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    // Re-registering the same browser is idempotent.
    expect((await kitti.post('/push/subscribe', { endpoint: `${fakeUrl}${kittiPath()}`, keys: kittiRcv.keys })).body.created).toBe(false);
    const mine = await kitti.get('/push/subscriptions');
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].endpoint.startsWith(fakeUrl)).toBe(true);
    expect(mine.body[0].endpoint).not.toContain(kittiId);
    expect(mine.body[0].ua).toBe('vitest');
    // Another user: nothing to see, nothing to delete.
    expect((await alex.get('/push/subscriptions')).body).toEqual([]);
    expect((await alex.req('DELETE', '/push/subscribe', { endpoint: `${fakeUrl}${kittiPath()}` })).body.removed).toBe(0);
    expect((await kitti.get('/push/subscriptions')).body).toHaveLength(1);
    // Audited.
    const audit = (await (await Client.login(srv.url, 'priya')).get('/audit?limit=200')).body as { action: string; role: string }[];
    expect(audit.some((e) => e.action === 'push.subscribe' && e.role === 'responder')).toBe(true);
  });

  it('assigning an incident pushes a VAPID-signed aes128gcm message with a deep link to the responder', async () => {
    const inc = await alex.post('/incidents', { title: 'Push drill', place: 'Gate', severity: 'low' });
    expect(inc.status).toBe(200);
    const n = hits.length;
    const asg = await alex.post(`/incidents/${inc.body.id}/assignments`, { responderId: 'u-kitti' });
    expect(asg.status).toBe(200);
    await waitFor(() => since(n, kittiPath()).length > 0, 5_000);
    const h = since(n, kittiPath())[0];
    expect(h.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, ?k=[\w-]+$/);
    expect(h.headers['content-encoding']).toBe('aes128gcm');
    expect(h.headers['content-type']).toBe('application/octet-stream');
    expect(h.headers.ttl).toBe('300');
    expect(h.headers.urgency).toBe('high');
    const msg = decrypt(kittiRcv, h.body);
    expect(msg.title).toBe(`Assigned: ${inc.body.id} Push drill`);
    expect(msg.body).toBe('Gate · Zone B');
    expect(msg.url).toBe(`/field/#task/${asg.body.id}`);
    expect(msg.incidentId).toBe(inc.body.id);
    expect(msg.tag).toBe(`asg-${asg.body.id}`);
    expect(msg.title.length).toBeLessThanOrEqual(60);
    expect(msg.body.length).toBeLessThanOrEqual(140);
  });

  it('a high-severity incident pushes to the subscribed supervisor, not to responders; medium does not page', async () => {
    expect((await nida.post('/push/subscribe', { endpoint: `${fakeUrl}${nidaPath()}`, keys: nidaRcv.keys })).status).toBe(200);
    const n = hits.length;
    const inc = await alex.post('/incidents', { title: 'Fire at the transformer', place: 'Transformer', type: 'Detection: Thermal hotspot', severity: 'high' });
    expect(inc.status).toBe(200);
    await waitFor(() => since(n, nidaPath()).length > 0, 5_000);
    const msg = decrypt(nidaRcv, since(n, nidaPath())[0].body);
    expect(msg.title).toBe(`High severity: ${inc.body.id}`);
    expect(msg.body).toBe('Fire at the transformer · Transformer');
    expect(msg.url).toBe('/');
    await sleep(200);
    expect(since(n, kittiPath())).toHaveLength(0);
    const m = hits.length;
    expect((await alex.post('/incidents', { title: 'Minor', place: 'Lot', severity: 'medium' })).status).toBe(200);
    await sleep(200);
    expect(hits.length).toBe(m);
  });

  it('an SLA breach pushes to supervisors', async () => {
    const inc = await alex.post('/incidents', { title: 'Loiterer at the gate', place: 'Service gate', type: 'Detection: Person', severity: 'medium' });
    expect(inc.status).toBe(200);
    const n = hits.length;
    const p = srv.built.platform;
    const realNow = p.now;
    p.now = () => Date.now() + 4 * 60_000; // acknowledge (2 min in the intrusion playbook) is breached for an untouched alert
    try {
      expect(p.checkSla().some((x) => x.incidentId === inc.body.id)).toBe(true);
    } finally {
      p.now = realNow;
    }
    // Other stages may breach too and arrive in any order: look for the acknowledge one.
    const ack = () =>
      since(n, nidaPath())
        .map((h) => decrypt(nidaRcv, h.body))
        .find((m) => m.tag === `sla-${inc.body.id}-acknowledge`);
    await waitFor(() => !!ack(), 5_000);
    const msg = ack()!;
    expect(msg.title).toBe(`SLA breached: ${inc.body.id}`);
    expect(msg.body).toMatch(/^Acknowledge > \d+ min · Loiterer at the gate$/);
    expect(msg.url).toBe('/');
    expect(msg.incidentId).toBe(inc.body.id);
  });

  it('removes a subscription whose endpoint answers 410 on the next send; POST /push/test reports delivery', async () => {
    const gone = `${fakeUrl}/gone/kitti/${randomUUID()}`;
    expect((await kitti.post('/push/subscribe', { endpoint: gone, keys: receiver().keys })).status).toBe(200);
    expect((await kitti.get('/push/subscriptions')).body).toHaveLength(2);
    const n = hits.length;
    const t = await kitti.post('/push/test');
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ subscriptions: 2, sent: 1, removed: 1, failed: 0, status: 'sent' });
    expect((await kitti.get('/push/subscriptions')).body).toHaveLength(1);
    const msg = decrypt(kittiRcv, since(n, kittiPath())[0].body);
    expect(msg.title).toBe('Test notification');
    expect(msg.url).toBe('/field/');
    // A user without devices gets a clear answer instead of an error.
    expect((await ploy.post('/push/test')).body).toMatchObject({ subscriptions: 0, sent: 0, status: 'none' });
    // Counters for the monitoring system.
    const metrics = (await ploy.get('/metrics')).body as string;
    expect(metrics).toMatch(/ps_push_total\{status="sent"\} [1-9]\d*/);
    expect(metrics).toMatch(/ps_push_total\{status="removed"\} 1\b/);
  });

  it('caps a user at 10 devices and lets them unsubscribe one by one', async () => {
    const eps = Array.from({ length: 9 }, () => `${fakeUrl}/sub/kitti/${randomUUID()}`);
    for (const e of eps) expect((await kitti.post('/push/subscribe', { endpoint: e, keys: kittiRcv.keys })).status).toBe(200);
    const over = await kitti.post('/push/subscribe', { endpoint: `${fakeUrl}/sub/kitti/${randomUUID()}`, keys: kittiRcv.keys });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('limit');
    for (const e of eps) expect((await kitti.req('DELETE', '/push/subscribe', { endpoint: e })).body.removed).toBe(1);
    expect((await kitti.get('/push/subscriptions')).body).toHaveLength(1);
  });
});
