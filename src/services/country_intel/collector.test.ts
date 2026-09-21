import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { readSourceState, writeSourceState } from './db.js';
import { acquireCollectorLease, collectSourceOnce, releaseCollectorLease, startCountryCollector } from './collector.js';

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-collect-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(async () => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

describe('collector', () => {
  test('failed batch keeps the durable source cursor', async () => {
    writeSourceState({ sourceId: 'gdelt', cursor: 'file-1' });
    const before = readSourceState('gdelt');
    await expect(collectSourceOnce('gdelt', async () => { throw new Error('download failed'); })).rejects.toThrow('download failed');
    expect(readSourceState('gdelt')?.cursor).toBe(before?.cursor);
    expect(readSourceState('gdelt')?.lastErrorCode).toBe('download failed');
  });

  test('successful batch advances the cursor exactly once', async () => {
    await collectSourceOnce('gdelt', async () => ({ cursor: 'file-2', details: [] }));
    expect(readSourceState('gdelt')?.cursor).toBe('file-2');
    expect(readSourceState('gdelt')?.lastSuccessfulFetchAt).toBeDefined();
  });

  test('expired leases are taken over, live leases are respected', () => {
    expect(acquireCollectorLease('owner-a', 60_000, 1000)).toBe(true);
    expect(acquireCollectorLease('owner-b', 60_000, 2000)).toBe(false);
    expect(acquireCollectorLease('owner-b', 60_000, 200_000)).toBe(true);
    releaseCollectorLease('owner-b');
    expect(acquireCollectorLease('owner-c', 60_000, 201_000)).toBe(true);
  });

  test('collector stops cleanly and releases its lease', async () => {
    let runs = 0;
    const handle = startCountryCollector([{ sourceId: 's', intervalMs: 0, collect: async () => { runs += 1; return { cursor: 'c' + String(runs), details: [] }; } }], { tickMs: 10, leaseTtlMs: 1000 });
    await Bun.sleep(60);
    await handle.stop();
    const afterStop = runs;
    await Bun.sleep(30);
    expect(runs).toBe(afterStop);
    expect(readSourceState('collector:lease')).toBeUndefined();
  });
});
