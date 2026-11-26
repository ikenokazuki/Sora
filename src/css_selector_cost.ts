// removeSelectors・selectors は、取得したページをメインスレッドで読む（cheerio の css-select）。段を重ねると、小さいページでも時間が掛け算で
// 伸びる形を、取得の前に断る（実測: 1KB のページで :has の入れ子 4 段が 2 秒・段ごとに約 10 倍。兄弟 100 個で ~ 4 つが 0.8 秒・300 個で
// 3 つが 3 秒・1,000 個では 60 秒たっても終わらない）。子孫・子・隣の指定と、:has を横に並べる形は、この伸び方をしない
import { SelectorType, parse, type Selector } from 'css-what';

/** `.price@content` の形（selectors の値）の、CSS の部分と属性の名前（extractWithSelectors と同じ読み方） */
export const ATTRIBUTE_SELECTOR = /^(.*?)@([a-zA-Z0-9_-]+)$/;

/**
 * 1 つの組み立て（カンマで分けた 1 つ）の中の ~ の数。:has などの中の ~ も、外の段と掛け算になるので足す。カンマで並べた引数は足し算なので、
 * いちばん多い物を数える。:has の中に :has があれば nested にする
 */
function inspect(tokens: Selector[], insideHas: boolean): { siblings: number; nested: boolean } {
  let siblings = 0;
  let nested = false;
  for (const token of tokens) {
    if (token.type === SelectorType.Sibling) siblings++;
    if (token.type !== SelectorType.Pseudo || !Array.isArray(token.data)) continue;
    const isHas = token.name === 'has';
    if (isHas && insideHas) nested = true;
    let inner = 0;
    for (const alternative of token.data) {
      const found = inspect(alternative, insideHas || isHas);
      inner = Math.max(inner, found.siblings);
      nested ||= found.nested;
    }
    siblings += inner;
  }
  return { siblings, nested };
}

/** 重い形のセレクタ（最初の 1 つ）と理由。読めないセレクタは見ない（読めるかは findInvalidCssSelector と取り出しの側が扱う） */
export function findCostlySelector(selectors: string[]): { selector: string; reason: string } | undefined {
  for (const selector of selectors) {
    let groups: Selector[][];
    try {
      groups = parse(selector);
    } catch {
      continue;
    }
    for (const tokens of groups) {
      const { siblings, nested } = inspect(tokens, false);
      if (nested) return { selector, reason: ':has の中に :has は書けません' };
      if (siblings > 1) return { selector, reason: '1 つのセレクタに ~ は 1 つまでです' };
    }
  }
  return undefined;
}
