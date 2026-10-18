// Camera feed rendered from the digital-twin scene, from the device's own camera position.
// Low resolution and frame rate, sensor grain, IR monochrome for night CCTV — like a real stream.
import { useEffect, useRef } from 'react';
import { getWorld, subscribeFrame } from '../twin/world';
import { drawCamera, FEED_H, FEED_W } from '../twin/snapshot';

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

export function SceneFeed({
  deviceId,
  ir,
  frozen,
  day = false,
  facing = 'front',
}: {
  deviceId: string;
  ir: boolean;
  frozen: boolean;
  /** Daytime lighting (light theme). */ day?: boolean;
  /** Which camera on the vehicle. */ facing?: 'front' | 'rear' | 'left' | 'right' | 'down';
}) {
  getWorld().setDaylight(day);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  useEffect(() => {
    const el = canvas.current!;
    el.width = FEED_W;
    el.height = FEED_H;
    let acc = 1;
    let drawn = false;
    // Don't spend GPU on a feed nobody can see (scrolled away or tab hidden).
    let onScreen = true;
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((e) => (onScreen = e[0]?.isIntersecting ?? true)) : null;
    io?.observe(el);
    const unsub = subscribeFrame((dt) => {
      acc += dt;
      if (acc < 1 / FPS) return;
      acc = 0;
      if ((!onScreen || document.visibilityState === 'hidden') && drawn) return;
      if (frozenRef.current && drawn) return; // keep the last frame — never pretend it's live
      if (drawCamera(el, deviceId, { ir, facing })) drawn = true;
    });
    return () => {
      unsub();
      io?.disconnect();
    };
  }, [deviceId, ir, facing]);

  return (
    <div className={`scene-feed${ir ? ' ir' : ''}${frozen ? ' frozen' : ''}`}>
      <canvas ref={canvas} />
      <div className="sf-noise" style={{ backgroundImage: `url(${noise()})` }} />
      <div className="sf-vignette" />
    </div>
  );
}
