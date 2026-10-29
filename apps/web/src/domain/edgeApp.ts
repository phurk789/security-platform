// Admin → "Edge app updates": read the build manifest that apps/edge-android/tools/build-apk.sh writes next to the
// APK (13store-edge-<version>.json) and check it belongs to the chosen APK before uploading. The server checks the
// SHA-256 of what arrives; these checks only catch a wrong pair of files early, with a clear message.
import { EDGE_APP_PACKAGE, type EdgeAppRelease } from '@13store/shared';

export type BuildManifest = Pick<EdgeAppRelease, 'packageName' | 'versionCode' | 'versionName' | 'sha256' | 'size'>;

export function readBuildManifest(text: string): BuildManifest | { error: string } {
  let m: Partial<BuildManifest>;
  try {
    m = JSON.parse(text);
  } catch {
    return { error: 'not a JSON file: choose the .json that build-apk.sh wrote next to the APK' };
  }
  if (!m || typeof m !== 'object') return { error: 'not a build manifest' };
  if (m.packageName !== EDGE_APP_PACKAGE) return { error: `not the edge app's manifest (package ${String(m.packageName)})` };
  if (!Number.isInteger(m.versionCode) || (m.versionCode as number) < 1) return { error: 'versionCode is missing' };
  if (typeof m.versionName !== 'string' || !m.versionName) return { error: 'versionName is missing' };
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) return { error: 'sha256 is missing' };
  if (!Number.isInteger(m.size) || (m.size as number) <= 0) return { error: 'size is missing' };
  return { packageName: m.packageName, versionCode: m.versionCode!, versionName: m.versionName, sha256: m.sha256.toLowerCase(), size: m.size! };
}

/** Why this APK and manifest should not be uploaded together, or null when they fit (and are newer). */
export function uploadProblem(m: BuildManifest, apk: { name: string; size: number }, published: EdgeAppRelease | null): string | null {
  if (!/\.apk$/i.test(apk.name)) return 'choose the .apk file';
  if (apk.size !== m.size) return `the APK (${apk.size} bytes) is not the one in the manifest (${m.size} bytes): use files of the same build`;
  if (published && m.versionCode <= published.versionCode)
    return `version ${m.versionName} (${m.versionCode}) is not newer than the published ${published.versionName} (${published.versionCode})`;
  return null;
}

/** Query string the server expects with the APK body. */
export function publishQuery(m: BuildManifest) {
  return new URLSearchParams({ packageName: m.packageName, versionCode: String(m.versionCode), versionName: m.versionName, sha256: m.sha256 }).toString();
}

export function fmtMB(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
