import { describe, expect, it } from 'vitest';
import {
  VIDEO_DEFAULTS as D,
  backoffMs,
  framesAdvanced,
  initialVideoState,
  videoBadge,
  videoStep,
  wantsConnection,
  type VideoConfig,
  type VideoEvent,
  type VideoState,
} from './videoState';

/** Run events through the machine from a fresh CONNECTING state at t=0. */
const run = (events: VideoEvent[], cfg: VideoConfig = D, from: VideoState = initialVideoState(0)) => events.reduce((s, e) => videoStep(s, e, cfg), from);
const frame = (at: number): VideoEvent => ({ type: 'frame', at });
const tick = (at: number): VideoEvent => ({ type: 'tick', at });
const ice = (at: number, state: Extract<VideoEvent, { type: 'ice' }>['state']): VideoEvent => ({ type: 'ice', at, state });
/** A stream that went LIVE at t=1000. */
const live = () => run([ice(500, 'connected'), frame(1000)]);

describe('live video state', () => {
  it('starts CONNECTING and needs a frame, not just a connection, to be LIVE', () => {
    expect(initialVideoState(0).phase).toBe('connecting');
    expect(run([ice(500, 'connected'), tick(900)]).phase).toBe('connecting');
    expect(live().phase).toBe('live');
  });

  it('no frames → STALLED once the threshold passes', () => {
    const s = live();
    expect(run([tick(1000 + D.liveWithinMs)], D, s).phase).toBe('live');
    const stalled = run([tick(1000 + D.liveWithinMs + 1)], D, s);
    expect(stalled.phase).toBe('stalled');
    expect(stalled.reason).toBe('no_frames');
  });

  it('frames resume → LIVE', () => {
    const stalled = run([tick(4000)], D, live());
    expect(stalled.phase).toBe('stalled');
    const back = run([frame(4200)], D, stalled);
    expect(back.phase).toBe('live');
    expect(back.lastFrameAt).toBe(4200);
    expect(back.reason).toBeNull();
  });

  it('frames keep it LIVE', () => {
    const s = run([frame(2000), tick(2500), frame(3500), tick(5000), frame(5400), tick(7000)], D, live());
    expect(s.phase).toBe('live');
  });

  it('the threshold is configurable', () => {
    const cfg = { ...D, liveWithinMs: 5000 };
    const s = run([ice(500, 'connected'), frame(1000), tick(5000)], cfg);
    expect(s.phase).toBe('live');
    expect(run([tick(6001)], cfg, s).phase).toBe('stalled');
  });

  it('ICE failed → RECONNECTING with backoff', () => {
    const s = run([ice(3000, 'failed')], D, live());
    expect(s.phase).toBe('reconnecting');
    expect(s.reason).toBe('link_lost');
    expect(s.attempt).toBe(1);
    expect(s.retryAt).toBe(3000 + D.backoffBaseMs);
    expect(wantsConnection(s.phase)).toBe(false);
  });

  it('ICE disconnected stops saying LIVE at once but keeps the link', () => {
    const s = run([ice(1500, 'disconnected')], D, live());
    expect(s.phase).toBe('stalled');
    expect(wantsConnection(s.phase)).toBe(true);
    expect(run([frame(1800)], D, s).phase).toBe('live');
  });

  it('a stall that does not recover → RECONNECTING', () => {
    const stalled = run([tick(3500)], D, live());
    expect(run([tick(1000 + D.liveWithinMs + D.stallReconnectMs - 1)], D, stalled).phase).toBe('stalled');
    const s = run([tick(1000 + D.liveWithinMs + D.stallReconnectMs)], D, stalled);
    expect(s.phase).toBe('reconnecting');
    expect(s.reason).toBe('no_frames');
  });

  it('a connection that never shows a frame times out → RECONNECTING', () => {
    const s = run([ice(500, 'connected'), tick(D.connectTimeoutMs)]);
    expect(s.phase).toBe('reconnecting');
    expect(s.reason).toBe('no_frames');
  });

  it('RECONNECTING opens a new session when the backoff ends', () => {
    const s = run([ice(3000, 'failed')], D, live());
    expect(run([tick(3000 + D.backoffBaseMs - 1)], D, s).phase).toBe('reconnecting');
    const next = run([tick(3000 + D.backoffBaseMs)], D, s);
    expect(next.phase).toBe('connecting');
    expect(next.session).toBe(s.session + 1);
    expect(next.attempt).toBe(1);
    expect(next.lastFrameAt).toBeNull();
  });

  it('ignores late events from the closed connection while RECONNECTING', () => {
    const s = run([ice(3000, 'failed')], D, live());
    expect(run([frame(3100), ice(3200, 'connected'), { type: 'error', at: 3300 }], D, s)).toBe(s);
  });

  it('exceeding retries → OFFLINE, and a frame resets the count', () => {
    let s = initialVideoState(0);
    let at = 0;
    for (let i = 1; i <= D.maxRetries; i++) {
      s = videoStep(s, { type: 'error', at, detail: 'boom' });
      expect(s.phase).toBe('reconnecting');
      expect(s.attempt).toBe(i);
      at = s.retryAt!;
      s = videoStep(s, tick(at));
      expect(s.phase).toBe('connecting');
    }
    s = videoStep(s, { type: 'error', at, detail: 'boom' });
    expect(s.phase).toBe('offline');
    expect(s.detail).toBe('boom');
    expect(wantsConnection(s.phase)).toBe(false);
    expect(videoStep(s, tick(at + 60_000))).toBe(s);

    const recovered = run([frame(at + 10)], D, { ...s, phase: 'connecting', attempt: 3 });
    expect(recovered.attempt).toBe(0);
  });

  it('backoff doubles and is capped', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n))).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });

  it('401/403 from the media server → DENIED, with no retry', () => {
    for (const status of [401, 403]) {
      const s = run([{ type: 'http', at: 800, from: 'media', status }]);
      expect(s.phase).toBe('denied');
      expect(s.reason).toBe('refused');
      expect(s.retryAt).toBeNull();
      expect(videoStep(s, tick(60_000))).toBe(s);
    }
  });

  it('403 from the platform → DENIED; 401 (signed out) → EXPIRED', () => {
    expect(run([{ type: 'http', at: 100, from: 'platform', status: 403, detail: 'Your role cannot view video.' }])).toMatchObject({ phase: 'denied', detail: 'Your role cannot view video.' });
    expect(run([{ type: 'http', at: 100, from: 'platform', status: 401 }])).toMatchObject({ phase: 'expired', reason: 'signed_out' });
  });

  it('other server errors are retried', () => {
    const s = run([{ type: 'http', at: 100, from: 'media', status: 404 }]);
    expect(s).toMatchObject({ phase: 'reconnecting', reason: 'server_error', detail: '404' });
  });

  it('"Try again" starts over from OFFLINE, DENIED or EXPIRED', () => {
    for (const phase of ['offline', 'denied', 'expired'] as const) {
      const s: VideoState = { ...initialVideoState(0), phase, attempt: 6 };
      expect(videoStep(s, { type: 'retry', at: 9000 })).toMatchObject({ phase: 'connecting', attempt: 0, session: 2, since: 9000 });
    }
    expect(videoStep(live(), { type: 'retry', at: 2000 }).phase).toBe('live');
  });

  it('pause releases the link; resume starts a fresh session', () => {
    const p = run([{ type: 'pause', at: 3000 }], D, live());
    expect(p.phase).toBe('paused');
    expect(wantsConnection(p.phase)).toBe(false);
    expect(run([tick(60_000)], D, p)).toBe(p);
    const r = run([{ type: 'resume', at: 70_000 }], D, p);
    expect(r).toMatchObject({ phase: 'connecting', attempt: 0, session: p.session + 1 });
    // A refused stream keeps its message when hidden.
    const denied = run([{ type: 'http', at: 1, from: 'media', status: 403 }]);
    expect(run([{ type: 'pause', at: 2 }], D, denied)).toBe(denied);
  });

  it('returns the same object when nothing changes', () => {
    const s = live();
    expect(videoStep(s, tick(1500))).toBe(s);
    expect(videoStep(s, ice(1500, 'connected'))).toBe(s);
  });
});

describe('frame detection', () => {
  it('needs a previous reading', () => {
    expect(framesAdvanced(null, { presented: 5 })).toBe(false);
  });

  it('counts presented or decoded frames', () => {
    expect(framesAdvanced({ presented: 4, decoded: 10 }, { presented: 5, decoded: 10 })).toBe(true);
    // Background tab: nothing painted, frames still decoded.
    expect(framesAdvanced({ presented: 4, decoded: 10 }, { presented: 4, decoded: 12 })).toBe(true);
    expect(framesAdvanced({ presented: 4, decoded: 10 }, { presented: 4, decoded: 10 })).toBe(false);
  });

  it('trusts frame counters over the media clock', () => {
    expect(framesAdvanced({ decoded: 10, mediaTime: 1 }, { decoded: 10, mediaTime: 2 })).toBe(false);
  });

  it('falls back to the media clock when no counter is available', () => {
    expect(framesAdvanced({ mediaTime: 1 }, { mediaTime: 1.2 })).toBe(true);
    expect(framesAdvanced({ mediaTime: 1 }, { mediaTime: 1 })).toBe(false);
  });
});

describe('feed badge', () => {
  it('only LIVE says LIVE', () => {
    const phases = ['connecting', 'live', 'stalled', 'reconnecting', 'offline', 'denied', 'expired', 'paused'] as const;
    for (const phase of phases) {
      for (const attempt of [0, 2]) {
        const b = videoBadge({ phase, attempt });
        expect(b.live).toBe(phase === 'live');
        expect(b.tag === 'LIVE').toBe(phase === 'live');
      }
    }
  });

  it('marks the picture as old when it is', () => {
    expect(videoBadge({ phase: 'stalled', attempt: 0 })).toMatchObject({ tag: 'DELAYED', frozen: 'delayed' });
    expect(videoBadge({ phase: 'reconnecting', attempt: 1 })).toMatchObject({ tag: 'RECONNECTING', frozen: 'no_signal' });
    expect(videoBadge({ phase: 'connecting', attempt: 1 })).toMatchObject({ tag: 'RECONNECTING', frozen: 'no_signal' });
    expect(videoBadge({ phase: 'offline', attempt: 6 })).toMatchObject({ tag: 'OFFLINE', frozen: 'no_signal' });
    expect(videoBadge({ phase: 'connecting', attempt: 0 })).toMatchObject({ tag: 'CONNECTING', frozen: null });
  });

  it('never shows LIVE on a frame older than the threshold (random event sequences)', () => {
    // Small deterministic generator so failures reproduce.
    let seed = 42;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const ices = ['checking', 'connected', 'disconnected', 'failed'] as const;
    let checked = 0;
    for (let trial = 0; trial < 200; trial++) {
      let s = initialVideoState(0);
      let at = 0;
      for (let i = 0; i < 300; i++) {
        at += Math.floor(rand() * 900);
        const r = rand();
        const e: VideoEvent =
          r < 0.45 ? frame(at) : r < 0.5 ? ice(at, ices[Math.floor(rand() * ices.length)]) : r < 0.52 ? { type: 'error', at } : r < 0.53 ? { type: 'http', at, from: 'media', status: 503 } : tick(at);
        s = videoStep(s, e);
        if (e.type === 'tick' && videoBadge(s).live) {
          checked++;
          expect(at - s.lastFrameAt!).toBeLessThanOrEqual(D.liveWithinMs);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
