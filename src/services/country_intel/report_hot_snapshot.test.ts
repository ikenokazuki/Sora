import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { latestHotSnapshots } from './db.js';
import { normalizeEvidence } from './evidence.js';
import type { CountryIntelProvider } from './provider_registry.js';
import { researchCountryContext } from './report.js';
import { resolveRegion } from './region.js';
let directory: string;
let previousPath: string | undefined;
beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-snap-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});
const T0 = new Date('2026-09-23T00:00:00Z');
const T1 = new Date('2026-09-23T00:05:00Z');
function weiboStub(ranks: Map<string, number>, now: Date): CountryIntelProvider {
  const region = resolveRegion('CN');
  return {
    id: 'weibo_hot',
    areas: ['media_activity'],
    latencyClass: 'near_realtime',
    defaultTtlSeconds: 60,
    timeoutMs: 1000,
    run: async (input) => ({
      items: [...ranks].map(([topicId, rank]) => {
        const evidence = normalizeEvidence({
          url: 'https://s.weibo.com/weibo?q=%23' + topicId + '%23',
          title: topicId,
          publisher: 'Weibo Hot Search',
          sourceType: 'structured_dataset',
          primarySource: false,
          latencyClass: 'near_realtime',
        }, input.region ?? region, now);
        return {
          evidence,
          detail: {
            evidenceId: evidence.id,
            providerId: 'weibo_hot',
            providerItemId: 'weibo:' + topicId,
            sourceRecordUrl: evidence.url,
            contentKind: 'excerpt',
            blocks: [],
            structuredData: { topicId, rank },
            retrievedAt: now.toISOString(),
            timeBasis: 'provider_observation',
            geographyBasis: 'unknown',
            sourceStatus: 'unverified',
            contentTruncated: false,
          },
        };
      }),
      coverage: ['media_activity'],
    }),
  };
}
describe('query-time hot snapshots', () => {
  test('first query saves a snapshot without previous ranks', async () => {
    const report = await researchCountryContext(
      { region: 'China' },
      { providers: [weiboStub(new Map([['topic-a', 2]]), T0)], now: () => T0, cache: null },
    );
    expect(latestHotSnapshots('weibo_hot').latest.map((row) => row.topicId)).toEqual(['topic-a']);
    const topic = report.recentContext?.topics.find((item) => item.topicId === 'topic-a');
    expect(topic?.rank).toBe(2);
    expect(topic?.previousRank).toBeUndefined();
    expect(latestHotSnapshots('zhihu_hot').latest).toEqual([]);
  });
  test('second query attaches rank changes from the previous snapshot', async () => {
    const ranks = new Map([['topic-a', 2]]);
    await researchCountryContext(
      { region: 'China' },
      { providers: [weiboStub(ranks, T0)], now: () => T0, cache: null },
    );
    ranks.set('topic-a', 1);
    const second = await researchCountryContext(
      { region: 'China' },
      { providers: [weiboStub(ranks, T1)], now: () => T1, cache: null },
    );
    const topic = second.recentContext?.topics.find((item) => item.topicId === 'topic-a');
    expect(topic?.rank).toBe(1);
    expect(topic?.previousRank).toBe(2);
    expect(topic?.rankChange).toBe('up');
  });
});
