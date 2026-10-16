import { createContext, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from 'react';
import { makeInitialState, reducer, type Msg } from './domain/reducer';
import type { AppState } from '@13store/shared';

const Ctx = createContext<{ s: AppState; dispatch: Dispatch<Msg> } | null>(null);

const TICK_MS = 250;

export function StoreProvider({ children }: { children: ReactNode }) {
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

  // Auto-dismiss toasts.
  // Keyed on the oldest toast id: state is cloned every tick, so the array itself always changes.
  const firstToast = s.toasts[0]?.id;
  useEffect(() => {
    if (!firstToast) return;
    const t = window.setTimeout(() => dispatch({ type: 'dismissToast', id: firstToast }), 5000);
    return () => window.clearTimeout(t);
  }, [firstToast]);

  // SHA-256 for evidence integrity display (checksum ≠ legal admissibility, PRD §8).
  const missingKey = s.evidence.filter((e) => !e.checksum).map((e) => e.id).join(',');
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

  return <Ctx.Provider value={{ s, dispatch }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore outside provider');
  return v;
}
