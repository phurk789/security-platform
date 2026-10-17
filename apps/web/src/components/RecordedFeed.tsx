// A real clip recorded earlier, played in a feed. Pan, tilt and zoom from the device's gimbal
// are applied to the picture digitally so the controls visibly act on real footage.
// Never labelled LIVE: the feed shows RECORDED and where the clip came from.
import { useEffect, useRef } from 'react';
import type { GimbalState } from '@13store/shared';
import { markClipMissing, type SampleClip } from '../media/feeds';

/** Head-room so a digital pan has somewhere to go at 1× (the picture is always a little zoomed). */
const BASE = 1.18;
const MAX_ZOOM = 8;

export function RecordedFeed({ clip, frozen, gimbal }: { clip: SampleClip; frozen: boolean; gimbal?: GimbalState }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (frozen) v.pause();
    else void v.play().catch(() => {});
  }, [frozen, clip.src]);

  const zoom = Math.min(MAX_ZOOM, Math.max(1, gimbal?.zoom ?? 1));
  const margin = ((BASE - 1) / BASE) * 50; // percent of the frame hidden on each side at 1×
  const tx = gimbal ? -(Math.max(-135, Math.min(135, gimbal.yaw)) / 135) * margin : 0;
  const ty = gimbal ? (Math.max(-90, Math.min(25, gimbal.pitch)) / 90) * margin : 0;
  return (
    <video
      ref={video}
      className="recorded"
      src={clip.src}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      onError={() => markClipMissing(clip.src)}
      style={{ transform: `scale(${(BASE * zoom).toFixed(3)}) translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)` }}
    />
  );
}
