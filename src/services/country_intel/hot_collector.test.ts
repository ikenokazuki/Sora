import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { latestHotSnapshots, pruneHotObservations, saveHotObservations } from './db.js';
import { diffHotSnapshots, toHotObservationInputs } from './hot_collector.js';
let directory: string;
let previousPath: string | undefined;
beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-hot-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(async () => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});
const T0 = Date.parse('2026-09-23T00:00:00Z');
const T1 = T0 + 5 * 60_000;
const DAY_MS = 86_400_000;
describe('hot observations', () => {
  test('saves and reads the latest two snapshots', () => {
    saveHotObservations([{ sourceId: 's', topicId: 'a', regionId: 'country:CN', observedAt: T0, rank: 2, title: 'A', url: 'https://example.org/a' }]);
    saveHotObservations([{ sourceId: 's', topicId: 'a', regionId: 'country:CN', observedAt: T1, rank: 1, title: 'A', url: 'https://example.org/a' }]);
    const { latest, previous } = latestHotSnapshots('s');
    expect(latest).toHaveLength(1);
    expect(latest[0].rank).toBe(1);
    expect(previous).toHaveLength(1);
    expect(previous[0].rank).toBe(2);
  });
  test('prunes observations older than the 7-day retention', () => {
    saveHotObservations([{ sourceId: 's', topicId: 'a', regionId: 'country:CN', observedAt: T0, title: 'A', url: 'https://example.org/a' }]);
    expect(pruneHotObservations(T0 + 8 * DAY_MS)).toBe(1);
    expect(latestHotSnapshots('s').latest).toEqual([]);
  });
  test('keeps observations within the 7-day retention', () => {
    saveHotObservations([{ sourceId: 's', topicId: 'a', regionId: 'country:CN', observedAt: T0, title: 'A', url: 'https://example.org/a' }]);
    expect(pruneHotObservations(T0 + 6 * DAY_MS)).toBe(0);
    expect(latestHotSnapshots('s').latest).toHaveLength(1);
  });
});
describe('hot diffs', () => {
  test('names new, moved, steady and dropped topics', () => {
    const row = (topicId: string, rank?: number) => ({ sourceId: 's', topicId, regionId: 'country:CN', observedAt: new Date(T1).toISOString(), ...(rank === undefined ? {} : { rank }), pinned: false, title: topicId, url: 'https://example.org/' + topicId });
    const changes = diffHotSnapshots([row('up', 5), row('down', 1), row('steady', 3), row('gone', 2)], [row('up', 2), row('down', 4), row('steady', 3), row('fresh', 1)]);
    expect(changes.find((c) => c.topicId === 'up')).toMatchObject({ kind: 'rank_up', previousRank: 5, currentRank: 2 });
    expect(changes.find((c) => c.topicId === 'down')).toMatchObject({ kind: 'rank_down' });
    expect(changes.find((c) => c.topicId === 'steady')).toMatchObject({ kind: 'steady' });
    expect(changes.find((c) => c.topicId === 'fresh')).toMatchObject({ kind: 'new' });
    expect(changes.find((c) => c.topicId === 'gone')).toMatchObject({ kind: 'dropped' });
  });
  test('toHotObservationInputs keeps stable topic ids', () => {
    const inputs = toHotObservationInputs('s', 'country:CN', new Date(T0).toISOString(), [{ evidence: { title: 'T', url: 'https://example.org/t' }, detail: { providerItemId: 'x:1', structuredData: { rank: 2, hot: '5' } } }]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ topicId: 'x:1', rank: 2, hot: '5', pinned: false });
  });
});
