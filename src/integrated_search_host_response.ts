import { safeTruncateMarkdown } from './enrichment.js';
import {
  type ScrapeFormat,
  IntegratedSearchResponseModeSchema,
  type IntegratedSearchResponseMode,
} from './types.js';

export { IntegratedSearchResponseModeSchema, type IntegratedSearchResponseMode };

export interface IntegratedSearchHostResponseOptions {
  responseMode?: IntegratedSearchResponseMode;
  explicitFormats?: readonly ScrapeFormat[];
  extractHighlights?: boolean;
  verbose?: boolean;
  /** 全結果の markdown 合計文字数の上限。未指定なら制限しない。 */
  maxTotalChars?: number;
  /** false のとき、画像・動画の URL（ogImage・media・本文中の画像記法）を省く。未指定は従来どおり含める。 */
  includeMedia?: boolean;
}

function hasCanonicalHighlights(item: Record<string, any>): boolean {
  return (
    Array.isArray(item?.highlights) &&
    item.highlights.some(
      (value: unknown) =>
        typeof value === 'string' && value.trim().length > 0,
    )
  );
}

function isXItem(item: Record<string, any>): boolean {
  if (item?.source === 'x') return true;

  const rawUrl =
    typeof item?.url === 'string'
      ? item.url
      : typeof item?.link === 'string'
        ? item.link
        : '';

  if (!rawUrl) return false;

  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'x.com' ||
      host.endsWith('.x.com') ||
      host === 'twitter.com' ||
      host.endsWith('.twitter.com')
    );
  } catch {
    return false;
  }
}

/**
 * A conservative, Host-facing evidence projection for one integrated-search item.
 *
 * This function deliberately preserves the existing JSON properties and only
 * considers removing `markdown`.
 *
 * `markdown` is NEVER overwritten with highlights.
 * `highlights` is NEVER removed here (compact mode may replace a duplicate with `highlightsSameAs`).
 */
export function projectIntegratedSearchEvidenceItem(
  sourceItem: Record<string, any>,
  options: IntegratedSearchHostResponseOptions = {},
): Record<string, any> {
  const item = { ...sourceItem };

  const markdownWasExplicitlyRequested =
    options.explicitFormats?.includes('markdown') === true;

  const highlightExtractionWasExplicitlyDisabled =
    options.extractHighlights === false;

  const hasFallbackRisk =
    Boolean(item?.scrapeError) || item?.isSnippetFallback === true;

  const mayElideMarkdown =
    !markdownWasExplicitlyRequested &&
    !highlightExtractionWasExplicitlyDisabled &&
    !hasFallbackRisk &&
    !isXItem(item) &&
    // 同じハイライトが別の結果にある（highlightsSameAs）場合も、根拠はそちらで足りる
    (hasCanonicalHighlights(item) || typeof item?.highlightsSameAs === 'string');

  if (mayElideMarkdown) {
    delete item.markdown;
  }

  return item;
}

// ponytail: URL に ')' を含む画像記法は対象外
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;

/** 画像・動画の URL を省く。本文中の画像記法は alt があれば「[画像: alt]」に置き換える。images（formats で明示要求）・highlights は触らない。 */
function stripMedia(result: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...result };
  if (Array.isArray(out.results)) {
    out.results = out.results.map((item: Record<string, any>) => {
      if (!item || typeof item !== 'object') return item;
      const { ogImage: _og, media: _media, ...rest } = item;
      if (typeof rest.markdown === 'string') {
        rest.markdown = rest.markdown.replace(MARKDOWN_IMAGE, (_m: string, alt: string) => (alt.trim() ? `[画像: ${alt.trim()}]` : ''));
      }
      return rest;
    });
  }
  if (out.realtime && Array.isArray(out.realtime.items)) {
    out.realtime = {
      ...out.realtime,
      items: out.realtime.items.map((item: Record<string, any>) => {
        if (!item || typeof item !== 'object') return item;
        const { media: _media, ...rest } = item;
        return rest;
      }),
    };
  }
  return out;
}

const NAV_LABEL_MAX_CHARS = 16;
const LINK_ONLY_LINE = /^(?:[-*+]|\d+\.)?\s*\[([^\]\n]*)\]\([^)\n]*\)$/;

/** 行がすべて「[短いラベル](URL)」だけの塊（グローバルナビ・パンくず・フッターのリンク列） */
function isNavBlock(block: string): boolean {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => {
    const m = l.match(LINK_ONLY_LINE);
    return m !== null && m[1].trim().length <= NAV_LABEL_MAX_CHARS;
  });
}

/**
 * 切り詰める前に、ナビゲーションのリンクだけの塊を本文より後ろへ回す（削除はしない。切るときに最初に落ちる）。
 * 先頭のフロントマターは先頭に残す。コードフェンスを含む Markdown は動かさない。
 * ponytail: ラベルが短いリンクだけの塊＝ナビとみなす。ラベルの短いニュース一覧は誤ってナビ扱いになりうる
 * （落ちる順が後ろになるだけで消えはしない）。ハイライト位置を優先する窓選択に置き換え可能。
 */
function demoteNavBlocks(markdown: string): string {
  if (markdown.includes('```')) return markdown;
  const front = markdown.match(/^---\n[\s\S]*?\n---(?:\n{2,}|\n?$)/)?.[0] ?? '';
  const blocks = markdown.slice(front.length).split(/\n{2,}/);
  const body = blocks.filter((b) => !isNavBlock(b));
  const nav = blocks.filter((b) => isNavBlock(b));
  if (nav.length === 0 || body.length === 0) return markdown;
  return front + [...body, ...nav].join('\n\n');
}

/**
 * 結果の markdown 合計を maxTotalChars に収める。順位 i に重み 1/(i+1) で配分し、
 * 取り分より短いページは全文を残して、余りを残りのページへ再配分する（重み付き max-min）。
 * highlights は触らない。切り詰めた結果には markdownTruncated を付け、段落境界（無ければ文字境界）で切る。
 * ponytail: 先頭側を残す単純切り詰め。ハイライト位置を優先する窓選択は必要になれば追加。
 */
function applyMarkdownBudget(
  results: Record<string, any>[],
  maxTotalChars: number,
): Record<string, any>[] {
  const len = results.map((it) => (typeof it?.markdown === 'string' ? it.markdown.length : 0));
  const w = len.map((n, i) => (n > 0 ? 1 / (i + 1) : 0));
  const quota: number[] = len.map(() => Infinity);
  let open = len.map((n, i) => i).filter((i) => len[i] > 0);
  let remaining = maxTotalChars;

  for (let moved = true; moved && open.length > 0; ) {
    moved = false;
    const wSum = open.reduce((a, i) => a + w[i], 0);
    for (const i of open) {
      const share = (remaining * w[i]) / wSum;
      if (len[i] <= share) {
        quota[i] = len[i];
        moved = true;
      }
    }
    if (moved) {
      remaining -= open.filter((i) => quota[i] !== Infinity).reduce((a, i) => a + len[i], 0);
      open = open.filter((i) => quota[i] === Infinity);
    } else {
      for (const i of open) quota[i] = Math.floor((remaining * w[i]) / wSum);
    }
  }

  return results.map((it, i) => {
    if (len[i] === 0 || len[i] <= quota[i]) return it;
    const md: string = it.markdown;
    const ordered = demoteNavBlocks(md);
    let kept = safeTruncateMarkdown(ordered, quota[i]);
    // safeTruncateMarkdown は開いたコードブロックを閉じるため数文字はみ出しうる。その分だけ手前で切り直す
    if (kept.length > quota[i]) kept = safeTruncateMarkdown(ordered, Math.max(0, 2 * quota[i] - kept.length));
    const para = kept.lastIndexOf('\n\n');
    if (para > quota[i] * 0.5) kept = kept.slice(0, para).trimEnd();
    return { ...it, markdown: kept, markdownTruncated: { totalChars: md.length, keptChars: kept.length } };
  });
}

/**
 * Host-facing boundary for integrated search.
 *
 * `full` is the default and returns the original object by identity.
 * `verbose` always forces full.
 *
 * `evidence` is explicit opt-in and is intentionally query-selective.
 * It preserves the existing JSON envelope/properties and only removes
 * per-result `markdown` when conservative safety conditions allow it.
 */
export function formatIntegratedSearchHostResponse(
  source: Record<string, any>,
  options: IntegratedSearchHostResponseOptions = {},
): Record<string, any> {
  const result = options.includeMedia === false ? stripMedia(source) : source;
  const mode = options.responseMode ?? 'full';
  const budget = options.maxTotalChars;
  const withBudget = (r: Record<string, any>) =>
    budget && Array.isArray(r?.results) ? { ...r, results: applyMarkdownBudget(r.results, budget) } : r;

  if (mode === 'full' || options.verbose === true) {
    return withBudget(result);
  }

  return withBudget({
    ...result,
    responseMode: 'evidence',
    results: Array.isArray(result?.results)
      ? result.results.map((item: Record<string, any>) =>
          projectIntegratedSearchEvidenceItem(item, options),
        )
      : result?.results,
  });
}

export function serializeIntegratedSearchMcpResponse(
  result: Record<string, any>,
  options: IntegratedSearchHostResponseOptions = {},
): string {
  const formatted = formatIntegratedSearchHostResponse(result, options);

  // 整形なしの JSON で返す（中身は同じで、整形ありより約10%少ないトークン）。
  // verbose は人が読む診断用なので整形する。
  return options.verbose === true
    ? JSON.stringify(formatted, null, 2)
    : JSON.stringify(formatted);
}
