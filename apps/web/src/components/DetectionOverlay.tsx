// Boxes from the camera's analytics (edge vision or camera-side) drawn over its live feed for a
// few seconds after each detection, with type, confidence and the outcome the rules gave it.
import { DETECTION_LABEL, type Detection } from '@13store/shared';
import { useStore } from '../store';
import { useT } from '../i18n';

const SHOW_MS = 12_000;

export function DetectionOverlay({ deviceId }: { deviceId?: string }) {
  const { s } = useStore();
  const t = useT();
  if (!deviceId) return null;
  const recent = s.detections.filter((d) => d.deviceId === deviceId && d.bbox && s.now - d.at < SHOW_MS && s.now - d.at >= 0).slice(0, 6);
  if (!recent.length) return null;
  return (
    <div className="det-overlay" aria-hidden>
      {recent.map((d) => (
        <DetBox key={d.id} d={d} age={(s.now - d.at) / SHOW_MS} />
      ))}
      <span className="det-tag">{t('AI')}</span>
    </div>
  );
}

function DetBox({ d, age }: { d: Detection; age: number }) {
  const t = useT();
  const [x, y, w, h] = d.bbox!;
  const tone = d.outcome === 'incident' || d.outcome === 'merged' ? 'alert' : d.outcome === 'logged' ? 'info' : 'muted';
  const temp = d.attributes?.temperatureC;
  return (
    <div className={`det-box ${tone}`} style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, opacity: 1 - age * 0.6 }}>
      <span className="det-label">
        {t(DETECTION_LABEL[d.type])}
        {d.attributes?.label && d.attributes.label !== d.type ? ` · ${d.attributes.label}` : ''} {Math.round(d.confidence * 100)}%{temp !== undefined ? ` · ${temp} °C` : ''}
        {d.attributes?.count ? ` · ${d.attributes.count}` : ''}
        {d.incidentId ? ` → ${d.incidentId}` : ''}
      </span>
    </div>
  );
}
