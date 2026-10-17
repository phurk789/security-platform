import { fmtDate, fmtTime } from '../domain/policy';
import { tr } from '../i18n';
import type { Freshness } from '@13store/shared';
import { SceneFeed } from './SceneFeed';
import { webglAvailable } from '../twin/world';
import { useStore } from '../store';
import { CameraControls } from './CameraControls';
import { WhepVideo } from './WhepVideo';
import { useState } from 'react';

export type Scene = 'gate' | 'plaza' | 'path' | 'lot' | 'ugv' | 'equipment';

/**
 * Drawn stand-in for a camera stream. Always labelled SIMULATED (UXUI §7).
 * When the source is stale or offline the frame freezes and the overlay says so — never LIVE.
 */
export function CameraFeed({
  scene,
  label,
  time,
  freshness = 'live',
  replay,
  compact,
  progress = 0,
  deviceId,
  controls,
  aimIncidentId,
}: {
  scene: Scene;
  label: string;
  time: number;
  freshness?: Freshness;
  replay?: boolean;
  compact?: boolean;
  /** 0..1 for the UGV forward view: how close the gate is. */
  progress?: number;
  /** Device whose camera to render from the 3D twin. Defaults to the id at the start of the label. */
  deviceId?: string;
  /** Show pan/tilt/zoom controls under the feed when the device has a gimbal. */
  controls?: boolean;
  /** Incident the controls can point the camera at. */
  aimIncidentId?: string;
}) {
  const { s, session } = useStore();
  const frozen = freshness !== 'live';
  const id = deviceId ?? label.match(/^[A-Z]{2,5}(?:-[A-Z0-9]+)+/)?.[0];
  const dev = id ? s.devices[id] : undefined;
  // Real camera with a stream on the site media server: play it over WebRTC. Not in replay.
  const liveStream = !compact && !replay && !!session && !!dev && dev.integration !== 'simulated' && !!dev.stream?.whep;
  const live3d = !compact && !liveStream && !!id && webglAvailable();
  const g = dev?.gimbal;
  // Small view: low-resolution sub-stream when the camera has one; HD on request.
  const hasSub = liveStream && !!dev?.stream?.whepSub;
  const [hd, setHd] = useState(false);
  const useSub = hasSub && !hd;
  const feed = (
    <div className={`feed${compact ? ' compact' : ''}${frozen && !liveStream ? ' frozen' : ''}${live3d ? ' feed-3d' : ''}`}>
      {liveStream ? (
        <WhepVideo
          key={`${dev!.id}:${useSub ? 'sub' : 'main'}`}
          getUrl={async () => {
            const r = await session!.mediaSession(dev!.id);
            const u = useSub ? r.whepSub : r.whep ?? r.whepSub;
            if (!u) throw new Error(tr('No live stream for this device.'));
            return u;
          }}
        />
      ) : live3d ? (
        <SceneFeed deviceId={id!} ir={id!.startsWith('CCTV')} frozen={frozen} />
      ) : (
      <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-label={tr('{label} simulated camera view', { label })}>
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0b1626" />
            <stop offset="1" stopColor="#1c2a3c" />
          </linearGradient>
          <radialGradient id="lamp" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffe9b0" stopOpacity="0.9" />
            <stop offset="1" stopColor="#ffe9b0" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="320" height="180" fill="url(#sky)" />
        {scene === 'gate' && <GateScene />}
        {scene === 'ugv' && <UgvScene progress={progress} />}
        {scene === 'plaza' && <PlazaScene />}
        {scene === 'path' && <PathScene />}
        {(scene === 'lot' || scene === 'equipment') && <LotScene />}
        <rect width="320" height="180" className="scan" />
      </svg>
      )}
      {!compact && g && !frozen && (
        <>
          <div className="feed-reticle" />
          <div className="feed-osd">
            <span>Y {g.yaw.toFixed(1)}°</span>
            <span>P {g.pitch.toFixed(1)}°</span>
            <span>{(g.zoom ?? 1).toFixed(1)}×</span>
            {g.recording && <span className="rec">● REC</span>}
          </div>
        </>
      )}
      {!compact && (
        <>
          <div className="feed-top">
            <span className="feed-label">{label}</span>
            <span className="feed-tags">
              {hasSub && (
                <button className="feed-q" onClick={() => setHd((v) => !v)} title={tr('Switch video quality (SD uses less bandwidth)')}>
                  {hd ? 'HD' : 'SD'}
                </button>
              )}
              <span className={`feed-tag ${replay ? 'replay' : liveStream ? 'live' : ''}`}>{replay ? 'REPLAY' : liveStream ? 'LIVE' : 'SIMULATED FEED'}</span>
            </span>
          </div>
          <div className="feed-bottom">
            <span>
              {fmtDate(time)} &nbsp;{fmtTime(time, true)}
            </span>
            {live3d && !frozen && <span className="feed-meta">{id!.startsWith('CCTV') ? 'IR · ' : ''}12 fps · 1.8 Mbps</span>}
            {frozen && <span className="feed-frozen">{freshness === 'offline' ? `NO SIGNAL · ${tr('last frame')}` : `FEED DELAYED · ${tr('frame frozen')}`}</span>}
          </div>
        </>
      )}
    </div>
  );
  if (!controls || compact || !dev?.capabilities.includes('gimbal')) return feed;
  return (
    <>
      {feed}
      <CameraControls device={dev} aimAt={aimIncidentId ? { incidentId: aimIncidentId } : undefined} />
    </>
  );
}

function Lamp({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <line x1={x} y1={y} x2={x} y2={y + 70} stroke="#3b4a5c" strokeWidth="2" />
      <circle cx={x} cy={y} r="26" fill="url(#lamp)" />
      <circle cx={x} cy={y} r="2.5" fill="#fff6d8" />
    </g>
  );
}

function GateScene() {
  return (
    <g>
      <polygon points="0,180 120,96 200,96 320,180" fill="#2a3442" />
      <polygon points="150,96 170,96 196,180 124,180" fill="none" stroke="#c7d2de" strokeOpacity="0.4" strokeDasharray="6 8" />
      <rect x="0" y="70" width="110" height="40" fill="#1a2533" />
      {Array.from({ length: 14 }).map((_, i) => (
        <line key={i} x1={8 + i * 7} y1="72" x2={8 + i * 7} y2="110" stroke="#5b6b7d" strokeWidth="1.4" />
      ))}
      <rect x="226" y="66" width="44" height="46" fill="#26364a" stroke="#4b5f78" />
      <rect x="232" y="74" width="32" height="16" fill="#f5d98c" opacity="0.65" />
      <rect x="212" y="112" width="8" height="18" fill="#8a96a3" />
      <rect x="120" y="110" width="96" height="6" fill="#e8edf2" />
      {Array.from({ length: 6 }).map((_, i) => (
        <rect key={i} x={122 + i * 16} y="110" width="8" height="6" fill="#e05252" />
      ))}
      <path d="M150 160 l10 -18 l10 18 h-6 v10 h-8 v-10z" fill="#e8edf2" opacity="0.7" />
      <Lamp x={70} y={36} />
      <Lamp x={296} y={30} />
    </g>
  );
}

function UgvScene({ progress }: { progress: number }) {
  const s = 0.6 + progress * 0.9;
  return (
    <g>
      <polygon points="0,180 130,92 190,92 320,180" fill="#2b3543" />
      <line x1="160" y1="92" x2="160" y2="180" stroke="#d3dbe4" strokeOpacity="0.35" strokeDasharray="8 10" />
      <g transform={`translate(160 ${100 - progress * 6}) scale(${s}) translate(-160 -100)`}>
        <rect x="112" y="78" width="96" height="5" fill="#e8edf2" />
        {Array.from({ length: 6 }).map((_, i) => (
          <rect key={i} x={113 + i * 16} y="78" width="8" height="5" fill="#e05252" />
        ))}
        <rect x="214" y="58" width="30" height="32" fill="#26364a" stroke="#4b5f78" />
        <rect x="218" y="64" width="22" height="10" fill="#f5d98c" opacity="0.6" />
      </g>
      <Lamp x={40} y={30} />
      <Lamp x={286} y={34} />
      <g stroke="#38bdf8" strokeOpacity="0.55" fill="none">
        <path d="M150 90 h20 M160 80 v20" />
        <rect x="120" y="60" width="80" height="60" strokeDasharray="4 6" />
      </g>
    </g>
  );
}

function PlazaScene() {
  return (
    <g>
      <rect x="0" y="100" width="320" height="80" fill="#2a3442" />
      <ellipse cx="160" cy="132" rx="70" ry="18" fill="none" stroke="#7d8b9a" />
      <rect x="20" y="30" width="90" height="72" fill="#253244" />
      <rect x="210" y="20" width="96" height="82" fill="#223043" />
      {Array.from({ length: 5 }).map((_, i) => (
        <rect key={i} x={30 + i * 16} y="44" width="8" height="10" fill="#f5d98c" opacity={i % 2 ? 0.2 : 0.55} />
      ))}
      <Lamp x={160} y={50} />
    </g>
  );
}

function PathScene() {
  return (
    <g>
      <polygon points="80,180 140,90 180,90 240,180" fill="#2c3644" />
      <rect x="0" y="60" width="90" height="120" fill="#1f2b3a" />
      <rect x="236" y="70" width="84" height="110" fill="#1f2b3a" />
      <rect x="146" y="128" width="30" height="20" fill="#5b6b7d" />
      <Lamp x={120} y={40} />
    </g>
  );
}

function LotScene() {
  return (
    <g>
      <rect x="0" y="96" width="320" height="84" fill="#28313d" />
      {Array.from({ length: 7 }).map((_, i) => (
        <line key={i} x1={20 + i * 46} y1="110" x2={10 + i * 46} y2="180" stroke="#cfd8e2" strokeOpacity="0.3" />
      ))}
      <rect x="40" y="128" width="34" height="18" rx="4" fill="#3d4a5a" />
      <rect x="180" y="134" width="34" height="18" rx="4" fill="#46525f" />
      <Lamp x={260} y={40} />
    </g>
  );
}
