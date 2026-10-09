// X Realtime の緩和検索で固有名詞（anchor）を落とさないための判定（v2.36.0）。
// ネットワークを使わない純粋関数だけを置く。取得と組み立ては services/yahoo.ts。
// 評価: eval/realtime_anchor_cases.json と scripts/eval-realtime-anchor.ts
import { INTENT_ATTRIBUTE_TERMS_LIST } from './lexicons/temporal.js';
import { PUBLIC_FOCUS_SEARCH_EXCLUDED_TERMS, PUBLIC_FOCUS_TERMS } from './lexicons/realtime_focus.js';

const nk = (s: string): string => (s || '').normalize('NFKC').toLowerCase();
const SEPARATOR = /[\s・]/;
const squash = (s: string): string => nk(s).replace(/[\s・]+/g, '');

/** 固有名詞になりにくい語（意図語・予定系の語）。判定の候補から外す。 */
const GENERIC_TERMS: Set<string> = new Set(
  [
    ...INTENT_ATTRIBUTE_TERMS_LIST,
    '明日', '今日', '予定', 'スケジュール', '情報', '一覧', '最新', '公式', 'まとめ',
    'いつ', 'どこ', '詳細', '概要', 'タイムテーブル',
  ].map(nk),
);

/** wave1 で固有名詞を含む投稿がこの割合未満なら、Yahoo がその語を扱えていない（記号の無視など）とみなす。 */
export const ANCHOR_BROKEN_RATIO = 0.5;

const isNumericTerm = (t: string): boolean => /^[0-9:/.\-]+$/.test(nk(t));

type Script = 'kata' | 'hira' | 'kanji' | 'latin' | 'other';

function scriptOf(c: string): Script {
  if (c >= '゠' && c <= 'ヿ') return 'kata';
  if (c >= '぀' && c <= 'ゟ') return 'hira';
  if (c >= '一' && c <= '鿿') return 'kanji';
  if (/^[a-z0-9]$/i.test(c)) return 'latin';
  return 'other';
}

/**
 * 語境界つきの一致。空白・中黒は無視して照合し、境界として扱う。
 * カタカナだけ・英数字だけの語は、前後が同じ文字種なら長い語の一部とみなす（「ライブ」は「ライブラリ」に一致しない）。
 */
export function termHits(term: string, text: string): boolean {
  const t = squash(term);
  if (!t) return false;
  const raw = nk(text);
  let x = '';
  const breakBefore: boolean[] = [];
  let pending = false;
  for (let i = 0; i < raw.length; i++) {
    if (SEPARATOR.test(raw[i])) {
      pending = true;
      continue;
    }
    breakBefore.push(pending);
    x += raw[i];
    pending = false;
  }
  const first = scriptOf(t[0]);
  const bounded = first === scriptOf(t[t.length - 1]) && (first === 'kata' || first === 'latin') ? first : undefined;
  for (let i = x.indexOf(t); i >= 0; i = x.indexOf(t, i + 1)) {
    if (!bounded) return true;
    const end = i + t.length;
    const beforeOk = i === 0 || breakBefore[i] || scriptOf(x[i - 1]) !== bounded;
    const afterOk = end >= x.length || breakBefore[end] || scriptOf(x[end]) !== bounded;
    if (beforeOk && afterOk) return true;
  }
  return false;
}

/** タイトルのサイト名部分（「記事名 | サイト名」の末尾）。区切りが無ければ空。 */
function titleSitePart(title: string): string {
  const parts = nk(title).split(/\s[|｜\-–—]\s|[|｜]/);
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/** 判定の候補: 汎用語・数値・評判系の目印を除いた語。全部除かれるなら全語。 */
export function anchorCandidates(terms: string[]): string[] {
  const candidates = terms.filter((t) => !GENERIC_TERMS.has(nk(t)) && !isNumericTerm(t) && !isPublicFocusTerm(t));
  return candidates.length > 0 ? candidates : terms;
}

/** X 投稿で優先する発信者。official: 本人・公式（予定・告知・事実確認）、public: 本人以外（評判・感想・炎上など） */
export type RealtimeFocus = 'official' | 'public';

const containsAny = (text: string, terms: string[]) => terms.some((t) => termHits(t, text));

/** 語が評判系の目印か（「叩かれてる」は「叩か」を含む）。 */
export const isPublicFocusTerm = (term: string): boolean => containsAny(term, PUBLIC_FOCUS_TERMS);

/** 投稿にほぼ書かれないため、X の検索語から外す目印か。 */
export const isSearchExcludedTerm = (term: string): boolean => containsAny(term, PUBLIC_FOCUS_SEARCH_EXCLUDED_TERMS);

/** クエリの語から focus を推定する。評判系の目印が無ければ公式優先（従来の動き）。 */
export function detectRealtimeFocus(query: string): RealtimeFocus {
  return containsAny(query || '', PUBLIC_FOCUS_TERMS) ? 'public' : 'official';
}

/**
 * 自動で見つけた公式アカウントが、クエリの対象のものか。表示名か、3割以上の投稿にクエリの語があれば真。
 * 取得したページの X 欄（TimeTree なら TimeTree 自身のアカウント）を公式とみなさないための確認。
 */
export function officialAccountMatches(
  posts: Array<{ text?: string; author_name?: string }>,
  terms: string[],
): boolean {
  if (posts.length === 0 || terms.length === 0) return false;
  if (postMentions({ author_name: posts[0].author_name }, terms)) return true;
  return posts.filter((p) => postMentions({ text: p.text }, terms)).length >= posts.length * 0.3;
}

/** 上限を超えて残す投稿の数の上限（上限内のどの投稿にも無い語を含む投稿）。 */
const MAX_EVIDENCE_EXTRA = 5;

/**
 * 返す投稿を上限まで選ぶ。検索（retrievalQueryIndex）ごとに交互に選び、第三者優先では同じ投稿者を後回しにする。
 * 上限内のどの投稿にも無い語を含む投稿は、上限を超えて残す（最大5件）。選んだ投稿は元の順序で返す。
 */
export function selectRealtimeItems<T extends Record<string, any>>(
  items: T[],
  options: { cap: number; focus: RealtimeFocus; terms: string[]; aliases?: Record<string, string[]> },
): { items: T[]; omitted: number } {
  if (items.length <= options.cap) return { items, omitted: 0 };
  const groups = new Map<number, number[]>();
  items.forEach((item, i) => {
    const key = typeof item.retrievalQueryIndex === 'number' ? item.retrievalQueryIndex : 0;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  let order: number[] = [];
  for (let round = 0; order.length < items.length; round++) {
    for (const group of groups.values()) if (round < group.length) order.push(group[round]);
  }
  if (options.focus === 'public') {
    const seen = new Set<string>();
    const first: number[] = [];
    const rest: number[] = [];
    for (const i of order) {
      const author = String(items[i].author_handle || '').toLowerCase();
      (author && seen.has(author) ? rest : first).push(i);
      if (author) seen.add(author);
    }
    order = [...first, ...rest];
  }
  const selected = new Set(order.slice(0, options.cap));
  const covers = (i: number, term: string) => postMentions(items[i], [term, ...(options.aliases?.[term] ?? [])]);
  let extra = 0;
  for (const term of options.terms) {
    if (extra >= MAX_EVIDENCE_EXTRA) break;
    if ([...selected].some((i) => covers(i, term))) continue;
    const add = order.find((i) => !selected.has(i) && covers(i, term));
    if (add !== undefined) {
      selected.add(add);
      extra++;
    }
  }
  const out = items.filter((_, i) => selected.has(i));
  return { items: out, omitted: items.length - out.length };
}

/**
 * 固有名詞の判定。Web 検索上位のタイトル（とサイト名部分）に出る語ほど高く、
 * X の総ヒット数が多い（ありふれた）語ほど低く採点する。総ヒット数は全候補分そろった時だけ使う。
 * 候補が2語以上でどれもタイトルに出なければ undefined（従来の緩和に任せる）。
 */
export function detectRealtimeAnchor(
  terms: string[],
  webTitles: string[],
  totals: Record<string, number> = {},
): string | undefined {
  const candidates = anchorCandidates(terms);
  if (candidates.length === 1) return candidates[0];
  const useTotals = candidates.every((t) => Number.isFinite(totals[t]) && totals[t] >= 0);
  let best: string | undefined;
  let bestScore = 0;
  for (const t of candidates) {
    let hits = 0;
    for (const title of webTitles) {
      if (termHits(t, title)) hits++;
      if (termHits(t, titleSitePart(title))) hits++;
    }
    const score = useTotals ? hits / Math.log(totals[t] + Math.E) : hits;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 公式アカウント投稿のハッシュタグから別名を検出する（=LOVE の「#イコラブ」→「イコラブ」）。
 * ハッシュタグ先頭の日本語部分を候補とし、その語で始まるタグを含む投稿が2件以上かつ30%以上のものを採る。
 * クエリ語と重なる語・汎用語を含む語は除く。
 */
export function detectAliasFromOfficialPosts(
  posts: Array<{ text?: string }>,
  queryTerms: string[],
): string | undefined {
  const tagsByPost = posts.map((p) => [...nk(p?.text || '').matchAll(/#([^\s#]+)/g)].map((m) => m[1]));
  const candidates = new Set<string>();
  for (const tags of tagsByPost) {
    for (const tag of tags) {
      const head = tag.match(/^[぀-ヿ一-鿿]{2,}/)?.[0];
      if (head) candidates.add(head);
    }
  }
  const query = queryTerms.map(squash).filter(Boolean);
  let best: string | undefined;
  let bestCount = 0;
  for (const c of candidates) {
    if (query.some((q) => q.includes(c) || c.includes(q))) continue;
    if ([...GENERIC_TERMS].some((g) => c.includes(g))) continue;
    const count = tagsByPost.filter((tags) => tags.some((tag) => tag.startsWith(c))).length;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best && bestCount >= 2 && bestCount >= posts.length * 0.3 ? best : undefined;
}

/** 投稿が語のどれかを含むか（本文と表示名。空白・中黒は無視）。 */
export function postMentions(item: { text?: string; author_name?: string }, terms: string[]): boolean {
  const haystack = squash(`${item?.text || ''} ${item?.author_name || ''}`);
  return terms.some((t) => {
    const s = squash(t);
    return s.length > 0 && haystack.includes(s);
  });
}

/** 固有名詞を含む投稿が半数未満なら壊れている（Yahoo が記号を無視して別物を返す等）。0件は判断しない。 */
export function isAnchorBroken(term: string, items: Array<{ text?: string; author_name?: string }>): boolean {
  if (items.length === 0) return false;
  return items.filter((i) => postMentions(i, [term])).length / items.length < ANCHOR_BROKEN_RATIO;
}
