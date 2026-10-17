// Procedural 3D models. Units are metres. Vehicles face −Z ("north") by default.
import * as THREE from 'three';
import { glowTexture, stripeTexture } from './textures';

const mat = (color: number | string, o: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.2, ...o });
const glow = (color: number | string) => new THREE.MeshBasicMaterial({ color, toneMapped: false });

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(rt: number, rb: number, h: number, m: THREE.Material, seg = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.castShadow = true;
  return mesh;
}

let _glowTex: THREE.Texture | null = null;
export function sprite(color: number, size: number, opacity = 1) {
  _glowTex ??= glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: _glowTex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  );
  s.scale.set(size, size, 1);
  return s;
}

// ---------------------------------------------------------------------------
// UGV — 6-wheel patrol rover
// ---------------------------------------------------------------------------

export interface UgvModel {
  root: THREE.Group;
  wheels: THREE.Mesh[];
  beacon: THREE.Mesh;
  beaconGlow: THREE.Sprite;
  headlight: THREE.SpotLight;
  camHead: THREE.Object3D;
  /** 4-in-1 module (if fitted): searchlight with its beam, and the red/blue warning light. */
  spot?: THREE.SpotLight;
  spotBeam?: THREE.Mesh;
  strobe?: { red: THREE.Sprite; blue: THREE.Sprite; light: THREE.PointLight };
}

/** UGV for a catalogue model (tracked D50 / D100 / D200), or the generic 6-wheel rover. */
export function makeUgv(opts: { model?: string; payload?: boolean } = {}): UgvModel {
  if (opts.model && TRACKED[opts.model]) return makeTracked(TRACKED[opts.model], !!opts.payload);
  return makeWheeled();
}

const TRACKED: Record<string, { scale: number; color: string; deck: string; cargo?: boolean }> = {
  D50: { scale: 0.85, color: '#58634f', deck: '#3d4538' },
  D100: { scale: 1, color: '#c8a465', deck: '#8f7444' },
  D200: { scale: 1.2, color: '#44513f', deck: '#2f382c', cargo: true },
};

function makeTracked(v: { scale: number; color: string; deck: string; cargo?: boolean }, payload: boolean): UgvModel {
  const root = new THREE.Group();
  const g = new THREE.Group();
  g.scale.setScalar(v.scale);
  root.add(g);
  const body = mat(v.color, { metalness: 0.35, roughness: 0.55 });
  const deck = mat(v.deck, { roughness: 0.8 });
  const rubber = mat('#15181c', { roughness: 0.95 });
  const steel = mat('#6b7480', { metalness: 0.7, roughness: 0.35 });
  // hull: low wedge-nosed box between the tracks
  g.add(box(0.74, 0.3, 1.3, body, 0, 0.42, 0));
  g.add(box(0.7, 0.05, 1.22, deck, 0, 0.6, 0.02));
  const nose = box(0.74, 0.18, 0.3, body, 0, 0.36, -0.72);
  nose.rotation.x = 0.5;
  g.add(nose);
  // tracks with road wheels and sprockets
  const wheels: THREE.Mesh[] = [];
  for (const x of [-0.47, 0.47]) {
    g.add(box(0.2, 0.3, 1.36, rubber, x, 0.2, 0));
    for (const z of [-0.68, 0.68]) {
      const end = cyl(0.15, 0.15, 0.2, rubber, 16);
      end.rotation.z = Math.PI / 2;
      end.position.set(x, 0.2, z);
      g.add(end);
    }
    for (const z of [-0.68, -0.34, 0, 0.34, 0.68]) {
      const w = cyl(0.1, 0.1, 0.21, steel, 10);
      w.rotation.z = Math.PI / 2;
      w.position.set(x + Math.sign(x) * 0.01, 0.2, z);
      g.add(w);
      wheels.push(w);
    }
  }
  if (v.cargo) {
    // D200: cargo bed with a tubular rail
    const rail = mat('#2a2f36', { metalness: 0.6, roughness: 0.4 });
    for (const x of [-0.36, 0.36]) g.add(box(0.03, 0.03, 1.1, rail, x, 0.84, 0.05));
    for (const z of [-0.5, 0.6]) g.add(box(0.75, 0.03, 0.03, rail, 0, 0.84, z));
    for (const [x, z] of [
      [-0.36, -0.5],
      [0.36, -0.5],
      [-0.36, 0.6],
      [0.36, 0.6],
    ])
      g.add(box(0.03, 0.22, 0.03, rail, x, 0.73, z));
    g.add(box(0.36, 0.2, 0.3, mat('#6d5a3a'), -0.12, 0.72, 0.25)); // crate
  }
  // sensor mast and SIYI gimbal camera
  const mast = cyl(0.03, 0.03, 0.5, steel);
  mast.position.set(0, 0.86, -0.3);
  g.add(mast);
  const camHead = new THREE.Group();
  camHead.position.set(0, 1.14, -0.34);
  camHead.add(box(0.2, 0.16, 0.18, mat('#1f242b', { metalness: 0.5 })));
  const lens = cyl(0.045, 0.045, 0.04, glow('#38bdf8'), 12);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0, -0.1);
  camHead.add(lens);
  g.add(camHead);
  // antenna
  const ant = cyl(0.01, 0.01, 0.5, rubber, 6);
  ant.position.set(-0.28, 0.88, 0.5);
  g.add(ant);
  // lights
  g.add(box(0.12, 0.05, 0.02, glow('#f4f7ff'), 0.26, 0.48, -0.66));
  g.add(box(0.12, 0.05, 0.02, glow('#f4f7ff'), -0.26, 0.48, -0.66));
  g.add(box(0.1, 0.04, 0.02, glow('#ff3b3b'), 0.28, 0.48, 0.66));
  g.add(box(0.1, 0.04, 0.02, glow('#ff3b3b'), -0.28, 0.48, 0.66));
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), glow('#fbbf24'));
  beacon.position.set(0.28, 0.66, 0.5);
  g.add(beacon);
  const beaconGlow = sprite(0xfbbf24, 0.8, 0.9);
  beaconGlow.position.copy(beacon.position);
  g.add(beaconGlow);
  const headlight = new THREE.SpotLight(0xe8f0ff, 30, 22, 0.55, 0.6, 1.5);
  headlight.position.set(0, 0.48, -0.66);
  headlight.target.position.set(0, 0, -8);
  g.add(headlight, headlight.target);
  const m: UgvModel = { root, wheels, beacon, beaconGlow, headlight, camHead };
  if (payload) Object.assign(m, fourInOne(g));
  return m;
}

/** 4-in-1 module on the front deck: loudspeaker horn, searchlight, red/blue warning light, camera. */
function fourInOne(g: THREE.Group) {
  const housing = mat('#2b3038', { metalness: 0.5, roughness: 0.45 });
  const mod = new THREE.Group();
  mod.position.set(0.14, 0.74, -0.42);
  mod.add(box(0.26, 0.18, 0.3, housing));
  const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.09, 0.14, 16, 1, true), mat('#15181c', { side: THREE.DoubleSide }));
  horn.rotation.x = Math.PI / 2;
  horn.position.set(-0.05, 0, -0.2);
  mod.add(horn);
  mod.add(box(0.08, 0.05, 0.02, glow('#fff6d8'), 0.07, 0.03, -0.16)); // searchlight lens
  const red = sprite(0xff2a2a, 0.5, 0);
  const blue = sprite(0x2a6bff, 0.5, 0);
  mod.add(box(0.07, 0.04, 0.07, glow('#7a1010'), -0.05, 0.11, 0));
  mod.add(box(0.07, 0.04, 0.07, glow('#10287a'), 0.05, 0.11, 0));
  red.position.set(-0.05, 0.13, 0);
  blue.position.set(0.05, 0.13, 0);
  mod.add(red, blue);
  g.add(mod);
  const spot = new THREE.SpotLight(0xfff1d0, 0, 70, 0.3, 0.45, 1.1);
  spot.position.set(0.21, 0.77, -0.6);
  spot.target.position.set(0.21, -0.6, -12);
  g.add(spot, spot.target);
  // visible beam (additive cone), drawn only when the searchlight is on
  const beamGeo = new THREE.ConeGeometry(1, 1, 24, 1, true);
  beamGeo.translate(0, -0.5, 0);
  beamGeo.rotateX(Math.PI / 2 + 0.05);
  const spotBeam = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      color: 0xfff1c8,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  spotBeam.scale.set(0.9, 0.9, 6);
  spotBeam.position.copy(spot.position);
  spotBeam.visible = false;
  g.add(spotBeam);
  const light = new THREE.PointLight(0xff2a2a, 0, 14, 1.5);
  light.position.set(0.14, 0.95, -0.42);
  g.add(light);
  return { spot, spotBeam, strobe: { red, blue, light } };
}

function makeWheeled(): UgvModel {
  const root = new THREE.Group();
  const body = mat('#39424f', { metalness: 0.55, roughness: 0.45 });
  const dark = mat('#1d232b', { roughness: 0.9 });
  root.add(box(0.92, 0.34, 1.42, body, 0, 0.46, 0));
  root.add(box(0.8, 0.08, 1.2, mat('#262c35'), 0, 0.67, 0.02));
  // side skirts
  root.add(box(0.06, 0.18, 1.3, dark, 0.47, 0.36, 0));
  root.add(box(0.06, 0.18, 1.3, dark, -0.47, 0.36, 0));
  const wheels: THREE.Mesh[] = [];
  const tyre = mat('#111418', { roughness: 0.95 });
  const hub = mat('#5a6472', { metalness: 0.6 });
  for (const z of [-0.5, 0, 0.5]) {
    for (const x of [-0.55, 0.55]) {
      const w = new THREE.Group();
      const t = cyl(0.23, 0.23, 0.17, tyre, 16);
      t.rotation.z = Math.PI / 2;
      const h = cyl(0.11, 0.11, 0.18, hub, 8);
      h.rotation.z = Math.PI / 2;
      w.add(t, h);
      w.position.set(x, 0.23, z);
      root.add(w);
      wheels.push(w as unknown as THREE.Mesh);
    }
  }
  // sensor mast and camera head
  const mast = cyl(0.03, 0.03, 0.62, body);
  mast.position.set(0, 0.98, -0.36);
  root.add(mast);
  const camHead = new THREE.Group();
  camHead.position.set(0, 1.32, -0.42);
  camHead.add(box(0.22, 0.13, 0.16, mat('#2a3039', { metalness: 0.5 })));
  const lens = cyl(0.04, 0.04, 0.04, glow('#38bdf8'), 12);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0, -0.09);
  camHead.add(lens);
  root.add(camHead);
  // lidar puck
  const lidar = cyl(0.08, 0.08, 0.07, mat('#20252c'), 16);
  lidar.position.set(0, 0.75, 0.3);
  root.add(lidar);
  // light bar and headlights
  root.add(box(0.7, 0.04, 0.02, glow('#38bdf8'), 0, 0.56, -0.72));
  root.add(box(0.12, 0.06, 0.02, glow('#f4f7ff'), 0.32, 0.47, -0.72));
  root.add(box(0.12, 0.06, 0.02, glow('#f4f7ff'), -0.32, 0.47, -0.72));
  root.add(box(0.1, 0.05, 0.02, glow('#ff3b3b'), 0.36, 0.47, 0.72));
  root.add(box(0.1, 0.05, 0.02, glow('#ff3b3b'), -0.36, 0.47, 0.72));
  // status beacon
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), glow('#fbbf24'));
  beacon.position.set(0.3, 0.78, 0.45);
  root.add(beacon);
  const beaconGlow = sprite(0xfbbf24, 0.9, 0.9);
  beaconGlow.position.copy(beacon.position);
  root.add(beaconGlow);
  const headlight = new THREE.SpotLight(0xe8f0ff, 30, 22, 0.55, 0.6, 1.5);
  headlight.position.set(0, 0.5, -0.7);
  headlight.target.position.set(0, 0, -8);
  root.add(headlight, headlight.target);
  return { root, wheels, beacon, beaconGlow, headlight, camHead };
}

// ---------------------------------------------------------------------------
// UAV — quadcopter
// ---------------------------------------------------------------------------

export interface UavModel {
  root: THREE.Group;
  rotors: THREE.Mesh[];
  navRed: THREE.Sprite;
  navGreen: THREE.Sprite;
  strobe: THREE.Sprite;
}

export function makeUav(): UavModel {
  const root = new THREE.Group();
  const shell = mat('#2f3640', { metalness: 0.4, roughness: 0.5 });
  root.add(box(0.36, 0.13, 0.42, shell));
  root.add(box(0.26, 0.06, 0.3, mat('#4b5563'), 0, 0.09, 0));
  const rotors: THREE.Mesh[] = [];
  const blade = new THREE.MeshBasicMaterial({ color: '#9aa7b8', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  for (const [x, z] of [
    [0.38, 0.38],
    [-0.38, 0.38],
    [0.38, -0.38],
    [-0.38, -0.38],
  ]) {
    const arm = box(0.04, 0.03, 0.6, shell, x / 2, 0, z / 2);
    arm.rotation.y = Math.atan2(x, z);
    root.add(arm);
    const motor = cyl(0.04, 0.05, 0.07, mat('#15191f'));
    motor.position.set(x, 0.05, z);
    root.add(motor);
    const r = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), blade);
    r.rotation.x = -Math.PI / 2;
    r.position.set(x, 0.09, z);
    root.add(r);
    rotors.push(r);
    // two visible blades over the disc
    const b = box(0.4, 0.005, 0.035, mat('#1c2128'), x, 0.095, z);
    b.castShadow = false;
    rotors.push(b);
  }
  const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), mat('#111418', { metalness: 0.6 }));
  gimbal.position.set(0, -0.1, -0.12);
  root.add(gimbal);
  const navRed = sprite(0xff3b3b, 0.5);
  navRed.position.set(-0.4, 0.02, -0.4);
  const navGreen = sprite(0x3bff7a, 0.5);
  navGreen.position.set(0.4, 0.02, -0.4);
  const strobe = sprite(0xffffff, 0.9);
  strobe.position.set(0, 0.15, 0.2);
  root.add(navRed, navGreen, strobe);
  return { root, rotors, navRed, navGreen, strobe };
}

// ---------------------------------------------------------------------------
// CCTV pole camera
// ---------------------------------------------------------------------------

export interface CctvModel {
  root: THREE.Group;
  head: THREE.Group;
  ir: THREE.Sprite;
  cone: THREE.Mesh;
}

export function makeCctv(height: number): CctvModel {
  const root = new THREE.Group();
  const metal = mat('#5b6573', { metalness: 0.6, roughness: 0.4 });
  const pole = cyl(0.07, 0.11, height, metal);
  pole.position.y = height / 2;
  root.add(pole);
  const head = new THREE.Group();
  head.position.y = height;
  const housing = box(0.24, 0.22, 0.6, mat('#e7ebf0', { roughness: 0.4 }), 0, 0, -0.2);
  const shield = box(0.32, 0.03, 0.72, mat('#d4d9e0'), 0, 0.14, -0.22);
  const lens = cyl(0.07, 0.07, 0.05, mat('#0b0f14', { metalness: 0.9, roughness: 0.1 }), 16);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0, -0.52);
  head.add(housing, shield, lens);
  const ir = sprite(0xff2a2a, 0.5, 0.55);
  ir.position.set(0, 0, -0.56);
  head.add(ir);
  root.add(head);
  // view cone (shown when selected)
  const coneGeo = new THREE.ConeGeometry(1, 1, 24, 1, true);
  coneGeo.translate(0, -0.5, 0);
  coneGeo.rotateX(-Math.PI / 2);
  const cone = new THREE.Mesh(
    coneGeo,
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }),
  );
  cone.visible = false;
  head.add(cone);
  return { root, head, ir, cone };
}

// ---------------------------------------------------------------------------
// Street furniture
// ---------------------------------------------------------------------------

export function makeLamp() {
  const g = new THREE.Group();
  const metal = mat('#3a4250', { metalness: 0.5 });
  const pole = cyl(0.08, 0.12, 7.5, metal, 8);
  pole.position.y = 3.75;
  const arm = box(0.08, 0.08, 1.4, metal, 0, 7.4, -0.6);
  const head = box(0.5, 0.14, 0.8, mat('#2b313b'), 0, 7.32, -1.2);
  const bulb = box(0.4, 0.04, 0.6, glow('#ffd9a0'), 0, 7.24, -1.2);
  const halo = sprite(0xffd28a, 5, 0.55);
  halo.position.set(0, 7.1, -1.2);
  g.add(pole, arm, head, bulb, halo);
  return g;
}

/** Fake light pool on the ground under a lamp (cheap, no real light). */
export function lampPool(radius = 9) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 32),
    new THREE.MeshBasicMaterial({
      map: glowTexture('rgba(255,214,150,0.55)', 'rgba(255,214,150,0)'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.06;
  return m;
}

const CAR_COLORS = ['#c9ced6', '#22262d', '#7b1f24', '#2c4a74', '#8a8f98', '#e8e8e2'];

export function makeCar(colorIndex: number, lightsOn = false) {
  const g = new THREE.Group();
  const paint = mat(CAR_COLORS[colorIndex % CAR_COLORS.length], { metalness: 0.7, roughness: 0.35 });
  const glass = mat('#0d1218', { metalness: 0.9, roughness: 0.15 });
  g.add(box(1.8, 0.62, 4.3, paint, 0, 0.55, 0));
  g.add(box(1.6, 0.52, 2.1, glass, 0, 1.1, 0.25));
  const tyre = mat('#0f1114');
  for (const [x, z] of [
    [0.85, 1.35],
    [-0.85, 1.35],
    [0.85, -1.35],
    [-0.85, -1.35],
  ]) {
    const w = cyl(0.32, 0.32, 0.22, tyre, 12);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.32, z);
    g.add(w);
  }
  if (lightsOn) {
    g.add(box(0.36, 0.12, 0.02, glow('#f6f8ff'), 0.6, 0.62, -2.16));
    g.add(box(0.36, 0.12, 0.02, glow('#f6f8ff'), -0.6, 0.62, -2.16));
    g.add(box(0.36, 0.1, 0.02, glow('#ff2a2a'), 0.6, 0.62, 2.16));
    g.add(box(0.36, 0.1, 0.02, glow('#ff2a2a'), -0.6, 0.62, 2.16));
    const beam = sprite(0xf0f4ff, 7, 0.35);
    beam.position.set(0, 0.6, -4.5);
    g.add(beam);
  }
  return g;
}

export function makeBarrier(length: number) {
  const g = new THREE.Group();
  const post = box(0.5, 1.1, 0.5, mat('#d9dde3'), 0, 0.55, 0);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(length, 0.12, 0.12), new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.5 }));
  (arm.material as THREE.MeshStandardMaterial).map!.repeat.set(length / 2, 1);
  (arm.material as THREE.MeshStandardMaterial).map!.wrapS = THREE.RepeatWrapping;
  arm.position.set(length / 2, 1.0, 0);
  arm.castShadow = true;
  const tip = sprite(0xff3030, 0.8, 0.9);
  tip.position.set(length, 1.0, 0);
  g.add(post, arm, tip);
  return g;
}

export function makeBooth() {
  const g = new THREE.Group();
  g.add(box(2.6, 2.6, 2.6, mat('#3a4b61'), 0, 1.3, 0));
  g.add(box(2.9, 0.15, 2.9, mat('#2a3646'), 0, 2.68, 0));
  g.add(box(1.8, 0.9, 0.02, glow('#f4d48c'), 0, 1.6, 1.31));
  const lightBox = sprite(0xffd48a, 4, 0.4);
  lightBox.position.set(0, 1.6, 2.2);
  g.add(lightBox);
  return g;
}

export { CAR_COLORS };

// ---------------------------------------------------------------------------
// People: low-poly walkers for the plaza and the subject of an alert
// ---------------------------------------------------------------------------

export interface PersonModel {
  root: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
}

const SHIRTS = ['#c9d2dc', '#3b5bdb', '#d9480f', '#2f9e44', '#f08c00', '#862e9c', '#1c7ed6', '#e8e8e2'];
const TROUSERS = ['#2b2f36', '#3e4a5c', '#5c4b3a', '#1f2a40'];

/** A 1.75 m figure: head, torso, swinging arms and legs. Drawn 1.5× for visibility from the HUD distance. */
export function makePerson(seed: number, hiVis = false): PersonModel {
  const root = new THREE.Group();
  const g = new THREE.Group();
  g.scale.setScalar(1.5);
  root.add(g);
  const shirt = mat(hiVis ? '#f5b301' : SHIRTS[seed % SHIRTS.length], { roughness: 0.9 });
  const trouser = mat(TROUSERS[seed % TROUSERS.length], { roughness: 0.95 });
  const skin = mat(['#e3b58f', '#c98f66', '#8d5a3b'][seed % 3], { roughness: 0.8 });
  const torso = box(0.38, 0.55, 0.22, shirt, 0, 1.05, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), skin);
  head.position.y = 1.47;
  head.castShadow = true;
  const legL = box(0.14, 0.78, 0.16, trouser, -0.1, 0.39, 0);
  const legR = box(0.14, 0.78, 0.16, trouser, 0.1, 0.39, 0);
  const armL = box(0.09, 0.5, 0.11, shirt, -0.26, 1.05, 0);
  const armR = box(0.09, 0.5, 0.11, shirt, 0.26, 1.05, 0);
  // pivot limbs from the hip / shoulder: shift geometry so rotation swings the lower end
  for (const m of [legL, legR]) (m.geometry.translate(0, -0.39, 0), (m.position.y = 0.78));
  for (const m of [armL, armR]) (m.geometry.translate(0, -0.25, 0), (m.position.y = 1.3));
  if (hiVis) {
    const stripe = box(0.4, 0.06, 0.24, glow('#f8fafc'), 0, 1.0, 0);
    g.add(stripe);
  }
  g.add(torso, head, legL, legR, armL, armR);
  return { root, legL, legR, armL, armR };
}
