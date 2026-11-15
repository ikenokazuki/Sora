/**
 * 文字列のキーで引く Map を、max 件以下に保つ（設計 6。穴 24）。別々のホスト名が渡されるたびに増え、削除の無い Map のための掃除。
 * 追加のあとに呼ぶ。上限以下なら何もしない（古いかどうかの判定も呼ばない）。超えているときは、
 *   1. 役目を終えた（isStale が true の）項目を、全部外す。
 *   2. まだ超えているなら、Map の先頭（入れた順に古い方）から、上限の 9 割になるまで外す。次の数回の追加で、また全体を調べないため。
 * 入れた順に古い方から外すので、呼ぶ側は、値を書き直すとき、先に delete してから set する（よく来るキーが後ろに動き、残る）。
 * max が 1 未満・数でないときは 1 として扱い、いま入れた項目（最後）は外さない。
 * isStale は、いま入れた項目に対して true にならないこと（呼ぶ側が守る。守らないと、いま入れた項目が外れる）。
 */
export function trimMap<V>(map: Map<string, V>, max: number, isStale: (value: V) => boolean): void {
  const cap = Math.max(1, Math.floor(max) || 1);
  if (map.size <= cap) return;
  for (const [key, value] of map) if (isStale(value)) map.delete(key);
  if (map.size <= cap) return;
  const target = Math.max(1, Math.floor(cap * 0.9));
  for (const key of map.keys()) {
    if (map.size <= target) break;
    map.delete(key);
  }
}
