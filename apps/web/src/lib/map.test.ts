// Map core without a browser: a fake map records sources and layers in order, so layer order,
// basemap switching, idempotent setup and overlay data can be checked exactly.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GEOFENCES, geoToSite, type Device, type Incident, type Mission, type TelemetrySample } from '@13store/shared';
import { BASEMAPS, BASEMAP_STORAGE_KEY, DEFAULT_BASEMAP, addBasemapLayers, basemapLabelsLayerId, basemapLayerId, basemaps, currentBasemap, getInitialBasemap, registerBasemaps, switchBasemap } from './basemaps';
import { LAYER_GROUPS, addLayerTo, ensureSlots, slotId } from './layerOrder';
import { OPERATIONAL_LAYER_IDS, SRC, buildOverlayData, ensureOperationalLayers, lngLat, trueBearing, updateOverlayData, type OverlayInput } from './overlays';
import { attachOrbitControls, clampPitch } from './orbitControls';
import { MAX_PITCH, baseMapStyle } from './terrain3d';

class FakeMap {
  layers: { id: string; layout: Record<string, unknown> }[] = [];
  sources = new Map<string, { spec: unknown; data?: unknown; setData(d: unknown): void }>();
  getLayer = (id: string) => this.layers.find((l) => l.id === id) as never;
  addLayer = (layer: { id: string; layout?: Record<string, unknown> }, before?: string) => {
    if (this.getLayer(layer.id)) throw new Error(`layer ${layer.id} already exists`);
    const entry = { id: layer.id, layout: { ...(layer.layout ?? {}) } };
    const i = before ? this.layers.findIndex((l) => l.id === before) : -1;
    if (before && i < 0) throw new Error(`before-layer ${before} missing`);
    if (i < 0) this.layers.push(entry);
    else this.layers.splice(i, 0, entry);
    return this as never;
  };
  getSource = (id: string) => this.sources.get(id) as never;
  addSource = (id: string, spec: unknown) => {
    if (this.sources.has(id)) throw new Error(`source ${id} already exists`);
    const s = { spec, data: undefined as unknown, setData: (d: unknown) => (s.data = d) };
    this.sources.set(id, s);
    return this as never;
  };
  setLayoutProperty = (id: string, k: string, v: unknown) => {
    this.layers.find((l) => l.id === id)!.layout[k] = v;
    return this as never;
  };
  getLayoutProperty = (id: string, k: string) => this.layers.find((l) => l.id === id)?.layout[k];
  order = (id: string) => this.layers.findIndex((l) => l.id === id);
}

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
});
afterEach(() => delete (globalThis as { localStorage?: unknown }).localStorage);

describe('globe style', () => {
  it('starts every map from an empty globe with sky and fog', () => {
    const s = baseMapStyle();
    expect(s).toMatchObject({ version: 8, sources: {}, layers: [], projection: { type: 'globe' } });
    expect(s.sky).toMatchObject({ 'sky-color': '#9fbdda', 'fog-ground-blend': 0.75 });
    expect(baseMapStyle()).not.toBe(s); // a fresh object per map
    expect(MAX_PITCH).toBe(89);
  });
});

describe('layer order', () => {
  it('keeps basemap at the bottom and live markers on top whatever the order layers are added in', () => {
    const m = new FakeMap();
    ensureSlots(m as never);
    ensureSlots(m as never); // idempotent
    expect(m.layers.map((l) => l.id)).toEqual(LAYER_GROUPS.slice(1).map((g) => slotId(g)));
    addLayerTo(m as never, 'live', { id: 'dots', type: 'circle', source: 's' });
    addLayerTo(m as never, 'basemap', { id: 'imagery', type: 'raster', source: 'r' });
    addLayerTo(m as never, 'routes', { id: 'route', type: 'line', source: 's' });
    addLayerTo(m as never, 'boundaries', { id: 'fence', type: 'line', source: 's' });
    expect(addLayerTo(m as never, 'routes', { id: 'route', type: 'line', source: 's' })).toBe(false);
    expect(m.order('imagery')).toBeLessThan(m.order('fence'));
    expect(m.order('fence')).toBeLessThan(m.order('route'));
    expect(m.order('route')).toBeLessThan(m.order('dots'));
    expect(m.layers.at(-1)!.id).toBe('dots');
  });
});

describe('basemaps', () => {
  it('offers OSM, Esri imagery, a satellite provider, satellite + labels and a terrain map, without keys', () => {
    expect(BASEMAPS.map((b) => b.id)).toEqual(expect.arrayContaining(['osm', 'esri-imagery', 's2cloudless', 'esri-imagery-labels', 'esri-topo']));
    for (const b of BASEMAPS) {
      expect(b.attribution.length).toBeGreaterThan(10);
      expect(b.tiles.every((u) => u.startsWith('https://') && !/key=|token=|google/i.test(u))).toBe(true);
    }
  });

  it('adds every basemap once under everything else, shows one, and keeps the choice across pages', () => {
    const m = new FakeMap();
    ensureSlots(m as never);
    addLayerTo(m as never, 'live', { id: 'dots', type: 'circle', source: 's' });
    expect(addBasemapLayers(m as never, getInitialBasemap())).toBe(DEFAULT_BASEMAP);
    addBasemapLayers(m as never, 'osm'); // second call adds nothing (the fake throws on duplicates)
    const visible = () => m.layers.filter((l) => l.id.startsWith('basemap-') && l.layout.visibility !== 'none').map((l) => l.id);
    expect(visible()).toEqual([basemapLayerId(DEFAULT_BASEMAP)]);
    expect(Math.max(...BASEMAPS.map((b) => m.order(basemapLayerId(b.id))))).toBeLessThan(m.order(slotId('terrain')));

    expect(switchBasemap(m as never, 'esri-imagery-labels')).toBe(true);
    expect(visible()).toEqual([basemapLayerId('esri-imagery-labels'), basemapLabelsLayerId('esri-imagery-labels')]);
    expect(currentBasemap(m as never)).toBe('esri-imagery-labels');
    expect(store.get(BASEMAP_STORAGE_KEY)).toBe('esri-imagery-labels');
    expect(getInitialBasemap()).toBe('esri-imagery-labels'); // the next page / reload opens with it

    expect(switchBasemap(m as never, 'no-such-map')).toBe(false);
    store.set(BASEMAP_STORAGE_KEY, 'retired-provider');
    expect(getInitialBasemap()).toBe(DEFAULT_BASEMAP);
  });

  it('adds the basemaps the server offers (Google) to the list, and drops them when the server stops offering them', () => {
    const google = { id: 'google-hybrid', label: 'Google satellite + labels', tiles: ['https://console.example/api/v1/basemaps/google-hybrid/tiles/{z}/{x}/{y}'], attribution: '', maxzoom: 22, provider: 'google' as const };
    store.set(BASEMAP_STORAGE_KEY, 'google-hybrid');
    expect(getInitialBasemap()).toBe(DEFAULT_BASEMAP); // not offered (yet): the default
    registerBasemaps([google, { ...google, id: 'osm', label: 'clash' }]);
    expect(basemaps().map((b) => b.id)).toEqual([...BASEMAPS.map((b) => b.id), 'google-hybrid']); // a clashing id is ignored
    expect(getInitialBasemap()).toBe('google-hybrid');
    const m = new FakeMap();
    ensureSlots(m as never);
    addBasemapLayers(m as never, getInitialBasemap());
    expect(currentBasemap(m as never)).toBe('google-hybrid');
    expect((m.sources.get(basemapLayerId('google-hybrid'))!.spec as { tiles: string[] }).tiles[0]).toMatch(/\/api\/v1\/basemaps\/google-hybrid\/tiles\//);
    registerBasemaps([]);
    expect(getInitialBasemap()).toBe(DEFAULT_BASEMAP);
  });
});

// ---------------------------------------------------------------------------

const GEO = { originLat: 13.4367374, originLon: 101.0275798, rotationDeg: -28.5 };
const dev = (id: string, extra: Partial<Device> = {}): Device =>
  ({ id, kind: 'ugv', model: 'x', integration: 'testing', pos: { x: 100, y: 100 }, accuracyM: 2, lastSeen: 1_000_000, rateMs: 1000, heading: 90, capabilities: [], commands: [], ...extra }) as unknown as Device;
const input = (over: Partial<OverlayInput> = {}): OverlayInput => ({
  anchor: GEO,
  devices: [],
  incidents: [],
  geofences: [],
  missions: [],
  telemetry: [],
  at: 1_000_000,
  replay: false,
  selectedDeviceId: null,
  selectedIncidentId: null,
  layers: {},
  showTrails: true,
  showPlan: false,
  freshness: () => 'live',
  ...over,
});
const ids = (fc: { features: { properties: unknown }[] }) => fc.features.map((f) => (f.properties as { id: string }).id);

describe('overlay data', () => {
  it('places devices at their real position: the WGS 84 point the gateway reported', () => {
    const d = buildOverlayData(input({ devices: [dev('UGV-01', { pos: { x: 120.5, y: 80.25 } })] }));
    const [lon, lat] = (d.devices.features[0].geometry as { coordinates: number[] }).coordinates;
    const back = geoToSite(GEO, { lat, lon });
    expect(Math.hypot(back.x - 120.5, back.y - 80.25)).toBeLessThan(0.001);
  });

  it('leaves a device with no GNSS fix off the map instead of drawing it at its last or default position', () => {
    const d = buildOverlayData(input({ devices: [dev('UGV-01', { noFix: true }), dev('UGV-02')] }));
    expect(ids(d.devices)).toEqual(['UGV-02']);
    expect(ids(d.accuracy)).toEqual(['UGV-02']);
  });

  it('points the heading arrow to true north bearings (site grid heading + grid rotation)', () => {
    const d = buildOverlayData(input({ devices: [dev('UGV-01', { heading: 90 }), dev('CCTV-01', { kind: 'cctv' } as Partial<Device>)] }));
    const p = (id: string) => d.devices.features.find((f) => (f.properties as { id: string }).id === id)!.properties as Record<string, number>;
    expect(p('UGV-01').bearing).toBeCloseTo(trueBearing(GEO, 90));
    expect(p('UGV-01').bearing).toBeCloseTo(61.5);
    expect(p('UGV-01').hasBearing).toBe(1);
    expect(p('CCTV-01').hasBearing).toBe(0);
  });

  it('follows the layer switches', () => {
    const devices = [dev('UGV-01'), dev('UAV-01', { kind: 'uav' } as Partial<Device>), dev('CCTV-01', { kind: 'cctv' } as Partial<Device>)];
    expect(ids(buildOverlayData(input({ devices, layers: { uav: false, cctv: false } })).devices)).toEqual(['UGV-01']);
    expect(buildOverlayData(input({ devices, layers: { geofences: false }, geofences: DEFAULT_GEOFENCES })).geofences.features).toHaveLength(0);
    expect(buildOverlayData(input({ geofences: DEFAULT_GEOFENCES })).geofences.features.length).toBe(DEFAULT_GEOFENCES.filter((g) => g.active).length);
    expect(buildOverlayData(input({ devices, layers: { labels: false } })).devices.features.every((f) => (f.properties as { showLabel: number }).showLabel === 0)).toBe(true);
  });

  it('draws trails from recent samples, broken where the vehicle went silent', () => {
    const s = (at: number, x: number): TelemetrySample => ({ deviceId: 'UGV-01', at, x, y: 50 });
    const telemetry = [s(900_000, 1), s(901_000, 2), s(902_000, 3), /* 60 s gap */ s(962_000, 10), s(963_000, 11), s(100, 99) /* too old */];
    const d = buildOverlayData(input({ devices: [dev('UGV-01')], telemetry: telemetry.filter((t) => t.at > 1000).concat() }));
    expect(d.trails.features.map((f) => (f.geometry as { coordinates: unknown[] }).coordinates.length)).toEqual([3, 2]);
    expect(buildOverlayData(input({ devices: [dev('UGV-01')], telemetry, showTrails: false })).trails.features).toHaveLength(0);
  });

  it('in replay shows where devices were at that time, and nothing for devices without a sample then', () => {
    const telemetry: TelemetrySample[] = [
      { deviceId: 'UGV-01', at: 500, x: 10, y: 10 },
      { deviceId: 'UGV-01', at: 700, x: 20, y: 10 },
      { deviceId: 'UGV-01', at: 900, x: 30, y: 10 },
    ];
    const d = buildOverlayData(input({ replay: true, at: 750, telemetry, devices: [dev('UGV-01', { noFix: true }), dev('UGV-02')] }));
    expect(ids(d.devices)).toEqual(['UGV-01']);
    expect((d.devices.features[0].geometry as { coordinates: number[] }).coordinates).toEqual(lngLat(GEO, { x: 20, y: 10 }));
  });

  it('shows open incidents and routes of missions in progress, drafts apart', () => {
    const inc = (id: string, status: Incident['status']) => ({ id, status, severity: 'high', createdAt: 0, pos: { x: 50, y: 50 } }) as unknown as Incident;
    const mission = (id: string, status: Mission['status'], draft: boolean): Mission =>
      ({ id, incidentId: 'INC-1', deviceId: 'UGV-01', operatorId: 'u', checkpoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }], planVersion: 2, approvedVersion: draft ? 1 : 2, status, nextCp: 0, createdAt: 0 }) as Mission;
    const d = buildOverlayData(input({ incidents: [inc('INC-1', 'new'), inc('INC-2', 'closed')], missions: [mission('M-1', 'executing', false), mission('M-2', 'pending_approval', true), mission('M-3', 'completed', false)], devices: [dev('UGV-01')] }));
    expect(ids(d.incidents)).toEqual(['INC-1']);
    expect(d.routes.features.map((f) => [(f.properties as { missionId: string }).missionId, (f.properties as { draft: number }).draft])).toEqual([
      ['M-1', 0],
      ['M-2', 1],
    ]);
  });

  it('adds overlay sources and layers once, above the basemap, and fills them in place', () => {
    const m = new FakeMap();
    ensureSlots(m as never);
    addBasemapLayers(m as never, 'osm');
    ensureOperationalLayers(m as never);
    ensureOperationalLayers(m as never); // a second time adds nothing
    expect(OPERATIONAL_LAYER_IDS.every((id) => m.order(id) > m.order(basemapLayerId('osm')))).toBe(true);
    expect(m.order('ops-boundary-line')).toBeLessThan(m.order('ops-route-line'));
    expect(m.order('ops-trail-line')).toBeLessThan(m.order('ops-device-dot'));
    expect(m.order('ops-device-dot')).toBeLessThan(m.order('ops-device-label'));
    const data = buildOverlayData(input({ devices: [dev('UGV-01')] }));
    updateOverlayData(m as never, data);
    expect((m.sources.get(SRC.devices)!.data as { features: unknown[] }).features).toHaveLength(1);
  });
});

describe('orbit controls', () => {
  function fakeMap() {
    const container = new EventTarget();
    const win = new EventTarget();
    const cam = { bearing: 10, pitch: 20 };
    let pan = true;
    const map = {
      getCanvasContainer: () => container,
      getBearing: () => cam.bearing,
      getPitch: () => cam.pitch,
      jumpTo: (o: { bearing: number; pitch: number }) => Object.assign(cam, o),
      dragPan: { isEnabled: () => pan, enable: () => (pan = true), disable: () => (pan = false) },
    };
    const pivot = { on: false, classList: { add: () => (pivot.on = true), remove: () => (pivot.on = false) } };
    const ev = (type: string, o: Record<string, unknown>) => Object.assign(new Event(type, { cancelable: true }), { button: 0, ctrlKey: false, metaKey: false, clientX: 0, clientY: 0, ...o });
    return { map, container, win, cam, pivot, ev, pan: () => pan };
  }

  it('turns with the middle button or Ctrl+drag: sideways = bearing, up/down = pitch within 0–89°', () => {
    const f = fakeMap();
    const dispose = attachOrbitControls(f.map as never, { win: f.win, pivot: f.pivot as never });
    f.container.dispatchEvent(f.ev('mousedown', { button: 1, clientX: 100, clientY: 100 }));
    expect(f.pan()).toBe(false); // no panning while turning
    expect(f.pivot.on).toBe(true);
    f.win.dispatchEvent(f.ev('mousemove', { clientX: 150, clientY: 60 }));
    expect(f.cam.bearing).toBeCloseTo(30);
    expect(f.cam.pitch).toBeCloseTo(32);
    f.win.dispatchEvent(f.ev('mousemove', { clientX: 150, clientY: -1000 }));
    expect(f.cam.pitch).toBe(MAX_PITCH);
    f.win.dispatchEvent(f.ev('mouseup', {}));
    expect(f.pan()).toBe(true);
    expect(f.pivot.on).toBe(false);

    f.container.dispatchEvent(f.ev('mousedown', { button: 0, ctrlKey: true, clientX: 0, clientY: 0 }));
    f.win.dispatchEvent(f.ev('mousemove', { clientX: 0, clientY: 2000 }));
    expect(f.cam.pitch).toBe(0);
    f.win.dispatchEvent(f.ev('mouseup', {}));
    dispose();
  });

  it('leaves a plain left drag to the map, and does nothing once disposed', () => {
    const f = fakeMap();
    const dispose = attachOrbitControls(f.map as never, { win: f.win, pivot: f.pivot as never });
    f.container.dispatchEvent(f.ev('mousedown', { button: 0, clientX: 0, clientY: 0 }));
    f.win.dispatchEvent(f.ev('mousemove', { clientX: 300, clientY: 300 }));
    expect(f.cam).toEqual({ bearing: 10, pitch: 20 });
    dispose();
    f.container.dispatchEvent(f.ev('mousedown', { button: 1, clientX: 0, clientY: 0 }));
    f.win.dispatchEvent(f.ev('mousemove', { clientX: 300, clientY: 0 }));
    expect(f.cam.bearing).toBe(10);
    expect(clampPitch(-5)).toBe(0);
  });
});
