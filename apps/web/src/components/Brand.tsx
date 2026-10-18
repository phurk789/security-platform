// Product brand: the 13 Enterprise mark, the 13STORE wordmark and the product name.
import markUrl from '../assets/13e-mark.png';
import logoUrl from '../assets/13e-logo.png';

export function BrandMark({ size = 34 }: { size?: number }) {
  return <img className="brand-mark" src={markUrl} alt="13 Enterprise" width={Math.round(size * 0.95)} height={size} />;
}

/** Full 13 Enterprise logo (mark + ENTERPRISE), for the sign-in page and printouts. */
export function BrandLogo({ height = 96 }: { height?: number }) {
  return <img className="brand-logo" src={logoUrl} alt="13 Enterprise" height={height} style={{ width: 'auto' }} />;
}

/** Browser tab icon from the bundled mark (works in the single-file build too). */
export function installFavicon() {
  if (typeof document === 'undefined') return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
  link.type = 'image/png';
  link.href = markUrl;
}
