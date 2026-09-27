import { describe, expect, test } from 'bun:test';
import { reciprocalRankFusion } from './rrf.js';

describe('retrieval/rrf (P1-WEB-01)', () => {
  test('stable multi-hit docs outrank single hits', () => {
    const out = reciprocalRankFusion(
      [
        [{ item: 'A', rank: 2, listId: 'q0' }, { item: 'B', rank: 1, listId: 'q0' }],
        [{ item: 'A', rank: 1, listId: 'q1' }],
      ],
      (x) => x,
    );
    expect(out[0].item).toBe('A');
    expect(out[0].ranks).toHaveLength(2);
    expect(out[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });
  test('ties keep first-seen order', () => {
    const out = reciprocalRankFusion(
      [[{ item: 'A', rank: 1, listId: 'q0' }], [{ item: 'B', rank: 1, listId: 'q1' }]],
      (x) => x,
    );
    expect(out.map((o) => o.item)).toEqual(['A', 'B']);
  });
});

import { reciprocalRankFusion as scalarRrf } from '../enrichment.js';
import { describe as describe2, expect as expect2, test as test2 } from 'bun:test';

describe2('rrf formula consistency', () => {
  test2('scalar helper matches generic fusion with 1-based ranks', () => {
    const ranks = [
      { key: 'a', rank: 0 },
      { key: 'a', rank: 2 },
    ];
    const scalar = scalarRrf(ranks, 60);
    const generic = reciprocalRankFusion(
      [[{ item: 'x', rank: 1, listId: 'q0' }], [{ item: 'x', rank: 3, listId: 'q1' }]],
      (x) => x,
      60,
    );
    expect2(generic[0].score).toBeCloseTo(scalar, 12);
  });
});
