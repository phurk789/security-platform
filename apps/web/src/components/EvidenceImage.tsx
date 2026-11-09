// Evidence images on screen. Every fetch of an evidence file is an "evidence.view" in the audit
// log, so an image is fetched only once it scrolls into view, then kept for the rest of the
// sign-in session (the most recent ones) and shown from memory when it comes back. A new sign-in
// (another user at the same screen) fetches again, so each user's views are logged.
import { useEffect, useRef, useState } from 'react';
import { ImageOff, Lock } from 'lucide-react';
import type { Api } from '../api';
import { can, currentUser } from '../domain/policy';
import { useStore } from '../store';
import { useT } from '../i18n';

interface Loaded {
  url: string;
  /** The server re-checked the file against its stored checksum. */
  intact: boolean;
}

/** Images kept in memory; the oldest beyond this are let go. */
const KEEP = 120;
const cache = new Map<string, Promise<Loaded>>();

function load(api: Api, id: string): Promise<Loaded> {
  const key = `${api.token}|${id}`;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used last, so the oldest go first.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = api.raw('GET', `/evidence/${encodeURIComponent(id)}/content`).then(async (res) => ({
    intact: res.headers.get('x-integrity') !== 'mismatch',
    url: URL.createObjectURL(await res.blob()),
  }));
  // A failed fetch is tried again next time.
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > KEEP) {
    const [old, gone] = cache.entries().next().value as [string, Promise<Loaded>];
    cache.delete(old);
    gone.then((l) => URL.revokeObjectURL(l.url)).catch(() => {});
  }
  return p;
}

export interface EvidenceImageState {
  url?: string;
  intact?: boolean;
  failed?: string;
  /** This viewer may not see evidence files, or there is no server (offline demo). */
  unavailable?: 'denied' | 'offline';
}

/** The image of an evidence file, fetched when `want` turns true. */
export function useEvidenceImage(id: string | undefined, want: boolean): EvidenceImageState {
  const { s, session } = useStore();
  const allowed = can(currentUser(s).role, 'evidence.view');
  const [state, setState] = useState<EvidenceImageState & { id?: string }>({});
  useEffect(() => {
    if (!id || !want || !session || !allowed) return;
    let live = true;
    load(session.api, id).then(
      (l) => live && setState({ id, ...l }),
      (e) => live && setState({ id, failed: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [id, want, session, allowed]);
  if (!session) return { unavailable: 'offline' };
  if (!allowed) return { unavailable: 'denied' };
  return state.id === id ? state : {};
}

/** True once the element has come near the screen (it stays true). */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') return setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

/** An evidence image in a frame that keeps its shape while it loads, fails or may not be shown. */
export function EvidenceImage({ id, alt, className = '', eager = false }: { id: string; alt: string; className?: string; eager?: boolean }) {
  const t = useT();
  const [ref, seen] = useSeen<HTMLDivElement>();
  const img = useEvidenceImage(id, eager || seen);
  let body: React.ReactNode;
  if (img.url) body = <img src={img.url} alt={alt} draggable={false} />;
  else if (img.unavailable === 'denied')
    body = (
      <span className="evd-img-note" title={t('You may not view evidence files.')}>
        <Lock size={16} />
      </span>
    );
  else if (img.failed || img.unavailable)
    body = (
      <span className="evd-img-note" title={img.failed ?? t('Image could not be loaded')}>
        <ImageOff size={16} />
      </span>
    );
  else body = <span className="evd-img-wait" aria-label={t('Loading image…')} />;
  return (
    <div ref={ref} className={`evd-img ${className}`}>
      {body}
    </div>
  );
}
