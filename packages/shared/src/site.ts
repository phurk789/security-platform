/** 17 Oct 2026 05:27:00 Asia/Bangkok — the scenario start time from the concept mockup. */
export const SCENARIO_START = Date.UTC(2026, 9, 16, 22, 27, 0);

// ---------------------------------------------------------------------------
// Site geometry (metres, local site grid; origin = north-west corner, +y = south)
// ---------------------------------------------------------------------------

export const SITE = {
  name: 'Civic Center',
  org: '13STORE Demo Org',
  width: 420,
  height: 290,
  crs: 'Local site grid (m) → WGS 84 via 2-point transform (placeholder)',
};

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
}

export const BUILDINGS: Building[] = [
  { id: 'B1', name: 'Building 1', use: 'Administration', x: 50, y: 52, w: 92, d: 56, h: 22, zone: 'Zone A' },
  { id: 'B2', name: 'Building 2', use: 'Public Services', x: 178, y: 26, w: 82, d: 62, h: 34, zone: 'Zone A' },
  { id: 'B3', name: 'Building 3', use: 'Civic Hall', x: 284, y: 40, w: 62, d: 72, h: 26, zone: 'Zone B' },
  { id: 'B4', name: 'Building 4', use: 'Operations', x: 300, y: 128, w: 74, d: 58, h: 24, zone: 'Zone B' },
  { id: 'B5', name: 'Building 5', use: 'Logistics', x: 78, y: 140, w: 84, d: 60, h: 18, zone: 'Zone A' },
];

export interface Zone {
  id: string;
  name: string;
  poly: [number, number][];
  label: [number, number];
}

export const ZONES: Zone[] = [
  { id: 'A', name: 'Zone A', poly: [[20, 16], [244, 16], [244, 232], [20, 232]], label: [96, 30] },
  { id: 'B', name: 'Zone B', poly: [[244, 16], [400, 16], [400, 232], [244, 232]], label: [376, 30] },
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
