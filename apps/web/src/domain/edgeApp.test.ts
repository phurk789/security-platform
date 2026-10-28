import { describe, expect, it } from 'vitest';
import { EDGE_APP_PACKAGE } from '@13store/shared';
import { fmtMB, publishQuery, readBuildManifest, uploadProblem } from './edgeApp';

const SHA = 'a'.repeat(64);
const manifest = { packageName: EDGE_APP_PACKAGE, versionCode: 3, versionName: '0.3.0', sha256: SHA, size: 21_000_000 };

describe('Edge app updates (Admin card)', () => {
  it('reads the manifest build-apk.sh writes, extra fields included', () => {
    expect(readBuildManifest(JSON.stringify({ ...manifest, sha256: SHA.toUpperCase(), abis: 'arm64-v8a', builtAt: '2026-10-28T09:00:00Z' }))).toEqual(manifest);
  });

  it('says what is wrong with something that is not that manifest', () => {
    expect(readBuildManifest('PK\u0003\u0004…')).toHaveProperty('error');
    expect((readBuildManifest(JSON.stringify({ ...manifest, packageName: 'com.example' })) as { error: string }).error).toMatch(/not the edge app/);
    for (const k of ['versionCode', 'versionName', 'sha256', 'size'] as const) {
      const { [k]: _drop, ...rest } = manifest;
      expect((readBuildManifest(JSON.stringify(rest)) as { error: string }).error).toMatch(new RegExp(k));
    }
  });

  it('catches an APK and a manifest from different builds, or a build that is not newer', () => {
    expect(uploadProblem(manifest, { name: '13store-edge-0.3.0.apk', size: 21_000_000 }, null)).toBeNull();
    expect(uploadProblem(manifest, { name: '13store-edge-0.3.0.json', size: 21_000_000 }, null)).toMatch(/\.apk/);
    expect(uploadProblem(manifest, { name: '13store-edge-0.2.0.apk', size: 20_000_000 }, null)).toMatch(/same build/);
    const published = { ...manifest, versionCode: 3, versionName: '0.3.0' };
    expect(uploadProblem(manifest, { name: 'x.apk', size: 21_000_000 }, published)).toMatch(/not newer/);
    expect(uploadProblem({ ...manifest, versionCode: 4 }, { name: 'x.apk', size: 21_000_000 }, published)).toBeNull();
  });

  it('sends the manifest fields the server checks', () => {
    expect(Object.fromEntries(new URLSearchParams(publishQuery(manifest)))).toEqual({ packageName: EDGE_APP_PACKAGE, versionCode: '3', versionName: '0.3.0', sha256: SHA });
    expect(fmtMB(21_500_000)).toBe('20.5 MB');
  });
});
