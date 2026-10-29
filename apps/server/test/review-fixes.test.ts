// Regression tests for defects found in the enterprise review.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITE, geofencesFromGeoJson, slaStages } from '@13store/shared';
import { Notifier } from '../src/notify';
import { Client, startServer, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client;
let ploy: Client;
let kitti: Client;

beforeAll(async () => {
  srv = await startServer({ gateway: false });
  [alex, ploy, kitti] = await Promise.all([Client.login(srv.url, 'alex'), Client.login(srv.url, 'ploy'), Client.login(srv.url, 'kitti')]);
}, 30_000);
afterAll(() => srv?.close());

describe('access rules', () => {
  it('administrators read an incident by id but do not change it', async () => {
    const inc = await alex.post('/incidents', { title: 'Private', place: 'Gate' });
    expect((await ploy.get(`/incidents/${inc.body.id}`)).status).toBe(200);
    expect((await ploy.post(`/incidents/${inc.body.id}/triage`)).status).toBe(403);
    expect((await alex.get(`/incidents/${inc.body.id}`)).status).toBe(200);
  });

  it('responders get no patrols or device details over REST, matching the live feed', async () => {
    expect((await kitti.get('/patrols')).body).toEqual([]);
    expect((await kitti.get('/devices/UGV-01')).status).toBe(404);
    expect((await kitti.get('/devices/UGV-01/telemetry')).status).toBe(404);
    // Administrators see the same patrols as a supervisor.
    expect((await ploy.get('/patrols')).status).toBe(200);
    expect(Array.isArray((await ploy.get('/patrols')).body)).toBe(true);
  });
});

describe('notification secrets', () => {
  it('refuses a masked secret that has no stored value (new or renamed channel)', async () => {
    const r = await ploy.patch('/admin/settings', {
      notifications: { channels: [{ id: 'renamed', name: 'SOC', kind: 'webhook', events: ['incident.new'], webhook: { url: 'https://soc.example/h', secret: '••••••••' } }] },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/masked secret/);
  });

  it('a retried SMS delivery does not text numbers that already succeeded', async () => {
    const calls: string[] = [];
    let failB = 1;
    const fetchFn = (async (url: string) => {
      const to = new URL(url).searchParams.get('to')!;
      calls.push(to);
      if (to === 'B' && failB-- > 0) return new Response('busy', { status: 503 });
      return new Response('OK', { status: 200 });
    }) as unknown as typeof fetch;
    const n = new Notifier(srv.db, { fetchFn, retryDelaysMs: [1, 1] });
    const d = await n.deliver(
      'org-demo',
      {
        id: 'sms',
        name: 'Duty',
        kind: 'sms',
        enabled: true,
        events: ['incident.new'],
        sms: { url: 'https://sms.example/send?to={to}&text={text}', method: 'GET', to: ['A', 'B'] },
      },
      { event: 'incident.new', title: 'x', text: 'y' },
    );
    expect(d.status).toBe('sent');
    expect(calls).toEqual(['A', 'B', 'B']);
  });
});

describe('GeoJSON import', () => {
  it('reports malformed coordinates instead of throwing', () => {
    const r = geofencesFromGeoJson(
      SITE.geo,
      { width: SITE.width, height: SITE.height },
      {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[100.5, 13.7, 100.6, 13.8]] }, properties: {} },
          { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: 'x' }, properties: {} },
        ],
      },
    );
    expect(r.geofences).toHaveLength(0);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/longitude, latitude/);
  });

  it('the import route answers 200 with errors for malformed input', async () => {
    const nida = await Client.login(srv.url, 'nida');
    const r = await nida.post('/geofences/import', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: 5 }, properties: {} }] });
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(0);
  });
});

describe('SLA', () => {
  it('an incident resolved from the control room meets "respond" at resolution', () => {
    const T0 = 1_000_000;
    const inc = {
      id: 'X',
      title: 't',
      type: 'Sensor alert',
      severity: 'medium',
      status: 'resolved',
      zone: 'Z',
      place: 'P',
      pos: { x: 0, y: 0 },
      source: 's',
      createdAt: T0,
    } as never;
    const ev = (title: string, min: number) => ({ id: title, incidentId: 'X', at: T0 + min * 60_000, receivedAt: T0, title, actor: 'a', tone: 'info' }) as never;
    const st = slaStages(
      inc,
      [ev('Camera opened', 1), ev('Verified — action required', 3), ev('Resolved', 8)],
      { acknowledge: 2, verify: 5, respond: 10, resolve: 60 },
      T0 + 120 * 60_000,
    );
    expect(st.find((s) => s.stage === 'respond')?.status).toBe('met');
  });
});

describe('single sign-on', () => {
  it('only same-origin return paths are accepted (unit check of the rule)', () => {
    const rule = (v: string) => /^\/(?![\/\\])/.test(v);
    expect(rule('/incidents')).toBe(true);
    expect(rule('//evil.example/x')).toBe(false);
    expect(rule('/\\evil.example')).toBe(false);
    expect(rule('https://evil.example')).toBe(false);
  });
});
