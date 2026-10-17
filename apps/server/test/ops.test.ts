// Command centre: SOP playbooks with checklists and SLA stages, outbound notifications
// (signed webhook with retries, LINE push, SMS gateway) and KPIs with the period report.
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PLAYBOOKS, computeKpi, pickPlaybook, slaStages, type Incident, type TimelineEvent } from '@13store/shared';
import { Notifier } from '../src/notify';
import { SECRET_MASK } from '../src/retention';
import { Client, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client;
let ploy: Client;
let nida: Client;

beforeAll(async () => {
  srv = await startServer();
  [alex, ploy, nida] = await Promise.all(['alex', 'ploy', 'nida'].map((u) => Client.login(srv.url, u)));
}, 30_000);
afterAll(() => srv?.close());

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
const inc = (over: Partial<Incident> = {}): Incident => ({
  id: 'INC-900',
  title: 'x',
  type: 'Sensor alert',
  severity: 'medium',
  status: 'new',
  zone: 'Zone B',
  place: 'Gate',
  pos: { x: 0, y: 0 },
  source: 'Sensor',
  createdAt: T0,
  thumb: 'gate',
  ...over,
});
const ev = (title: string, min: number): TimelineEvent => ({
  id: `e${title}${min}`,
  incidentId: 'INC-900',
  at: T0 + min * 60_000,
  receivedAt: T0 + min * 60_000,
  actor: 'x',
  title,
});

describe('playbooks and SLA stages', () => {
  it('picks the playbook by incident type and falls back to the general one', () => {
    expect(pickPlaybook(DEFAULT_PLAYBOOKS, inc({ type: 'Detection: Thermal hotspot' }))?.id).toBe('fire');
    expect(pickPlaybook(DEFAULT_PLAYBOOKS, inc({ type: 'Detection: Person' }))?.id).toBe('intrusion');
    expect(pickPlaybook(DEFAULT_PLAYBOOKS, inc({ type: 'Sensor alert' }))?.id).toBe('intrusion');
    expect(pickPlaybook(DEFAULT_PLAYBOOKS, inc({ type: 'Something else' }))?.id).toBe('default');
  });

  it('measures each stage from the alert and marks met, at risk or breached', () => {
    const limits = { acknowledge: 2, verify: 5, respond: 10, resolve: 60 };
    // Fresh alert, 1 minute old: everything running; at 100 s acknowledge (2 min) is at risk (last 30 s).
    let st = slaStages(inc(), [], limits, T0 + 60_000);
    expect(st.map((s) => s.status)).toEqual(['running', 'running', 'running', 'running']);
    expect(slaStages(inc(), [], limits, T0 + 100_000)[0].status).toBe('at_risk');
    // 3 minutes, still new: acknowledge breached.
    st = slaStages(inc(), [], limits, T0 + 3 * 60_000);
    expect(st[0].status).toBe('breached');
    // Triage at 1 min, verified at 4 min, mission started at 12 min: ack met, verify met, respond breached (late), resolve running.
    const events = [ev('Camera opened', 1), ev('Verified — action required', 4), ev('Mission MSN-1 started', 12)];
    st = slaStages(inc({ status: 'responding' }), events, limits, T0 + 15 * 60_000);
    expect(st.map((s) => s.status)).toEqual(['met', 'met', 'breached', 'running']);
    expect(st[2].doneAt).toBe(T0 + 12 * 60_000);
    // Dismissed as a false alarm at 3 min: no response needed; the dismissal resolves it.
    st = slaStages(inc({ status: 'dismissed' }), [ev('Camera opened', 1), ev('Dismissed as false alarm', 3)], limits, T0 + 60 * 60_000);
    expect(st.map((s) => s.status)).toEqual(['met', 'met', 'na', 'met']);
    // No limit → not applicable.
    expect(slaStages(inc(), [], { ...limits, respond: 0 }, T0)[2].status).toBe('na');
  });

  it('computes KPIs: counts, percentiles, compliance, false alarms', () => {
    const incidents = [
      inc({ id: 'A', status: 'closed', createdAt: T0 }),
      inc({ id: 'B', status: 'dismissed', createdAt: T0 + 3_600_000, type: 'Detection: Person' }),
      inc({ id: 'C', status: 'responding', createdAt: T0 + 7_200_000, severity: 'high' }),
      inc({ id: 'P', status: 'closed', createdAt: T0 + 100, type: 'Scheduled patrol', patrolId: 'PAT-1' }),
    ];
    const tl: TimelineEvent[] = [
      { ...ev('Camera opened', 1), incidentId: 'A' },
      { ...ev('Verified — action required', 3), incidentId: 'A' },
      { ...ev('Mission MSN-1 started', 8), incidentId: 'A' },
      { ...ev('Resolved', 40), incidentId: 'A' },
      { ...ev('Camera opened', 61), incidentId: 'B', at: T0 + 3_600_000 + 60_000 },
      { ...ev('Dismissed as false alarm', 62), incidentId: 'B', at: T0 + 3_600_000 + 120_000 },
      { ...ev('Camera opened', 121), incidentId: 'C', at: T0 + 7_200_000 + 60_000 },
      { ...ev('Verified — action required', 130), incidentId: 'C', at: T0 + 7_200_000 + 10 * 60_000 },
    ];
    const k = computeKpi({ from: T0 - 1, to: T0 + 86_400_000, incidents, timeline: tl, missions: [], playbooks: DEFAULT_PLAYBOOKS, now: T0 + 7_200_000 + 20 * 60_000 });
    expect(k.incidents.total).toBe(4);
    expect(k.incidents.open).toBe(1);
    expect(k.incidents.falseAlarmPct).toBe(25);
    expect(k.response.verify.n).toBe(3);
    expect(k.response.verify.p50).toBe(3);
    expect(k.response.respond.p50).toBe(8);
    // A: ack 1≤2, verify 3≤5, respond 8≤10, resolve 40≤60 all met. B: ack, verify and resolve (dismissal) met. C: ack met, verify 10>5 breached, respond still open 20>10 breached.
    expect(k.sla.met).toBe(8);
    expect(k.sla.breached).toBe(2);
    expect(k.sla.compliancePct).toBe(80);
    expect(k.incidents.perDay.length).toBeGreaterThanOrEqual(1);
    expect(k.incidents.byType[0]).toEqual({ type: 'Sensor alert', n: 2 });
  });
});

/** Fake endpoints: a webhook that verifies the signature and fails once, a LINE push API, an SMS gateway. */
function fakeEndpoints(secret: string) {
  const got: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let webhookFailures = 1;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      got.push({ path: req.url ?? '', headers: req.headers, body });
      if (req.url === '/hook') {
        const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
        if (req.headers['x-pst-signature'] !== sig) {
          res.writeHead(401);
          return res.end('bad signature');
        }
        if (webhookFailures > 0) {
          webhookFailures--;
          res.writeHead(503);
          return res.end('try later');
        }
        res.writeHead(200);
        return res.end('ok');
      }
      if (req.url === '/line/push') {
        if (req.headers.authorization !== 'Bearer line-token-1') {
          res.writeHead(401);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      if (req.url?.startsWith('/sms')) {
        res.writeHead(200);
        return res.end('OK');
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise<{ url: string; got: typeof got; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, got, close: () => server.close() })),
  );
}

describe('notifications', () => {
  it('delivers a signed webhook (retrying once), a LINE push and an SMS; logs each; masks secrets for the console', async () => {
    const fake = await fakeEndpoints('hook-secret');
    srv.built.platform.notifier = new Notifier(srv.db, { now: () => srv.built.platform.now(), retryDelaysMs: [10, 10], lineApiUrl: `${fake.url}/line/push` });
    srv.built.platform.notifier.onDelivery = (d, orgId) => srv.built.platform.bus.emit('notification', { orgId, delivery: d });
    try {
      const channels = [
        {
          id: 'hook',
          name: 'SOC webhook',
          kind: 'webhook',
          events: ['incident.new', 'sla.breach', 'incident.confirmed'],
          webhook: { url: `${fake.url}/hook`, secret: 'hook-secret' },
        },
        { id: 'line', name: 'Ops LINE', kind: 'line', events: ['incident.new'], minSeverity: 'high', line: { token: 'line-token-1', to: 'Cgroup1' } },
        { id: 'sms', name: 'Duty phone', kind: 'sms', events: ['incident.confirmed'], sms: { url: `${fake.url}/sms?to={to}&text={text}`, method: 'GET', to: ['+66812345678'] } },
      ];
      const saved = await ploy.patch('/admin/settings', { notifications: { channels } });
      expect(saved.status).toBe(200);
      expect(saved.body.notifications.channels[0].webhook.secret).toBe(SECRET_MASK);
      expect(saved.body.notifications.channels[1].line.token).toBe(SECRET_MASK);
      // Sending the masked value back keeps the stored secret.
      const again = await ploy.patch('/admin/settings', { notifications: { channels: saved.body.notifications.channels } });
      expect(again.status).toBe(200);
      expect(
        (await ploy.patch('/admin/settings', { notifications: { channels: [{ id: 'x', name: 'x', kind: 'webhook', events: ['incident.new'], webhook: { url: 'ftp://nope' } }] } }))
          .status,
      ).toBe(400);
      expect((await ploy.patch('/admin/settings', { notifications: { channels: saved.body.notifications.channels } })).status).toBe(200);

      // A medium alert: webhook yes (after one retry), LINE no (below high), SMS no (event).
      const r = await alex.post('/incidents', { title: 'Notify me', place: 'Gate', severity: 'medium' });
      expect(r.status).toBe(200);
      // Seeded incidents may breach SLA in the background: look only at this alert's deliveries.
      const mine = () => fake.got.filter((g) => g.path === '/hook' && JSON.parse(g.body).incidentId === r.body.id);
      await waitFor(() => mine().length >= 2, 5000);
      const hook = mine();
      expect(hook).toHaveLength(2);
      const payload = JSON.parse(hook[1].body);
      expect(payload).toMatchObject({ event: 'incident.new', incidentId: r.body.id, severity: 'medium' });
      expect(hook[1].headers['x-pst-event']).toBe('incident.new');
      expect(fake.got.some((g) => g.path === '/line/push')).toBe(false);
      // A high alert goes to LINE too; confirming it sends the SMS.
      const hi = await alex.post('/incidents', { title: 'Big one', place: 'Lot', severity: 'high' });
      await waitFor(() => fake.got.some((g) => g.path === '/line/push'), 5000);
      const line = JSON.parse(fake.got.find((g) => g.path === '/line/push')!.body);
      expect(line.to).toBe('Cgroup1');
      expect(line.messages[0].text).toMatch(/Big one/);
      await alex.post(`/incidents/${hi.body.id}/triage`);
      await alex.post(`/incidents/${hi.body.id}/confirm`);
      await waitFor(() => fake.got.some((g) => g.path.startsWith('/sms')), 5000);
      expect(decodeURIComponent(fake.got.find((g) => g.path.startsWith('/sms'))!.path)).toMatch(/to=\+66812345678&text=.*confirmed/);
      // Delivery log for the administrator; dispatcher cannot read it.
      await waitFor(async () => ((await ploy.get('/admin/notifications/log')).body as any[]).length >= 4, 5000);
      const log = (await ploy.get('/admin/notifications/log')).body as any[];
      expect(log.find((d) => d.channelId === 'hook' && d.event === 'incident.new' && d.incidentId === r.body.id)).toMatchObject({ status: 'sent', attempts: 2 });
      expect((await alex.get('/admin/notifications/log')).status).toBe(403);
      // Test button.
      const test = await ploy.post('/admin/notifications/test', { channelId: 'line' });
      expect(test.body).toMatchObject({ status: 'sent', kind: 'line' });
      expect((await ploy.post('/admin/notifications/test', { channelId: 'ghost' })).status).toBe(404);
    } finally {
      fake.close();
    }
  }, 20_000);
});

describe('playbooks on the platform', () => {
  it('gives a new incident its checklist; steps are ticked with who and when; SLA breaches are raised once', async () => {
    const r = await alex.post('/incidents', { title: 'Hotspot drill', place: 'Transformer', type: 'Detection: Thermal hotspot', severity: 'high' });
    expect(r.body.playbookId).toBe('fire');
    expect(r.body.checklist.map((s: any) => s.id)).toEqual(['verify-thermal', 'call-fire', 'dispatch-ugv', 'keep-clear', 'notify-fm', 'record']);
    const done = await alex.post(`/incidents/${r.body.id}/steps/call-fire`, { done: true });
    expect(done.status).toBe(200);
    const step = done.body.checklist.find((s: any) => s.id === 'call-fire');
    expect(step.by).toBe('Alex Chen');
    expect(step.doneAt).toBeGreaterThan(0);
    expect((await alex.post(`/incidents/${r.body.id}/steps/nope`, { done: true })).status).toBe(404);
    const tl = (await alex.get(`/incidents/${r.body.id}/timeline`)).body as any[];
    expect(tl.some((e) => e.title === 'Step done: Call the fire brigade (199) and the site fire warden')).toBe(true);

    // Jump 4 minutes ahead: acknowledge (1 min) and verify (3 min) are breached for an untouched alert.
    const p = srv.built.platform;
    const realNow = p.now;
    p.now = () => Date.now() + 4 * 60_000;
    try {
      const first = p.checkSla();
      expect(first.filter((x) => x.incidentId === r.body.id).map((x) => x.stage)).toEqual(['acknowledge', 'verify']);
      expect(p.checkSla().filter((x) => x.incidentId === r.body.id)).toEqual([]); // raised once
      const inc = (await alex.get(`/incidents/${r.body.id}`)).body;
      expect(inc.slaBreached).toEqual(['acknowledge', 'verify']);
      const tl2 = (await alex.get(`/incidents/${r.body.id}/timeline`)).body as any[];
      expect(tl2.filter((e) => /^SLA breached/.test(e.title)).map((e) => e.title)).toEqual(['SLA breached: acknowledge within 1 min', 'SLA breached: verify within 3 min']);
      const audit = (await Client.login(srv.url, 'priya')).get('/audit?action=sla.breach');
      expect(((await audit).body as any[]).length).toBeGreaterThanOrEqual(2);
    } finally {
      p.now = realNow;
    }
  });

  it('administrators change playbooks; bad ones are refused', async () => {
    const st = (await ploy.get('/admin/settings')).body;
    expect(st.playbooks.map((b: any) => b.id)).toEqual(['fire', 'intrusion', 'equipment', 'default']);
    const books = st.playbooks.map((b: any) => (b.id === 'intrusion' ? { ...b, sla: { ...b.sla, verify: 2 } } : b));
    expect((await ploy.patch('/admin/settings', { playbooks: books })).body.playbooks[1].sla.verify).toBe(2);
    expect((await ploy.patch('/admin/settings', { playbooks: [{ id: 'bad id', name: 'x', steps: [], sla: {} }] })).status).toBe(400);
    expect((await ploy.patch('/admin/settings', { playbooks: [{ id: 'ok', name: 'x', steps: [{ title: '' }], sla: {} }] })).status).toBe(400);
    expect((await nida.get('/admin/settings')).status).toBe(403);
  });

  it('serves KPIs and the period report; downloads are audited', async () => {
    const k = await alex.get(`/kpi?from=${Date.now() - 86_400_000}&to=${Date.now() + 60_000}`);
    expect(k.status).toBe(200);
    expect(k.body.incidents.total).toBeGreaterThan(3);
    expect(k.body.sla.measured).toBeGreaterThan(0);
    expect(k.body.detections).toBeDefined();
    expect(k.body.patrols).toBeDefined();
    const rep = await alex.get(`/kpi/report?from=${Date.now() - 86_400_000}&to=${Date.now() + 60_000}`);
    expect(rep.body.markdown).toMatch(/# Operations report/);
    expect(rep.body.markdown).toMatch(/SLA compliance/);
    // Download needs evidence.export (supervisor), not a dispatcher.
    const dl = await fetch(`${srv.url}/api/v1/kpi/report?from=${Date.now() - 86_400_000}&to=${Date.now()}&download=1`, { headers: { authorization: `Bearer ${alex.token}` } });
    expect(dl.status).toBe(403);
    const ok = await fetch(`${srv.url}/api/v1/kpi/report?from=${Date.now() - 86_400_000}&to=${Date.now()}&download=1`, { headers: { authorization: `Bearer ${nida.token}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(await ok.text()).toMatch(/## Response times/);
    const audit = (await Client.login(srv.url, 'priya')).get('/audit?action=report.export');
    expect(((await audit).body as any[]).some((a) => /^kpi:/.test(a.object))).toBe(true);
  });
});
