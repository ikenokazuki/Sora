import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { latestHotSnapshots, pruneHotObservations, readSourceState, saveHotObservations } from './db.js';
import { collectHotSource, createHotCollectorJobs, diffHotSnapshots, hotCollectRegions, toHotObservationInputs, type HotSourceDef } from './hot_collector.js';
import { collectSourceOnce, collectorBackoffMs } from './collector.js';
import type { CountryIntelProvider } from './provider_registry.js';
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
function stubProvider(items: { topicId: string; rank?: number; title: string }[]): CountryIntelProvider {
  return {
    id: 'test_hot',
    areas: ['media_activity'],
    latencyClass: 'near_realtime',
    defaultTtlSeconds: 60,
    timeoutMs: 1000,
    run: async () => ({
      items: items.map((item) => ({
        evidence: { id: 'ev-' + item.topicId, regionId: 'country:CN', url: 'https://example.org/' + item.topicId, title: item.title, sourceType: 'structured_dataset', retrievedAt: new Date(T0).toISOString(), primarySource: false, latencyClass: 'near_realtime' },
        detail: { evidenceId: 'ev-' + item.topicId, providerId: 'test_hot', providerItemId: 'test:' + item.topicId, sourceRecordUrl: 'https://example.org/' + item.topicId, contentKind: 'excerpt', blocks: [], structuredData: { topicId: item.topicId, ...(item.rank === undefined ? {} : { rank: item.rank }) }, retrievedAt: new Date(T0).toISOString(), timeBasis: 'provider_observation', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: false },
      })),
      coverage: ['media_activity'],
    }),
  };
}
const defFor = (createProvider: HotSourceDef['createProvider']): HotSourceDef => ({ sourceId: 'test_hot', region: 'CN', intervalMs: 300_000, createProvider });
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
  test('prunes expired observations only', () => {
    saveHotObservations([{ sourceId: 's', topicId: 'a', regionId: 'country:CN', observedAt: T0, title: 'A', url: 'https://example.org/a' }]);
    expect(pruneHotObservations(T0 + 31 * 86_400_000)).toBe(1);
    expect(latestHotSnapshots('s').latest).toEqual([]);
  });
  test('collectHotSource persists provider topics', async () => {
    const def = defFor(() => stubProvider([{ topicId: 'a', rank: 1, title: 'A' }]));
    const result = await collectHotSource(def, { now: () => T1 });
    expect(result.observed).toBe(1);
    expect(result.cursor).toBe(new Date(T1).toISOString());
    expect(latestHotSnapshots('test_hot').latest.map((row) => row.topicId)).toEqual(['a']);
  });
  test('collectHotSource failure keeps the previous cursor', async () => {
    const def = defFor(() => stubProvider([{ topicId: 'a', rank: 1, title: 'A' }]));
    await collectHotSource(def, { now: () => T0 });
    const failing = defFor(() => ({ ...stubProvider([]), run: async () => { throw new Error('boom'); } }));
    await expect(collectHotSource({ ...failing, sourceId: 'test_hot' }, { now: () => T1 })).rejects.toThrow('boom');
    expect(latestHotSnapshots('test_hot').latest).toHaveLength(1);
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
});
describe('hot collector wiring', () => {
  test('parses collect regions with a CN default', () => {
    expect(hotCollectRegions({} as NodeJS.ProcessEnv)).toEqual(['CN']);
    expect(hotCollectRegions({ SORA_INTEL_COLLECT_REGIONS: 'jp, us' } as NodeJS.ProcessEnv)).toEqual(['JP', 'US']);
  });
  test('builds one job per source in the requested regions', () => {
    const jobs = createHotCollectorJobs(['CN']);
    expect(jobs).toHaveLength(6);
    expect(jobs[0].intervalMs).toBe(5 * 60_000);
    expect(jobs.find((job) => job.sourceId === 'hot:cctv_news')?.intervalMs).toBe(10 * 60_000);
    expect(createHotCollectorJobs(['JP'])).toEqual([]);
  });
  test('toHotObservationInputs keeps stable topic ids', () => {
    const inputs = toHotObservationInputs('s', 'country:CN', new Date(T0).toISOString(), [{ evidence: { title: 'T', url: 'https://example.org/t' }, detail: { providerItemId: 'x:1', structuredData: { rank: 2, hot: '5' } } }]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ topicId: 'x:1', rank: 2, hot: '5', pinned: false });
  });
  test('backoff grows 5 to 30 minutes', () => {
    expect(collectorBackoffMs(undefined, T0)).toBe(5 * 60_000);
    const prev = (delayMs: number) => ({ sourceId: 's', lastCheckedAt: new Date(T0).toISOString(), retryAt: new Date(T0 + delayMs).toISOString() });
    expect(collectorBackoffMs(prev(5 * 60_000), T0)).toBe(10 * 60_000);
    expect(collectorBackoffMs(prev(20 * 60_000), T0)).toBe(30 * 60_000);
  });
  test('failed batches record retry time and keep the cursor', async () => {
    await expect(collectSourceOnce('hot:test', async () => { throw new Error('down'); })).rejects.toThrow('down');
    const state = readSourceState('hot:test');
    expect(state?.cursor).toBeUndefined();
    expect(state?.lastErrorCode).toBe('down');
    expect(Date.parse(state?.retryAt ?? '')).toBeGreaterThan(Date.now());
  });
});
