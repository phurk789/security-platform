// Atomic ledger writes under injected disk failures: whatever step fails, the previous ledger file
// stays whole, no temp file is left behind, and a restart still sees every command saved before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AdapterDeclaration } from '@13store/shared';
import { CommandLedger, LEDGER_CLOCK_SKEW_MS, admitCommand, ledgerFile, writeFileAtomic } from '../src/sdk';
import { cmd, fakeCtx } from './helpers';

const fail = vi.hoisted(() => ({ step: null as null | 'write' | 'fsync' | 'rename' }));

// Pass-through node:fs whose write steps can be made to fail on demand.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const boom = (code: string) => Object.assign(new Error(`${code}: simulated disk failure`), { code });
  const mocked = {
    ...fs,
    writeFileSync: ((target: unknown, data: unknown, ...rest: unknown[]) => {
      if (fail.step === 'write' && typeof target === 'number' && typeof data === 'string') {
        fs.writeFileSync(target, data.slice(0, Math.floor(data.length / 2))); // half the bytes, then the disk fills up
        throw boom('ENOSPC');
      }
      return (fs.writeFileSync as (...a: unknown[]) => void)(target, data, ...rest);
    }) as typeof fs.writeFileSync,
    fsyncSync: ((fd: number) => {
      if (fail.step === 'fsync') throw boom('EIO');
      return fs.fsyncSync(fd);
    }) as typeof fs.fsyncSync,
    renameSync: ((from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      if (fail.step === 'rename') throw boom('EIO');
      return fs.renameSync(from, to);
    }) as typeof fs.renameSync,
  };
  return { ...mocked, default: mocked };
});

const DEVICE = 'UGV-01';
const decl = { deviceId: DEVICE, commands: ['start', 'pause', 'resume', 'stop'] } as AdapterDeclaration;
let dir: string;
let file: string;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
  fail.step = null;
  dir = mkdtempSync(join(tmpdir(), 'gw-ledger-atomic-'));
  file = ledgerFile(dir, DEVICE);
});
afterEach(() => {
  fail.step = null;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('atomic ledger writes', () => {
  it.each(['write', 'fsync', 'rename'] as const)('a failed %s keeps the previous file whole and leaves no temp file', (step) => {
    const l = new CommandLedger({ file, deviceId: DEVICE });
    vi.advanceTimersByTime(LEDGER_CLOCK_SKEW_MS + 1);
    const done = cmd('stop');
    expect(l.record(done, 'succeeded')).toBe(true);
    const before = readFileSync(file, 'utf8');

    fail.step = step;
    const start = cmd('start');
    const run = fakeCtx(l);
    expect(admitCommand(run.ctx, decl, l, start)).toBe(false); // could not be saved → not run
    expect(run.got.updates).toEqual([{ commandId: start.commandId, status: 'rejected', detail: expect.stringMatching(/cannot save/) }]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dirname(file))).toEqual(['UGV-01.json']);

    fail.step = null;
    const after = new CommandLedger({ file, deviceId: DEVICE });
    expect(after.check(done, Date.now())).toMatchObject({ kind: 'duplicate', status: 'succeeded' });
  });

  it('writeFileAtomic replaces the content in one step', () => {
    const target = join(dir, 'x.json');
    writeFileAtomic(target, '{"v":1}');
    writeFileAtomic(target, '{"v":2}');
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}');
    fail.step = 'rename';
    expect(() => writeFileAtomic(target, '{"v":3}')).toThrow(/simulated/);
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}');
    expect(existsSync(target) && readdirSync(dir)).toEqual(['x.json']);
  });
});
