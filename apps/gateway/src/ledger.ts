// Command dedupe ledger for one adapter's device.
//
// Remembers every idempotency key the device has been handed, so a command that arrives twice
// (server retry, reconnect, gateway restart) never runs twice. With a `file`, the ledger survives
// restarts: each change is written to disk (temp file + fsync + rename) before the command runs,
// so a command that ran is always on disk. See docs/ADAPTER_CONTRACT.md §7.
//
// When the history cannot be trusted (no file yet, unreadable, corrupt) the ledger fails safe: a
// command that may have been issued before the ledger was loaded is treated as already seen with
// an unknown outcome, and is not executed. The server sets expiresAt = issuedAt + COMMAND_TTL_MS,
// so every such command has expiresAt < load time + COMMAND_TTL_MS + clock skew, and the window
// closes by itself about 12 s after the gateway starts.

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { COMMAND_TTL_MS, type GwCommandUpdate, type SrvCommand } from '@13store/shared';
import type { Logger } from './sdk';

/** File format id. A file with any other format loads as corrupt. */
export const LEDGER_FORMAT = 'ps-gw-ledger/1';
/**
 * How long an entry is kept after its last update: 10 min, 60× COMMAND_TTL_MS (10 s).
 * Dedupe only needs entries until the command expires; keeping them longer means a late
 * re-delivery gets the status the device really reported instead of "expired, not executed".
 * At human command rates that is a few hundred entries at most, a file of tens of KB.
 */
export const LEDGER_RETAIN_MS = 10 * 60_000;
/** Entries kept per device (soft bound, see CommandLedger). */
export const LEDGER_MAX_ENTRIES = 1_000;
/** Allowance for the server and gateway clocks disagreeing (the 2 s freshness tolerance of D-23). */
export const LEDGER_CLOCK_SKEW_MS = 2_000;

export type LedgerStatus = GwCommandUpdate['status'] | 'received';

/** Outcome of checking an incoming command against the ledger. */
export type LedgerCheck =
  | { kind: 'new' }
  | { kind: 'duplicate'; status: LedgerStatus; detail?: string }
  /** Not in the ledger, but it may have reached the device before the ledger's history was lost. Never execute it. */
  | { kind: 'unknown' }
  | { kind: 'expired' };

export interface LedgerOptions {
  /** Where to keep the ledger. Omit to keep it in memory only (lost on restart). */
  file?: string;
  /** The device this ledger belongs to. Written into the file and checked on load. */
  deviceId?: string;
  /** Keep entries this long after their last update. Default LEDGER_RETAIN_MS. */
  retainMs?: number;
  /** Keep at most this many entries. Default LEDGER_MAX_ENTRIES. */
  maxEntries?: number;
  /** Clock skew allowance between server and gateway. Default LEDGER_CLOCK_SKEW_MS. */
  clockSkewMs?: number;
  now?: () => number;
  log?: Logger;
}

interface Entry {
  commandId: string;
  status: LedgerStatus;
  detail?: string;
  /** The command's own expiry (server clock). */
  expiresAt: number;
  /** Last update (gateway clock). */
  at: number;
}

type FileEntry = { key: string } & Entry;

interface LedgerFile {
  format: typeof LEDGER_FORMAT;
  deviceId: string | null;
  savedAt: number;
  /** Oldest update first. */
  entries: FileEntry[];
  /** SHA-256 (hex) of JSON.stringify(entries): catches damage that still parses as JSON. */
  sha256: string;
}

const STATUSES = new Set<LedgerStatus>(['received', 'acknowledged', 'executing', 'succeeded', 'rejected', 'failed']);

/** Where the gateway keeps one device's ledger: `<dataDir>/ledger/<deviceId>.json`. */
export function ledgerFile(dataDir: string, deviceId: string) {
  const safe = /^[A-Za-z0-9._-]{1,64}$/.test(deviceId) ? deviceId : `id-${createHash('sha256').update(deviceId).digest('hex').slice(0, 16)}`;
  return join(dataDir, 'ledger', `${safe}.json`);
}

/**
 * Tracks commands by idempotency key so a retried request never executes twice,
 * and rejects commands that arrive after their expiry.
 *
 * Entries are dropped once they are older than `retainMs` (TTL), and the oldest are dropped
 * when there are more than `maxEntries` (size bound). Neither ever drops an entry whose command
 * could still be admitted (now ≤ expiresAt + clock skew): forgetting it would let it run again.
 * So under a flood of commands the ledger may briefly hold more than `maxEntries`.
 */
export class CommandLedger {
  private byKey = new Map<string, Entry>();
  /** Commands that expire at or before this time may have reached the device before the ledger was loaded. */
  private unknownUntil = -Infinity;
  private readonly file?: string;
  private readonly deviceId?: string;
  private readonly retainMs: number;
  private readonly maxEntries: number;
  private readonly skewMs: number;
  private readonly now: () => number;
  private readonly log?: Logger;
  private saveFailing = false;
  private overBound = false;

  constructor(opts: LedgerOptions = {}) {
    this.file = opts.file;
    this.deviceId = opts.deviceId;
    this.retainMs = opts.retainMs ?? LEDGER_RETAIN_MS;
    this.maxEntries = opts.maxEntries ?? LEDGER_MAX_ENTRIES;
    this.skewMs = opts.clockSkewMs ?? LEDGER_CLOCK_SKEW_MS;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log;
    if (this.file) this.load(this.file);
  }

  /** True when the ledger is kept in a file and survives restarts. */
  get persistent() {
    return !!this.file;
  }

  /** Number of entries held. */
  get size() {
    return this.byKey.size;
  }

  check(cmd: SrvCommand, now: number): LedgerCheck {
    const seen = this.byKey.get(cmd.idempotencyKey);
    if (seen) return { kind: 'duplicate', status: seen.status, detail: seen.detail };
    if (cmd.expiresAt <= this.unknownUntil) return { kind: 'unknown' };
    if (now > cmd.expiresAt) return { kind: 'expired' };
    return { kind: 'new' };
  }

  /**
   * Remember the latest status of a command. With a file, the change is on disk when this returns.
   * Returns false only if the file could not be written; the entry is still kept in memory.
   */
  record(cmd: SrvCommand, status: LedgerStatus, detail?: string): boolean {
    const now = this.now();
    // Re-insert so the map stays in last-update order (oldest first) for the size bound.
    this.byKey.delete(cmd.idempotencyKey);
    this.byKey.set(cmd.idempotencyKey, { commandId: cmd.commandId, status, detail, expiresAt: cmd.expiresAt, at: now });
    this.prune(now);
    return this.save(now);
  }

  commandIdFor(key: string) {
    return this.byKey.get(key)?.commandId;
  }

  /** Forget every entry (simulator demo reset). Also empties the file. A fail-safe window from loading stays. */
  clear() {
    this.byKey.clear();
    this.save(this.now());
  }

  // ---- retention -------------------------------------------------------------------

  /** True once the command can no longer be admitted, even allowing for clock skew. */
  private canForget(e: Entry, now: number) {
    return now > e.expiresAt + this.skewMs;
  }

  private prune(now: number) {
    for (const [k, e] of this.byKey) if (now - e.at > this.retainMs && this.canForget(e, now)) this.byKey.delete(k);
    if (this.byKey.size > this.maxEntries) {
      for (const [k, e] of this.byKey) {
        if (this.byKey.size <= this.maxEntries) break;
        if (this.canForget(e, now)) this.byKey.delete(k);
      }
    }
    const over = this.byKey.size > this.maxEntries;
    if (over && !this.overBound)
      this.log?.warn(`${this.label}: command ledger holds ${this.byKey.size} commands that could still run (bound ${this.maxEntries}). Keeping them all.`);
    this.overBound = over;
  }

  // ---- file ------------------------------------------------------------------------

  private get label() {
    return this.deviceId ?? 'command ledger';
  }

  private save(now: number): boolean {
    if (!this.file) return true;
    const entries: FileEntry[] = [...this.byKey].map(([key, e]) => ({ key, ...e }));
    const body: LedgerFile = { format: LEDGER_FORMAT, deviceId: this.deviceId ?? null, savedAt: now, entries, sha256: digest(entries) };
    try {
      writeFileAtomic(this.file, JSON.stringify(body));
    } catch (e) {
      if (!this.saveFailing)
        this.log?.error(`${this.label}: cannot save the command ledger to ${this.file}: ${(e as Error).message}. Once-only execution is not guaranteed across a restart until this is fixed.`);
      this.saveFailing = true;
      return false;
    }
    if (this.saveFailing) this.log?.info(`${this.label}: command ledger saved to ${this.file} again`);
    this.saveFailing = false;
    return true;
  }

  private load(file: string) {
    const now = this.now();
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch (e) {
      this.log?.error(`${this.label}: cannot create ${dirname(file)}: ${(e as Error).message}`);
    }
    removeStaleTemps(file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return this.distrust(now, 'error', `cannot read the command ledger ${file}: ${(e as Error).message}`);
      this.distrust(now, 'info', `no command ledger at ${file} yet (first start, or the data directory was lost)`);
      this.save(now); // create it now, so an unwritable data directory shows up at start, not at the first command
      return;
    }
    try {
      const entries = parseLedger(text, this.deviceId);
      entries.sort((a, b) => a.at - b.at);
      for (const { key, ...e } of entries) this.byKey.set(key, e);
      this.prune(now);
      this.log?.info(`${this.label}: loaded ${this.byKey.size} command ledger entries from ${file}`);
    } catch (e) {
      this.byKey.clear();
      const kept = quarantine(file, now);
      this.distrust(now, 'error', `command ledger ${file} is corrupt (${(e as Error).message})${kept ? `; kept it as ${basename(kept)}` : ''}`);
      this.save(now);
    }
  }

  /** Fail safe: any command that may have been issued before now counts as already seen. */
  private distrust(now: number, level: 'info' | 'error', why: string) {
    this.unknownUntil = now + COMMAND_TTL_MS + this.skewMs;
    this.log?.[level](
      `${this.label}: ${why}. Commands issued before this start are treated as already seen and not executed (until ${new Date(this.unknownUntil).toISOString()}).`,
    );
  }
}

function digest(entries: unknown) {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function validEntry(e: unknown): e is FileEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.key === 'string' &&
    x.key.length > 0 &&
    typeof x.commandId === 'string' &&
    STATUSES.has(x.status as LedgerStatus) &&
    Number.isFinite(x.expiresAt) &&
    Number.isFinite(x.at) &&
    (x.detail === undefined || typeof x.detail === 'string')
  );
}

/** Parse and validate a ledger file. Throws with a short reason if anything is off. */
function parseLedger(text: string, deviceId: string | undefined): FileEntry[] {
  const f = JSON.parse(text) as Partial<LedgerFile> | null;
  if (!f || typeof f !== 'object') throw new Error('not a JSON object');
  if (f.format !== LEDGER_FORMAT) throw new Error(`unknown format ${JSON.stringify(f.format)}`);
  if (deviceId !== undefined && f.deviceId !== deviceId) throw new Error(`written for device ${JSON.stringify(f.deviceId)}`);
  if (!Array.isArray(f.entries)) throw new Error('entries is not a list');
  if (f.sha256 !== digest(f.entries)) throw new Error('checksum mismatch');
  for (const e of f.entries) if (!validEntry(e)) throw new Error(`bad entry ${JSON.stringify(e).slice(0, 80)}`);
  return f.entries;
}

/** Move a corrupt file aside for inspection. Returns the new path, or undefined if it could not be moved. */
function quarantine(file: string, now: number) {
  const to = `${file}.corrupt-${now}`;
  try {
    renameSync(file, to);
    return to;
  } catch {
    return undefined;
  }
}

/** Temp files left by a crash mid-write. They never hold the only copy, so they are safe to delete. */
function removeStaleTemps(file: string) {
  const dir = dirname(file);
  const prefix = `${basename(file)}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith('.tmp')) continue;
    try {
      rmSync(join(dir, n), { force: true });
    } catch {
      /* best effort */
    }
  }
}

let tmpSeq = 0;

/**
 * Replace a file so that a reader, or a restart after a crash or power loss, sees either the old
 * or the new content, never a mix: write a temp file in the same directory, fsync it, rename it
 * over the target (atomic on POSIX and NTFS), then fsync the directory where the OS allows it.
 */
export function writeFileAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}-${++tmpSeq}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd); // bytes on disk before the rename makes them visible
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the next load removes it */
    }
    throw e;
  }
  syncDir(dirname(file));
}

/** Make the rename itself durable. Windows cannot open a directory for fsync, and some filesystems refuse. */
function syncDir(dir: string) {
  if (process.platform === 'win32') return;
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* the rename is still atomic, only its durability on power loss is weaker */
  }
}
