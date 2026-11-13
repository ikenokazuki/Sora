/**
 * crawl の includePatterns / excludePatterns 用のワイルドカード照合（設計 6。穴 21）。正規表現にしない。
 *
 *  - `**`（`*` が 2 つ以上並んだもの）は、任意の文字列（`/` を含む）
 *  - `*` は、`/` を除く任意の文字列
 *  - ほかの文字は、そのままの文字（`.` `?` `[` `(` なども。大文字小文字を区別する）
 *  - 全体に一致したときだけ true
 *
 * 貪欲に進み、不一致のときは、直前の `*` を 1 文字広げて戻る（`/` は越えられない）。それができないときは、直前の `**` を 1 文字広げて、
 * そこからやり直す。`*` の数で、時間が爆発しない（`*a*a*a*a*b` のようなパターンを、正規表現にすると、メインのスレッドが止まる）。
 * 悪意のある組（パターンと URL）でも、呼び出し側が渡す steps の予算で、仕事の量に上限をかける（超えたら GlobBudgetError）。
 */

/** 仕事の量の予算。1 回の照合の繰り返し 1 回で 1 減る。複数の照合で共有する（crawl 1 回ぶん） */
export interface GlobBudget {
  steps: number;
}

export class GlobBudgetError extends Error {
  constructor() {
    super('パターンの照合が、予算（steps）を超えました');
    this.name = 'GlobBudgetError';
  }
}

export function globMatch(pattern: string, text: string, budget?: GlobBudget): boolean {
  let p = 0;
  let t = 0;
  /** 直前の `**`: その直後のパターンの位置（無ければ -1）と、吸っている範囲の終わり */
  let dNext = -1;
  let dEnd = 0;
  /** 直前の `**` より後ろにある、直前の `*`: その直後のパターンの位置（無ければ -1）と、吸っている範囲の終わり */
  let sNext = -1;
  let sEnd = 0;

  while (t < text.length) {
    if (budget && --budget.steps < 0) throw new GlobBudgetError();
    if (p < pattern.length && pattern[p] === '*') {
      let end = p;
      while (end < pattern.length && pattern[end] === '*') end++;
      if (end - p >= 2) {
        dNext = end;
        dEnd = t;
        sNext = -1; // これより前の * は、もう広げない（** が、そのあとの分を吸える）
      } else {
        sNext = end;
        sEnd = t;
      }
      p = end;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (sNext >= 0 && text[sEnd] !== '/') {
      sEnd++;
      t = sEnd;
      p = sNext;
    } else if (dNext >= 0) {
      // ここに来るのは、`*` が無いか、`/` で止まっているとき。止まった状態は、新しい `*` に当たって上書きされるまで使われないので、戻さなくてよい
      dEnd++;
      t = dEnd;
      p = dNext;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
