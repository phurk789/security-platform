// Site management: administrators create, rename and delete sites; devices move between sites
// only while offline (their gateway is paired again there); an evaluation licence has one site.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startServer, type TestServer } from './helpers';

describe('sites in the demo environment', () => {
  let srv: TestServer;
  let alex: Client; // dispatcher
  let ploy: Client; // admin
  beforeAll(async () => {
    srv = await startServer();
    [alex, ploy] = await Promise.all(['alex', 'ploy'].map((u) => Client.login(srv.url, u)));
  }, 30_000);
  afterAll(() => srv?.close());

  it('creates, renames and lists a site; dispatchers cannot', async () => {
    expect((await alex.post('/sites', { name: 'Event yard', originLat: 13.75, originLon: 100.5 })).status).toBe(403);
    expect((await ploy.post('/sites', { name: '', originLat: 13.75, originLon: 100.5 })).status).toBe(400);
    expect((await ploy.post('/sites', { name: 'Event yard', originLat: 200, originLon: 100.5 })).status).toBe(400);
    const s = await ploy.post('/sites', { name: 'Event yard', originLat: 13.75, originLon: 100.5 });
    expect(s.status).toBe(200);
    expect(s.body.geometry.geo).toMatchObject({ originLat: 13.75, originLon: 100.5 });
    expect(s.body.geometry.buildings).toEqual([]); // a real site has no demo plan
    const r = await ploy.patch(`/sites/${s.body.id}`, { name: 'Event yard B' });
    expect(r.body.name).toBe('Event yard B');
    const list = (await ploy.get('/sites')).body as { id: string; name: string; demo: boolean; devices: string[] }[];
    expect(list.find((x) => x.id === s.body.id)).toMatchObject({ name: 'Event yard B', demo: false, devices: [] });
    expect(list.find((x) => x.demo)?.devices.length).toBeGreaterThan(0);
  });

  it('moves an offline device to another site and back; refuses a live one and a busy site delete', async () => {
    const site = (await ploy.post('/sites', { name: 'Second yard', originLat: 13.8, originLon: 100.6 })).body;
    expect((await ploy.post('/devices', { id: 'UGV-90', kind: 'ugv', model: 'Spare rover' })).status).toBe(200);
    const live = await ploy.patch('/devices/UGV-01/site', { siteId: site.id });
    expect(live.status).toBe(409);
    expect(live.body.error).toMatch(/is online/);
    expect((await ploy.patch('/devices/UGV-90/site', { siteId: site.id })).status).toBe(200);
    let list = (await ploy.get('/sites')).body as { id: string; devices: string[] }[];
    expect(list.find((x) => x.id === site.id)?.devices).toEqual(['UGV-90']);
    expect(((await ploy.get(`/devices?siteId=${site.id}`)).body as { id: string }[]).map((d) => d.id)).toEqual(['UGV-90']);
    const busy = await ploy.req('DELETE', `/sites/${site.id}`);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/1 devices/);
    const home = list.find((x) => x.id !== site.id && x.devices.includes('UGV-01'))!.id;
    expect((await ploy.patch('/devices/UGV-90/site', { siteId: home })).status).toBe(200);
    expect((await ploy.req('DELETE', `/sites/${site.id}`)).status).toBe(200);
    list = (await ploy.get('/sites')).body as { id: string; devices: string[] }[];
    expect(list.some((x) => x.id === site.id)).toBe(false);
    const audit = (await ploy.get('/audit?action=admin.device_move')).body as { object: string; action: string }[];
    expect(audit.filter((e) => e.object === 'UGV-90' && e.action === 'admin.device_move')).toHaveLength(2);
    // The first site stays the default: a device registered without a site lands there.
    expect((await ploy.post('/devices', { id: 'UGV-91', kind: 'ugv', model: 'Spare' })).status).toBe(200);
    expect(((await ploy.get('/sites')).body as { id: string; devices: string[] }[]).find((x) => x.devices.includes('UGV-91'))?.id).toBe(home);
    expect((await ploy.post('/devices', { id: 'UGV-92', kind: 'ugv', model: 'Spare', siteId: 'no-such-site' })).status).toBe(404);
  });

  it('site access per user: checked lists, sessions end on a change, a site someone only sees cannot be removed', async () => {
    const site = (await ploy.post('/sites', { name: 'Gate yard', originLat: 13.7, originLon: 100.4 })).body as { id: string };
    const users = (await ploy.get('/admin/users')).body as { id: string; username: string; siteIds: string[] }[];
    const a = users.find((u) => u.username === 'alex')!;
    const me = users.find((u) => u.username === 'ploy')!;
    expect((await ploy.patch(`/admin/users/${a.id}`, { siteIds: ['no-such-site'] })).status).toBe(400);
    expect((await ploy.patch(`/admin/users/${a.id}`, { siteIds: 'all' })).status).toBe(400);
    expect((await ploy.patch(`/admin/users/${me.id}`, { siteIds: [site.id] })).status).toBe(409); // not your own
    expect((await ploy.patch(`/admin/users/${a.id}`, { siteIds: [site.id] })).body.siteIds).toEqual([site.id]);
    expect((await alex.get('/sites')).status).toBe(401); // signed out: the old feed had the old access
    const alex2 = await Client.login(srv.url, 'alex');
    expect(((await alex2.get('/sites')).body as { id: string }[]).map((x) => x.id)).toEqual([site.id]);
    expect((await alex2.get('/snapshot')).body.site.id).toBe(site.id);
    const blocked = await ploy.req('DELETE', `/sites/${site.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/alex can only see Gate yard/);
    expect((await ploy.patch(`/admin/users/${a.id}`, { siteIds: [] })).status).toBe(200);
    expect((await ploy.req('DELETE', `/sites/${site.id}`)).status).toBe(200);
  });
});

describe('sites under an evaluation licence', () => {
  let srv: TestServer;
  let admin: Client;
  beforeAll(async () => {
    process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
    srv = await startServer({ env: 'pilot', gateway: false });
    delete process.env.ADMIN_PASSWORD;
    admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
  }, 30_000);
  afterAll(() => srv?.close());

  it('allows one site: a second needs a licence file', async () => {
    const r = await admin.post('/sites', { name: 'Event', originLat: 13.75, originLon: 100.5 });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('license');
    expect((await admin.req('DELETE', `/sites/${((await admin.get('/sites')).body as { id: string }[])[0].id}`)).status).toBe(409);
  });
});
