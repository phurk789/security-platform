import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ApiError, type Api } from '../api';
import { Dialog } from './Dialog';
import { useT } from '../i18n';

/** Risk-based re-authentication before approve, export, handover and admin actions (PRD §8). */
export function StepUpDialog({ api, onDone, onClose }: { api: Api; onDone: () => void; onClose: () => void }) {
  const t = useT();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={t("Confirm it's you")} onClose={onClose}>
      <p className="muted">{t('This action needs your password again. It stays confirmed for 15 minutes.')}</p>
      <form
        className="field"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            await api.post('/auth/step-up', { password: pw });
            onDone();
          } catch (x) {
            setErr(x instanceof ApiError ? x.message : t('Could not confirm.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <span>{t('Password')}</span>
        <input id="stepup-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <small className="warn-text">{err}</small>}
        <footer className="row gap-s" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn-secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn-primary" disabled={!pw || busy}><ShieldCheck size={16} /> {t('Confirm')}</button>
        </footer>
      </form>
    </Dialog>
  );
}
