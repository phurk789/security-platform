// Presentation preferences only. Never changes the data source or device control mode.
import { useSyncExternalStore } from 'react';
import { Layers2 } from 'lucide-react';
import { useT } from '../i18n';

const KEY = 'ps-glass';
const listeners = new Set<() => void>();
function read(): boolean {
  try { return localStorage.getItem(KEY) !== 'solid'; } catch { return true; }
}
let enabled = read();
function apply() {
  if (typeof document !== 'undefined') document.documentElement.dataset.glass = enabled ? 'glass' : 'solid';
}
apply();
export function setGlassEnabled(value: boolean) {
  enabled = value;
  try { localStorage.setItem(KEY, value ? 'glass' : 'solid'); } catch { /* Session only. */ }
  apply();
  listeners.forEach((listener) => listener());
}
export function GlassToggle() {
  const t = useT();
  const on = useSyncExternalStore(
    (callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    () => enabled,
    () => true,
  );
  return (
    <button type="button" className="lg-glass-toggle" aria-pressed={on}
      aria-label={t('Glass effects')} title={t('Toggle glass effects. Use solid panels for higher readability.')}
      onClick={() => setGlassEnabled(!on)}>
      <Layers2 size={16} aria-hidden="true" /> <span>{on ? 'Glass' : t('Solid')}</span>
    </button>
  );
}
