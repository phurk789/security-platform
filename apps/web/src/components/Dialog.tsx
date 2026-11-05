import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useT } from '../i18n';

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass a new onClose on every render, and the console re-renders with each telemetry
  // sample. Keep the latest one in a ref so the effects below run once, when the dialog opens:
  // re-running them moved the focus back every second, so typing was lost and Enter closed it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => {
    // The first field to fill in (a password, a reason), else the first button below the title.
    const root = ref.current;
    const field = root?.querySelector<HTMLElement>('textarea, select, input') ?? root?.querySelector<HTMLElement>(':scope > :not(header) button');
    field?.focus();
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')}><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Asks for a mandatory reason (dismiss, merge, reject — PRD F03, UXUI S02). */
export function ReasonDialog({
  title,
  hint,
  confirmLabel,
  onConfirm,
  onClose,
  extra,
  danger,
}: {
  title: string;
  hint: string;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  extra?: ReactNode;
  danger?: boolean;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  return (
    <Dialog title={title} onClose={onClose}>
      {extra}
      <label className="field">
        <span>{t('Reason (required)')}</span>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={hint} />
      </label>
      <footer>
        <button className="btn-secondary" onClick={onClose}>{t('Cancel')}</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={!reason.trim()} onClick={() => onConfirm(reason)}>
          {confirmLabel}
        </button>
      </footer>
    </Dialog>
  );
}
