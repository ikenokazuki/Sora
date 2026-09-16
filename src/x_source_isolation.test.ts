import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildXIsolatedEvidence,
  buildXRetrievalPlan,
  parseXDiscoverySeed,
  stripXWebDiscoveryText,
} from './x_source_isolation.js';

describe('Phase 2 v2 X Source Isolation', () => {
  test('supports profile, status, i/web/status, and i/status URL shapes', () => {
    expect(parseXDiscoverySeed('https://x.com/kimisora_JPN')?.kind).toBe('profile');
    expect(
      parseXDiscoverySeed(
        'https://x.com/kimisora_JPN/status/2099058849554829468',
      )?.statusId,
    ).toBe('2099058849554829468');
    expect(
      parseXDiscoverySeed(
        'https://x.com/i/web/status/2099058849554829468',
      )?.statusId,
    ).toBe('2099058849554829468');
    expect(
      parseXDiscoverySeed(
        'https://x.com/i/status/2099058849554829468',
      )?.statusId,
    ).toBe('2099058849554829468');
  });

  test('deduplicates X seeds and caps unique dedicated retrievals at two', () => {
    const plan = buildXRetrievalPlan([
      { url: 'https://x.com/a/status/1111111111111111111' },
      { url: 'https://x.com/a/status/1111111111111111111' },
      { url: 'https://x.com/b' },
      { url: 'https://x.com/c' },
    ]);

    expect(plan).toHaveLength(2);
    expect(plan[0].itemIndexes).toEqual([0, 1]);
    expect(plan[1].seed.handle).toBe('b');
  });

  test('strips Web snippet/description before X evidence handling', () => {
    expect(
      stripXWebDiscoveryText({
        url: 'https://x.com/a/status/1',
        title: 'A / X',
        snippet: 'WEB_SNIPPET',
        description: 'WEB_DESCRIPTION',
        rank: 1,
      }),
    ).toEqual({
      url: 'https://x.com/a/status/1',
      title: 'A / X',
      rank: 1,
    });
  });

  test('status URL accepts exact status-id match as primary evidence', () => {
    const seed = parseXDiscoverySeed(
      'https://x.com/a/status/2099058849554829468',
    )!;
    const evidence = buildXIsolatedEvidence(seed, [
      {
        url: 'https://x.com/a/status/2099058849554829468',
        author_handle: 'a',
        text: 'exact verified body',
      },
      {
        url: 'https://x.com/a/status/9999999999999999999',
        author_handle: 'a',
        text: 'other post',
      },
    ]);

    expect(evidence.relation).toBe('exact_status');
    expect(evidence.eligibleForPrimaryEvidence).toBe(true);
    expect(evidence.markdown).toContain('exact verified body');
    expect(evidence.markdown).not.toContain('other post');
  });

  test('related posts are diagnostic-only and never primary evidence', () => {
    const seed = parseXDiscoverySeed(
      'https://x.com/a/status/2099058849554829468',
    )!;
    const evidence = buildXIsolatedEvidence(seed, [
      {
        url: 'https://x.com/a/status/9999999999999999999',
        author_handle: 'a',
        text: 'related but not exact',
      },
    ]);

    expect(evidence.relation).toBe('related_posts');
    expect(evidence.eligibleForPrimaryEvidence).toBe(false);
    expect(evidence.selectedItems).toEqual([]);
    expect(evidence.markdown).toBeUndefined();
    expect(evidence.relatedItems).toHaveLength(1);
  });

  test('profile retrieval may use dedicated account posts as evidence', () => {
    const seed = parseXDiscoverySeed('https://x.com/a')!;
    const evidence = buildXIsolatedEvidence(seed, [
      {
        author_handle: 'a',
        text: 'account source text',
      },
    ]);

    expect(evidence.relation).toBe('account_posts');
    expect(evidence.eligibleForPrimaryEvidence).toBe(true);
    expect(evidence.markdown).toContain('account source text');
  });

  test('integration remains feature-flagged and cache-partitioned', () => {
    const source = readFileSync(
      new URL('./scraper.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain(
      "process.env.SORA_X_SOURCE_ISOLATION === 'true'",
    );
    expect(source).toContain(
      "${xSourceIsolation ? 'xiso-on' : 'xiso-off'}",
    );
    expect(source).toContain('buildXRetrievalPlan(topItems, 2)');
  });
});
