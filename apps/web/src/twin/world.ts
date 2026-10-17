// The 3D digital twin. One scene, shared by the map view and the camera feeds, so what a
// camera "sees" is the same model the map shows. Kept in sync with AppState every frame.
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { BUILDINGS, FENCE_Y, GATE, ROAD, SITE, ZONES, freshnessAt, type AppState, type Device, type Incident, type Mission, type Point } from '@13store/shared';
import { CAMERA_VIEWS, LAMPS, LIT_LAMPS, PARKED, TREES, toWorld } from './layout';
import { beamTexture, facadeTextures, groundTexture, roofTexture } from './textures';
import { lampPool, makeBarrier, makeBooth, makeCar, makeCctv, makeLamp, makeUav, makeUgv, type CctvModel, type UavModel, type UgvModel } from './models';

/** Devices are drawn larger than life so they stay visible at site scale (map symbol scale). */
export const SYMBOL_SCALE = { ugv: 4.5, uav: 3.6 };

type Vis =
  | { kind: 'ugv'; m: UgvModel; pos: THREE.Vector3; heading: number; label: CSS2DObject; ring: THREE.Mesh; halo: THREE.Mesh }
  | { kind: 'uav'; m: UavModel; pos: THREE.Vector3; heading: number; label: CSS2DObject; ring: THREE.Mesh; halo: THREE.Mesh; tether: THREE.Line; shadow: THREE.Mesh }
  | { kind: 'cctv'; m: CctvModel; pos: THREE.Vector3; heading: number; label: CSS2DObject; ring: THREE.Mesh; halo: THREE.Mesh };

interface IncVis {
  root: THREE.Group;
  ring: THREE.Mesh;
  fill: THREE.Mesh;
  beam: THREE.Mesh;
  label: CSS2DObject;
}

export interface WorldCallbacks {
  selectDevice(id: string): void;
  selectIncident(id: string): void;
}

const AMBER = new THREE.Color('#fbbf24');
const CYAN = new THREE.Color('#38bdf8');
const RED = new THREE.Color('#f87171');
const GREY = new THREE.Color('#8596ab');

function el(cls: string, html: string, onClick?: () => void) {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  if (onClick) {
    d.addEventListener('pointerdown', (e) => e.stopPropagation());
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
  }
  return d;
}

/** Map-only graphics (rings, routes, beams, zone lines) live on layer 1 so camera feeds don't see them. */
export const OVERLAY = 1;
function overlay<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => c.layers.set(OVERLAY));
  return o;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class TwinWorld {
  readonly scene = new THREE.Scene();
  state: AppState | null = null;
  callbacks: WorldCallbacks = { selectDevice() {}, selectIncident() {} };
  private devices = new Map<string, Vis>();
  private incidents = new Map<string, IncVis>();
  private routeGroup = new THREE.Group();
  private routeKey = '';
  private zoneLines: { name: string; line: THREE.LineLoop; fill: THREE.Mesh }[] = [];
  private labelsGroup = new THREE.Group();
  private cars: { g: THREE.Group; dir: 1 | -1; speed: number; lane: number }[] = [];
  private feedCams = new Map<string, THREE.PerspectiveCamera>();
  private t = 0;
  private beamTex = beamTexture();
  labelsVisible = true;
  /** Holographic extras for the Twin HUD theme: building outlines, grid, perimeter, sweep. */
  readonly hud = new THREE.Group();
  private hudPulse?: THREE.Mesh;
  buildingLabels: CSS2DObject[] = [];

  constructor() {
    this.build();
  }

  // ---------------------------------------------------------------------------
  // static site
  // ---------------------------------------------------------------------------

  private build() {
    const s = this.scene;
    s.background = new THREE.Color('#070d18');
    // Pre-dawn sky (scenario time 05:27): deep navy overhead, a faint glow low in the east.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1800, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {},
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `varying vec3 vDir;
          void main(){
            float h = clamp(vDir.y, -0.1, 1.0);
            vec3 top = vec3(0.020, 0.035, 0.075);
            vec3 mid = vec3(0.055, 0.085, 0.150);
            vec3 col = mix(mid, top, smoothstep(0.0, 0.55, h));
            float east = max(0.0, dot(normalize(vec3(vDir.x, 0.0, vDir.z)), vec3(1.0, 0.0, -0.25)));
            float glow = pow(east, 6.0) * exp(-max(h, 0.0) * 9.0);
            col += vec3(0.42, 0.22, 0.10) * glow * 0.55;
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    sky.renderOrder = -1;
    s.add(sky);
    s.fog = new THREE.FogExp2('#0c1527', 0.0014);

    s.add(new THREE.HemisphereLight('#5b75a3', '#1a2230', 1.9));
    const moon = new THREE.DirectionalLight('#b8c9e8', 2.1);
    moon.position.set(-160, 260, -140);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    const sc = moon.shadow.camera;
    sc.left = -260;
    sc.right = 260;
    sc.top = 200;
    sc.bottom = -200;
    sc.near = 50;
    sc.far = 700;
    moon.shadow.bias = -0.0006;
    moon.shadow.normalBias = 0.6;
    s.add(moon);

    // ground: outer land + painted site plan
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ color: '#0d1612', roughness: 1 }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.05;
    outer.receiveShadow = true;
    s.add(outer);
    // road continues beyond the site
    const roadOut = new THREE.Mesh(new THREE.PlaneGeometry(2400, ROAD.h), new THREE.MeshStandardMaterial({ color: '#161c23', roughness: 0.95 }));
    roadOut.rotation.x = -Math.PI / 2;
    roadOut.position.set(0, -0.02, toWorld(0, ROAD.y + ROAD.h / 2).z);
    s.add(roadOut);
    const site = new THREE.Mesh(new THREE.PlaneGeometry(SITE.width, SITE.height), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.92 }));
    site.rotation.x = -Math.PI / 2;
    site.receiveShadow = true;
    s.add(site);

    // HUD grid around the site and a glowing perimeter
    const grid = new THREE.GridHelper(1400, 70, 0x1d6f8f, 0x0f3348);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.y = 0.02;
    this.hud.add(grid);
    const half = { w: SITE.width / 2, h: SITE.height / 2 };
    const perim = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-half.w, 0.3, -half.h), new THREE.Vector3(half.w, 0.3, -half.h), new THREE.Vector3(half.w, 0.3, half.h), new THREE.Vector3(-half.w, 0.3, half.h)]),
      new THREE.LineBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.8, toneMapped: false }),
    );
    this.hud.add(perim);
    const pulse = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96), new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 0.4;
    this.hudPulse = pulse;
    this.hud.add(pulse);
    s.add(overlay(this.hud));
    this.hud.visible = false;

    // buildings
    const roof = roofTexture();
    BUILDINGS.forEach((b, i) => {
      const { map, emissive } = facadeTextures(17 + i * 5);
      const sideX = map.clone();
      const sideXE = emissive.clone();
      map.repeat.set(b.w / 14, b.h / 16);
      emissive.repeat.copy(map.repeat);
      sideX.repeat.set(b.d / 14, b.h / 16);
      sideXE.repeat.copy(sideX.repeat);
      [map, emissive, sideX, sideXE].forEach((t) => (t.needsUpdate = true));
      const front = new THREE.MeshStandardMaterial({ map, emissiveMap: emissive, emissive: '#ffffff', emissiveIntensity: 0.55, roughness: 0.75, metalness: 0.15 });
      const side = new THREE.MeshStandardMaterial({ map: sideX, emissiveMap: sideXE, emissive: '#ffffff', emissiveIntensity: 0.55, roughness: 0.75, metalness: 0.15 });
      const r = roof.clone();
      r.repeat.set(b.w / 12, b.d / 12);
      r.needsUpdate = true;
      const top = new THREE.MeshStandardMaterial({ map: r, roughness: 0.9 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), [side, side, top, top, front, front]);
      const p = toWorld(b.x + b.w / 2, b.y + b.d / 2);
      mesh.position.set(p.x, b.h / 2, p.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      s.add(mesh);
      // HUD outline: glowing edges and a roof frame
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(b.w + 0.3, b.h + 0.3, b.d + 0.3)), new THREE.LineBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.7, toneMapped: false }));
      edges.position.copy(mesh.position);
      this.hud.add(overlay(edges));
      // parapet + rooftop plant
      const parapet = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.6, 1.1, b.d + 0.6), new THREE.MeshStandardMaterial({ color: '#4c5666', roughness: 0.8 }));
      parapet.position.set(p.x, b.h + 0.2, p.z);
      parapet.scale.set(1, 1, 1);
      const inner = new THREE.Mesh(new THREE.BoxGeometry(b.w - 0.6, 1.2, b.d - 0.6), new THREE.MeshStandardMaterial({ color: '#5c6676', roughness: 0.9 }));
      inner.position.set(p.x, b.h + 0.25, p.z);
      s.add(parapet, inner);
      for (let k = 0; k < 3; k++) {
        const u = new THREE.Mesh(new THREE.BoxGeometry(4 + k, 2.2, 3 + (k % 2) * 2), new THREE.MeshStandardMaterial({ color: '#6b7585', roughness: 0.6, metalness: 0.4 }));
        u.position.set(p.x - b.w / 4 + k * (b.w / 4), b.h + 1.6, p.z - b.d / 5 + (k % 2) * (b.d / 3));
        u.castShadow = true;
        s.add(u);
      }
      // entrance canopy with a light
      const door = toWorld(b.x + b.w / 2, b.y + b.d + 0.4);
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, 3), new THREE.MeshStandardMaterial({ color: '#2b3442' }));
      canopy.position.set(door.x, 4, door.z + 1.2);
      const doorGlow = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 3.2), new THREE.MeshBasicMaterial({ color: '#ffe2a8', toneMapped: false }));
      doorGlow.position.set(door.x, 1.6, door.z + 0.05);
      const pool = lampPool(7);
      pool.position.set(door.x, 0.07, door.z + 4);
      s.add(canopy, doorGlow, pool);
      // label
      const label = new CSS2DObject(el('t3-bld', `<b>${esc(b.name)}</b><span>${esc(b.use)}</span>`));
      label.position.set(p.x, b.h + 6, p.z);
      this.buildingLabels.push(label);
      this.labelsGroup.add(label);
    });

    // trees (instanced)
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3, 6);
    const crownGeo = new THREE.IcosahedronGeometry(2.6, 1);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#3a2c22', roughness: 1 }), TREES.length);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true }), TREES.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    TREES.forEach((tr, i) => {
      const p = toWorld(tr.x, tr.y);
      m4.compose(new THREE.Vector3(p.x, 1.5 * tr.s, p.z), q, new THREE.Vector3(tr.s, tr.s, tr.s));
      trunks.setMatrixAt(i, m4);
      q.setFromEuler(new THREE.Euler(0, i * 1.7, 0));
      m4.compose(new THREE.Vector3(p.x, 4.4 * tr.s, p.z), q, new THREE.Vector3(tr.s, tr.s * 1.15, tr.s));
      crowns.setMatrixAt(i, m4);
      col.setHSL(0.36 + ((i * 37) % 10) / 200, 0.35, 0.16 + ((i * 13) % 10) / 120);
      crowns.setColorAt(i, col);
    });
    trunks.castShadow = crowns.castShadow = true;
    crowns.receiveShadow = true;
    s.add(trunks, crowns);

    // lamps
    LAMPS.forEach((l, i) => {
      const lamp = makeLamp();
      const p = toWorld(l.x, l.y);
      lamp.position.set(p.x, 0, p.z);
      lamp.rotation.y = l.y > FENCE_Y ? Math.PI : 0;
      s.add(lamp);
      const pool = lampPool(10);
      pool.position.set(p.x, 0.06, p.z + (l.y > FENCE_Y ? 1.2 : -1.2));
      s.add(pool);
      if (LIT_LAMPS.includes(i)) {
        const light = new THREE.PointLight('#ffcf8a', 120, 34, 1.6);
        light.position.set(p.x, 7, p.z + (l.y > FENCE_Y ? 1.2 : -1.2));
        s.add(light);
      }
    });

    // perimeter fence with the gate gap
    const postGeo = new THREE.BoxGeometry(0.12, 2.2, 0.12);
    const postMat = new THREE.MeshStandardMaterial({ color: '#7d8796', metalness: 0.6, roughness: 0.4 });
    const posts: Point[] = [];
    for (let x = 6; x <= SITE.width - 6; x += 3) if (x < GATE.x || x > GATE.x + GATE.w) posts.push({ x, y: FENCE_Y });
    const postMesh = new THREE.InstancedMesh(postGeo, postMat, posts.length);
    posts.forEach((pt, i) => {
      const p = toWorld(pt.x, pt.y);
      postMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, 1.1, p.z));
    });
    postMesh.castShadow = true;
    s.add(postMesh);
    const railMat = new THREE.MeshStandardMaterial({ color: '#6b7584', metalness: 0.6, roughness: 0.4, transparent: true, opacity: 0.85 });
    for (const [x0, x1] of [
      [6, GATE.x],
      [GATE.x + GATE.w, SITE.width - 6],
    ]) {
      for (const y of [0.4, 1.2, 2.0]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.05, 0.05), railMat);
        const p = toWorld((x0 + x1) / 2, FENCE_Y);
        rail.position.set(p.x, y, p.z);
        s.add(rail);
      }
    }
    const barrier = makeBarrier(GATE.w - 1);
    const bp = toWorld(GATE.x + 0.5, FENCE_Y);
    barrier.position.set(bp.x, 0, bp.z);
    s.add(barrier);
    const booth = makeBooth();
    const boothP = toWorld(GATE.x + GATE.w + 5, FENCE_Y - 5);
    booth.position.set(boothP.x, 0, boothP.z);
    s.add(booth);

    // parked cars
    for (const c of PARKED) {
      const car = makeCar(c.c);
      const p = toWorld(c.x, c.y);
      car.position.set(p.x, 0, p.z);
      car.rotation.y = c.r;
      s.add(car);
    }
    // traffic on the public road (ambient, not tracked)
    for (let i = 0; i < 4; i++) {
      const dir = i % 2 ? -1 : 1;
      const car = makeCar(i + 1, true);
      car.rotation.y = dir === 1 ? -Math.PI / 2 : Math.PI / 2;
      this.cars.push({ g: car, dir, speed: 9 + i * 2.5, lane: dir === 1 ? ROAD.y + ROAD.h * 0.72 : ROAD.y + ROAD.h * 0.28 });
      car.position.x = -300 + i * 170;
      s.add(car);
    }

    // zones
    for (const z of ZONES) {
      const pts = z.poly.map(([x, y]) => {
        const p = toWorld(x, y);
        return new THREE.Vector3(p.x, 0.25, p.z);
      });
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: '#9fb0c6', dashSize: 3, gapSize: 2.2, transparent: true, opacity: 0.45, toneMapped: false }));
      line.computeLineDistances();
      const [x0, y0] = z.poly[0];
      const [x1, y1] = z.poly[2];
      const fill = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0)),
        new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.0, depthWrite: false, toneMapped: false }),
      );
      fill.rotation.x = -Math.PI / 2;
      const c = toWorld((x0 + x1) / 2, (y0 + y1) / 2);
      fill.position.set(c.x, 0.2, c.z);
      s.add(overlay(line), overlay(fill));
      this.zoneLines.push({ name: z.name, line, fill });
      const label = new CSS2DObject(el('t3-zone', esc(z.name)));
      const lp = toWorld(z.label[0], z.label[1]);
      label.position.set(lp.x, 18, lp.z);
      this.labelsGroup.add(label);
    }

    s.add(this.routeGroup, this.labelsGroup);
  }

  // ---------------------------------------------------------------------------
  // dynamic objects
  // ---------------------------------------------------------------------------

  setState(s: AppState) {
    this.state = s;
  }

  private ensureDevice(d: Device): Vis {
    let v = this.devices.get(d.id);
    if (v) return v;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    const halo = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.4, 48), new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    halo.rotation.x = -Math.PI / 2;
    const label = new CSS2DObject(el('t3-dev', '', () => this.callbacks.selectDevice(d.id)));
    const p = toWorld(d.pos.x, d.pos.y);
    const pos = new THREE.Vector3(p.x, 0, p.z);
    if (d.kind === 'ugv') {
      const m = makeUgv();
      m.root.scale.setScalar(SYMBOL_SCALE.ugv);
      m.root.userData = { kind: 'device', id: d.id };
      this.scene.add(m.root, overlay(ring), overlay(halo));
      v = { kind: 'ugv', m, pos, heading: 0, label, ring, halo };
    } else if (d.kind === 'uav') {
      const m = makeUav();
      m.root.scale.setScalar(SYMBOL_SCALE.uav);
      m.root.userData = { kind: 'device', id: d.id };
      const tether = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), new THREE.LineDashedMaterial({ color: CYAN, dashSize: 1.2, gapSize: 1, transparent: true, opacity: 0.6, toneMapped: false }));
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(2, 24), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.35, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2;
      this.scene.add(m.root, overlay(ring), overlay(halo), overlay(tether), shadow);
      v = { kind: 'uav', m, pos, heading: 0, label, ring, halo, tether, shadow };
    } else {
      const view = CAMERA_VIEWS[d.id] ?? { height: 6, target: { x: d.pos.x, y: d.pos.y - 20 }, fov: 55 };
      const m = makeCctv(view.height);
      m.root.userData = { kind: 'device', id: d.id };
      m.root.position.copy(pos);
      const t = toWorld(view.target.x, view.target.y);
      m.head.lookAt(new THREE.Vector3(t.x, view.targetHeight ?? 0, t.z));
      // lookAt points +Z at the target; the model looks down −Z, so turn it around.
      m.head.rotateY(Math.PI);
      const dist = Math.hypot(t.x - pos.x, t.z - pos.z, view.height);
      const halfW = Math.tan(THREE.MathUtils.degToRad(view.fov / 2)) * dist;
      m.cone.scale.set(halfW, halfW * 0.6, dist);
      overlay(m.cone);
      this.scene.add(m.root, overlay(ring), overlay(halo));
      v = { kind: 'cctv', m, pos, heading: 0, label, ring, halo };
    }
    this.labelsGroup.add(label);
    this.devices.set(d.id, v);
    return v;
  }

  private positionsAt(s: AppState): Record<string, Point> {
    if (!s.replay.active) return Object.fromEntries(Object.values(s.devices).map((d) => [d.id, d.pos]));
    const out: Record<string, Point> = {};
    for (const d of Object.values(s.devices)) {
      let p: Point | undefined;
      for (const t of s.telemetry) {
        if (t.deviceId !== d.id) continue;
        if (t.at > s.replay.at) break;
        p = { x: t.x, y: t.y };
      }
      out[d.id] = p ?? d.pos;
    }
    return out;
  }

  /** Displayed gimbal attitude, eased between telemetry samples. */
  private gimbalView = new Map<string, { yaw: number; pitch: number; zoom: number }>();

  private easeGimbal(d: Device, dt: number) {
    if (!d.gimbal) {
      this.gimbalView.delete(d.id);
      return null;
    }
    const want = { yaw: d.gimbal.yaw, pitch: d.gimbal.pitch, zoom: d.gimbal.zoom ?? 1 };
    const cur = this.gimbalView.get(d.id);
    if (!cur) {
      this.gimbalView.set(d.id, want);
      return want;
    }
    const k = 1 - Math.exp(-dt * 7);
    cur.yaw += (want.yaw - cur.yaw) * k;
    cur.pitch += (want.pitch - cur.pitch) * k;
    cur.zoom = Math.exp(Math.log(cur.zoom) + (Math.log(want.zoom) - Math.log(cur.zoom)) * k);
    return cur;
  }

  /** Unit view direction of a gimbal camera: base bearing (rad, 0 = north) plus gimbal yaw, absolute pitch. */
  private static gimbalDir(bearing: number, g: { yaw: number; pitch: number }) {
    const yaw = bearing + THREE.MathUtils.degToRad(g.yaw);
    const p = THREE.MathUtils.degToRad(g.pitch);
    return new THREE.Vector3(Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
  }

  private static zoomFov(fov: number, zoom: number) {
    return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) / Math.max(1, zoom)));
  }

  private syncDevices(dt: number) {
    const s = this.state!;
    const positions = this.positionsAt(s);
    const k = 1 - Math.exp(-dt * 2.6);
    for (const d of Object.values(s.devices)) {
      const v = this.ensureDevice(d);
      const visible = s.layers[d.kind];
      const fresh = s.replay.active ? 'live' : freshnessAt(s.now, d);
      const sel = s.selectedDeviceId === d.id;
      const target = toWorld((positions[d.id] ?? d.pos).x, (positions[d.id] ?? d.pos).y);
      const tv = new THREE.Vector3(target.x, 0, target.z);
      const moving = v.pos.distanceTo(tv);
      if (v.kind !== 'cctv') {
        // smooth between 1 Hz telemetry fixes; snap if far (e.g. reset or replay seek)
        if (moving > 40) v.pos.copy(tv);
        else if (fresh !== 'offline') v.pos.lerp(tv, k);
        const want = d.heading !== undefined ? THREE.MathUtils.degToRad(d.heading) : moving > 0.05 ? Math.atan2(tv.x - v.pos.x, -(tv.z - v.pos.z)) : v.heading;
        let diff = want - v.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        v.heading += diff * Math.min(1, dt * 4);
      }
      const speed = fresh === 'live' ? d.speed : 0;
      const tone = fresh === 'live' ? CYAN : fresh === 'stale' ? AMBER : RED;
      const blink = fresh === 'live' ? 1 : 0.4 + 0.6 * Math.abs(Math.sin(this.t * 4));

      if (v.kind === 'ugv') {
        const { m } = v;
        m.root.visible = visible;
        m.root.position.copy(v.pos);
        m.root.rotation.y = -v.heading;
        for (const w of m.wheels) (w as unknown as THREE.Object3D).rotation.x -= (speed / (0.23 * SYMBOL_SCALE.ugv)) * dt * SYMBOL_SCALE.ugv;
        const busy = s.missions.some((x) => x.deviceId === d.id && x.status === 'executing');
        const on = busy ? Math.sin(this.t * 9) > 0 : true;
        (m.beacon.material as THREE.MeshBasicMaterial).color.set(busy ? '#fbbf24' : fresh === 'live' ? '#4ade80' : '#f87171');
        m.beaconGlow.material.color.set(busy ? 0xfbbf24 : fresh === 'live' ? 0x4ade80 : 0xf87171);
        m.beaconGlow.material.opacity = on ? 0.95 : 0.1;
        m.headlight.intensity = fresh === 'offline' ? 0 : 30;
        const g = this.easeGimbal(d, dt);
        if (g && m.camHead) {
          m.camHead.rotation.order = 'YXZ';
          m.camHead.rotation.y = -THREE.MathUtils.degToRad(g.yaw);
          m.camHead.rotation.x = THREE.MathUtils.degToRad(g.pitch);
        }
      } else if (v.kind === 'uav') {
        const { m } = v;
        const alt = d.alt ?? 40;
        m.root.visible = v.tether.visible = v.shadow.visible = visible;
        m.root.position.set(v.pos.x, alt + Math.sin(this.t * 1.3) * 0.4, v.pos.z);
        m.root.rotation.y = -v.heading;
        m.root.rotation.z = Math.sin(this.t * 0.9) * 0.04;
        for (const r of m.rotors) r.rotation.y += dt * (fresh === 'offline' ? 0 : 60);
        const on = Math.sin(this.t * 6) > 0.6;
        m.strobe.material.opacity = on ? 1 : 0;
        m.navRed.material.opacity = m.navGreen.material.opacity = 0.9;
        const g = v.tether.geometry as THREE.BufferGeometry;
        g.setFromPoints([new THREE.Vector3(v.pos.x, alt - 0.6, v.pos.z), new THREE.Vector3(v.pos.x, 0.2, v.pos.z)]);
        v.tether.computeLineDistances();
        v.shadow.position.set(v.pos.x, 0.08, v.pos.z);
      } else {
        const { m } = v;
        m.root.visible = visible;
        m.ir.material.opacity = fresh === 'offline' ? 0 : 0.35 + 0.25 * Math.sin(this.t * 2 + d.id.length);
        const relevant = sel || s.incidents.some((i) => i.id === s.selectedIncidentId && i.cameraId === d.id);
        m.cone.visible = visible && relevant && fresh !== 'offline';
        const g = this.easeGimbal(d, dt);
        const view = CAMERA_VIEWS[d.id];
        if (g && view) {
          const t = toWorld(view.target.x, view.target.y);
          const bearing = d.mount ? THREE.MathUtils.degToRad(d.mount.bearingDeg) : Math.atan2(t.x - v.pos.x, -(t.z - v.pos.z));
          const dir = TwinWorld.gimbalDir(bearing, g);
          const head = new THREE.Vector3(v.pos.x, view.height, v.pos.z);
          m.head.lookAt(head.clone().add(dir));
          m.head.rotateY(Math.PI);
          // Cone reaches the ground (or 120 m when looking at the horizon); narrows with zoom.
          const dist = dir.y < -0.02 ? Math.min(120, view.height / -dir.y) : 120;
          const halfW = Math.tan(THREE.MathUtils.degToRad(TwinWorld.zoomFov(view.fov, g.zoom) / 2)) * dist;
          m.cone.scale.set(halfW, halfW * 0.6, dist);
        }
        (m.cone.material as THREE.MeshBasicMaterial).opacity = 0.07 + 0.03 * Math.sin(this.t * 2);
      }

      // accuracy ring (true metres, grows when stale) and selection halo
      const accuracy = Math.max(1.2, d.accuracyM * (fresh === 'stale' ? 1 + (s.now - d.lastSeen) / 2000 : 1)) * 1.6;
      v.ring.visible = visible && s.layers.accuracy && v.kind !== 'cctv';
      v.ring.position.set(v.pos.x, 0.18, v.pos.z);
      v.ring.scale.setScalar(accuracy * (v.kind === 'uav' ? 1.4 : 1));
      (v.ring.material as THREE.MeshBasicMaterial).color.copy(tone);
      (v.ring.material as THREE.MeshBasicMaterial).opacity = 0.65 * blink;
      v.halo.visible = visible && sel;
      v.halo.position.set(v.pos.x, 0.2, v.pos.z);
      v.halo.scale.setScalar(1 + 0.15 * Math.sin(this.t * 3));
      (v.halo.material as THREE.MeshBasicMaterial).opacity = 0.55;

      // label
      v.label.visible = visible && this.labelsVisible;
      const h = v.kind === 'ugv' ? 1.7 * SYMBOL_SCALE.ugv + 2 : v.kind === 'uav' ? (d.alt ?? 40) + 4 : (CAMERA_VIEWS[d.id]?.height ?? 6) + 2.5;
      v.label.position.set(v.pos.x, h, v.pos.z);
      const sim = d.integration === 'simulated' ? '<i>SIM</i>' : '';
      const warn = fresh === 'live' ? '' : `<em class="${fresh}">${fresh === 'stale' ? 'STALE' : 'OFFLINE'}</em>`;
      const html = `<b>${esc(d.id)}</b>${sim}${warn}`;
      const div = v.label.element;
      if (div.dataset.html !== html) {
        div.innerHTML = html;
        div.dataset.html = html;
      }
      div.className = `t3-dev k-${d.kind} f-${fresh}${sel ? ' sel' : ''}`;
    }
  }

  private ensureIncident(i: Incident): IncVis {
    let v = this.incidents.get(i.id);
    if (v) return v;
    const root = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4, 56), new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.3;
    const fill = new THREE.Mesh(new THREE.CircleGeometry(3.2, 56), new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false }));
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.28;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 1.6, 40, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: AMBER, map: this.beamTex, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }),
    );
    beam.position.y = 20;
    root.add(overlay(ring), overlay(fill), overlay(beam));
    root.userData = { kind: 'incident', id: i.id };
    const label = new CSS2DObject(el('t3-inc', '', () => this.callbacks.selectIncident(i.id)));
    label.position.y = 24;
    root.add(label);
    this.scene.add(root);
    v = { root, ring, fill, beam, label };
    this.incidents.set(i.id, v);
    return v;
  }

  private syncIncidents() {
    const s = this.state!;
    const at = s.replay.active ? s.replay.at : s.now;
    const seen = new Set<string>();
    for (const i of s.incidents) {
      const show = (i.createdAt <= at && !['closed', 'duplicate', 'dismissed'].includes(i.status)) || i.id === s.selectedIncidentId;
      if (!show) continue;
      seen.add(i.id);
      const v = this.ensureIncident(i);
      const p = toWorld(i.pos.x, i.pos.y);
      v.root.position.set(p.x, 0, p.z);
      v.root.visible = true;
      const sel = i.id === s.selectedIncidentId;
      const unverified = i.status === 'new' || i.status === 'triaging';
      const c = unverified ? AMBER : i.severity === 'high' ? RED : i.status === 'resolved' || i.status === 'closed' ? GREY : CYAN;
      for (const m of [v.ring, v.fill, v.beam]) (m.material as THREE.MeshBasicMaterial).color.copy(c);
      const pulse = (this.t * (sel ? 0.9 : 0.6)) % 1;
      v.ring.scale.setScalar(sel ? 1 + pulse * 1.4 : 1);
      (v.ring.material as THREE.MeshBasicMaterial).opacity = sel ? 0.9 * (1 - pulse) + 0.1 : 0.7;
      v.beam.visible = sel || unverified;
      (v.beam.material as THREE.MeshBasicMaterial).opacity = sel ? 0.55 : 0.28;
      v.label.visible = this.labelsVisible;
      const tone = unverified ? 'amber' : i.severity === 'high' ? 'red' : 'cyan';
      const html = sel ? `<b>${esc(i.id)}</b><span>${esc(i.title)}</span>` : `<b>${esc(i.id)}</b>`;
      const div = v.label.element;
      if (div.dataset.html !== html) {
        div.innerHTML = `<i class="mark">!</i><div>${html}</div>`;
        div.dataset.html = html;
      }
      div.className = `t3-inc t-${tone}${sel ? ' sel' : ''}`;
    }
    for (const [id, v] of this.incidents) if (!seen.has(id)) v.root.visible = false;
  }

  private syncRoute() {
    const s = this.state!;
    const inc = s.incidents.find((i) => i.id === s.selectedIncidentId);
    const list = inc ? s.missions.filter((m) => m.incidentId === inc.id) : [];
    const m: Mission | undefined = list[list.length - 1];
    const active = m && !['cancelled', 'rejected', 'completed', 'failed'].includes(m.status);
    const draft = !!m && m.approvedVersion !== m.planVersion;
    const key = active ? `${m.id}:${m.planVersion}:${m.nextCp}:${draft}` : '';
    if (key !== this.routeKey) {
      this.routeKey = key;
      this.routeGroup.clear();
      if (active) {
        const color = draft ? AMBER : CYAN;
        const cps = m.checkpoints.map((p) => {
          const w = toWorld(p.x, p.y);
          return new THREE.Vector3(w.x, 0.35, w.z);
        });
        // remaining path from the next checkpoint on, plus a dashed or solid ribbon
        for (let i = 0; i < cps.length - 1; i++) this.addSegment(cps[i], cps[i + 1], color, draft, i < m.nextCp - 1);
        cps.forEach((c, i) => {
          const done = i < m.nextCp;
          const marker = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.25, 24), new THREE.MeshBasicMaterial({ color: done ? GREY : color, toneMapped: false }));
          marker.position.copy(c);
          const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 6), new THREE.MeshBasicMaterial({ color: done ? GREY : color, toneMapped: false }));
          pin.position.set(c.x, 2, c.z);
          const label = new CSS2DObject(el(`t3-cp${done ? ' done' : ''}${draft ? ' draft' : ''}`, String(i + 1)));
          label.position.set(c.x, 4.6, c.z);
          this.routeGroup.add(overlay(marker), overlay(pin), label);
        });
      }
    }
    // live leg from the vehicle to its next checkpoint
    this.routeGroup.children.filter((c) => c.userData.live).forEach((c) => this.routeGroup.remove(c));
    if (active && m.nextCp < m.checkpoints.length) {
      const v = this.devices.get(m.deviceId);
      if (v) {
        const n = toWorld(m.checkpoints[m.nextCp].x, m.checkpoints[m.nextCp].y);
        const seg = this.addSegment(new THREE.Vector3(v.pos.x, 0.35, v.pos.z), new THREE.Vector3(n.x, 0.35, n.z), draft ? AMBER : CYAN, draft, false);
        seg.forEach((o) => (o.userData.live = true));
      }
    }
  }

  private addSegment(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, dashed: boolean, done: boolean) {
    const len = a.distanceTo(b);
    const out: THREE.Object3D[] = [];
    if (len < 0.01) return out;
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    const angle = Math.atan2(dir.x, dir.z);
    const matl = new THREE.MeshBasicMaterial({ color: done ? GREY : color, transparent: true, opacity: done ? 0.4 : 0.95, toneMapped: false, depthWrite: false });
    if (dashed) {
      for (let d = 0; d < len; d += 3) {
        const l = Math.min(1.8, len - d);
        const dash = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, l), matl);
        dash.position.copy(a).addScaledVector(dir, d + l / 2);
        dash.rotation.y = angle;
        this.routeGroup.add(overlay(dash));
        out.push(dash);
      }
    } else {
      const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, len), matl);
      ribbon.position.copy(a).addScaledVector(dir, len / 2);
      ribbon.rotation.y = angle;
      const glowM = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.05, len), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: done ? 0.05 : 0.18, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }));
      glowM.position.copy(ribbon.position);
      glowM.rotation.y = angle;
      this.routeGroup.add(overlay(ribbon), overlay(glowM));
      out.push(ribbon, glowM);
    }
    return out;
  }

  private syncZones() {
    const s = this.state!;
    const inc = s.incidents.find((i) => i.id === s.selectedIncidentId);
    for (const z of this.zoneLines) {
      const sel = inc?.zone === z.name;
      z.line.visible = s.layers.zones;
      z.fill.visible = s.layers.zones && sel;
      const lm = z.line.material as THREE.LineDashedMaterial;
      lm.color.copy(sel ? CYAN : new THREE.Color('#9fb0c6'));
      lm.opacity = sel ? 0.95 : 0.4;
      (z.fill.material as THREE.MeshBasicMaterial).opacity = sel ? 0.05 + 0.02 * Math.sin(this.t * 2) : 0;
    }
  }

  /** Advance animations and sync with state. Called once per frame by the ticker. */
  /** Turn the holographic HUD extras on or off. */
  setHud(on: boolean) {
    this.hud.visible = on;
  }

  update(dt: number) {
    this.t += dt;
    if (this.hud.visible && this.hudPulse) {
      // A slow radar-style sweep ring from the site centre every 6 s.
      const k = (this.t % 6) / 6;
      this.hudPulse.scale.setScalar(20 + k * 260);
      (this.hudPulse.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - k);
    }
    for (const c of this.cars) {
      c.g.position.x += c.dir * c.speed * dt;
      if (c.g.position.x > 700) c.g.position.x = -700;
      if (c.g.position.x < -700) c.g.position.x = 700;
      c.g.position.z = toWorld(0, c.lane).z;
    }
    if (!this.state) return;
    this.syncDevices(dt);
    this.syncIncidents();
    this.syncRoute();
    this.syncZones();
    for (const b of this.buildingLabels) b.visible = this.labelsVisible;
  }

  // ---------------------------------------------------------------------------
  // cameras for the feeds
  // ---------------------------------------------------------------------------

  /** A camera positioned where the real device's camera is. Updated every call. */
  feedCamera(deviceId: string, aspect: number): THREE.PerspectiveCamera | null {
    const d = this.state?.devices[deviceId];
    if (!d) return null;
    let cam = this.feedCams.get(deviceId);
    if (d.kind === 'cctv') {
      const view = CAMERA_VIEWS[deviceId];
      if (!view) return null;
      cam ??= new THREE.PerspectiveCamera(view.fov, aspect, 0.3, 600);
      const p = toWorld(d.pos.x, d.pos.y);
      const t = toWorld(view.target.x, view.target.y);
      const g = this.gimbalView.get(deviceId) ?? (d.gimbal ? { yaw: d.gimbal.yaw, pitch: d.gimbal.pitch, zoom: d.gimbal.zoom ?? 1 } : null);
      if (g) {
        // Gimbal camera: yaw is relative to the mount's zero (the default view), pitch is absolute.
        const dir = TwinWorld.gimbalDir(d.mount ? THREE.MathUtils.degToRad(d.mount.bearingDeg) : Math.atan2(t.x - p.x, -(t.z - p.z)), g);
        const eye = new THREE.Vector3(p.x, view.height - 0.1, p.z);
        eye.addScaledVector(new THREE.Vector3(dir.x, 0, dir.z).normalize(), 1.2);
        cam.position.copy(eye);
        cam.lookAt(eye.clone().addScaledVector(dir, 50));
        cam.fov = TwinWorld.zoomFov(view.fov, g.zoom);
      } else {
        // Sit just in front of the lens so the camera's own housing is not in view.
        const tgt = new THREE.Vector3(t.x, view.targetHeight ?? 0, t.z);
        const eye = new THREE.Vector3(p.x, view.height - 0.1, p.z);
        eye.addScaledVector(tgt.clone().sub(eye).normalize(), 1.2);
        cam.position.copy(eye);
        cam.lookAt(tgt);
      }
    } else {
      const v = this.devices.get(deviceId);
      if (!v) return null;
      cam ??= new THREE.PerspectiveCamera(d.kind === 'uav' ? 70 : 62, aspect, 0.2, 600);
      const fwd = new THREE.Vector3(Math.sin(v.heading), 0, -Math.cos(v.heading));
      if (d.kind === 'ugv') {
        // Real camera: ~1.3 m up on the mast. The model is drawn enlarged, so put the
        // camera just ahead of the drawn bumper to keep the view clear.
        const ahead = 0.75 * SYMBOL_SCALE.ugv;
        cam.position.set(v.pos.x + fwd.x * ahead, 1.4, v.pos.z + fwd.z * ahead);
        const g = this.gimbalView.get(deviceId);
        if (g) {
          const dir = TwinWorld.gimbalDir(v.heading, g);
          cam.lookAt(cam.position.clone().addScaledVector(dir, 30));
          cam.fov = TwinWorld.zoomFov(62, g.zoom);
        } else cam.lookAt(v.pos.x + fwd.x * 30, 0.9, v.pos.z + fwd.z * 30);
      } else {
        const alt = (d.alt ?? 40) + Math.sin(this.t * 1.3) * 0.4;
        cam.position.set(v.pos.x, alt - 1.6, v.pos.z);
        cam.lookAt(v.pos.x + fwd.x * 40, 0, v.pos.z + fwd.z * 40);
      }
    }
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    this.feedCams.set(deviceId, cam);
    return cam;
  }

  /** Raycast helper for clicks on the 3D view. */
  pick(raycaster: THREE.Raycaster): { kind: 'device' | 'incident'; id: string } | null {
    const targets: THREE.Object3D[] = [];
    for (const v of this.devices.values()) if (v.m.root.visible) targets.push(v.m.root);
    for (const v of this.incidents.values()) if (v.root.visible) targets.push(v.ring, v.fill);
    const hit = raycaster.intersectObjects(targets, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.kind) o = o.parent;
    return o ? { kind: o.userData.kind, id: o.userData.id } : null;
  }

  /** World position of a site point (for camera focus). */
  worldOf(p: Point) {
    const w = toWorld(p.x, p.y);
    return new THREE.Vector3(w.x, 0, w.z);
  }
}

// ---------------------------------------------------------------------------
// shared world + frame ticker
// ---------------------------------------------------------------------------

let world: TwinWorld | null = null;
const subscribers = new Set<(dt: number) => void>();
let raf = 0;
let last = 0;

export function getWorld() {
  world ??= new TwinWorld();
  return world;
}

function loop(now: number) {
  const dt = Math.min(0.1, (now - (last || now)) / 1000);
  last = now;
  world?.update(dt);
  for (const fn of subscribers) fn(dt);
  raf = subscribers.size ? requestAnimationFrame(loop) : 0;
}

export function subscribeFrame(fn: (dt: number) => void) {
  subscribers.add(fn);
  if (!raf) {
    last = 0;
    raf = requestAnimationFrame(loop);
  }
  return () => {
    subscribers.delete(fn);
  };
}

let webgl: boolean | null = null;
export function webglAvailable() {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement('canvas');
    webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
}
