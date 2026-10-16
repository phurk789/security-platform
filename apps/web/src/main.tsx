import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LoginResponse, Meta, SessionUser } from '@13store/shared';
import { App } from './App';
import { Api, loadToken, saveToken } from './api';
import { RemoteProvider } from './remote';
import { StandaloneProvider } from './store';
import { Login } from './views/Login';
import { LangProvider, tr } from './i18n';
import './styles.css';

type Phase = { k: 'checking' } | { k: 'login'; meta: Meta | null; error?: string } | { k: 'ready'; meta: Meta; user: SessionUser } | { k: 'standalone' };

function Root() {
  const api = useMemo(() => new Api(), []);
  const [phase, setPhase] = useState<Phase>(__STANDALONE__ ? { k: 'standalone' } : { k: 'checking' });

  useEffect(() => {
    if (__STANDALONE__) return;
    (async () => {
      let meta: Meta;
      try {
        meta = await api.get<Meta>('/meta');
      } catch {
        setPhase({ k: 'login', meta: null });
        return;
      }
      const token = loadToken();
      if (token) {
        api.token = token;
        try {
          const me = await api.get<{ user?: SessionUser }>('/auth/me');
          if (me.user) return setPhase({ k: 'ready', meta, user: me.user });
        } catch {
          /* expired */
        }
        saveToken('');
        api.token = '';
      }
      setPhase({ k: 'login', meta });
    })();
  }, [api]);

  const login = useCallback(
    async (username: string, password: string, meta: Meta) => {
      const r = await api.post<LoginResponse>('/auth/login', { username, password });
      api.token = r.token;
      saveToken(r.token);
      setPhase({ k: 'ready', meta, user: r.user });
    },
    [api],
  );

  const logout = useCallback(() => {
    const meta = phase.k === 'ready' ? phase.meta : null;
    api.post('/auth/logout').catch(() => {});
    api.token = '';
    api.replay = false;
    saveToken('');
    setPhase({ k: 'login', meta });
  }, [api, phase]);

  if (phase.k === 'checking') return <div className="login"><p className="muted">{tr('Connecting…')}</p></div>;
  if (phase.k === 'standalone')
    return (
      <StandaloneProvider>
        <App />
      </StandaloneProvider>
    );
  if (phase.k === 'login') return <Login meta={phase.meta} error={phase.error} onLogin={(u, p) => login(u, p, phase.meta!)} onOffline={() => setPhase({ k: 'standalone' })} />;

  if (phase.user.role === 'responder') {
    return (
      <div className="login">
        <div className="login-card">
          <h2>{tr('Hello {name}', { name: phase.user.name })}</h2>
          <p className="muted">{tr('Field responders use the mobile field app.')}</p>
          <a className="btn-primary wide big" href="/field/">{tr('Open the field app')}</a>
          <button className="btn-ghost small" onClick={logout}>{tr('Sign out')}</button>
        </div>
      </div>
    );
  }

  return (
    <RemoteProvider
      key={phase.user.id}
      api={api}
      user={phase.user}
      meta={phase.meta}
      onLogout={logout}
      onSwitch={async (username) => {
        await api.post('/auth/logout').catch(() => {});
        await login(username, 'demo1234', phase.meta);
      }}
    >
      <App />
    </RemoteProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LangProvider>
      <Root />
    </LangProvider>
  </StrictMode>,
);
