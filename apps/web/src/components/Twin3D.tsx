// WebGL view of the digital twin. Orbit with drag, zoom with wheel/pinch, click a device or incident.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Point } from '@13store/shared';
import { feedFrame, getQuality, useQuality } from '../twin/quality';
import { useStore } from '../store';
import { fromWorld } from '../twin/layout';
import { INTERIOR_LAYER, getWorld, subscribeFrame } from '../twin/world';
import { director, useDirector } from '../twin/director';
import { useAppearance, useTheme } from './Hud';
import { TwinCallout } from './TwinCallout';

export interface Twin3DApi {
  zoom(factor: number): void;
  focusSelection(): void;
  /** Glide the orbit centre to a site point (minimap click). */
  lookAt(p: Point): void;
}

/** Where the camera looks, in site coordinates — for the minimap. */
export interface ViewInfo {
  heading: number;
  target: Point;
  from: Point;
  dist: number;
}

const HOME = { pos: new THREE.Vector3(-175, 235, 320), target: new THREE.Vector3(22, 0, 18) };

export const Twin3D = forwardRef<
  Twin3DApi,
  {
    onHeading?: (deg: number) => void;
    onView?: (v: ViewInfo) => void;
    /** Keep this device centred (camera follows it). */ follow?: string;
    /** Take shots from the camera director (booth script). */
    directed?: boolean;
  }
>(function Twin3D({ onHeading, onView, follow, directed }, ref) {
  const { s, dispatch } = useStore();
  const host = useRef<HTMLDivElement>(null);
  const ctl = useRef<{ camera: THREE.PerspectiveCamera; controls: OrbitControls; goal?: { target: THREE.Vector3; dist: number } } | null>(null);
  const world = getWorld();
  world.setState(s);
  world.setHud(useTheme() === 'hud');
  world.setDaylight(useAppearance() === 'light');
  world.callbacks = {
    selectDevice: (id) => dispatch({ type: 'selectDevice', id }),
    selectIncident: (id) => dispatch({ type: 'selectIncident', id }),
    selectBuilding: (id) => dispatch({ type: 'selectBuilding', id }),
  };
  const quality = useQuality();
  const qualityRef = useRef(getQuality());
  qualityRef.current = quality;
  const headingRef = useRef(onHeading);
  headingRef.current = onHeading;
  const viewRef = useRef(onView);
  viewRef.current = onView;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const followRef = useRef(follow);
  followRef.current = follow;
  /** Vehicle the director asked us to follow (overview only). */
  const scriptFollow = useRef<string | null>(null);
  const dir = useDirector();

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    // Shadows are recomputed a few times a second, not every frame (only vehicles move).
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    // PCF directly: PCFSoft was removed in three.js and silently switched to PCF after the first
    // frame, which made every shader compile twice.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 't3-canvas';
    el.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = 't3-labels';
    el.appendChild(labels.domElement);

    const camera = new THREE.PerspectiveCamera(36, 1, 1, 4000);
    camera.position.copy(HOME.pos);
    camera.layers.enableAll();
    camera.layers.disable(INTERIOR_LAYER); // the map is an open cutaway; ceilings are for camera feeds
    // Both quality levels draw through a composer (MSAA render target + colour output pass), so
    // the scene's shaders are the same either way and switching quality never recompiles them.
    // High adds bloom for lamps and windows and 4× MSAA; low uses 2× and no bloom.
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(world.scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.5, 0.9);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    const lowTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 2 });
    const lowComposer = new EffectComposer(renderer, lowTarget);
    lowComposer.addPass(new RenderPass(world.scene, camera));
    lowComposer.addPass(new OutputPass());
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(HOME.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = 1.36;
    controls.minDistance = 25;
    controls.maxDistance = 900;
    controls.screenSpacePanning = false;
    controls.update();
    ctl.current = { camera, controls };

    const insets = { l: 0, r: 0, t: 0, b: 0 };
    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      for (const c of [composer, lowComposer]) {
        c.setPixelRatio(renderer.getPixelRatio());
        c.setSize(w, h);
      }
      labels.setSize(w, h);
      camera.aspect = w / h;
      // Panels floating over the map (HUD layout) cover its edges: centre the scene in the gap
      // between them by shifting the projection, not the camera. Insets come from CSS variables.
      const css = getComputedStyle(el);
      const px = (n: string) => parseFloat(css.getPropertyValue(n)) || 0;
      Object.assign(insets, { l: px('--view-l'), r: px('--view-r'), t: px('--view-t'), b: px('--view-b') });
      const offX = (insets.r - insets.l) / 2;
      const offY = (insets.b - insets.t) / 2;
      if (offX || offY) camera.setViewOffset(w, h, offX, offY, w, h);
      else camera.clearViewOffset();
      // Narrow gap between panels: pull back so the whole site still fits (tuned on 1920 px).
      const gap = w - px('--view-l') - px('--view-r');
      camera.zoom = gap < w ? Math.max(0.55, Math.min(1, gap / 1080)) : 1;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // click-to-select (ignore drags)
    let down: { x: number; y: number } | null = null;
    const ray = new THREE.Raycaster();
    ray.layers.enableAll();
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      if (directed) {
        director.userMoved();
        controls.autoRotate = false;
        scriptFollow.current = null;
      }
    };
    const onWheel = () => {
      if (directed) {
        director.userMoved();
        controls.autoRotate = false;
      }
    };
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true });
    controls.autoRotateSpeed = 0.35;
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = world.pick(ray);
      if (hit?.kind === 'device') world.callbacks.selectDevice(hit.id);
      if (hit?.kind === 'incident') world.callbacks.selectIncident(hit.id);
      if (hit?.kind === 'building') world.callbacks.selectBuilding(hit.id);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    let lastHeading = 999;
    const lastView = { x: Infinity, z: Infinity, d: Infinity, az: Infinity };
    // Build every shader in the background before the first frame, so the page stays
    // responsive while the GPU driver compiles (it can take many seconds on a first visit).
    let ready = false;
    const markReady = () => {
      ready = true;
      el.classList.add('t3-ready');
    };
    try {
      // Compile for the composer's render target: shaders differ between drawing to a target
      // and drawing to the screen, and compiling the wrong set would double the work.
      world.update(0); // create the vehicles (and their lights) first, so nothing recompiles later
      renderer.setRenderTarget(target);
      const job = renderer.compileAsync(world.scene, camera);
      renderer.setRenderTarget(null);
      job.then(markReady, markReady);
    } catch {
      renderer.setRenderTarget(null);
      markReady();
    }
    let shadowAcc = 0;
    const unsub = subscribeFrame((dt) => {
      if (!ready) return;
      shadowAcc += dt;
      if (shadowAcc > 0.2) {
        shadowAcc = 0;
        renderer.shadowMap.needsUpdate = true;
      }
      if (feedFrame(dt, performance.now()))
        dispatchRef.current({ type: 'toast', tone: 'warn', text: 'Switched the 3D twin to low quality to keep the picture smooth on this computer.' });
      const c = ctl.current!;
      if (c.goal) {
        const k = 1 - Math.exp(-dt * 3);
        const off = camera.position.clone().sub(controls.target);
        controls.target.lerp(c.goal.target, k);
        off.setLength(THREE.MathUtils.lerp(off.length(), c.goal.dist, k));
        camera.position.copy(controls.target).add(off);
        if (controls.target.distanceTo(c.goal.target) < 0.5 && Math.abs(off.length() - c.goal.dist) < 1) c.goal = undefined;
      } else if (followRef.current ?? scriptFollow.current) {
        // Follow mode: glide the orbit centre (and camera with it) after the vehicle.
        const p = world.devicePos((followRef.current ?? scriptFollow.current)!);
        if (p) {
          const delta = p.sub(controls.target).multiplyScalar(1 - Math.exp(-dt * 2.5));
          controls.target.add(delta);
          camera.position.add(delta);
        }
      }
      controls.update();
      renderer.toneMappingExposure = world.exposure;
      if (qualityRef.current === 'high') {
        bloom.strength = world.daylight ? 0.14 : 0.32;
        world.setComposed(true);
        composer.render();
        world.setComposed(false);
      } else lowComposer.render();
      labels.render(world.scene, camera);
      // Keep the info callout inside the view: flip it to the left of the anchor on the right half
      // of the map, and below the anchor near the top edge.
      const cp = world.calloutPos();
      if (cp) {
        const ndc = cp.project(camera);
        const w = el.clientWidth;
        const h = el.clientHeight;
        const sx = ((ndc.x + 1) / 2) * w;
        const sy = ((1 - ndc.y) / 2) * h;
        // card is ~240 px wide and ~230 px tall, 32 px / 36 px off the anchor
        world.calloutEl.classList.toggle('flip', sx + 280 > w - insets.r);
        world.calloutEl.classList.toggle('below', sy - 280 < insets.t + 110);
      }
      const az = THREE.MathUtils.radToDeg(controls.getAzimuthalAngle());
      if (Math.abs(az - lastHeading) > 0.5) {
        lastHeading = az;
        headingRef.current?.(az);
      }
      const tg = controls.target;
      const dist = camera.position.distanceTo(tg);
      if (viewRef.current && (Math.abs(tg.x - lastView.x) > 0.5 || Math.abs(tg.z - lastView.z) > 0.5 || Math.abs(dist - lastView.d) > 1 || Math.abs(az - lastView.az) > 0.5)) {
        Object.assign(lastView, { x: tg.x, z: tg.z, d: dist, az });
        viewRef.current({ heading: az, target: fromWorld(tg.x, tg.z), from: fromWorld(camera.position.x, camera.position.z), dist });
      }
    });

    return () => {
      unsub();
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      composer.dispose();
      target.dispose();
      lowComposer.dispose();
      lowTarget.dispose();
      renderer.dispose();
      el.innerHTML = '';
      ctl.current = null;
    };
  }, [world]);

  // Director shots (booth script): home, a point, follow a vehicle, or a slow idle orbit.
  useEffect(() => {
    const c = ctl.current;
    if (!directed || !c || dir.seq === 0) return;
    const shot = dir.shot;
    c.controls.autoRotate = shot.kind === 'idle';
    scriptFollow.current = shot.kind === 'follow' ? shot.id : null;
    if (shot.kind === 'home' || shot.kind === 'idle') c.goal = { target: HOME.target.clone(), dist: HOME.pos.distanceTo(HOME.target) };
    else if (shot.kind === 'point') c.goal = { target: world.worldOf(shot.p), dist: shot.dist };
    else if (shot.kind === 'follow') {
      const p = world.devicePos(shot.id);
      if (p) c.goal = { target: p, dist: shot.dist };
    }
  }, [dir.seq, dir.shot, directed, world]);

  // Starting to follow a vehicle: fly in to a close orbit around it.
  useEffect(() => {
    const c = ctl.current;
    if (!c || !follow) return;
    const p = world.devicePos(follow);
    if (p) c.goal = { target: p, dist: 120 };
  }, [follow, world]);

  useImperativeHandle(ref, () => ({
    lookAt(p: Point) {
      const c = ctl.current;
      if (!c) return;
      const off = c.camera.position.clone().sub(c.controls.target);
      c.goal = { target: world.worldOf(p), dist: c.goal?.dist ?? off.length() };
    },
    zoom(f: number) {
      const c = ctl.current;
      if (!c) return;
      const off = c.camera.position.clone().sub(c.controls.target);
      const base = c.goal?.dist ?? off.length();
      c.goal = { target: c.goal?.target ?? c.controls.target.clone(), dist: THREE.MathUtils.clamp(base * f, 25, 900) };
    },
    focusSelection() {
      const c = ctl.current;
      const st = world.state;
      if (!c || !st) return;
      const bld = st.selectedBuildingId ? world.buildingCenter(st.selectedBuildingId) : null;
      if (bld) {
        c.goal = { target: bld.center, dist: Math.max(bld.w, bld.d) * 2.4 };
        return;
      }
      const inc = st.incidents.find((i) => i.id === st.selectedIncidentId);
      const dev = st.selectedDeviceId ? st.devices[st.selectedDeviceId] : undefined;
      const p = dev?.pos ?? inc?.pos;
      c.goal = p ? { target: world.worldOf(p), dist: 85 } : { target: HOME.target.clone(), dist: HOME.pos.distanceTo(HOME.target) };
    },
  }));

  return (
    <div ref={host} className="t3-host" role="img" aria-label="3D digital twin">
      {createPortal(<TwinCallout />, world.calloutEl)}
    </div>
  );
});
