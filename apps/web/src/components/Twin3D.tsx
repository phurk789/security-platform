// WebGL view of the digital twin. Orbit with drag, zoom with wheel/pinch, click a device or incident.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { useStore } from '../store';
import { getWorld, subscribeFrame } from '../twin/world';

export interface Twin3DApi {
  zoom(factor: number): void;
  focusSelection(): void;
}

const HOME = { pos: new THREE.Vector3(-175, 235, 320), target: new THREE.Vector3(22, 0, 18) };

export const Twin3D = forwardRef<Twin3DApi, { onHeading?: (deg: number) => void }>(function Twin3D({ onHeading }, ref) {
  const { s, dispatch } = useStore();
  const host = useRef<HTMLDivElement>(null);
  const ctl = useRef<{ camera: THREE.PerspectiveCamera; controls: OrbitControls; goal?: { target: THREE.Vector3; dist: number } } | null>(null);
  const world = getWorld();
  world.setState(s);
  world.callbacks = {
    selectDevice: (id) => dispatch({ type: 'selectDevice', id }),
    selectIncident: (id) => dispatch({ type: 'selectIncident', id }),
  };
  const headingRef = useRef(onHeading);
  headingRef.current = onHeading;

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
      labels.setSize(w, h);
      camera.aspect = w / h;
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
      }
      controls.update();
      renderer.render(world.scene, camera);
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
      renderer.dispose();
      el.innerHTML = '';
      ctl.current = null;
    };
  }, [world]);

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
      const inc = st.incidents.find((i) => i.id === st.selectedIncidentId);
      const dev = st.selectedDeviceId ? st.devices[st.selectedDeviceId] : undefined;
      const p = dev?.pos ?? inc?.pos;
      c.goal = p ? { target: world.worldOf(p), dist: 85 } : { target: HOME.target.clone(), dist: HOME.pos.distanceTo(HOME.target) };
    },
  }));

  return <div ref={host} className="t3-host" role="img" aria-label="3D digital twin" />;
});
