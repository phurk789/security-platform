// Camera feed rendered from the digital-twin scene, from the device's own camera position.
// Low resolution and frame rate, sensor grain, IR monochrome for night CCTV — like a real stream.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { getWorld, subscribeFrame } from '../twin/world';

const FPS = 12;
let noiseUrl: string | null = null;

function noise() {
  if (noiseUrl) return noiseUrl;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  noiseUrl = c.toDataURL();
  return noiseUrl;
}

export function SceneFeed({ deviceId, ir, frozen }: { deviceId: string; ir: boolean; frozen: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  useEffect(() => {
    const world = getWorld();
    const renderer = new THREE.WebGLRenderer({ canvas: canvas.current!, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(400, 225, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = ir ? 2.4 : 1.6;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    let acc = 1;
    let drawn = false;
    // Don't spend GPU on a feed nobody can see (scrolled away or tab hidden).
    let onScreen = true;
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((e) => (onScreen = e[0]?.isIntersecting ?? true)) : null;
    io?.observe(canvas.current!);
    const unsub = subscribeFrame((dt) => {
      acc += dt;
      if (acc < 1 / FPS) return;
      acc = 0;
      if ((!onScreen || document.visibilityState === 'hidden') && drawn) return;
      if (frozenRef.current && drawn) return; // keep the last frame — never pretend it's live
      const cam = world.feedCamera(deviceId, 16 / 9);
      if (!cam) return;
      renderer.render(world.scene, cam);
      drawn = true;
    });
    return () => {
      unsub();
      io?.disconnect();
      renderer.dispose();
    };
  }, [deviceId, ir]);

  return (
    <div className={`scene-feed${ir ? ' ir' : ''}${frozen ? ' frozen' : ''}`}>
      <canvas ref={canvas} />
      <div className="sf-noise" style={{ backgroundImage: `url(${noise()})` }} />
      <div className="sf-vignette" />
    </div>
  );
}
