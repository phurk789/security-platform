// Camera director for the overview twin: the booth script asks for a shot (home, a point, follow
// a vehicle, slow idle orbit) and the 3D view glides there. Any hand on the mouse or touch screen
// takes precedence for a while, so a visitor exploring is never fought by the script.
import { useSyncExternalStore } from 'react';
import type { Point } from '@13store/shared';

export type Shot = { kind: 'home' } | { kind: 'point'; p: Point; dist: number } | { kind: 'follow'; id: string; dist: number } | { kind: 'idle' };

interface DirectorState {
  shot: Shot;
  seq: number;
  /** Hands-off until this time (ms) after the user moved the camera. */
  userUntil: number;
}

let state: DirectorState = { shot: { kind: 'home' }, seq: 0, userUntil: 0 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const USER_HOLD_MS = 25_000;

export const director = {
  /** Ask for a shot. Ignored while the user is in control (unless `force`). */
  cut(shot: Shot, force = false) {
    if (!force && Date.now() < state.userUntil) return;
    state = { ...state, shot, seq: state.seq + 1 };
    emit();
  },
  /** The user touched the camera: hold off scripted moves for a while. */
  userMoved() {
    state = { ...state, userUntil: Date.now() + USER_HOLD_MS };
    emit();
  },
  /** Scripted camera back in charge now (e.g. the loop restarts). */
  release() {
    state = { ...state, userUntil: 0 };
    emit();
  },
  get(): DirectorState {
    return state;
  },
};

export function useDirector() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => state,
    () => state,
  );
}
