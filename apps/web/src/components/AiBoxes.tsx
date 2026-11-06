// Live AI boxes over a camera view: what the vision pipeline sees right now (people keep their
// number while they are followed), placed on video that is scaled to cover the view. Boxes vanish
// on their own when the AI or the link stops (see useLiveTracks). Only drawing: detections, rules
// and incidents are the record.
import { useEffect, useRef, useState } from 'react';
import { DETECTION_LABEL } from '@13store/shared';
import { placeBox, useLiveTracks } from '../domain/visionTracks';
import { useT } from '../i18n';
import './ai-boxes.css';

/** Frame shape assumed until the AI reports its own (most camera streams are 16:9). */
const DEFAULT_FRAME = { width: 1280, height: 720 };

export function AiBoxes({ deviceIds }: { deviceIds: string[] }) {
  const t = useT();
  const live = useLiveTracks(deviceIds);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const fw = live?.width ?? DEFAULT_FRAME.width;
  const fh = live?.height ?? DEFAULT_FRAME.height;
  return (
    <div ref={ref} className="ai-boxes" aria-hidden="true">
      {live?.boxes.map((b, i) => {
        const r = placeBox(b.bbox, fw, fh, size.w, size.h);
        if (!r) return null;
        return (
          <div key={b.id !== undefined ? `t${b.id}` : `i${i}`} className={`ai-box k-${b.type}`} style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
            <span>
              {t(DETECTION_LABEL[b.type])} {Math.round(b.confidence * 100)}%{b.id !== undefined ? ` · #${b.id}` : ''}
              {b.distM !== undefined ? ` · ${t('≈ {m} m', { m: b.distM })}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}
