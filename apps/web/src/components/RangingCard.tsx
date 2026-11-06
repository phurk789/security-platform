// Distance to people on a camera's video: the camera geometry (height over the floor, tilt) the
// platform uses, and how to calibrate it without a tape measure on the camera. Someone stands at a
// known distance (count the floor tiles), types it in and saves the point; two points, near and
// far, give height and tilt. Live boxes then show "≈ 4.2 m".
import { useState } from 'react';
import { Ruler } from 'lucide-react';
import { RANGING_TYPES, type Device } from '@13store/shared';
import { can, currentUser } from '../domain/policy';
import { aiSources, calibrationReadiness } from '../domain/deviceAi';
import { useLiveTracks } from '../domain/visionTracks';
import { useT } from '../i18n';
import { useStore } from '../store';
import './ai-boxes.css';

export function RangingCard({ d }: { d: Device }) {
  const { s, session } = useStore();
  const t = useT();
  const live = useLiveTracks(aiSources(d, s.devices));
  const r = d.ranging;
  const [dist, setDist] = useState('3');
  const [hand, setHand] = useState(false);
  const [h, setH] = useState(String(r?.heightM ?? ''));
  const [tilt, setTilt] = useState(String(r?.tiltDeg ?? 0));
  const [fov, setFov] = useState(String(r?.vfovDeg ?? d.mount?.fovDeg ?? 50));
  const [busy, setBusy] = useState(false);
  if (!session || s.replay.active) return null;
  const allowed = can(currentUser(s).role, 'camera.control');
  const ready = calibrationReadiness(live?.boxes);
  const people = (live?.boxes ?? []).filter((b) => (RANGING_TYPES as readonly string[]).includes(b.type)).length;
  const distM = Number(dist);
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  };
  const hint =
    ready === 'ready'
      ? t('Ready: one person in view, feet visible.')
      : ready === 'many'
        ? t('Only one person may be in view ({n} now).', { n: people })
        : ready === 'cut'
          ? t('Step back: the feet are cut off at the bottom of the picture.')
          : d.ai?.on
            ? t('Stand in front of the camera.')
            : t('Switch AI on, then stand in front of the camera.');
  return (
    <section className="dp-range" aria-label={t('Distance to people')}>
      <header>
        <Ruler size={13} aria-hidden="true" /> <b>{t('Distance to people')}</b>
      </header>
      <p className="fine">
        {r
          ? t('Camera {h} m above the floor, tilted {tilt}° down, field of view {fov}°.', { h: r.heightM.toFixed(2), tilt: r.tiltDeg.toFixed(1), fov: r.vfovDeg })
          : t('Not set yet: no distances are shown.')}
        {r?.source === 'calibrated' && r.samples?.length ? ` ${t('{n} calibration points, average error {e}%.', { n: r.samples.length, e: r.errorPct ?? 0 })}` : ''}
        {r?.source === 'manual' ? ` ${t('Typed in by hand.')}` : ''}
      </p>
      {allowed && (
        <>
          <div className="dp-range-cal">
            <label>
              {t('The person stands')}{' '}
              <input type="number" inputMode="decimal" min={0.5} max={30} step={0.1} value={dist} onChange={(e) => setDist(e.target.value)} aria-label={t('Distance in metres')} /> {t('m from the camera')}
            </label>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || ready !== 'ready' || !(distM >= 0.5 && distM <= 30)}
              onClick={() => void run(() => session.addRangingPoint(d.id, distM))}
            >
              {t('Save this point')}
            </button>
          </div>
          <small className={`dp-range-hint${ready === 'ready' ? ' ok' : ''}`}>{hint}</small>
          <small className="fine">{t('Tip: save two points, near and far (for example 2 m and 5 m). Floor tiles help: count them.')}</small>
          <div className="dp-range-actions">
            <button type="button" className="btn-ghost" onClick={() => setHand((v) => !v)} aria-expanded={hand}>
              {t('Set by hand')}
            </button>
            {r && (
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => void run(() => session.clearRanging(d.id))}>
                {t('Clear')}
              </button>
            )}
          </div>
          {hand && (
            <form
              className="dp-range-hand"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => session.setRanging(d.id, { heightM: Number(h), tiltDeg: Number(tilt), vfovDeg: Number(fov) })).then((ok) => ok && setHand(false));
              }}
            >
              <label>
                {t('Height (m)')} <input type="number" inputMode="decimal" min={0.05} max={20} step={0.01} value={h} onChange={(e) => setH(e.target.value)} required />
              </label>
              <label>
                {t('Tilt down (°)')} <input type="number" inputMode="decimal" min={-30} max={89} step={0.5} value={tilt} onChange={(e) => setTilt(e.target.value)} />
              </label>
              <label>
                {t('Field of view (°)')} <input type="number" inputMode="decimal" min={10} max={150} step={1} value={fov} onChange={(e) => setFov(e.target.value)} />
              </label>
              <button className="btn-secondary" disabled={busy || !h}>
                {t('Save')}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
