// Recordings timeline for an incident: what video exists for a camera around the incident,
// play a stretch of it (MP4 from the site media server, or a labelled storyboard for simulated
// cameras) and save that stretch to the incident as checksummed evidence.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Film, Save, Play, X } from 'lucide-react';
import { fmtTime, type Incident } from '@13store/shared';
import { can, currentUser } from '../domain/policy';
import { useStore, type ClipLink, type Recordings } from '../store';
import { useT } from '../i18n';

const DURATIONS = [30, 60, 120, 300];

export function RecordingsCard({ inc }: { inc: Incident }) {
  const { s, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  // Devices change every telemetry tick: key the camera list on ids so the selection survives.
  const onMission = s.missions
    .filter((m) => m.incidentId === inc.id)
    .map((m) => m.deviceId)
    .sort()
    .join(',');
  const cameraIds = Object.values(s.devices)
    .filter((d) => d.capabilities.includes('video') || d.capabilities.includes('camera'))
    .map((d) => d.id)
    .sort()
    .join(',');
  const cameras = useMemo(() => {
    const mission = new Set(onMission.split(',').filter(Boolean));
    return cameraIds
      .split(',')
      .filter(Boolean)
      .sort((a, b) => rank(a, inc.cameraId, mission) - rank(b, inc.cameraId, mission) || a.localeCompare(b));
  }, [cameraIds, onMission, inc.cameraId]);
  const [deviceId, setDeviceId] = useState(inc.cameraId ?? cameras[0] ?? '');
  const [rec, setRec] = useState<Recordings | null>(null);
  const [error, setError] = useState('');
  const [dur, setDur] = useState(60);
  const [start, setStart] = useState<number | null>(null);
  const [clip, setClip] = useState<ClipLink | null>(null);
  const [busy, setBusy] = useState(false);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDeviceId(inc.cameraId ?? cameras[0] ?? '');
    setStart(null);
    setClip(null);
  }, [inc.id, inc.cameraId, cameras]);

  // Window: five minutes before the alert until now (or until the incident closed plus a margin).
  const from = inc.createdAt - 5 * 60_000;
  const to = Math.max(inc.createdAt + 60_000, s.now);

  const load = useCallback(async () => {
    if (!session || !deviceId) return;
    try {
      setRec(await session.recordings(deviceId, from, to));
      setError('');
    } catch (e) {
      setRec(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, deviceId, from, Math.floor(to / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  if (!session || !cameras.length) return null;
  const span = Math.max(1, to - from);
  const pct = (x: number) => `${Math.max(0, Math.min(100, ((x - from) / span) * 100)).toFixed(2)}%`;
  const cursor = s.replay.active ? s.replay.at : null;
  const pick = (e: React.MouseEvent) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    const at = from + ((e.clientX - r.left) / r.width) * span;
    setStart(Math.round(Math.min(to - dur * 1000, Math.max(from, at))));
    setClip(null);
  };
  const covered = (at: number) => rec?.segments.some((g) => at >= g.start && at <= g.end) ?? false;
  const play = async () => {
    if (start === null) return;
    setBusy(true);
    try {
      setClip(await session.clip(deviceId, start, dur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card rec-card">
      <div className="row between">
        <h3>
          <Film size={16} /> {t('Recordings')}
        </h3>
        <span className={`badge ${rec?.label === 'RECORDED' ? 'badge-green' : 'badge-violet solid'}`}>{rec ? rec.label : '…'}</span>
      </div>
      <div className="row gap-s wrap">
        <select
          value={deviceId}
          onChange={(e) => {
            setDeviceId(e.target.value);
            setStart(null);
            setClip(null);
          }}
          aria-label={t('Camera')}
        >
          {cameras.map((id) => (
            <option key={id} value={id}>
              {id}
              {id === inc.cameraId ? ` · ${t('incident camera')}` : ''}
            </option>
          ))}
        </select>
        <select value={dur} onChange={(e) => setDur(Number(e.target.value))} aria-label={t('Clip length')}>
          {DURATIONS.map((d) => (
            <option key={d} value={d}>
              {d < 60 ? t('{n} s', { n: d }) : t('{n} min', { n: d / 60 })}
            </option>
          ))}
        </select>
      </div>
      <div className="rec-bar" ref={bar} onClick={pick} role="slider" aria-label={t('Recording timeline')} aria-valuemin={from} aria-valuemax={to} aria-valuenow={start ?? from}>
        {rec?.segments.map((g, i) => (
          <span key={i} className="rec-seg" style={{ left: pct(g.start), width: `calc(${pct(g.end)} - ${pct(g.start)})` }} />
        ))}
        <span className="rec-mark alert" style={{ left: pct(inc.createdAt) }} title={t('Alert')} />
        {cursor !== null && <span className="rec-mark replay" style={{ left: pct(cursor) }} title="REPLAY" />}
        {start !== null && <span className="rec-sel" style={{ left: pct(start), width: `calc(${pct(start + dur * 1000)} - ${pct(start)})` }} />}
      </div>
      <div className="rec-ticks mono muted">
        <small>{fmtTime(from, true)}</small>
        <small>
          {t('alert')} {fmtTime(inc.createdAt, true)}
        </small>
        <small>{fmtTime(to, true)}</small>
      </div>
      {error && <p className="warn-text">{error}</p>}
      {rec && rec.segments.length === 0 && !error && <p className="fine">{t('No recording for this camera in this window.')}</p>}
      {start === null ? (
        <p className="fine">{t('Click the timeline to choose where the clip starts. Cyan = recording available.')}</p>
      ) : (
        <div className="row gap-s wrap">
          <span className="mono">
            {fmtTime(start, true)} → {fmtTime(start + dur * 1000, true)}
          </span>
          <button className="btn-secondary small" disabled={busy || !covered(start)} onClick={() => void play()}>
            <Play size={14} /> {t('Play')}
          </button>
          {can(me.role, 'evidence.add') && !s.replay.active && (
            <button className="btn-primary small" disabled={busy || !covered(start)} onClick={() => void session.saveClip(inc.id, deviceId, start, dur)}>
              <Save size={14} /> {t('Save to evidence')}
            </button>
          )}
          {!covered(start) && <small className="muted">{t('No recording at that time.')}</small>}
        </div>
      )}
      {clip && (
        <div className="rec-player">
          <div className="row between">
            <span className={`badge ${clip.label === 'RECORDED' ? 'badge-green' : 'badge-violet solid'}`}>{clip.label}</span>
            <button className="btn-ghost small" onClick={() => setClip(null)} aria-label={t('Close')}>
              <X size={14} />
            </button>
          </div>
          {clip.mime.startsWith('video/') ? <video controls autoPlay muted playsInline src={clip.url} /> : <img src={clip.url} alt={t('Recording storyboard')} />}
        </div>
      )}
    </section>
  );
}

function rank(id: string, cameraId: string | undefined, onMission: Set<string>) {
  if (id === cameraId) return 0;
  if (onMission.has(id)) return 1;
  return 2;
}
