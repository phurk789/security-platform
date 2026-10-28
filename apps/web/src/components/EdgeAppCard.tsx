// Admin → "Edge app updates": publish a new build of the edge Android app. Paired remotes find it with their
// gateway key ("Check for updates" in the app) and install it after the person on site confirms.
import { useCallback, useEffect, useState } from 'react';
import { PackageCheck, Upload } from 'lucide-react';
import { fmtDate, fmtTime, type EdgeAppRelease } from '@13store/shared';
import type { Api } from '../api';
import { useT } from '../i18n';
import { fmtMB, publishQuery, readBuildManifest, uploadProblem, type BuildManifest } from '../domain/edgeApp';

export function EdgeAppCard({ api, act, reloadKey }: { api: Api; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; reloadKey: number }) {
  const t = useT();
  const [release, setRelease] = useState<EdgeAppRelease | null>(null);
  const [apk, setApk] = useState<File | null>(null);
  const [manifest, setManifest] = useState<BuildManifest | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<{ release: EdgeAppRelease | null }>('/admin/edge-app').then((r) => setRelease(r.release)), [api]);
  useEffect(() => {
    load().catch(() => {});
  }, [load, reloadKey]);

  useEffect(() => {
    setProblem(manifest && apk ? uploadProblem(manifest, apk, release) : null);
  }, [manifest, apk, release]);

  const pickManifest = async (f: File | undefined) => {
    setManifest(null);
    if (!f) return;
    const m = readBuildManifest(await f.text());
    if ('error' in m) setProblem(t('Manifest: {error}', { error: m.error }));
    else setManifest(m);
  };

  const publish = () =>
    act(async () => {
      if (!apk || !manifest) return;
      setBusy(true);
      try {
        await api.upload(`/admin/edge-app?${publishQuery(manifest)}`, apk, 'application/vnd.android.package-archive');
        setApk(null);
        setManifest(null);
        await load();
      } finally {
        setBusy(false);
      }
    }, t('Version {v} published. Remotes get it from "Check for updates" in the app.', { v: manifest?.versionName ?? '' }));

  return (
    <section className="card">
      <h3>
        <PackageCheck size={16} /> {t('Edge app updates')}
      </h3>
      <p className="fine" style={{ marginTop: 0 }}>
        {t(
          'Publish a new build of the 13STORE Edge app: choose the .apk and the .json that build-apk.sh wrote next to it. Paired remotes see it under "Check for updates" and install it after the person on site confirms. The app keeps its pairing.',
        )}
      </p>
      {release ? (
        <ul className="list">
          <li>
            <span>
              <b>{release.versionName}</b>{' '}
              <small className="muted">
                {t('version code {n}', { n: release.versionCode })} · {fmtMB(release.size)} · {release.publishedAt ? `${fmtDate(release.publishedAt)} ${fmtTime(release.publishedAt)}` : ''} · {release.publishedBy}
              </small>
            </span>
            <button className="btn-ghost small" onClick={() => act(() => api.del('/admin/edge-app').then(load), t('Update withdrawn.'))}>
              {t('Withdraw')}
            </button>
          </li>
        </ul>
      ) : (
        <p className="muted">{t('No app update published.')}</p>
      )}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void publish();
        }}
      >
        <label className="check">
          APK <input id="app-apk" type="file" accept=".apk,application/vnd.android.package-archive" onChange={(e) => setApk(e.target.files?.[0] ?? null)} />
        </label>
        <label className="check">
          {t('Manifest')} <input id="app-manifest" type="file" accept=".json,application/json" onChange={(e) => void pickManifest(e.target.files?.[0])} />
        </label>
        <button className="btn-primary" disabled={!apk || !manifest || !!problem || busy}>
          <Upload size={16} /> {busy ? t('Uploading…') : manifest ? t('Publish {v}', { v: manifest.versionName }) : t('Publish')}
        </button>
      </form>
      {problem && <p className="fine warn-text">{problem}</p>}
    </section>
  );
}
