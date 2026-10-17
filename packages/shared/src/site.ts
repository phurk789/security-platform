import type { GeoAnchor } from './geo';
/** 17 Oct 2026 05:27:00 Asia/Bangkok — the scenario start time from the concept mockup. */
export const SCENARIO_START = Date.UTC(2026, 9, 16, 22, 27, 0);

// ---------------------------------------------------------------------------
// Site geometry (metres, local site grid; origin = north-west corner, +y = south)
// ---------------------------------------------------------------------------

/** WGS 84 position of the demo site's grid origin (north-west corner). Placeholder in central
 *  Bangkok; a real site gets its anchor from a survey (Administration → Site & GIS). */
export const DEMO_GEO: GeoAnchor = { originLat: 13.7563, originLon: 100.5018, rotationDeg: 0 };

export const SITE = {
  name: 'Civic Center',
  org: '13STORE Demo Org',
  width: 420,
  height: 290,
  crs: 'Local site grid (m, origin NW corner, +x east, +y south) anchored to WGS 84',
  /** WGS 84 anchor of the grid origin and its rotation. */
  geo: DEMO_GEO,
};

export interface Entrance {
  id: string;
  name: string;
  kind: 'main' | 'service' | 'fire';
  x: number;
  y: number;
}

/** Building information (BIM / facility register) used by the twin and the building panel. */
export interface BuildingInfo {
  levels: number;
  levelHeightM: number;
  basementLevels?: number;
  gfaM2: number;
  occupancy: number;
  yearBuilt?: number;
  structure: string;
  entrances: Entrance[];
  hydrants: { x: number; y: number }[];
  /** Notable systems and assets for responders (alarm panel, generator, lift, control room …). */
  assets: string[];
  /** Where the 3D model comes from: drawn from the footprint, or an imported BIM model (glTF). */
  modelSource: 'procedural' | 'bim';
}

export interface Building {
  id: string;
  name: string;
  use: string;
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  zone: string;
  bim: BuildingInfo;
}

const info = (b: Omit<Building, 'bim'>, extra: Partial<BuildingInfo> & Pick<BuildingInfo, 'occupancy' | 'structure' | 'assets'>): Building => {
  const levelHeightM = extra.levelHeightM ?? 3.6;
  const levels = extra.levels ?? Math.max(1, Math.round(b.h / levelHeightM));
  const cx = b.x + b.w / 2;
  const entrances: Entrance[] = extra.entrances ?? [
    { id: `${b.id}-E1`, name: 'Main entrance (south)', kind: 'main', x: cx, y: b.y + b.d },
    { id: `${b.id}-E2`, name: 'Service entrance (east)', kind: 'service', x: b.x + b.w, y: b.y + b.d / 2 },
    { id: `${b.id}-F1`, name: 'Fire exit (north-west)', kind: 'fire', x: b.x + 4, y: b.y },
    { id: `${b.id}-F2`, name: 'Fire exit (south-east)', kind: 'fire', x: b.x + b.w - 4, y: b.y + b.d },
  ];
  return {
    ...b,
    bim: {
      levels,
      levelHeightM,
      basementLevels: extra.basementLevels,
      gfaM2: extra.gfaM2 ?? Math.round(b.w * b.d * levels * 0.92),
      occupancy: extra.occupancy,
      yearBuilt: extra.yearBuilt,
      structure: extra.structure,
      entrances,
      hydrants: extra.hydrants ?? [{ x: cx - 12, y: b.y + b.d + 6 }],
      assets: extra.assets,
      modelSource: 'procedural',
    },
  };
};

export const BUILDINGS: Building[] = [
  info(
    { id: 'B1', name: 'Building 1', use: 'Administration', x: 50, y: 52, w: 92, d: 56, h: 22, zone: 'Zone A' },
    {
      occupancy: 420,
      yearBuilt: 2009,
      structure: 'Reinforced concrete frame, curtain wall',
      assets: ['Fire alarm panel, lobby L1', 'Server room L3 (east wing)', '2 lifts, 2 stair cores'],
    },
  ),
  info(
    { id: 'B2', name: 'Building 2', use: 'Public Services', x: 178, y: 26, w: 82, d: 62, h: 34, zone: 'Zone A' },
    {
      occupancy: 900,
      yearBuilt: 2015,
      basementLevels: 1,
      structure: 'Reinforced concrete, glass façade',
      assets: ['Fire alarm panel, security desk L1', 'Backup generator, basement', 'Public counters L1–L2', '3 lifts, 2 stair cores'],
    },
  ),
  info(
    { id: 'B3', name: 'Building 3', use: 'Civic Hall', x: 284, y: 40, w: 62, d: 72, h: 26, zone: 'Zone B' },
    {
      levels: 3,
      levelHeightM: 8,
      occupancy: 1200,
      yearBuilt: 1998,
      structure: 'Steel long-span roof on concrete frame',
      assets: ['Auditorium 800 seats', 'Fire alarm panel, foyer', 'Sprinklered'],
    },
  ),
  info(
    { id: 'B4', name: 'Building 4', use: 'Operations', x: 300, y: 128, w: 74, d: 58, h: 24, zone: 'Zone B' },
    { occupancy: 260, yearBuilt: 2012, structure: 'Reinforced concrete frame', assets: ['Security control room L2', 'Backup generator, roof', 'Vehicle bay, east side'] },
  ),
  info(
    { id: 'B5', name: 'Building 5', use: 'Logistics', x: 78, y: 140, w: 84, d: 60, h: 18, zone: 'Zone A' },
    {
      levels: 2,
      levelHeightM: 7.5,
      occupancy: 80,
      yearBuilt: 2004,
      structure: 'Steel portal frame, metal cladding',
      assets: ['Loading dock, south side', 'Fuel store (diesel 2000 L), west', 'Forklift charging area'],
    },
  ),
];

/** Nearest entrance of a building to a point (for pointing cameras and routing responders). */
export function nearestEntrance(b: Building, p: { x: number; y: number }) {
  return b.bim.entrances.reduce((best, e) => (Math.hypot(e.x - p.x, e.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? e : best), b.bim.entrances[0]);
}

/** True if a point lies inside the building footprint plus a margin (metres). */
export function atBuilding(b: Building, p: { x: number; y: number }, marginM = 12) {
  return p.x >= b.x - marginM && p.x <= b.x + b.w + marginM && p.y >= b.y - marginM && p.y <= b.y + b.d + marginM;
}

export interface Zone {
  id: string;
  name: string;
  poly: [number, number][];
  label: [number, number];
}

export const ZONES: Zone[] = [
  {
    id: 'A',
    name: 'Zone A',
    poly: [
      [20, 16],
      [244, 16],
      [244, 232],
      [20, 232],
    ],
    label: [96, 30],
  },
  {
    id: 'B',
    name: 'Zone B',
    poly: [
      [244, 16],
      [400, 16],
      [400, 232],
      [244, 232],
    ],
    label: [376, 30],
  },
];

export const PARKING = { x: 178, y: 196, w: 104, d: 30 };
export const PLAZA = { cx: 214, cy: 126, r: 26 };
export const FENCE_Y = 232;
export const GATE = { x: 322, w: 26 };
export const ROAD = { y: 246, h: 26 };

/** Default inspection route for UGV-01 to the service gate (draft until approved). */
export const DEFAULT_ROUTE = [
  { x: 262, y: 218 },
  { x: 312, y: 222 },
  { x: 334, y: 228 },
];

/** Route presets offered in the mission planner. */
export const ROUTES: { id: string; label: string; pts: { x: number; y: number }[] }[] = [
  { id: 'direct', label: 'Direct to service gate · 3 checkpoints', pts: DEFAULT_ROUTE },
  {
    id: 'sweep',
    label: 'Perimeter sweep via Building 4 · 5 checkpoints',
    pts: [
      { x: 262, y: 218 },
      { x: 290, y: 204 },
      { x: 384, y: 204 },
      { x: 384, y: 224 },
      { x: 334, y: 228 },
    ],
  },
];

/** True if a point is inside the site's operating boundary (inside the fence, or at the gate). */
export function insideDemoArea(p: { x: number; y: number }) {
  return p.x > 20 && p.x < 400 && p.y > 16 && p.y < 240;
}

/** Serializable site description sent to clients. */
export const SITE_GEOMETRY = { ...SITE, buildings: BUILDINGS, zones: ZONES, parking: PARKING, plaza: PLAZA, fenceY: FENCE_Y, gate: GATE, road: ROAD };
export type SiteGeometry = typeof SITE_GEOMETRY;
