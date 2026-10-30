// The site's route library on the server: fetched once per site, shared by the map panel and the
// mission and patrol forms, and fetched again after a route is saved or removed.
import { useEffect, useSyncExternalStore } from 'react';
import type { SavedRoute } from '@13store/shared';
import type { Api } from '../api';

const EMPTY: SavedRoute[] = [];
let cache: { key: string; routes: SavedRoute[] } | null = null;
let loading: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

async function load(api: Api, siteId: string | undefined, force = false) {
  const key = siteId ?? '';
  if (!force && (cache?.key === key || loading === key)) return;
  loading = key;
  try {
    const routes = await api.get<SavedRoute[]>(siteId ? `/saved-routes?siteId=${encodeURIComponent(siteId)}` : '/saved-routes');
    cache = { key, routes };
  } catch {
    // Without the right (or a server that predates the library) the forms simply offer none.
    cache = { key, routes: [] };
  } finally {
    loading = null;
    emit();
  }
}

export const savedRoutes = {
  refresh: (api: Api, siteId: string | undefined) => load(api, siteId, true),
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

/** The current site's saved routes ([] without a server or before they arrive). */
export function useSavedRoutes(api: Api | undefined, siteId: string | undefined): SavedRoute[] {
  const snap = useSyncExternalStore(
    savedRoutes.subscribe,
    () => cache,
    () => cache,
  );
  useEffect(() => {
    if (api) void load(api, siteId);
  }, [api, siteId]);
  return snap && snap.key === (siteId ?? '') ? snap.routes : EMPTY;
}
