import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import type { AppState, CameraAction, Meta, Point, SessionUser } from '@13store/shared';
import { makeInitialState, reducer, type Msg } from './domain/reducer';
import type { Api } from './api';

/** Extra capabilities available when connected to a platform server. */
export interface Session {
  api: Api;
  user: SessionUser;
  meta: Meta;
  logout(): void;
  /** Demo environment only: sign in as another seeded user (role switch at the booth). */
  switchUser?(username: string): Promise<void>;
  demoUsers: { username: string; name: string; role: string }[];
  /** Open (or download, if allowed) an evidence file. */
  openEvidence(id: string, download?: boolean): Promise<void>;
  /** Ask the media gateway for a signed stream URL. Rejects if the role cannot view video. */
  mediaUrl(deviceId: string): Promise<string>;
  /** Full media session: signed frame URL, plus WebRTC (WHEP) / HLS links for real devices. */
  mediaSession(deviceId: string): Promise<MediaSession>;
  /** Gimbal camera control (pan/tilt, zoom, photo, record). Never throws; failures come back in the result. */
  cameraControl(deviceId: string, action: CameraAction): Promise<CameraResult>;
  /** Point a gimbal camera at an incident or a site position. */
  aimCamera(deviceId: string, target: { incidentId: string } | Point): Promise<CameraResult>;
  /** Recorded video coverage for a camera between two times. */
  recordings(deviceId: string, from: number, to: number): Promise<Recordings>;
  /** A playable link for a stretch of recording (MP4 from the media server, or a storyboard for simulated cameras). */
  clip(deviceId: string, start: number, durationS: number): Promise<ClipLink>;
  /** Save a stretch of recording to the incident as evidence. */
  saveClip(incidentId: string, deviceId: string, start: number, durationS: number): Promise<void>;
  reload(): Promise<void>;
}

export interface Recordings {
  label: 'RECORDED' | 'SIMULATED';
  segments: { start: number; end: number }[];
  playback: boolean;
}

export interface ClipLink {
  url: string;
  mime: string;
  label: 'RECORDED' | 'SIMULATED';
  expiresAt: number;
}

export interface MediaSession {
  url: string;
  expiresAt: number;
  label: 'SIMULATED' | 'LIVE';
  whep?: string;
  hls?: string;
  whepSub?: string;
  hlsSub?: string;
}

export interface CameraResult {
  ok: boolean;
  /** True only when the camera itself answered. */
  confirmed: boolean;
  detail: string;
}

export interface StoreValue {
  s: AppState;
  dispatch: (m: Msg) => void;
  mode: 'standalone' | 'remote';
  session?: Session;
}

export const StoreCtx = createContext<StoreValue | null>(null);

const TICK_MS = 250;

/** Offline demo: the whole scenario runs in the browser (booth fallback, UXUI §9). */
export function StandaloneProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reducer, undefined, makeInitialState);

  useEffect(() => {
    let last = performance.now();
    const t = window.setInterval(() => {
      const now = performance.now();
      dispatch({ type: 'tick', dt: Math.min(1000, Math.round(now - last)) });
      last = now;
    }, TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  useToastTimer(s, dispatch);

  // SHA-256 for evidence integrity display (checksum ≠ legal admissibility, PRD §8).
  const missingKey = s.evidence
    .filter((e) => !e.checksum)
    .map((e) => e.id)
    .join(',');
  useEffect(() => {
    const missing = s.evidence.filter((e) => !e.checksum);
    if (!missing.length || !crypto?.subtle) return;
    for (const e of missing) {
      const payload = new TextEncoder().encode(`${e.id}|${e.source}|${e.capturedAt}|${e.title}`);
      crypto.subtle.digest('SHA-256', payload).then((buf) => {
        const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
        dispatch({ type: 'setChecksum', evidenceId: e.id, checksum: hex });
      });
    }
  }, [missingKey]);

  return <StoreCtx.Provider value={{ s, dispatch, mode: 'standalone' }}>{children}</StoreCtx.Provider>;
}

/** Auto-dismiss the oldest toast. Keyed on its id because state is replaced every tick. */
export function useToastTimer(s: AppState, dispatch: (m: Msg) => void) {
  const firstToast = s.toasts[0]?.id;
  useEffect(() => {
    if (!firstToast) return;
    const t = window.setTimeout(() => dispatch({ type: 'dismissToast', id: firstToast }), 5000);
    return () => window.clearTimeout(t);
  }, [firstToast]);
}

export function useStore() {
  const v = useContext(StoreCtx);
  if (!v) throw new Error('useStore outside provider');
  return v;
}
