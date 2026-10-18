import { useState } from 'react';
import { BrandLogo } from '../components/Brand';
import { KeyRound, LogIn, MonitorPlay, TriangleAlert } from 'lucide-react';
import type { Meta } from '@13store/shared';
import { ApiError } from '../api';
import { LangToggle, roleLabel, useT } from '../i18n';

export function Login({
  meta,
  onLogin,
  onOffline,
  error: initialError,
}: {
  meta: Meta | null;
  onLogin: (username: string, password: string) => Promise<void>;
  onOffline: () => void;
  error?: string;
}) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const [busy, setBusy] = useState(false);
  const demo = meta?.env === 'demo';

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-logo">
          <BrandLogo height={110} />
        </div>
        <div className="brand">
          <span className="product">PUBLIC SECURITY TWIN</span>
          <LangToggle className="login-lang" />
        </div>
        {meta ? (
          <span className={`mode ${meta.dataLabel === 'LIVE' ? 'mode-live' : 'mode-sim'}`}>
            <TriangleAlert size={14} /> {meta.dataLabel} · {t('{env} environment', { env: meta.env })}
          </span>
        ) : (
          <p className="banner warn">{t('The platform server cannot be reached.')}</p>
        )}
        {meta?.sso && (
          <a className="btn-primary wide big sso-btn" href={`${meta.sso.startUrl}?returnTo=${encodeURIComponent(location.pathname)}`}>
            <KeyRound size={18} /> {t('Sign in with {name}', { name: meta.sso.name })}
          </a>
        )}
        {meta?.sso && error && !username && <p className="warn-text">{error}</p>}
        {meta?.sso && <p className="muted login-or">{t('or with a local account')}</p>}
        {meta && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await onLogin(username.trim(), password);
              } catch (x) {
                setError(x instanceof ApiError ? x.message : t('Sign-in failed.'));
              } finally {
                setBusy(false);
              }
            }}
            className="login-form"
          >
            <label className="field">
              <span>{t('Username')}</span>
              <input id="login-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </label>
            <label className="field">
              <span>{t('Password')}</span>
              <input id="login-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <p className="warn-text">{error}</p>}
            <button className="btn-primary wide big" disabled={!username || !password || busy}>
              <LogIn size={18} /> {t('Sign in')}
            </button>
          </form>
        )}
        {demo && (
          <div className="demo-accounts">
            <p className="muted">
              {t('Demo accounts (password')} <code>demo1234</code>):
            </p>
            <div className="chips">
              {[
                ['alex', 'dispatcher'],
                ['nida', 'supervisor'],
                ['somchai', 'operator'],
                ['kitti', 'responder'],
                ['priya', 'auditor'],
                ['ploy', 'admin'],
              ].map(([u, r]) => (
                <button
                  key={u}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setUsername(u);
                    setPassword('demo1234');
                  }}
                >
                  <b>{u}</b> {roleLabel(r)}
                </button>
              ))}
            </div>
          </div>
        )}
        <button className="btn-ghost small" onClick={onOffline}>
          <MonitorPlay size={14} /> {t('Run the offline demo instead (no server, browser-only simulation)')}
        </button>
      </div>
    </div>
  );
}
