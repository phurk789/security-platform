// This computer's camera (laptop webcam or a USB camera) shown as a device's feed: a real, live
// picture with no infrastructure, for booths and bench tests. The browser asks for permission once.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { acquireLocalCamera, releaseLocalCamera } from '../media/feeds';

type State = 'connecting' | 'playing' | 'denied' | 'unavailable';

export function LocalCameraFeed({ onState }: { onState?: (s: State) => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>('connecting');
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    let live = true;
    let held = false;
    acquireLocalCamera()
      .then((stream) => {
        held = true;
        if (!live) return;
        if (video.current) video.current.srcObject = stream;
        setState('playing');
        onStateRef.current?.('playing');
      })
      .catch((e: unknown) => {
        if (!live) return;
        const name = (e as { name?: string })?.name;
        const s: State = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable';
        setState(s);
        onStateRef.current?.(s);
      });
    return () => {
      live = false;
      if (held) releaseLocalCamera();
    };
  }, []);

  return (
    <>
      <video ref={video} className="whep local" autoPlay muted playsInline />
      {state !== 'playing' && (
        <div className="whep-msg">
          {state === 'connecting'
            ? t('Connecting to the camera…')
            : state === 'denied'
              ? t('Camera permission was refused. Allow the camera for this site and choose the source again.')
              : t('No camera is available in this view. Open the demo in a browser tab (HTTPS or localhost) with a camera attached.')}
        </div>
      )}
    </>
  );
}
