// Live video from the site media server over WebRTC (WHEP, as served by MediaMTX).
// The link carries a 60-second token that the media server checks with the platform, so each
// (re)connect asks the platform for a fresh link.
// What the feed says comes from domain/videoState.ts: LIVE only while new frames keep arriving
// (requestVideoFrameCallback and getStats framesDecoded), otherwise DELAYED, then a bounded
// reconnect with backoff, OFFLINE, DENIED or EXPIRED. A frozen frame is never shown as live.
// To save link bandwidth the stream is dropped while the view is hidden or scrolled away
// (the media server then stops pulling from the camera) and resumes when it is visible again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { useT, type T } from '../i18n';
import {
  VIDEO_DEFAULTS,
  framesAdvanced,
  initialVideoState,
  videoBadge,
  videoStep,
  wantsConnection,
  type FrameSample,
  type IceState,
  type VideoBadge,
  type VideoConfig,
  type VideoEvent,
  type VideoState,
} from '../domain/videoState';

/** Keep the stream this long after the view was hidden, so quick tab switches don't reconnect. */
const IDLE_CLOSE_MS = 10_000;
/** Clock tick and frame-counter reading interval. */
const SAMPLE_MS = 250;
/** getStats is heavier than the other readings. */
const STATS_MS = 1_000;

const now = () => performance.now();

/** True while the element is on screen and the page is visible (false after a grace period). */
function useInView(el: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(true);
  useEffect(() => {
    let onScreen = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const want = onScreen && document.visibilityState !== 'hidden';
      clearTimeout(timer);
      if (want) setActive(true);
      else timer = setTimeout(() => setActive(false), IDLE_CLOSE_MS);
    };
    const io = typeof IntersectionObserver !== 'undefined' && el.current ? new IntersectionObserver((e) => ((onScreen = e[0]?.isIntersecting ?? true), update())) : null;
    if (io && el.current) io.observe(el.current);
    document.addEventListener('visibilitychange', update);
    return () => {
      io?.disconnect();
      document.removeEventListener('visibilitychange', update);
      clearTimeout(timer);
    };
  }, [el]);
  return active;
}

export function WhepVideo({
  getUrl,
  onBadge,
  config,
}: {
  getUrl: () => Promise<string>;
  /** Called when the feed's status tag changes (LIVE, DELAYED, RECONNECTING …). */
  onBadge?: (b: VideoBadge) => void;
  /** Thresholds; defaults in VIDEO_DEFAULTS (LIVE within 2 s of the last frame). */
  config?: Partial<VideoConfig>;
}) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const getUrlRef = useRef(getUrl);
  getUrlRef.current = getUrl;
  const onBadgeRef = useRef(onBadge);
  onBadgeRef.current = onBadge;
  const cfgRef = useRef<VideoConfig>(VIDEO_DEFAULTS);
  cfgRef.current = { ...VIDEO_DEFAULTS, ...config };

  // The machine lives in a ref: frames arrive many times a second and must not re-render.
  // `view` changes only when something on screen changes.
  const machine = useRef<VideoState | null>(null);
  machine.current ??= initialVideoState(now());
  const [view, setView] = useState<VideoState>(machine.current);
  const dispatch = useCallback((e: VideoEvent) => {
    const prev = machine.current!;
    const next = videoStep(prev, e, cfgRef.current);
    if (next === prev) return;
    machine.current = next;
    if (next.phase !== prev.phase || next.session !== prev.session || next.attempt !== prev.attempt || next.reason !== prev.reason || next.detail !== prev.detail) setView(next);
  }, []);

  // Clock: drives the stall, connect-timeout and backoff rules.
  useEffect(() => {
    const id = setInterval(() => dispatch({ type: 'tick', at: now() }), SAMPLE_MS);
    return () => clearInterval(id);
  }, [dispatch]);

  const active = useInView(video);
  useEffect(() => dispatch({ type: active ? 'resume' : 'pause', at: now() }), [active, dispatch]);

  const badge = videoBadge(view);
  // The tag decides the whole badge, so report on tag changes only.
  useEffect(() => onBadgeRef.current?.(badge), [badge.tag]);

  // One connection per session while the state wants one. Leaving those phases (or unmounting)
  // closes the peer connection and ends the WHEP session on the media server.
  const conn = wantsConnection(view.phase) ? view.session : 0;
  useEffect(() => {
    if (!conn) return;
    const el = video.current;
    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let resource: string | null = null;
    const send = (e: VideoEvent) => {
      if (!stopped) dispatch(e);
    };
    const release = () => {
      pc?.close();
      pc = null;
      if (resource) void fetch(resource, { method: 'DELETE', keepalive: true }).catch(() => {});
      resource = null;
    };

    // Frames: count presented frames, read framesDecoded now and then, compare readings.
    const rvfc = !!el && typeof el.requestVideoFrameCallback === 'function';
    let presented = 0;
    let decoded: number | undefined;
    let handle = 0;
    const onFrame = () => {
      presented++;
      if (!stopped && el) handle = el.requestVideoFrameCallback(onFrame);
    };
    if (el && rvfc) handle = el.requestVideoFrameCallback(onFrame);
    const read = (): FrameSample => ({ presented: rvfc ? presented : undefined, decoded, mediaTime: el?.currentTime });
    let last = read();
    let statsAt = 0;
    const sampler = setInterval(() => {
      const at = now();
      const next = read();
      // A paused element (autoplay blocked) shows a still picture even while frames are decoded.
      if (framesAdvanced(last, next) && el && !el.paused) send({ type: 'frame', at });
      last = next;
      if (pc && at - statsAt >= STATS_MS) {
        statsAt = at;
        void framesDecoded(pc).then((n) => {
          if (n !== undefined) decoded = n;
        });
      }
    }, SAMPLE_MS);

    async function connect() {
      let url: string;
      try {
        url = await getUrlRef.current();
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400) return send({ type: 'http', at: now(), from: 'platform', status: e.status, detail: e.message });
        return send({ type: 'error', at: now(), detail: errorText(e) });
      }
      if (stopped) return;
      try {
        const peer = new RTCPeerConnection();
        pc = peer;
        peer.addTransceiver('video', { direction: 'recvonly' });
        peer.addTransceiver('audio', { direction: 'recvonly' });
        peer.ontrack = (e) => {
          if (!el || !e.streams[0] || el.srcObject === e.streams[0]) return;
          el.srcObject = e.streams[0];
          void el.play().catch(() => {}); // muted autoplay; if refused, no frames count and the feed never says LIVE
        };
        peer.oniceconnectionstatechange = () => send({ type: 'ice', at: now(), state: peer.iceConnectionState as IceState });
        await peer.setLocalDescription(await peer.createOffer());
        await gatherIce(peer, 2000);
        if (stopped) return;
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: peer.localDescription!.sdp });
        const loc = res.ok ? res.headers.get('Location') : null;
        if (loc) resource = new URL(loc, url).toString();
        // Closed while the offer was in flight: end the session the server just made.
        if (stopped) return release();
        if (!res.ok) return send({ type: 'http', at: now(), from: 'media', status: res.status });
        await peer.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      } catch (e) {
        send({ type: 'error', at: now(), detail: errorText(e) });
      }
    }

    void connect();
    return () => {
      stopped = true;
      clearInterval(sampler);
      if (el && rvfc) el.cancelVideoFrameCallback(handle);
      release();
    };
  }, [conn, dispatch]);

  // Drop the last stream reference when the player goes away.
  useEffect(() => {
    const el = video.current;
    return () => {
      if (el) el.srcObject = null;
    };
  }, []);

  const msg = message(t, view, cfgRef.current);
  const canRetry = view.phase === 'offline' || view.phase === 'denied' || view.phase === 'expired';
  return (
    <>
      <video ref={video} className="whep" autoPlay muted playsInline />
      {msg && (
        // Over the last frame (dimmed) when there is one to show; opaque otherwise.
        <div className={`whep-msg${badge.frozen ? ' over-frame' : ''}`} role="status" aria-live="polite">
          <div>
            <div>{msg.main}</div>
            {msg.sub && <small>{msg.sub}</small>}
            {canRetry && (
              <button type="button" className="feed-q whep-retry" onClick={() => dispatch({ type: 'retry', at: now() })}>
                {t('Try again')}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** Overlay text for the player state; none while LIVE or DELAYED (the frozen frame stays visible, labelled). */
function message(t: T, s: VideoState, cfg: VideoConfig): { main: string; sub?: string } | null {
  const retrying = t('Reconnecting (attempt {n} of {max})…', { n: s.attempt, max: cfg.maxRetries });
  switch (s.phase) {
    case 'live':
    case 'stalled':
      return null;
    case 'connecting':
      return s.attempt > 0 ? { main: retrying } : { main: t('Connecting to live video…') };
    case 'reconnecting':
      return { main: reasonText(t, s), sub: retrying };
    case 'offline':
      return { main: t('Live video is offline.'), sub: reasonText(t, s) };
    case 'denied':
      return { main: t('Access to this video was refused.'), sub: reasonText(t, s) };
    case 'expired':
      return { main: t('Your sign-in has ended. Sign in again to watch live video.') };
    case 'paused':
      return { main: t('Paused to save bandwidth. Resumes when visible.') };
  }
}

function reasonText(t: T, s: VideoState): string {
  switch (s.reason) {
    case 'link_lost':
      return t('Video link lost.');
    case 'no_frames':
      return t('No picture from the camera.');
    case 'server_error':
      return t('Media server error {code}.', { code: s.detail });
    case 'network':
      return s.detail || t('Cannot reach the media server.');
    case 'refused':
      return s.detail || t('The media server refused this link.');
    default:
      return '';
  }
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** framesDecoded of the inbound video stream, if the browser reports it. */
async function framesDecoded(pc: RTCPeerConnection): Promise<number | undefined> {
  try {
    const stats = await pc.getStats();
    let n: number | undefined;
    stats.forEach((r: { type?: string; kind?: string; framesDecoded?: number }) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && typeof r.framesDecoded === 'number') n = r.framesDecoded;
    });
    return n;
  } catch {
    return undefined; // closed meanwhile
  }
}

function gatherIce(pc: RTCPeerConnection, timeoutMs: number) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, timeoutMs);
  });
}
