// Canonical Reciprocal Rank Fusion (RFC P1-WEB-01, P1-X-01).
// Merges multiple provider-ranked lists without discarding
// provider order. Score = sum over lists of 1 / (k + rank).

export interface RankedCandidate<T> {
  item: T;
  rank: number;
  listId: string;
}

export interface FusedCandidate<T> {
  item: T;
  score: number;
  ranks: Array<{ listId: string; rank: number }>;
}

export function reciprocalRankFusion<T>(
  lists: RankedCandidate<T>[][],
  getKey: (item: T) => string,
  k = 60,
): Array<FusedCandidate<T>> {
  const byKey = new Map<string, FusedCandidate<T> & { order: number }>();
  for (const list of lists) {
    for (const cand of list) {
      const key = getKey(cand.item);
      if (!key) continue;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { item: cand.item, score: 0, ranks: [], order: byKey.size };
        byKey.set(key, entry);
      }
      entry.ranks.push({ listId: cand.listId, rank: cand.rank });
      entry.score += 1 / (k + cand.rank);
    }
  }
  const out = [...byKey.values()];
  out.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.order - b.order));
  return out.map(({ order: _o, ...rest }) => rest);
}
