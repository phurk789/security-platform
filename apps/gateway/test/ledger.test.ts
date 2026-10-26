// Persistent command ledger: dedupe survives a gateway restart, entries expire and are bounded,
// and a missing, unreadable or corrupt file fails safe (earlier commands count as already seen).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { COMMAND_TTL_MS, DEFAULT_ROUTE, seedDevices, type AdapterDeclaration } from '@13store/shared';
import { SimUgv } from '../src/adapters';
import { CommandLedger, LEDGER_CLOCK_SKEW_MS, LEDGER_FORMAT, admitCommand, ledgerFile, type LedgerOptions, type Logger } from '../src/sdk';
import { cmd, fakeCtx, statuses } from './helpers';

const DEVICE = 'UGV-01';
const decl = { deviceId: DEVICE, commands: ['start', 'pause', 'resume', 'stop'] } as AdapterDeclaration;

let dir: string;
let file: string;
beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
  dir = mkdtempSync(join(tmpdir(), 'gw-ledger-'));
  file = ledgerFile(dir, DEVICE);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function recordingLog() {
  const lines: { level: 'info' | 'warn' | 'error'; msg: string }[] = [];
  const log: Logger = {
    info: (msg) => lines.push({ level: 'info', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
  };
  return { log, lines };
}

/** Load the ledger the way the gateway does at start. */
const load = (opts: Partial<LedgerOptions> = {}) => new CommandLedger({ file, deviceId: DEVICE, ...opts });

/**
 * Load the ledger, then let the post-start window pass, so commands the test issues from here on
 * are plainly new. (The window itself is tested in "fails safe" below.)
 */
function started(opts: Partial<LedgerOptions> = {}) {
  const l = load(opts);
  vi.advanceTimersByTime(LEDGER_CLOCK_SKEW_MS + 1);
  return l;
}

const onDisk = () => JSON.parse(readFileSync(file, 'utf8')) as { format: string; deviceId: string; entries: { key: string; status: string }[]; sha256: string };
const keysOnDisk = () => onDisk().entries.map((e) => e.key);
const sha = (entries: unknown) => createHash('sha256').update(JSON.stringify(entries)).digest('hex');

describe('dedupe across a gateway restart', () => {
  it('saves a command before it runs; after a restart a re-delivery is not run and its known status is re-reported', () => {
    const before = started();
    const c = cmd('start', { route: DEFAULT_ROUTE });
    const run1 = fakeCtx(before);
    expect(admitCommand(run1.ctx, decl, before, c)).toBe(true);
    // Write-ahead: it is on disk by the time the adapter may act on it.
    expect(onDisk().entries).toEqual([expect.objectContaining({ key: c.idempotencyKey, commandId: c.commandId, status: 'received' })]);
    before.record(c, 'executing');
    before.record(c, 'succeeded');

    vi.advanceTimersByTime(2_000); // gateway restarts; the server re-delivers within the command TTL
    const after = load();
    const run2 = fakeCtx(after);
    expect(admitCommand(run2.ctx, decl, after, { ...c, commandId: 'CMD-RETRY' })).toBe(false);
    expect(run2.got.updates).toEqual([{ commandId: c.commandId, status: 'succeeded', detail: undefined }]);
  });

  it('a command admitted just before the gateway died, with no outcome yet, stays blocked and silent', () => {
    const before = started();
    const c = cmd('resume');
    expect(admitCommand(fakeCtx(before).ctx, decl, before, c)).toBe(true);

    const after = load();
    const run2 = fakeCtx(after);
    expect(after.check(c, Date.now())).toEqual({ kind: 'duplicate', status: 'received', detail: undefined });
    expect(admitCommand(run2.ctx, decl, after, c)).toBe(false);
    expect(run2.got.updates).toEqual([]); // outcome unknown: say nothing, the server shows timed out
  });

  it('SimUgv: a start re-delivered after a gateway restart does not move the vehicle again', () => {
    const seed = seedDevices(0);
    const ugv1 = new SimUgv(seed[DEVICE]);
    const run1 = fakeCtx(started());
    ugv1.start(run1.ctx);
    const c = cmd('start', { route: DEFAULT_ROUTE });
    ugv1.onCommand(c);
    vi.advanceTimersByTime(1_000);
    expect(statuses(run1.got, c.commandId)).toEqual(['acknowledged', 'executing', 'succeeded']);
    ugv1.stop();

    const ugv2 = new SimUgv(seed[DEVICE]); // fresh process: vehicle state and adapter memory are gone
    const run2 = fakeCtx(load());
    ugv2.start(run2.ctx);
    ugv2.onCommand(c);
    vi.advanceTimersByTime(3_000);
    expect(statuses(run2.got, c.commandId)).toEqual(['succeeded']); // re-reported, not re-run
    expect(run2.got.telemetry.length).toBeGreaterThan(0);
    expect(run2.got.telemetry.every((t) => t.speed === 0)).toBe(true);
    ugv2.stop();
  });
});

describe('TTL expiry', () => {
  it('forgets an entry once it is older than retainMs and its command has expired, on write and on load', () => {
    const l = started({ retainMs: 60_000 });
    const c1 = cmd('start');
    l.record(c1, 'succeeded');
    vi.advanceTimersByTime(30_000);
    const c2 = cmd('stop');
    l.record(c2, 'succeeded');
    expect(keysOnDisk()).toEqual([c1.idempotencyKey, c2.idempotencyKey]);

    vi.advanceTimersByTime(31_000); // c1 last updated 61 s ago
    const c3 = cmd('pause');
    l.record(c3, 'rejected', 'Cannot pause while idle.');
    expect(keysOnDisk()).toEqual([c2.idempotencyKey, c3.idempotencyKey]);
    expect(l.check(c1, Date.now())).toEqual({ kind: 'expired' });

    vi.advanceTimersByTime(50_000); // gateway down a while: c2 is past retention (81 s), c3 is not (50 s)
    const reloaded = load({ retainMs: 60_000 });
    expect(reloaded.size).toBe(1);
    expect(reloaded.check(c3, Date.now())).toMatchObject({ kind: 'duplicate', status: 'rejected' });
  });

  it('never forgets a command that could still run, whatever the retention', () => {
    const l = started({ retainMs: 1 });
    const live = cmd('start'); // expires in COMMAND_TTL_MS
    l.record(live, 'executing');
    vi.advanceTimersByTime(COMMAND_TTL_MS - 1_000);
    l.record(cmd('stop'), 'succeeded');
    expect(l.check(live, Date.now())).toMatchObject({ kind: 'duplicate', status: 'executing' });

    vi.advanceTimersByTime(1_000 + LEDGER_CLOCK_SKEW_MS + 1); // past expiry + clock skew
    l.record(cmd('stop'), 'succeeded');
    expect(l.check(live, Date.now())).toEqual({ kind: 'expired' });
  });
});

describe('size bound', () => {
  it('keeps at most maxEntries, dropping the oldest commands that can no longer run', () => {
    const l = started({ maxEntries: 3 });
    const old = Array.from({ length: 5 }, () => cmd('stop', { expiresAt: Date.now() - COMMAND_TTL_MS }));
    for (const c of old) l.record(c, 'rejected', 'Command expired before it reached the device. Not executed.');
    expect(l.size).toBe(3);
    expect(keysOnDisk()).toEqual(old.slice(2).map((c) => c.idempotencyKey));
  });

  it('never drops a command that could still run to make room: warns, then trims once they expire', () => {
    const { log, lines } = recordingLog();
    const l = started({ maxEntries: 2, log });
    const live = Array.from({ length: 3 }, () => cmd('start'));
    for (const c of live) l.record(c, 'received');
    expect(l.size).toBe(3);
    for (const c of live) expect(l.check(c, Date.now()).kind).toBe('duplicate');
    expect(lines.filter((x) => x.level === 'warn' && /could still run/.test(x.msg))).toHaveLength(1);

    vi.advanceTimersByTime(COMMAND_TTL_MS + LEDGER_CLOCK_SKEW_MS + 1);
    const next = cmd('stop');
    l.record(next, 'succeeded');
    expect(keysOnDisk()).toEqual([live[2].idempotencyKey, next.idempotencyKey]);
  });
});

describe('fails safe when the history cannot be trusted', () => {
  /** A good ledger file holding one finished command, as a crash would leave it. */
  function goodFile() {
    const l = started();
    const ran = cmd('start');
    admitCommand(fakeCtx(l).ctx, decl, l, ran);
    l.record(ran, 'succeeded');
    return { ran, text: readFileSync(file, 'utf8') };
  }

  const damage: [string, (good: string, key: string) => string][] = [
    ['truncated JSON', (good) => good.slice(0, Math.floor(good.length / 2))],
    ['not JSON at all', () => '\u0000\u0000\u0000'],
    ['an edited key (checksum mismatch)', (good, key) => good.replace(key, `${key}x`)],
    ['an unknown format', (good) => JSON.stringify({ ...JSON.parse(good), format: 'ps-gw-ledger/0' })],
    ['a file written for another device', (good) => JSON.stringify({ ...JSON.parse(good), deviceId: 'UGV-02' })],
    [
      'a bad entry with a valid checksum',
      (good) => {
        const f = JSON.parse(good);
        f.entries[0].status = 'teleported';
        return JSON.stringify({ ...f, sha256: sha(f.entries) });
      },
    ],
  ];

  it.each(damage)('%s: logs it, keeps the file aside, and treats earlier commands as already seen', (_name, corrupt) => {
    const { ran, text } = goodFile();
    const neverArrived = cmd('resume'); // issued before the restart, delivered after it
    writeFileSync(file, corrupt(text, ran.idempotencyKey));
    const damaged = readFileSync(file, 'utf8');

    vi.advanceTimersByTime(1_000);
    const { log, lines } = recordingLog();
    const l = load({ log });
    expect(lines.some((x) => x.level === 'error' && /corrupt/.test(x.msg) && x.msg.includes(file))).toBe(true);
    const aside = readdirSync(dirname(file)).filter((n) => n.startsWith('UGV-01.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dirname(file), aside[0]), 'utf8')).toBe(damaged);

    // Both may have reached the device before the restart: neither runs, and nothing is claimed about them.
    for (const c of [ran, neverArrived]) {
      const run = fakeCtx(l);
      expect(l.check(c, Date.now())).toEqual({ kind: 'unknown' });
      expect(admitCommand(run.ctx, decl, l, c)).toBe(false);
      expect(run.got.updates).toEqual([]);
    }

    // A command issued after the start (beyond clock skew) is new and runs.
    vi.advanceTimersByTime(LEDGER_CLOCK_SKEW_MS + 1);
    const fresh = cmd('start');
    expect(admitCommand(fakeCtx(l).ctx, decl, l, fresh)).toBe(true);
    expect(keysOnDisk()).toEqual([fresh.idempotencyKey]); // a clean file replaces the damaged one
  });

  it('no file yet (first start, or the data directory was lost): the same window applies, and closes after TTL + skew', () => {
    const { log, lines } = recordingLog();
    const l = load({ log });
    expect(lines).toEqual([expect.objectContaining({ level: 'info', msg: expect.stringMatching(/no command ledger at .* yet/) })]);
    const issuedBeforeStart = cmd('start', { expiresAt: Date.now() + COMMAND_TTL_MS - 500 });
    const issuedAtStart = cmd('start');
    expect(l.check(issuedBeforeStart, Date.now())).toEqual({ kind: 'unknown' });
    expect(l.check(issuedAtStart, Date.now())).toEqual({ kind: 'unknown' }); // within clock skew of the start

    vi.advanceTimersByTime(LEDGER_CLOCK_SKEW_MS + 1);
    expect(l.check(cmd('start'), Date.now())).toEqual({ kind: 'new' });
    vi.advanceTimersByTime(COMMAND_TTL_MS);
    expect(l.check(issuedBeforeStart, Date.now())).toEqual({ kind: 'unknown' }); // still never run, even though expired
  });

  it('an in-memory ledger keeps the old behaviour: no window, nothing written', () => {
    const l = new CommandLedger();
    expect(l.persistent).toBe(false);
    expect(l.check(cmd('start'), Date.now())).toEqual({ kind: 'new' });
    expect(l.record(cmd('start'), 'received')).toBe(true);
    expect(existsSync(dirname(file))).toBe(false);
  });

  it('unreadable and unwritable (a directory in the way): start and resume are refused, stop and pause still run', () => {
    mkdirSync(file, { recursive: true });
    const { log, lines } = recordingLog();
    const l = load({ log });
    expect(lines.some((x) => x.level === 'error' && /cannot read the command ledger/.test(x.msg))).toBe(true);
    vi.advanceTimersByTime(LEDGER_CLOCK_SKEW_MS + 1);

    for (const type of ['start', 'resume'] as const) {
      const c = cmd(type);
      const run = fakeCtx(l);
      expect(admitCommand(run.ctx, decl, l, c)).toBe(false);
      expect(run.got.updates).toEqual([{ commandId: c.commandId, status: 'rejected', detail: expect.stringMatching(/cannot save its command ledger/) }]);
    }
    for (const type of ['stop', 'pause'] as const) {
      const c = cmd(type);
      const run = fakeCtx(l);
      expect(admitCommand(run.ctx, decl, l, c)).toBe(true);
      // Still deduped in memory for the life of this process.
      expect(admitCommand(run.ctx, decl, l, c)).toBe(false);
    }
    expect(lines.filter((x) => x.level === 'error' && /cannot save/.test(x.msg))).toHaveLength(1); // logged once, not per command
  });
});

describe('atomic writes', () => {
  it('each save replaces the whole file, checksummed, and leaves no temp files behind', () => {
    const l = started();
    for (let i = 0; i < 5; i++) l.record(cmd('stop'), 'succeeded');
    expect(readdirSync(dirname(file))).toEqual(['UGV-01.json']);
    const f = onDisk();
    expect(f).toMatchObject({ format: LEDGER_FORMAT, deviceId: DEVICE });
    expect(f.entries).toHaveLength(5);
    expect(f.sha256).toBe(sha(f.entries));
  });

  it('a temp file left by a crash mid-write is ignored and removed on the next start', () => {
    const l = started();
    const c = cmd('start');
    l.record(c, 'succeeded');
    const good = readFileSync(file, 'utf8');
    const stale = `${file}.4242-7.tmp`;
    writeFileSync(stale, good.slice(0, 20)); // half-written replacement that never got renamed

    const after = load();
    expect(after.check(c, Date.now())).toMatchObject({ kind: 'duplicate', status: 'succeeded' });
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(good);
  });

  it('device ids that are not safe file names get a hashed file name', () => {
    expect(ledgerFile(dir, 'UGV-01')).toBe(join(dir, 'ledger', 'UGV-01.json'));
    const odd = ledgerFile(dir, '../../etc/passwd');
    expect(dirname(odd)).toBe(join(dir, 'ledger'));
    expect(odd).toMatch(/id-[0-9a-f]{16}\.json$/);
  });
});
