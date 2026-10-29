// In-app updates for the edge Android app (apps/edge-android). An administrator publishes an APK together with the
// manifest that tools/build-apk.sh writes next to it; paired edge apps ask for the latest release with their gateway
// key and download it. The file lives in DATA_DIR/edge-app (the data volume), so it survives redeploys.
// The server does not read the APK's binary manifest: version code and name come from the build manifest, and the
// SHA-256 of the bytes that arrived must match it. The app checks package, version and signing key before installing.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDGE_APP_PACKAGE, type EdgeAppRelease } from '@13store/shared';
import { ApiError, type Actor, type Platform } from './platform';

/** An APK larger than this is refused (today's build is about 21 MB). */
export const EDGE_APP_MAX_BYTES = 150 * 1024 * 1024;

export class EdgeAppStore {
  private dir: string;
  constructor(
    dataDir: string,
    private p: Platform,
  ) {
    this.dir = join(dataDir, 'edge-app');
  }

  private get apk() {
    return join(this.dir, 'app.apk');
  }
  private get meta() {
    return join(this.dir, 'app.json');
  }

  latest(): EdgeAppRelease | null {
    if (!existsSync(this.meta) || !existsSync(this.apk)) return null;
    try {
      return JSON.parse(readFileSync(this.meta, 'utf8')) as EdgeAppRelease;
    } catch {
      return null;
    }
  }

  /** Administrator view of what is published. */
  view(a: Actor) {
    this.p.require(a, 'admin.keys', 'edge_app', { mutating: false });
    return { release: this.latest() };
  }

  publish(a: Actor, q: Record<string, unknown>, body: unknown): EdgeAppRelease {
    this.p.require(a, 'admin.keys', 'edge_app');
    const versionCode = Number(q.versionCode);
    const versionName = String(q.versionName ?? '').trim();
    const sha256 = String(q.sha256 ?? '').trim().toLowerCase();
    const packageName = String(q.packageName ?? EDGE_APP_PACKAGE).trim();
    if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) throw new ApiError(400, 'invalid', 'versionCode must be a whole number (from the build manifest).');
    if (!/^[\w.+-]{1,40}$/.test(versionName)) throw new ApiError(400, 'invalid', 'versionName must be 1–40 letters, digits, dots or dashes, e.g. 0.2.0.');
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ApiError(400, 'invalid', 'sha256 must be the 64 hex digits from the build manifest.');
    if (packageName !== EDGE_APP_PACKAGE) throw new ApiError(400, 'invalid', `This is not the edge app (package ${packageName}, expected ${EDGE_APP_PACKAGE}).`);
    if (!Buffer.isBuffer(body) || !body.length) throw new ApiError(400, 'invalid', 'Send the APK file as the request body.');
    if (body.length > EDGE_APP_MAX_BYTES) throw new ApiError(413, 'invalid', 'The APK is too large.');
    if (body.readUInt32BE(0) !== 0x504b0304) throw new ApiError(400, 'invalid', 'This file is not an APK (not a zip archive).');
    const got = createHash('sha256').update(body).digest('hex');
    if (got !== sha256) throw new ApiError(400, 'invalid', 'The APK does not match its manifest (SHA-256 differs): upload the .apk and the .json of the same build.');
    const current = this.latest();
    if (current && versionCode <= current.versionCode)
      throw new ApiError(409, 'conflict', `Version ${versionName} (${versionCode}) is not newer than the published ${current.versionName} (${current.versionCode}): Android only installs newer builds.`);

    const release: EdgeAppRelease = { packageName, versionCode, versionName, sha256, size: body.length, publishedAt: this.p.now(), publishedBy: a.name };
    mkdirSync(this.dir, { recursive: true });
    // Write then rename: a download in progress keeps reading the old file, a new one gets the whole new file.
    writeFileSync(`${this.apk}.tmp`, body);
    renameSync(`${this.apk}.tmp`, this.apk);
    writeFileSync(`${this.meta}.tmp`, JSON.stringify(release, null, 2));
    renameSync(`${this.meta}.tmp`, this.meta);
    this.p.audit(a, 'edge.app_publish', `${packageName} ${versionName}`, 'ok', `versionCode ${versionCode} · ${body.length} bytes · sha256 ${sha256.slice(0, 16)}…`);
    return release;
  }

  unpublish(a: Actor) {
    this.p.require(a, 'admin.keys', 'edge_app');
    const r = this.latest();
    if (!r) throw new ApiError(404, 'not_found', 'No edge app is published.');
    rmSync(this.meta, { force: true });
    rmSync(this.apk, { force: true });
    this.p.audit(a, 'edge.app_unpublish', `${r.packageName} ${r.versionName}`);
  }

  /** Edge apps (gateway keys) and administrators. */
  private allow(a: Actor) {
    if (a.role !== 'gateway') this.p.require(a, 'admin.keys', 'edge_app', { mutating: false });
  }

  /** What a paired app needs to decide whether to update. */
  forEdge(a: Actor): EdgeAppRelease {
    this.allow(a);
    const r = this.latest();
    if (!r) throw new ApiError(404, 'not_found', 'No app update is published on this server.');
    const { publishedBy: _by, ...rest } = r;
    return rest;
  }

  /** The APK as a stream, audited. `client` is what the app says about itself (version, device). */
  download(a: Actor, client: string) {
    this.allow(a);
    const r = this.latest();
    if (!r) throw new ApiError(404, 'not_found', 'No app update is published on this server.');
    this.p.audit(a, 'edge.app_download', `${r.packageName} ${r.versionName}`, 'ok', client.replace(/[\r\n]/g, ' ').slice(0, 120) || undefined);
    return { release: r, stream: createReadStream(this.apk) };
  }
}
