import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    ref.current?.querySelector<HTMLElement>('textarea, select, input, button')?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
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
  const [reason, setReason] = useState('');
  return (
    <Dialog title={title} onClose={onClose}>
      {extra}
      <label className="field">
        <span>Reason (required)</span>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={hint} />
      </label>
      <footer>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={!reason.trim()} onClick={() => onConfirm(reason)}>
          {confirmLabel}
        </button>
      </footer>
    </Dialog>
  );
}
