// Evidence & replay for one incident, laid out for the operator reviewing it: what happened and who
// saw it (top), where it happened on the site's real map with a numbered pin where each image was
// taken (left), the selected image large with its time, source, distance and confidence, and every
// image in time order (right); recordings, notes and other files below.
import { ChevronLeft, ChevronRight, Download, Eye, FileText, History, Images, MapPinOff, Maximize2, Radio, ShieldAlert, ShieldCheck, StickyNote, X } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { Detection, Evidence, Incident } from '@13store/shared';
import { can, currentUser, fmtDate, fmtTime, freshness } from '../domain/policy';
import { detectionWindow, evidenceShots, isImage, mergeDetections, splitSource, summarizeShots, type Shot } from '../domain/evidence';
import { useStore } from '../store';
import { age, useT } from '../i18n';
import { IncidentBadge } from '../components/Badges';
import { CameraFeed } from '../components/CameraFeed';
import { TwinMap } from '../components/TwinMap';
import { RecordingsCard } from '../components/Recordings';
import { LatLon } from '../components/LatLon';
import { EvidenceImage, useEvidenceImage } from '../components/EvidenceImage';
import './evidence.css';

const EvidenceMap = __STANDALONE__ ? null : lazy(() => import('../components/EvidenceMap'));
const SEVERITY: Record<Incident['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' };

/**
 * The detections behind an incident's images (where the camera was, the distance, the confidence):
 * fetched for the span of the images, plus any that arrived live since. Needs report access.
 */
function useIncidentDetections(related: ReadonlySet<string>, files: readonly Evidence[]): Detection[] {
  const { s, session } = useStore();
  const allowed = can(currentUser(s).role, 'report.view');
  const win = detectionWindow(files);
  const key = session && allowed && win ? `${win.from}:${win.to}` : '';
  const [fetched, setFetched] = useState<Detection[]>([]);
  useEffect(() => {
    if (!key || !session) return;
    const [from, to] = key.split(':');
    let live = true;
    // Only incident and merged detections carry snapshots; asking for those two keeps the list short.
    const q = (outcome: string) => session.api.get<Detection[]>(`/detections?from=${from}&to=${to}&outcome=${outcome}&limit=1000`);
    Promise.all([q('incident'), q('merged')])
      .then(([a, b]) => live && setFetched([...a, ...b]))
      .catch((e) => console.warn('[evidence] detections unavailable', e));
    return () => {
      live = false;
    };
  }, [key, session]);
  return useMemo(() => mergeDetections(fetched, s.detections).filter((d) => d.incidentId && related.has(d.incidentId)), [fetched, s.detections, related]);
}

export function EvidencePage() {
  const { s, dispatch, mode } = useStore();
  const t = useT();
  const inc = s.incidents.find((i) => i.id === s.selectedIncidentId) ?? s.incidents[0];
  const incId = inc?.id;
  const related = useMemo(
    () => new Set(incId ? [incId, ...s.incidents.filter((i) => i.duplicateOf === incId).map((i) => i.id)] : []),
    [incId, s.incidents],
  );
  const replayAt = s.replay.active ? s.replay.at : undefined;
  const files = useMemo(
    () => s.evidence.filter((e) => related.has(e.incidentId) && (replayAt === undefined || e.capturedAt <= replayAt)),
    [s.evidence, related, replayAt],
  );
  const detections = useIncidentDetections(related, files);
  const shots = useMemo(() => evidenceShots(files, detections), [files, detections]);
  const others = useMemo(() => files.filter((e) => !isImage(e)).sort((a, b) => b.capturedAt - a.capturedAt), [files]);
  const [picked, setPicked] = useState<string>();
  const [full, setFull] = useState(false);
  useEffect(() => {
    setPicked(undefined);
    setFull(false);
  }, [incId]);

  // Devices that saw it or were sent to it, keyed on their ids so the map does not redraw for each telemetry tick.
  const deviceKey = useMemo(() => {
    if (!inc) return '';
    const ids = new Set<string>();
    for (const x of shots) if (x.deviceId) ids.add(x.deviceId);
    if (inc.cameraId) ids.add(inc.cameraId);
    for (const m of s.missions) if (related.has(m.incidentId)) ids.add(m.deviceId);
    const raisedBy = splitSource(inc.source.replace(/ \(simulated\)$/, '')).device;
    if (s.devices[raisedBy]) ids.add(raisedBy);
    return [...ids].sort().join(',');
  }, [inc, shots, s.missions, s.devices, related]);
  const deviceIds = useMemo(() => deviceKey.split(',').filter(Boolean), [deviceKey]);

  if (!inc)
    return (
      <div className="page evd-page">
        <div className="page-head">
          <h1>{t('Evidence & replay')}</h1>
        </div>
        <p className="empty">{t('No incidents yet.')}</p>
      </div>
    );

  // Nothing picked yet: the newest image.
  const current = shots.find((x) => x.ev.id === picked) ?? shots[shots.length - 1];
  const idx = current ? shots.indexOf(current) : 0;
  /** One image back or on, wrapping round. */
  const step = (d: number) => {
    if (shots.length) setPicked(shots[(idx + d + shots.length) % shots.length].ev.id);
  };
  const sum = summarizeShots(shots);
  const raised = splitSource(inc.source.replace(/ \(simulated\)$/, ''));
  const cam = inc.cameraId ? s.devices[inc.cameraId] : undefined;
  const now = s.replay.active ? s.replay.at : s.now;
  const start = inc.createdAt - 30_000;

  return (
    <div className="page evd-page">
      <div className="page-head">
        <div>
          <h1>{t('Evidence & replay')}</h1>
        </div>
        <div className="row gap-s">
          <select value={inc.id} onChange={(e) => dispatch({ type: 'selectIncident', id: e.target.value })} aria-label={t('Incident')}>
            {s.incidents.map((i) => (
              <option key={i.id} value={i.id}>
                {i.id} · {i.title}
              </option>
            ))}
          </select>
          {s.replay.active ? (
            <button className="btn-primary" onClick={() => dispatch({ type: 'exitReplay' })}>
              <Radio size={16} /> {t('Return to live')}
            </button>
          ) : (
            <button className="btn-secondary" onClick={() => dispatch({ type: 'enterReplay', at: inc.createdAt })}>
              <History size={16} /> {t('Replay this incident')}
            </button>
          )}
        </div>
      </div>
      {s.replay.active && (
        <div className="replay-bar">
          <History size={18} />
          <b>REPLAY</b>
          <span className="mono">
            {fmtDate(now)} {fmtTime(now, true)}
          </span>
          <span>{t('You are viewing past data. Device control is off.')}</span>
          <input
            type="range"
            min={start}
            max={s.now}
            step={1000}
            value={now}
            onChange={(e) => dispatch({ type: 'seekReplay', at: Number(e.target.value) })}
            aria-label={t('Replay time')}
          />
          <span className="mono muted">−{age(s.now - now)}</span>
        </div>
      )}

      <section className="evd-head" aria-label={t('Incident')}>
        <span className={`evd-sev sev-${inc.severity}`} title={`${t('Severity')}: ${t(SEVERITY[inc.severity])}`} />
        <div className="evd-head-main">
          <h2>
            <span className="mono">{inc.id}</span> {inc.title}
          </h2>
          <div className="evd-head-sub">
            <IncidentBadge status={inc.status} />
            <span>
              {t('Severity')} {t(SEVERITY[inc.severity])}
            </span>
            {inc.place && <span>{inc.place}</span>}
            {inc.zone && <span>{inc.zone}</span>}
          </div>
        </div>
        <dl className="evd-facts">
          <div>
            <dt>{t('Seen by')}</dt>
            <dd>
              {raised.device}
              {raised.box && (
                <small>
                  {t('AI box')} {raised.box}
                </small>
              )}
            </dd>
          </div>
          <div>
            <dt>{t('Time')}</dt>
            <dd>
              {fmtTime(sum.first ?? inc.createdAt, true)}
              {sum.last !== undefined && sum.last !== sum.first && `–${fmtTime(sum.last, true)}`}
              <small>{fmtDate(sum.first ?? inc.createdAt)}</small>
            </dd>
          </div>
          <div>
            <dt>{t('Images')}</dt>
            <dd>
              {shots.length}
              {shots.length > 0 && <small>{t('{n} on the map', { n: sum.placed })}</small>}
            </dd>
          </div>
          {sum.nearestM !== undefined && (
            <div>
              <dt>{t('Nearest')}</dt>
              <dd>
                {t('{m} m', { m: sum.nearestM })}
                <small>{t('from the camera')}</small>
              </dd>
            </div>
          )}
        </dl>
      </section>

      <div className="evd-grid">
        <div className="evd-map">
          {EvidenceMap && mode === 'remote' ? (
            <Suspense fallback={<div className="map map-real map-loading">{t('Loading map…')}</div>}>
              <EvidenceMap inc={inc} related={related} deviceIds={deviceIds} shots={shots} selected={current?.ev.id} onSelect={setPicked} />
            </Suspense>
          ) : (
            <TwinMap />
          )}
        </div>
        <div className="evd-side">
          {current ? (
            <ShotViewer shot={current} total={shots.length} onStep={step} onFull={() => setFull(true)} />
          ) : (
            <section className="evd-card evd-viewer evd-viewer-empty">
              <Images size={22} />
              <p>{t('No images for this incident yet.')}</p>
            </section>
          )}
          {shots.length > 0 && <ShotList shots={shots} current={current?.ev.id} onPick={setPicked} onStep={step} />}
        </div>
      </div>

      <div className="evd-lower">
        {cam && <CameraFeed scene={cam.view ?? 'gate'} label={`${cam.id} ${inc.place}`} time={now} freshness={s.replay.active ? 'live' : freshness(s, cam)} replay={s.replay.active} />}
        <RecordingsCard inc={inc} />
        <FilesCard inc={inc} files={others} />
      </div>
      <p className="fine evd-fine">
        {t('Checksums show a file has not changed. They are not, on their own, proof of admissibility.')} {t('Opening an image or file is recorded in the audit log.')}
      </p>
      {full && current && <Lightbox shot={current} total={shots.length} onStep={step} onClose={() => setFull(false)} />}
    </div>
  );
}

/** Distance and confidence of an image, as short text. */
function useShotFacts() {
  const t = useT();
  return (x: Shot) => ({
    far: x.distanceM !== undefined ? t('about {m} m away', { m: x.distanceM }) : undefined,
    sure: x.confidence !== undefined ? t('confidence {p}%', { p: Math.round(x.confidence * 100) }) : undefined,
  });
}

function ShotViewer({ shot, total, onStep, onFull }: { shot: Shot; total: number; onStep: (d: number) => void; onFull: () => void }) {
  const { s, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const img = useEvidenceImage(shot.ev.id, true);
  const facts = useShotFacts()(shot);
  const src = splitSource(shot.ev.source);
  return (
    <section className="evd-card evd-viewer" aria-label={t('Image {n} of {total}', { n: shot.n, total })}>
      <header className="evd-viewer-head">
        <span className="evd-num">{shot.n}</span>
        <div className="evd-viewer-when">
          <b className="mono">{fmtTime(shot.ev.capturedAt, true)}</b>
          <small>{t('Image {n} of {total}', { n: shot.n, total })}</small>
        </div>
        {total > 1 && (
          <div className="evd-step">
            <button className="icon-btn" onClick={() => onStep(-1)} aria-label={t('Previous image')} title={t('Previous image')}>
              <ChevronLeft size={18} />
            </button>
            <button className="icon-btn" onClick={() => onStep(1)} aria-label={t('Next image')} title={t('Next image')}>
              <ChevronRight size={18} />
            </button>
          </div>
        )}
      </header>
      <button className="evd-stage" onClick={onFull} title={t('Open full size')} aria-label={t('Open full size')}>
        <EvidenceImage id={shot.ev.id} alt={shot.ev.title} eager />
        <span className="evd-stage-zoom">
          <Maximize2 size={15} />
        </span>
        {shot.ev.simulated && <span className="badge badge-violet solid evd-stage-sim">SIMULATED</span>}
      </button>
      <dl className="evd-facts evd-facts-shot">
        <div>
          <dt>{t('Seen by')}</dt>
          <dd>
            {src.device}
            {src.box && (
              <small>
                {t('AI box')} {src.box}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('Distance')}</dt>
          <dd>{facts.far ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('Confidence')}</dt>
          <dd>{shot.confidence !== undefined ? `${Math.round(shot.confidence * 100)}%` : '—'}</dd>
        </div>
        <div>
          <dt>{t('Camera position')}</dt>
          <dd>{shot.pos ? <LatLon p={shot.pos} /> : <span className="muted">{t('No position')}</span>}</dd>
        </div>
      </dl>
      <div className="evd-actions">
        <button className="btn-secondary small" onClick={onFull}>
          <Maximize2 size={14} /> {t('Open full size')}
        </button>
        {session && can(me.role, 'evidence.export') && (
          <button className="btn-ghost small" onClick={() => session.openEvidence(shot.ev.id, true)}>
            <Download size={14} /> {t('Download (logged)')}
          </button>
        )}
      </div>
      <p className="evd-hash">
        {img.url &&
          (img.intact ? (
            <span className="evd-intact ok">
              <ShieldCheck size={13} /> {t('Checksum matches')}
            </span>
          ) : (
            <span className="evd-intact bad">
              <ShieldAlert size={13} /> {t('Checksum does not match: the file may have been changed')}
            </span>
          ))}
        <span className="mono">
          {shot.ev.id} · sha-256 {shot.ev.checksum ? `${shot.ev.checksum.slice(0, 16)}…` : t('computing…')}
        </span>
      </p>
    </section>
  );
}

function ShotList({ shots, current, onPick, onStep }: { shots: readonly Shot[]; current?: string; onPick: (id: string) => void; onStep: (d: number) => void }) {
  const t = useT();
  const facts = useShotFacts();
  const list = useRef<HTMLOListElement>(null);
  // Keep the selected row in view inside the list (never scrolling the page).
  useEffect(() => {
    const box = list.current;
    const row = box?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = row.offsetTop - (box.clientHeight - row.offsetHeight) / 2;
  }, [current]);
  return (
    <section className="evd-card evd-list">
      <h3>
        <Images size={16} /> {t('Snapshots ({n})', { n: shots.length })}
      </h3>
      <ol
        ref={list}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          onStep(d);
          // Focus follows the selection, so the arrow keys keep working.
          requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[aria-current="true"] button')?.focus());
        }}
      >
        {shots.map((x) => {
          const on = x.ev.id === current;
          const f = facts(x);
          return (
            <li key={x.ev.id} aria-current={on ? 'true' : undefined}>
              <button className={`evd-row${on ? ' sel' : ''}`} onClick={() => onPick(x.ev.id)}>
                <EvidenceImage id={x.ev.id} alt={x.ev.title} className="evd-thumb" />
                <span className="evd-num">{x.n}</span>
                <span className="evd-row-main">
                  <b className="mono">{fmtTime(x.ev.capturedAt, true)}</b>
                  <small>{[f.far, f.sure].filter(Boolean).join(' · ') || x.ev.id}</small>
                </span>
                {!x.pos && (
                  <span className="evd-row-flag" title={t('No position')}>
                    <MapPinOff size={14} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The selected image as large as the screen allows; arrow keys step through the others. */
function Lightbox({ shot, total, onStep, onClose }: { shot: Shot; total: number; onStep: (d: number) => void; onClose: () => void }) {
  const t = useT();
  const facts = useShotFacts()(shot);
  const src = splitSource(shot.ev.source);
  const keys = useRef({ onStep, onClose });
  keys.current = { onStep, onClose };
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') keys.current.onClose();
      else if (e.key === 'ArrowLeft') keys.current.onStep(-1);
      else if (e.key === 'ArrowRight') keys.current.onStep(1);
    };
    window.addEventListener('keydown', k);
    closeBtn.current?.focus();
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div className="scrim evd-lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <figure role="dialog" aria-modal="true" aria-label={t('Image {n} of {total}', { n: shot.n, total })}>
        <EvidenceImage id={shot.ev.id} alt={shot.ev.title} eager className="evd-lightbox-img" />
        <figcaption>
          <span className="evd-num">{shot.n}</span>
          <span className="evd-lightbox-text">
            <span>
              <b className="mono">{fmtTime(shot.ev.capturedAt, true)}</b> · {src.device}
              {src.box ? ` · ${t('AI box')} ${src.box}` : ''}
              {facts.far ? ` · ${facts.far}` : ''}
              {facts.sure ? ` · ${facts.sure}` : ''}
            </span>
            <small className="mono">
              {shot.ev.id} · {t('Image {n} of {total}', { n: shot.n, total })}
            </small>
          </span>
          {total > 1 && (
            <>
              <button className="icon-btn" onClick={() => onStep(-1)} aria-label={t('Previous image')} title={t('Previous image')}>
                <ChevronLeft size={20} />
              </button>
              <button className="icon-btn" onClick={() => onStep(1)} aria-label={t('Next image')} title={t('Next image')}>
                <ChevronRight size={20} />
              </button>
            </>
          )}
          <button ref={closeBtn} className="icon-btn" onClick={onClose} aria-label={t('Close')} title={t('Close')}>
            <X size={20} />
          </button>
        </figcaption>
      </figure>
    </div>
  );
}

/** Operator notes, clips and other files of the incident, newest first, and a note to add. */
function FilesCard({ inc, files }: { inc: Incident; files: readonly Evidence[] }) {
  const { s, dispatch, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const [note, setNote] = useState('');
  const canAdd = !s.replay.active && can(me.role, 'evidence.add');
  return (
    <section className="evd-card evd-files">
      <h3>
        <FileText size={16} /> {t('Notes & files ({n})', { n: files.length })}
      </h3>
      {files.length ? (
        <ul className="files">
          {files.map((e) => (
            <li key={e.id}>
              <div className="row between">
                <b>{e.title}</b>
                {e.simulated && <span className="badge badge-violet solid">SIMULATED</span>}
              </div>
              <small className="muted">
                {t('{id} · {kind} · {source} · captured {time} · by {who}', {
                  id: e.id,
                  kind: t(e.kind),
                  source: e.source,
                  time: fmtTime(e.capturedAt, true),
                  who: e.recordedBy,
                })}
                {e.incidentId !== inc.id && ` · ${t('from {id} (merged)', { id: e.incidentId })}`}
              </small>
              {e.kind !== 'note' && <small className="mono muted">sha-256 {e.checksum ? `${e.checksum.slice(0, 16)}…` : t('computing…')}</small>}
              {session && e.kind !== 'note' && (
                <div className="row gap-s">
                  <button className="btn-ghost small" onClick={() => session.openEvidence(e.id)}>
                    <Eye size={14} /> {t('Open')}
                  </button>
                  {can(me.role, 'evidence.export') && (
                    <button className="btn-ghost small" onClick={() => session.openEvidence(e.id, true)}>
                      <Download size={14} /> {t('Download (logged)')}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted evd-none">{t('No notes or other files yet.')}</p>
      )}
      {canAdd && (
        <div className="evd-note">
          <label className="field">
            <span>
              <StickyNote size={14} /> {t('Add note')}
            </span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Observation, contact made, follow-up…')} />
          </label>
          <button
            className="btn-secondary"
            disabled={!note.trim()}
            onClick={() => {
              dispatch({ type: 'addNote', incidentId: inc.id, text: note });
              setNote('');
            }}
          >
            {t('Attach note')}
          </button>
        </div>
      )}
    </section>
  );
}
