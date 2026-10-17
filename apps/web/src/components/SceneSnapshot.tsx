// A still picture from a device's camera in the twin, refreshed every few seconds while on
// screen. Used for incident thumbnails so the queue shows what the camera sees (the alert's
// subject, the vehicle arriving) instead of a drawing. Labelled SIM like every simulated feed.
import { useEffect, useRef } from 'react';
import { useAppearance } from './Hud';
import { snapshotInto } from '../twin/snapshot';

export function SceneSnapshot({ deviceId, label, refreshMs = 6000, className = '' }: { deviceId: string; label?: string; refreshMs?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const night = useAppearance() === 'dark';
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let visible = true;
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((e) => (visible = e[0]?.isIntersecting ?? true)) : null;
    io?.observe(c);
    const draw = () => visible && document.visibilityState !== 'hidden' && snapshotInto(c, deviceId, { ir: night && deviceId.startsWith('CCTV'), day: !night });
    // First frame once the world has had a tick; then refresh on the interval.
    const t0 = setTimeout(draw, 400);
    const timer = setInterval(draw, refreshMs);
    return () => {
      clearTimeout(t0);
      clearInterval(timer);
      io?.disconnect();
    };
  }, [deviceId, night, refreshMs]);
  return (
    <div className={`snap ${className}`}>
      <canvas ref={ref} width={320} height={180} aria-label={label ?? deviceId} />
      {label && <span className="snap-label">{label}</span>}
      <span className="snap-tag">SIM</span>
    </div>
  );
}
