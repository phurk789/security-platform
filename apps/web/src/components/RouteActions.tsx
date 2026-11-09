// What happens at each checkpoint of a route, as small tags: the speed of the leg to it, a wait,
// where the camera turns, a sweep, a photo, an evidence clip. Also the read-only list of a route's
// checkpoints with their tags, for the saved route and mission screens.
import { Camera, Gauge, Hourglass, MoveHorizontal, ScanEye, Video } from 'lucide-react';
import type { RoutePoint } from '@13store/shared';
import { useT, type T } from '../i18n';

/** "down 30° · right 45° · 3×" in the reader's language; empty when the camera stays ahead and wide. */
export function lookText(p: RoutePoint, t: T) {
  const { pitch = 0, yaw = 0, zoom = 1 } = p.look ?? {};
  const parts: string[] = [];
  if (pitch) parts.push(pitch < 0 ? t('down {n}°', { n: -pitch }) : t('up {n}°', { n: pitch }));
  if (yaw) parts.push(yaw < 0 ? t('left {n}°', { n: -yaw }) : t('right {n}°', { n: yaw }));
  if (zoom > 1) parts.push(`${zoom}×`);
  return parts.join(' · ');
}

/** The tags of one checkpoint. `speed`: the route's own speed, so a leg at that speed shows no tag. */
export function PointChips({ p, speed }: { p: RoutePoint; speed?: number }) {
  const t = useT();
  const look = lookText(p, t);
  return (
    <>
      {p.speed !== undefined && p.speed !== speed && (
        <span className="route-cp-tag" title={t('Speed to here')}>
          <Gauge size={11} aria-hidden="true" /> {t('{v} m/s', { v: p.speed })}
        </span>
      )}
      {p.holdS ? (
        <span className="route-cp-tag" title={t('Wait here')}>
          <Hourglass size={11} aria-hidden="true" /> {t('{n} s', { n: p.holdS })}
        </span>
      ) : null}
      {p.look && (
        <span className="route-cp-tag" title={t('Turn the camera')}>
          <ScanEye size={11} aria-hidden="true" /> {look || t('Ahead')}
        </span>
      )}
      {p.sweep ? (
        <span className="route-cp-tag" title={t('Sweep left and right')}>
          <MoveHorizontal size={11} aria-hidden="true" /> ±{p.sweep}°
        </span>
      ) : null}
      {p.photo && (
        <span className="route-cp-tag" role="img" title={t('Photo here')} aria-label={t('Photo here')}>
          <Camera size={11} aria-hidden="true" />
        </span>
      )}
      {p.capture && (
        <span className="route-cp-tag" role="img" title={t('The view here is kept as evidence')} aria-label={t('The view here is kept as evidence')}>
          <Video size={11} aria-hidden="true" />
        </span>
      )}
    </>
  );
}

/** A route's checkpoints in order, each with its name and what happens there (read only). */
export function RouteActionsList({ points, speed }: { points: RoutePoint[]; speed?: number }) {
  const t = useT();
  return (
    <ol className="mp-points">
      {points.map((p, i) => (
        <li key={i}>
          <span className="mp-pt">{i + 1}</span>
          <span className="grow">{p.name ?? t('Checkpoint {n}', { n: i + 1 })}</span>
          <span className="mp-pt-tags">
            <PointChips p={p} speed={speed} />
          </span>
        </li>
      ))}
    </ol>
  );
}
