// Live video from the site media server over WebRTC (WHEP, as served by MediaMTX).
// The link carries a 60-second token that the media server checks with the platform, so each
// (re)connect asks the platform for a fresh link. Never shows a stale frame as live.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

type State = 'connecting' | 'playing' | 'failed';

export function WhepVideo({ getUrl, onState }: { getUrl: () => Promise<string>; onState?: (s: State) => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>('connecting');
  const [why, setWhy] = useState('');
  const getUrlRef = useRef(getUrl);
  getUrlRef.current = getUrl;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let resource: string | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const set = (s: State, w = '') => {
      if (stopped) return;
      setState(s);
      setWhy(w);
      onStateRef.current?.(s);
    };

    const close = () => {
      pc?.close();
      pc = null;
      if (resource) void fetch(resource, { method: 'DELETE' }).catch(() => {});
      resource = null;
    };

    const again = (w: string) => {
      clearTimeout(retry);
      close();
      set('failed', w);
      if (stopped) return;
      attempt++;
      retry = setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)));
    };

    async function connect() {
      if (stopped) return;
      set('connecting');
      try {
        const url = await getUrlRef.current();
        pc = new RTCPeerConnection();
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.ontrack = (e) => {
          if (video.current && e.streams[0]) video.current.srcObject = e.streams[0];
        };
        pc.onconnectionstatechange = () => {
          const st = pc?.connectionState;
          if (st === 'connected') {
            attempt = 0;
            set('playing');
          } else if (st === 'failed' || st === 'disconnected') again(t('Video link lost. Reconnecting…'));
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await gatherIce(pc, 2000);
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription!.sdp });
        if (res.status === 401 || res.status === 403) return again(t('The media server refused this link.'));
        if (!res.ok) return again(t('Media server error {code}.', { code: res.status }));
        const loc = res.headers.get('Location');
        resource = loc ? new URL(loc, url).toString() : null;
        await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      } catch (e) {
        again(e instanceof Error ? e.message : String(e));
      }
    }

    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      close();
    };
  }, [t]);

  return (
    <>
      <video ref={video} className="whep" autoPlay muted playsInline />
      {state !== 'playing' && <div className="whep-msg">{state === 'connecting' ? t('Connecting to live video…') : why || t('Video unavailable.')}</div>}
    </>
  );
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
