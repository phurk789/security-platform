// State of a live (WHEP) video player — Technical Plan §13.5. Pure: no DOM, no timers.
// The player feeds it timestamped events and follows the phase it returns, so the rules that
// decide when the feed may say LIVE are unit-tested (videoState.test.ts).
//
//   CONNECTING ──first frame──▶ LIVE ──no frame for liveWithinMs──▶ STALLED ──frame──▶ LIVE
//       │                        │ ICE failed                         │ still no frame after
//       │ ICE failed, error,     │                                    │ stallReconnectMs, ICE failed
//       │ no frame in time       ▼                                    ▼
//       └──────────────────▶ RECONNECTING ──backoff──▶ CONNECTING (next session)
//                                 └─ retries used up ─▶ OFFLINE
//
//   401/403 from the media server or the platform ▶ DENIED; platform sign-in ended (401) ▶ EXPIRED.
//   Only LIVE may show the LIVE tag: a frozen frame is never labelled LIVE (PRD F04, Master Plan §22).

export type VideoPhase = 'connecting' | 'live' | 'stalled' | 'reconnecting' | 'offline' | 'denied' | 'expired' | 'paused';

/** RTCIceConnectionState, repeated here so the module needs no DOM types. */
export type IceState = 'new' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed';

export interface VideoConfig {
  /** LIVE only while a new frame was seen within this many ms. */
  liveWithinMs: number;
  /** After this much longer without a frame, drop the link and reconnect. */
  stallReconnectMs: number;
  /** A connect attempt that shows no frame within this long has failed. */
  connectTimeoutMs: number;
  /** Failed attempts in a row that are retried; one more failure means OFFLINE. */
  maxRetries: number;
  /** First retry delay; doubles each attempt up to backoffMaxMs. */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const VIDEO_DEFAULTS: VideoConfig = {
  liveWithinMs: 2_000,
  stallReconnectMs: 5_000,
  connectTimeoutMs: 10_000,
  maxRetries: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 15_000,
};

/** Why the player is not LIVE, for the message on the feed. */
export type VideoReason = 'link_lost' | 'no_frames' | 'server_error' | 'network' | 'refused' | 'signed_out';

export interface VideoState {
  phase: VideoPhase;
  /** Goes up on every new connect attempt. The player keeps one connection per value. */
  session: number;
  /** Failed attempts since the last LIVE. */
  attempt: number;
  /** When the current phase started. */
  since: number;
  /** When the last new frame was seen in this session. */
  lastFrameAt: number | null;
  /** RECONNECTING: when to try again. */
  retryAt: number | null;
  reason: VideoReason | null;
  /** Error message or HTTP status, shown under the reason. */
  detail: string;
}

export type VideoEvent =
  | { type: 'frame'; at: number }
  | { type: 'ice'; at: number; state: IceState }
  /** HTTP error from the platform (media session) or the media server (WHEP offer). */
  | { type: 'http'; at: number; from: 'platform' | 'media'; status: number; detail?: string }
  /** Any other failure of the current attempt (network, browser, no stream URL). */
  | { type: 'error'; at: number; detail?: string }
  /** Clock. The player sends one a few times a second. */
  | { type: 'tick'; at: number }
  /** View hidden / visible again (bandwidth saving). */
  | { type: 'pause'; at: number }
  | { type: 'resume'; at: number }
  /** Operator pressed "Try again". */
  | { type: 'retry'; at: number };

export function initialVideoState(at: number): VideoState {
  return { phase: 'connecting', session: 1, attempt: 0, since: at, lastFrameAt: null, retryAt: null, reason: null, detail: '' };
}

/** Wait before retry number `attempt` (1-based): base, 2×base, 4×base … capped. */
export function backoffMs(attempt: number, cfg: VideoConfig = VIDEO_DEFAULTS): number {
  return Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
}

/** Phases in which the player holds an open connection. Any other phase releases it. */
export function wantsConnection(phase: VideoPhase): boolean {
  return phase === 'connecting' || phase === 'live' || phase === 'stalled';
}

const TERMINAL: readonly VideoPhase[] = ['offline', 'denied', 'expired'];

/**
 * Next state. Returns the same object when nothing changes, so callers can skip a re-render.
 * Events that belong to a connection the state no longer wants (e.g. a late frame while
 * RECONNECTING) are ignored.
 */
export function videoStep(s: VideoState, e: VideoEvent, cfg: VideoConfig = VIDEO_DEFAULTS): VideoState {
  const at = e.at;
  const to = (phase: VideoPhase, patch: Partial<VideoState> = {}): VideoState => ({ ...s, phase, since: at, ...patch });
  const connect = (attempt: number) => to('connecting', { session: s.session + 1, attempt, lastFrameAt: null, retryAt: null, reason: null, detail: '' });
  const fail = (reason: VideoReason, detail = ''): VideoState => {
    const attempt = s.attempt + 1;
    if (attempt > cfg.maxRetries) return to('offline', { attempt, retryAt: null, reason, detail });
    return to('reconnecting', { attempt, retryAt: at + backoffMs(attempt, cfg), reason, detail });
  };
  const refused = (ev: Extract<VideoEvent, { type: 'http' }>): VideoState => {
    if (ev.from === 'platform' && ev.status === 401) return to('expired', { retryAt: null, reason: 'signed_out', detail: ev.detail ?? '' });
    if (ev.status === 401 || ev.status === 403) return to('denied', { retryAt: null, reason: 'refused', detail: ev.detail ?? '' });
    return fail('server_error', ev.detail ?? String(ev.status));
  };

  switch (e.type) {
    case 'pause':
      // Nothing to save on a refused stream; keep its message.
      return s.phase === 'paused' || s.phase === 'denied' || s.phase === 'expired' ? s : to('paused', { retryAt: null });
    case 'resume':
      return s.phase === 'paused' ? connect(0) : s;
    case 'retry':
      return TERMINAL.includes(s.phase) || s.phase === 'reconnecting' ? connect(0) : s;
  }

  switch (s.phase) {
    case 'connecting':
      switch (e.type) {
        // Connected is not enough: LIVE starts with the first frame actually seen.
        case 'frame':
          return to('live', { attempt: 0, lastFrameAt: at, reason: null, detail: '' });
        case 'ice':
          return e.state === 'failed' || e.state === 'closed' ? fail('link_lost') : s;
        case 'http':
          return refused(e);
        case 'error':
          return fail('network', e.detail);
        case 'tick':
          return at - s.since >= cfg.connectTimeoutMs ? fail('no_frames') : s;
      }
      return s;

    case 'live':
    case 'stalled':
      switch (e.type) {
        case 'frame':
          return s.phase === 'live' ? { ...s, lastFrameAt: at } : to('live', { lastFrameAt: at, reason: null, detail: '' });
        case 'ice':
          if (e.state === 'failed' || e.state === 'closed') return fail('link_lost');
          // Disconnected often heals by itself within seconds, so keep the link, but stop saying LIVE.
          if (e.state === 'disconnected' && s.phase === 'live') return to('stalled', { reason: 'link_lost' });
          return s;
        case 'http':
          return refused(e);
        case 'error':
          return fail('network', e.detail);
        case 'tick': {
          const quiet = at - (s.lastFrameAt ?? s.since);
          if (s.phase === 'live' && quiet > cfg.liveWithinMs) return to('stalled', { reason: 'no_frames' });
          if (s.phase === 'stalled' && quiet >= cfg.liveWithinMs + cfg.stallReconnectMs) return fail(s.reason ?? 'no_frames');
          return s;
        }
      }
      return s;

    case 'reconnecting':
      return e.type === 'tick' && s.retryAt !== null && at >= s.retryAt ? connect(s.attempt) : s;

    default:
      // offline, denied, expired, paused: wait for retry or resume.
      return s;
  }
}

/** One reading of the player's frame counters. A browser may not provide all of them. */
export interface FrameSample {
  /** Frames presented, counted with requestVideoFrameCallback. */
  presented?: number;
  /** framesDecoded from RTCPeerConnection.getStats (inbound video). */
  decoded?: number;
  /** video.currentTime. The media clock can run on without new frames, so it is used only when no frame counter is available. */
  mediaTime?: number;
}

/** True when a new frame arrived between two readings. */
export function framesAdvanced(prev: FrameSample | null, next: FrameSample): boolean {
  if (!prev) return false;
  let counted = false;
  // A frame counter wins over the media clock. Presented frames stop while the tab is in the
  // background even though frames still arrive, so either counter going up is enough.
  for (const k of ['presented', 'decoded'] as const) {
    const a = prev[k];
    const b = next[k];
    if (a === undefined || b === undefined) continue;
    counted = true;
    if (b > a) return true;
  }
  if (counted) return false;
  return prev.mediaTime !== undefined && next.mediaTime !== undefined && next.mediaTime > prev.mediaTime;
}

export interface VideoBadge {
  /** Status code on the feed. Stays in English on purpose (UXUI §7); words from PRD F04. */
  tag: 'LIVE' | 'CONNECTING' | 'DELAYED' | 'RECONNECTING' | 'OFFLINE' | 'DENIED' | 'EXPIRED' | 'PAUSED';
  /** True only in LIVE. */
  live: boolean;
  /** The picture on screen is old: the last frame of a stalled stream, or of a lost link. */
  frozen: 'delayed' | 'no_signal' | null;
}

/** What the feed shows for a player state. */
export function videoBadge(s: Pick<VideoState, 'phase' | 'attempt'>): VideoBadge {
  switch (s.phase) {
    case 'live':
      return { tag: 'LIVE', live: true, frozen: null };
    case 'stalled':
      return { tag: 'DELAYED', live: false, frozen: 'delayed' };
    case 'connecting':
      // A retry in progress still shows the last frame of the lost link.
      return s.attempt > 0 ? { tag: 'RECONNECTING', live: false, frozen: 'no_signal' } : { tag: 'CONNECTING', live: false, frozen: null };
    case 'reconnecting':
      return { tag: 'RECONNECTING', live: false, frozen: 'no_signal' };
    case 'offline':
      return { tag: 'OFFLINE', live: false, frozen: 'no_signal' };
    case 'denied':
      return { tag: 'DENIED', live: false, frozen: null };
    case 'expired':
      return { tag: 'EXPIRED', live: false, frozen: null };
    case 'paused':
      return { tag: 'PAUSED', live: false, frozen: null };
  }
}
