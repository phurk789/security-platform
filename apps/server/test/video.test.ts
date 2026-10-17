// Video: AI / sensor detections with per-organisation rules, recordings from the site media
// server (MediaMTX playback API) and clips saved as evidence.
import http from 'node:http';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DETECTION_RULES, GATEWAY_PROTOCOL } from '@13store/shared';
import { matchRule, sanitizeDetection, validateRules } from '../src/detections';
import { DEMO_ALERT_KEY, SANDBOX_GATEWAY_KEY } from '../src/seed';
import { Client, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client;
let ploy: Client;
let sensor: Client;

beforeAll(async () => {
  srv = await startServer();
  [alex, ploy] = await Promise.all([Client.login(srv.url, 'alex'), Client.login(srv.url, 'ploy')]);
  sensor = Client.withKey(srv.url, DEMO_ALERT_KEY);
}, 30_000);
afterAll(() => srv?.close());

describe('detection rules', () => {
  it('matches the first enabled rule, honouring confidence, temperature, zones and hours', () => {
    const rules = validateRules([
      {
        id: 'night',
        name: 'Night intrusion',
        types: ['person'],
        minConfidence: 0.5,
        zones: ['Zone B'],
        hours: { from: '22:00', to: '06:00' },
        action: 'incident',
        severity: 'high',
        cooldownS: 60,
      },
      ...DEFAULT_DETECTION_RULES,
    ]);
    const tz = 'Asia/Bangkok';
    const night = Date.UTC(2026, 0, 1, 19, 0, 0); // 02:00 Bangkok
    const day = Date.UTC(2026, 0, 1, 7, 0, 0); // 14:00 Bangkok
    expect(matchRule(rules, { type: 'person', confidence: 0.7, zone: 'Zone B', at: night }, tz)?.id).toBe('night');
    expect(matchRule(rules, { type: 'person', confidence: 0.7, zone: 'Zone B', at: day }, tz)?.id).toBe('intrusion');
    expect(matchRule(rules, { type: 'person', confidence: 0.7, zone: 'Zone A', at: night }, tz)?.id).toBe('intrusion');
    expect(matchRule(rules, { type: 'person', confidence: 0.3, zone: 'Zone B', at: night }, tz)).toBeUndefined();
    expect(matchRule(rules, { type: 'thermal_hotspot', confidence: 1, at: day, attributes: { temperatureC: 45 } }, tz)).toBeUndefined();
    expect(matchRule(rules, { type: 'thermal_hotspot', confidence: 1, at: day, attributes: { temperatureC: 85 } }, tz)?.id).toBe('fire');
    expect(matchRule(rules, { type: 'motion', confidence: 1, at: day }, tz)?.action).toBe('ignore');
    expect(matchRule(rules, { type: 'vehicle', confidence: 0.9, at: day }, tz)?.action).toBe('log');
  });

  it('rejects malformed rules and detections with a readable message', () => {
    expect(() => validateRules([{ id: 'bad id!', name: 'x', types: ['person'], action: 'incident' }])).toThrow(/id must be/);
    expect(() => validateRules([{ id: 'a', name: 'x', types: ['ghost'], action: 'incident' }])).toThrow(/types must list/);
    expect(() => validateRules([{ id: 'a', name: 'x', types: ['person'], action: 'incident', hours: { from: '25:00', to: '06:00' } }])).toThrow(/HH:MM/);
    expect(() => validateRules([{ id: 'a', name: 'x', types: ['person'], action: 'delete' }])).toThrow(/action must be/);
    expect(() => sanitizeDetection({ type: 'unicorn' }, Date.now())).toThrow(/type must be/);
    expect(() => sanitizeDetection({ type: 'person', confidence: 7 }, Date.now())).toThrow(/confidence/);
    expect(sanitizeDetection({ type: 'person', at: Date.now() + 3_600_000 }, Date.now()).at).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe('detection ingest', () => {
  it('raises an incident with the frame as evidence, merges repeats within the cooldown, logs vehicles, ignores motion', async () => {
    const frame = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180"/></svg>').toString('base64');
    const r1 = await sensor.post('/detections', {
      type: 'person',
      confidence: 0.87,
      deviceId: 'CCTV-02',
      source: 'Video analytics',
      bbox: [0.47, 0.49, 0.1, 0.39],
      pos: { x: 341, y: 238 },
      snapshot: { mime: 'image/svg+xml', base64: frame },
      externalId: 'va-1001',
    });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ type: 'person', outcome: 'incident', ruleId: 'intrusion', deviceId: 'CCTV-02' });
    const incId = r1.body.incidentId as string;
    const inc = (await alex.get(`/incidents/${incId}`)).body;
    expect(inc).toMatchObject({ title: 'Person detected · CCTV-02', type: 'Detection: Person', severity: 'medium', cameraId: 'CCTV-02', status: 'new' });
    const ev = (await alex.get(`/incidents/${incId}/evidence`)).body as any[];
    expect(ev.some((e) => e.id === r1.body.snapshotEvidenceId && e.kind === 'snapshot' && e.mime === 'image/svg+xml')).toBe(true);
    const tl = (await alex.get(`/incidents/${incId}/timeline`)).body as any[];
    expect(tl.some((e) => e.title === 'Detection details' && /confidence 87%/.test(e.detail) && /box 47\/49\/10\/39%/.test(e.detail))).toBe(true);

    // Same camera, same type, a few seconds later → joins the open incident, no second alarm.
    const r2 = await sensor.post('/detections', { type: 'person', confidence: 0.91, deviceId: 'CCTV-02', source: 'Video analytics' });
    expect(r2.body).toMatchObject({ outcome: 'merged', incidentId: incId });
    expect(((await alex.get(`/incidents/${incId}/timeline`)).body as any[]).some((e) => e.title === 'Person detected again')).toBe(true);
    // The sender retrying with the same externalId gets the first answer back.
    const r3 = await sensor.post('/detections', { type: 'person', confidence: 0.87, deviceId: 'CCTV-02', externalId: 'va-1001' });
    expect(r3.body).toMatchObject({ id: r1.body.id, outcome: 'duplicate' });
    // Vehicles are logged, motion ignored; neither raises an incident.
    const batch = await sensor.post('/detections', [
      { type: 'vehicle', confidence: 0.8, deviceId: 'CCTV-01', attributes: { plate: '1กข 1234' } },
      { type: 'motion', deviceId: 'CCTV-03' },
    ]);
    expect(batch.body.map((d: any) => d.outcome)).toEqual(['logged', 'ignored']);
    expect(batch.body[0].incidentId).toBeUndefined();

    const list = (await alex.get('/detections?limit=10')).body as any[];
    expect(list.map((d) => d.type).sort()).toEqual(['motion', 'person', 'person', 'vehicle']);
    const stats = (await alex.get('/detections/stats')).body as any[];
    expect(stats.find((s) => s.type === 'person' && s.outcome === 'incident').n).toBe(1);
  });

  it('a thermal hotspot above the threshold is a high-severity incident; below it is only logged', async () => {
    const cold = await sensor.post('/detections', { type: 'thermal_hotspot', deviceId: 'CCTV-02', source: 'Thermal NVR', attributes: { temperatureC: 42 } });
    expect(cold.body.outcome).toBe('logged');
    const hot = await sensor.post('/detections', {
      type: 'thermal_hotspot',
      deviceId: 'CCTV-02',
      source: 'Thermal NVR',
      attributes: { temperatureC: 78.5 },
      place: 'Transformer yard',
    });
    expect(hot.body).toMatchObject({ outcome: 'incident', ruleId: 'fire' });
    const inc = (await alex.get(`/incidents/${hot.body.incidentId}`)).body;
    expect(inc).toMatchObject({ title: 'Thermal hotspot 78.5 °C · CCTV-02', severity: 'high', place: 'Transformer yard' });
  });

  it('administrators change the rules; a dispatcher cannot, and bad rules are refused', async () => {
    const cur = (await ploy.get('/admin/settings')).body;
    expect(cur.detection.rules.map((r: any) => r.id)).toEqual(['intrusion', 'fire', 'crowd', 'vehicles', 'motion']);
    const rules = cur.detection.rules.map((r: any) => (r.id === 'vehicles' ? { ...r, action: 'incident', severity: 'low' } : r));
    const saved = await ploy.patch('/admin/settings', { detection: { rules, timezone: 'Asia/Bangkok' } });
    expect(saved.status).toBe(200);
    expect(saved.body.detection.rules.find((r: any) => r.id === 'vehicles').action).toBe('incident');
    const v = await sensor.post('/detections', { type: 'vehicle', confidence: 0.9, deviceId: 'CCTV-01', attributes: { plate: '2ขค 555' } });
    expect(v.body.outcome).toBe('incident');
    expect((await alex.get(`/incidents/${v.body.incidentId}`)).body.title).toBe('Vehicle detected · CCTV-01');
    expect((await ploy.patch('/admin/settings', { detection: { rules: [{ id: 'x', name: 'x', types: ['person'], action: 'explode' }] } })).status).toBe(400);
    expect((await ploy.patch('/admin/settings', { detection: { timezone: 'Mars/Olympus' } })).status).toBe(400);
    expect((await alex.get('/admin/settings')).status).toBe(403);
    const audit = (await Client.login(srv.url, 'priya')).get('/audit?action=admin.settings_update');
    expect(((await audit).body as any[]).length).toBeGreaterThan(0);
  });

  it('a camera adapter can raise detections through the gateway channel', async () => {
    const devop = await Client.login(srv.url, 'devop');
    const ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${SANDBOX_GATEWAY_KEY}` } });
    await new Promise((r) => ws.on('open', r));
    const welcome = new Promise<any>((r) => ws.once('message', (m) => r(JSON.parse(String(m)))));
    ws.send(
      JSON.stringify({
        t: 'hello',
        protocol: GATEWAY_PROTOCOL,
        gatewayId: 'onvif-edge',
        adapters: [
          {
            deviceId: 'SBX-ROVER-01',
            kind: 'cctv',
            model: 'ONVIF PTZ',
            integration: 'testing',
            capabilities: ['video', 'camera'],
            commands: [],
            rateMs: 1000,
            limitations: '',
            linkLossBehavior: '',
          },
        ],
      }),
    );
    expect((await welcome).accepted).toEqual(['SBX-ROVER-01']);
    ws.send(
      JSON.stringify({
        t: 'event',
        deviceId: 'SBX-ROVER-01',
        at: Date.now() - 1000,
        kind: 'detection',
        detail: 'tns1:RuleEngine/FieldDetector/ObjectsInside',
        detection: { type: 'intrusion', confidence: 1, source: 'ONVIF PTZ analytics' },
      }),
    );
    await waitFor(async () => ((await devop.get('/detections?limit=5')).body as any[]).some((d) => d.type === 'intrusion'));
    const det = ((await devop.get('/detections?limit=5')).body as any[]).find((d) => d.type === 'intrusion');
    expect(det).toMatchObject({ outcome: 'incident', deviceId: 'SBX-ROVER-01', source: 'ONVIF PTZ analytics' });
    expect((await devop.get(`/incidents/${det.incidentId}`)).body.title).toBe('Intrusion detected · SBX-ROVER-01');
    ws.close();
  });

  it('demo controls inject a detection the way an analytics system would', async () => {
    const r = await alex.post('/demo/inject-detection', { type: 'thermal_hotspot' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ type: 'thermal_hotspot', deviceId: 'CCTV-02' });
    expect(['incident', 'merged']).toContain(r.body.outcome);
  });
});

/** A fake MediaMTX playback server: /list and /get, checking the token the platform hands out. */
function fakePlayback(srvUrl: string) {
  const hits: string[] = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push(u.pathname + u.search);
    // MediaMTX asks the platform whether this viewer may play this path.
    const auth = await fetch(`${srvUrl}/api/v1/media/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'playback', path: u.searchParams.get('path'), query: u.search.slice(1) }),
    });
    if (auth.status !== 200) {
      res.writeHead(401);
      return res.end();
    }
    if (u.pathname === '/list') {
      const start = Date.parse(u.searchParams.get('start')!);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify([
          { start: new Date(start + 60_000).toISOString(), duration: 600, url: 'x' },
          { start: new Date(start + 900_000).toISOString(), duration: 120.5, url: 'y' },
        ]),
      );
    }
    if (u.pathname === '/get') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end(Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(2048, 7)]));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise<{ url: string; hits: string[]; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits, close: () => server.close() })),
  );
}

describe('recordings', () => {
  it('simulated cameras show coverage from telemetry and play back as a labelled storyboard', async () => {
    const now = Date.now();
    const r = await alex.get(`/media/CCTV-02/recordings?from=${now - 600_000}&to=${now}`);
    expect(r.status).toBe(200);
    expect(r.body.label).toBe('SIMULATED');
    expect(r.body.playback).toBe(false);
    expect(r.body.segments.length).toBeGreaterThan(0);
    expect(r.body.segments[0].end).toBeGreaterThan(r.body.segments[0].start);
    const clip = await alex.post('/media/CCTV-02/clip', { start: now - 60_000, duration: 30 });
    expect(clip.body).toMatchObject({ label: 'SIMULATED', mime: 'image/svg+xml' });
    const svg = await fetch(srv.url + clip.body.url);
    expect(svg.status).toBe(200);
    const text = await svg.text();
    expect(text).toMatch(/SIMULATED RECORDING/);
    expect((text.match(/<g transform/g) ?? []).length).toBe(6);
    expect((await fetch(srv.url + clip.body.url.replace(/sig=.{4}/, 'sig=0000'))).status).toBe(403);
    // Auditors may not watch video.
    expect((await (await Client.login(srv.url, 'priya')).get(`/media/CCTV-02/recordings`)).status).toBe(403);
  });

  it('saves a stretch of recording to the incident as checksummed evidence', async () => {
    const inc = (await alex.post('/incidents', { title: 'Clip test', place: 'Gate' })).body;
    const r = await alex.post(`/incidents/${inc.id}/evidence/clip`, { deviceId: 'CCTV-02', start: Date.now() - 90_000, duration: 45 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'clip', incidentId: inc.id, source: 'CCTV-02', simulated: true, mime: 'image/svg+xml' });
    expect(r.body.title).toMatch(/^CCTV-02 recording \d\d:\d\d:\d\d–\d\d:\d\d:\d\d$/);
    const content = await fetch(`${srv.url}/api/v1/evidence/${r.body.id}/content`, { headers: { authorization: `Bearer ${alex.token}` } });
    expect(content.headers.get('x-integrity')).toBe('ok');
    expect((await alex.post(`/incidents/${inc.id}/evidence/clip`, { deviceId: 'CCTV-02', start: Date.now() + 60_000, duration: 30 })).status).toBe(400);
  });

  it('real cameras answer from the site media server playback API with the viewer token checked by the platform', async () => {
    const pb = await fakePlayback(srv.url);
    const devop = await Client.login(srv.url, 'devop');
    const ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${SANDBOX_GATEWAY_KEY}` } });
    await new Promise((r) => ws.on('open', r));
    const welcome = new Promise<any>((r) => ws.once('message', (m) => r(JSON.parse(String(m)))));
    ws.send(
      JSON.stringify({
        t: 'hello',
        protocol: GATEWAY_PROTOCOL,
        gatewayId: 'onvif-edge',
        adapters: [
          {
            deviceId: 'SBX-ROVER-01',
            kind: 'cctv',
            model: 'ONVIF PTZ',
            integration: 'testing',
            capabilities: ['video', 'camera'],
            commands: [],
            rateMs: 1000,
            limitations: '',
            linkLossBehavior: '',
            stream: { whep: 'https://edge.example:8889/cam-ptz-01/whep', playback: pb.url },
          },
        ],
      }),
    );
    expect((await welcome).accepted).toEqual(['SBX-ROVER-01']);
    try {
      const now = Date.now();
      const r = await devop.get(`/media/SBX-ROVER-01/recordings?from=${now - 3_600_000}&to=${now}`);
      expect(r.status).toBe(200);
      expect(r.body.label).toBe('RECORDED');
      expect(r.body.playback).toBe(true);
      expect(r.body.segments).toHaveLength(2);
      expect(r.body.segments[1].end - r.body.segments[1].start).toBe(120_500);
      expect(pb.hits[0]).toMatch(/^\/list\?path=cam-ptz-01&start=.*&token=/);
      const clip = await devop.post('/media/SBX-ROVER-01/clip', { start: now - 120_000, duration: 20 });
      expect(clip.body.label).toBe('RECORDED');
      expect(clip.body.url).toMatch(new RegExp(`^${pb.url}/get\\?path=cam-ptz-01&start=.*&duration=20&format=mp4&token=`));
      // The platform-issued token is for this device only: MediaMTX asks and is told no for another path.
      const bad = await fetch(clip.body.url.replace('path=cam-ptz-01', 'path=other-cam'));
      expect(bad.status).toBe(401);
      expect((await fetch(clip.body.url)).status).toBe(200);
      // Save a clip: the platform fetches the MP4 from the media server and stores it with a checksum.
      const dev = await Client.login(srv.url, 'dev');
      const inc = (await dev.post('/incidents', { title: 'Sandbox clip', place: 'Lot' })).body;
      expect(inc.id).toMatch(/^SBX-INC-/);
      const ev = await dev.post(`/incidents/${inc.id}/evidence/clip`, { deviceId: 'SBX-ROVER-01', start: now - 120_000, duration: 20 });
      expect(ev.status).toBe(200);
      expect(ev.body).toMatchObject({ kind: 'clip', mime: 'video/mp4', simulated: false, size: 12 + 2048 });
      expect((srv.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'evidence.clip' AND org_id = 'org-sandbox'").get() as { n: number }).n).toBe(1);
    } finally {
      ws.close();
      pb.close();
    }
  });
});
