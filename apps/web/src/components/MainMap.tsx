// The overview's map: the real map (MapLibre) when connected to a server, the drawn twin in the
// offline demo (no internet for imagery there). The real map is loaded on demand, and left out of
// the offline single-file build altogether.
import { Suspense, lazy } from 'react';
import { useStore } from '../store';
import { useT } from '../i18n';
import { TwinMap } from './TwinMap';

const RealMap = __STANDALONE__ ? null : lazy(() => import('./RealMap'));

/** `follow`: keep this device centred (real map only; the drawn site map shows the whole site). */
export function MainMap({ follow }: { follow?: string } = {}) {
  const { mode } = useStore();
  const t = useT();
  if (!RealMap || mode !== 'remote') return <TwinMap />;
  return (
    <Suspense fallback={<div className="map map-real map-loading">{t('Loading map…')}</div>}>
      <RealMap follow={follow} />
    </Suspense>
  );
}
