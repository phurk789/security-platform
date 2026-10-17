// WebGL view of the digital twin. Orbit with drag, zoom with wheel/pinch, click a device or incident.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { getQuality, useQuality } from '../twin/quality';
import { useStore } from '../store';
import { getWorld, subscribeFrame } from '../twin/world';
import { useAppearance, useTheme } from './Hud';

export interface Twin3DApi {
  zoom(factor: number): void;
  focusSelection(): void;
}

const HOME = { pos: new THREE.Vector3(-175, 235, 320), target: new THREE.Vector3(22, 0, 18) };

export const Twin3D = forwardRef<Twin3DApi, { onHeading?: (deg: number) => void; /** Keep this device centred (camera follows it). */ follow?: string }>(function Twin3D({ onHeading, follow }, ref) {
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
  const followRef = useRef(follow);
  followRef.current = follow;

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    // High quality: MSAA render target, bloom for lamps and windows, colour output pass.
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(world.scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.5, 0.9);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
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

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
      labels.setSize(w, h);
      camera.aspect = w / h;
      // Panels floating over the map (HUD layout) cover its edges: centre the scene in the gap
      // between them by shifting the projection, not the camera. Insets come from CSS variables.
      const css = getComputedStyle(el);
      const px = (n: string) => parseFloat(css.getPropertyValue(n)) || 0;
      const offX = (px('--view-r') - px('--view-l')) / 2;
      const offY = (px('--view-b') - px('--view-t')) / 2;
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
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
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
    const unsub = subscribeFrame((dt) => {
      const c = ctl.current!;
      if (c.goal) {
        const k = 1 - Math.exp(-dt * 3);
        const off = camera.position.clone().sub(controls.target);
        controls.target.lerp(c.goal.target, k);
        off.setLength(THREE.MathUtils.lerp(off.length(), c.goal.dist, k));
        camera.position.copy(controls.target).add(off);
        if (controls.target.distanceTo(c.goal.target) < 0.5 && Math.abs(off.length() - c.goal.dist) < 1) c.goal = undefined;
      } else if (followRef.current) {
        // Follow mode: glide the orbit centre (and camera with it) after the vehicle.
        const p = world.devicePos(followRef.current);
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
      } else renderer.render(world.scene, camera);
      labels.render(world.scene, camera);
      const az = THREE.MathUtils.radToDeg(controls.getAzimuthalAngle());
      if (Math.abs(az - lastHeading) > 0.5) {
        lastHeading = az;
        headingRef.current?.(az);
      }
    });

    return () => {
      unsub();
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      composer.dispose();
      target.dispose();
      renderer.dispose();
      el.innerHTML = '';
      ctl.current = null;
    };
  }, [world]);

  // Starting to follow a vehicle: fly in to a close orbit around it.
  useEffect(() => {
    const c = ctl.current;
    if (!c || !follow) return;
    const p = world.devicePos(follow);
    if (p) c.goal = { target: p, dist: 120 };
  }, [follow, world]);

  useImperativeHandle(ref, () => ({
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

  return <div ref={host} className="t3-host" role="img" aria-label="3D digital twin" />;
});
