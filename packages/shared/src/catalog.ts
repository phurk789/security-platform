// Vehicle and payload catalogue: rated specs from the manufacturer's brochure, used to show unit
// details, estimate remaining runtime and pick the 3D model. Ratings are the maker's claims; the
// platform shows them as "rated", never as measured.
//
// Scope: this platform runs patrol, reconnaissance and transport work. Weapon stations offered on
// some chassis (D50 / D100 strike configurations) are not integrated, and explosive vehicles are
// not supported at all. Units are registered in their unarmed configuration.

export type VehicleRole = 'patrol' | 'recon' | 'transport';

export interface VehicleModel {
  id: string;
  name: string;
  role: VehicleRole;
  kind: 'ugv';
  drive: 'tracked' | 'wheeled';
  /** Length × width × height in mm. */
  dimsMm: [number, number, number];
  massKg: number;
  payloadKg: number;
  maxSpeedKmh: number;
  climbDeg: number;
  obstacleMm: number;
  trenchMm: number;
  enduranceMin: number;
  /** Remote control range with clear line of sight and no interference. */
  controlRangeM: number;
  link: string;
  camera: string;
  capabilities: string[];
  notes: string;
}

export const VEHICLE_CATALOG: Record<string, VehicleModel> = {
  D50: {
    id: 'D50',
    name: 'D50 tracked UGV',
    role: 'recon',
    kind: 'ugv',
    drive: 'tracked',
    dimsMm: [750, 700, 350],
    massKg: 55,
    payloadKg: 50,
    maxSpeedKmh: 5,
    climbDeg: 35,
    obstacleMm: 100,
    trenchMm: 250,
    enduranceMin: 150,
    controlRangeM: 1000,
    link: 'Video + data remote controller; fibre or dual wireless link',
    camera: 'HD first-person camera',
    capabilities: ['camera', 'ground_patrol', 'waypoints'],
    notes: 'Skid-steer tracks, turns on the spot. Registered in reconnaissance configuration (no weapon station).',
  },
  D100: {
    id: 'D100',
    name: 'D100 tracked UGV',
    role: 'patrol',
    kind: 'ugv',
    drive: 'tracked',
    dimsMm: [1000, 800, 400],
    massKg: 130,
    payloadKg: 100,
    maxSpeedKmh: 5,
    climbDeg: 35,
    obstacleMm: 140,
    trenchMm: 400,
    enduranceMin: 120,
    controlRangeM: 1000,
    link: 'Video + data remote controller; fibre or dual wireless link',
    camera: 'HD first-person camera',
    capabilities: ['camera', 'ground_patrol', 'waypoints'],
    notes: 'Independent suspension, 155 mm rubber tracks. Registered as a patrol carrier (no weapon station).',
  },
  D200: {
    id: 'D200',
    name: 'D200 heavy transport UGV',
    role: 'transport',
    kind: 'ugv',
    drive: 'tracked',
    dimsMm: [1360, 960, 520],
    massKg: 150,
    payloadKg: 200,
    maxSpeedKmh: 9,
    climbDeg: 30,
    obstacleMm: 200,
    trenchMm: 400,
    enduranceMin: 150,
    controlRangeM: 2000,
    link: 'Remote control or autonomous driving; GNSS (GPS/GLONASS/BDS/Galileo, ±1 m)',
    camera: '4K camera + 1080p forward first-person camera',
    capabilities: ['camera', 'ground_patrol', 'waypoints', 'cargo'],
    notes: 'Electric servo drive, planetary reduction. Carries equipment and supplies to the scene.',
  },
};

export interface PayloadModel {
  id: string;
  name: string;
  capabilities: string[];
  notes: string;
}

export const PAYLOAD_CATALOG: Record<string, PayloadModel> = {
  'loudhailer-4in1': {
    id: 'loudhailer-4in1',
    name: '4-in-1 module: two-way loudspeaker, searchlight, warning light, HD camera',
    capabilities: ['speaker', 'spotlight', 'beacon', 'camera'],
    notes: 'Preset announcements from the console; live two-way talk uses the module’s own audio link.',
  },
};

/** Capabilities of a catalogue vehicle fitted with payload modules. */
export function catalogCapabilities(modelId: string, payloads: string[] = []) {
  const caps = new Set(VEHICLE_CATALOG[modelId]?.capabilities ?? []);
  for (const p of payloads) for (const c of PAYLOAD_CATALOG[p]?.capabilities ?? []) caps.add(c);
  return [...caps];
}

/** Rated runtime left at this battery level, minutes (linear estimate). */
export function runtimeLeftMin(modelId: string | undefined, batteryPct: number | undefined) {
  const m = modelId ? VEHICLE_CATALOG[modelId] : undefined;
  if (!m || batteryPct === undefined) return null;
  return Math.round((m.enduranceMin * Math.max(0, Math.min(100, batteryPct))) / 100);
}
