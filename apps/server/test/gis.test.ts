// Enterprise 5 — GIS: WGS 84 anchor, GeoJSON export and import, gateway anchor check.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILDINGS, SITE, STEP_UP_ACTIONS, geoToSite, geofencesFromGeoJson, siteGeoJson, siteToGeo, toLonLat, type GeoJsonFeatureCollection } from '@13store/shared';
import { defaultAdapters, startGateway } from '@13store/gateway';
import { DEMO_GATEWAY_KEY } from '../src/seed';
import { Client, consoleSocket, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client; // dispatcher
let ploy: Client; // admin
let nida: Client; // supervisor

beforeAll(async () => {
  srv = await startServer();
  [alex, ploy, nida] = await Promise.all([Client.login(srv.url, 'alex'), Client.login(srv.url, 'ploy'), Client.login(srv.url, 'nida')]);
}, 30_000);
afterAll(() => srv?.close());

const A = SITE.geo;

describe('site grid ↔ WGS 84', () => {
  it('round-trips points and respects grid rotation', () => {
    const p = { x: 210.4, y: 140.2 };
    const g = siteToGeo(A, p);
    expect(g.lat).toBeLessThan(A.originLat); // +y is south
    expect(g.lon).toBeGreaterThan(A.originLon); // +x is east
    const back = geoToSite(A, g);
    expect(back.x).toBeCloseTo(p.x, 3);
    expect(back.y).toBeCloseTo(p.y, 3);
    const rot = { ...A, rotationDeg: 30 };
    const b2 = geoToSite(rot, siteToGeo(rot, p));
    expect(b2.x).toBeCloseTo(p.x, 3);
    expect(b2.y).toBeCloseTo(p.y, 3);
  });

  it('exports the site as a FeatureCollection with closed rings in [lon, lat]', () => {
    const fc = siteGeoJson({
      site: {
        id: 'site-demo',
        name: 'Civic Center',
        geometry: {
          ...SITE,
          buildings: BUILDINGS,
          zones: [],
          parking: { x: 0, y: 0, w: 1, d: 1 },
          plaza: { cx: 0, cy: 0, r: 1 },
          fenceY: 0,
          gate: { x: 0, w: 1 },
          road: {} as never,
        },
      },
      anchor: A,
      layers: ['buildings', 'site'],
    });
    expect(fc.type).toBe('FeatureCollection');
    const b1 = BUILDINGS[0];
    const f = fc.features.find((x) => x.id === b1.id)!;
    expect(f.geometry?.type).toBe('Polygon');
    const ring = (f.geometry as { coordinates: number[][][] }).coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(ring[0]).toEqual(toLonLat(A, { x: b1.x, y: b1.y }));
    expect(f.properties).toMatchObject({ layer: 'building', name: b1.name });
    expect(fc.site?.crs).toBe('urn:ogc:def:crs:OGC:1.3:CRS84');
  });

  it('imports polygons as geofences and explains what it skipped', () => {
    const poly = (pts: { x: number; y: number }[]) => [[...pts, pts[0]].map((p) => toLonLat(A, p))];
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'gis-1',
          geometry: {
            type: 'Polygon',
            coordinates: poly([
              { x: 200, y: 120 },
              { x: 240, y: 120 },
              { x: 240, y: 150 },
              { x: 200, y: 150 },
            ]),
          },
          properties: { name: 'Stage build-up', kind: 'keep-out', reason: 'Crane working' },
        },
        {
          type: 'Feature',
          id: 'gis-2',
          geometry: {
            type: 'Polygon',
            coordinates: poly([
              { x: 10, y: 10 },
              { x: 30, y: 10 },
              { x: 20, y: 30 },
            ]),
          },
          properties: { kind: 'no_fly' },
        },
        {
          type: 'Feature',
          id: 'far',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [100.9, 13.9],
                [100.91, 13.9],
                [100.91, 13.91],
                [100.9, 13.9],
              ],
            ],
          },
          properties: { name: 'Elsewhere' },
        },
        { type: 'Feature', id: 'pt', geometry: { type: 'Point', coordinates: [100.5, 13.75] }, properties: {} },
        {
          type: 'Feature',
          id: 'bad-kind',
          geometry: {
            type: 'Polygon',
            coordinates: poly([
              { x: 50, y: 50 },
              { x: 60, y: 50 },
              { x: 60, y: 60 },
            ]),
          },
          properties: { kind: 'lava' },
        },
      ],
    };
    const r = geofencesFromGeoJson(A, { width: SITE.width, height: SITE.height }, fc);
    expect(r.geofences).toHaveLength(2);
    expect(r.geofences[0]).toMatchObject({ name: 'Stage build-up', kind: 'keep_out', appliesTo: ['ugv', 'uav'], reason: 'Crane working', active: true });
    expect(r.geofences[0].poly[0]).toEqual({ x: 200, y: 120 });
    expect(r.geofences[0].poly).toHaveLength(4);
    expect(r.geofences[1]).toMatchObject({ name: 'gis-2', kind: 'no_fly', appliesTo: ['uav'] });
    expect(r.errors).toHaveLength(3);
    expect(r.errors.join(' ')).toMatch(/not on this site/);
    expect(r.errors.join(' ')).toMatch(/only Polygon/);
    expect(r.errors.join(' ')).toMatch(/kind must be/);
    expect(geofencesFromGeoJson(A, { width: 1, height: 1 }, { nope: true }).errors[0]).toMatch(/FeatureCollection/);
  });
});

describe('GIS on the platform', () => {
  it('serves the site record with its anchor and exports GeoJSON (download audited; admins get no incidents)', async () => {
    const site = (await alex.get('/sites/default')).body;
    expect(site.id).toBeTruthy();
    expect(site.geometry.geo).toEqual(SITE.geo);
    const r = await alex.req('GET', `/sites/${site.id}/geojson?download=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/geo\+json/);
    expect(r.headers.get('content-disposition')).toMatch(/attachment/);
    const layers = new Set((r.body as GeoJsonFeatureCollection).features.map((f) => f.properties.layer));
    expect([...layers].sort()).toEqual(['building', 'device', 'entrance', 'geofence', 'hydrant', 'incident', 'site', 'zone']);
    expect((r.body as GeoJsonFeatureCollection).features.find((f) => f.properties.layer === 'incident')?.properties.dataLabel).toBe('SIMULATION');
    const admin = (await ploy.get('/sites/default/geojson?layers=incidents,devices')).body as GeoJsonFeatureCollection;
    expect(admin.features.some((f) => f.properties.layer === 'incident')).toBe(false);
    expect(admin.features.some((f) => f.properties.layer === 'device')).toBe(true);
    const audit = (await ploy.get('/audit?action=site.export')).body as any[];
    expect(audit.some((e) => e.actorName === 'Alex Chen' || e.actor === 'Alex Chen' || JSON.stringify(e).includes('geojson'))).toBe(true);
  });

  it('imports geofences from GeoJSON; re-import updates by name; dispatchers cannot', async () => {
    const poly = (pts: { x: number; y: number }[]) => [[...pts, pts[0]].map((p) => toLonLat(A, p))];
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 7,
          geometry: {
            type: 'Polygon',
            coordinates: poly([
              { x: 120, y: 60 },
              { x: 160, y: 60 },
              { x: 160, y: 90 },
              { x: 120, y: 90 },
            ]),
          },
          properties: { name: 'Imported works', kind: 'caution' },
        },
      ],
    };
    expect((await alex.post('/geofences/import', fc)).status).toBe(403);
    const r = await nida.post('/geofences/import', fc);
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    expect(r.body.geofences[0]).toMatchObject({ name: 'Imported works', kind: 'caution' });
    const id = r.body.geofences[0].id;
    const again = await nida.post('/geofences/import', { ...fc, features: [{ ...fc.features[0], properties: { name: 'Imported works', kind: 'keep_out' } }] });
    expect(again.body.imported).toBe(1);
    expect(again.body.geofences[0].id).toBe(id);
    const list = (await alex.get('/geofences')).body as any[];
    expect(list.filter((g) => g.name === 'Imported works')).toHaveLength(1);
    expect(list.find((g) => g.id === id).kind).toBe('keep_out');
    expect((await nida.post('/geofences/import', { type: 'FeatureCollection', features: [] })).body).toMatchObject({ imported: 0 });
  });

  it('lets an administrator move the anchor (step-up action); the change is published and audited', async () => {
    expect((await alex.patch('/sites/default/geo', { originLat: 13.8, originLon: 100.6 })).status).toBe(403);
    // A fresh sign-in opens the step-up window; moving the anchor is a step-up action like approvals.
    expect(STEP_UP_ACTIONS).toContain('site.manage');
    expect((await ploy.patch('/sites/default/geo', { originLat: 95, originLon: 100.6 })).status).toBe(400);
    const [dispatcherWs, adminWs] = await Promise.all([consoleSocket(srv.wsUrl, alex.token), consoleSocket(srv.wsUrl, ploy.token)]);
    const ok = await ploy.patch('/sites/default/geo', { originLat: 13.8, originLon: 100.6, rotationDeg: 12 });
    expect(ok.status).toBe(200);
    // Every open console, administrators included, learns the new anchor at once.
    await waitFor(() => dispatcherWs.events.some((e) => e.type === 'site') && adminWs.events.some((e) => e.type === 'site'));
    expect(dispatcherWs.events.find((e) => e.type === 'site').site.geometry.geo.rotationDeg).toBe(12);
    dispatcherWs.close();
    adminWs.close();
    expect(ok.body.geometry.geo).toEqual({ originLat: 13.8, originLon: 100.6, rotationDeg: 12 });
    expect((await alex.get('/sites/default')).body.geometry.geo.rotationDeg).toBe(12);
    const snap = (await alex.get('/snapshot')).body;
    expect(snap.site.geometry.geo.originLat).toBe(13.8);
    expect(((await ploy.get('/audit?action=site.geo')).body as any[]).length).toBeGreaterThan(0);
    // back to the demo anchor for the other tests
    expect((await ploy.patch('/sites/default/geo', SITE.geo)).status).toBe(200);
  });

  it('warns when a gateway converts positions with a different anchor than the site', async () => {
    const gw = startGateway({
      serverUrl: srv.wsUrl,
      key: DEMO_GATEWAY_KEY,
      gatewayId: 'edge-shifted',
      adapters: defaultAdapters({ rateMs: 500 }).slice(0, 1),
      geo: { originLat: SITE.geo.originLat + 0.001, originLon: SITE.geo.originLon },
      log: { info() {}, warn() {}, error() {} } as never,
    });
    try {
      const mismatches = async () => ((await ploy.get('/audit?limit=200')).body as any[]).filter((e) => e.action === 'gateway.geo_mismatch');
      await waitFor(async () => (await mismatches()).length > 0, 10_000);
      const ev = (await mismatches())[0];
      expect(ev.object).toBe('edge-shifted');
      expect(JSON.stringify(ev)).toMatch(/11[0-9]\.\d m/); // 0.001° latitude ≈ 111 m
    } finally {
      await gw.stop();
    }
  });
});
