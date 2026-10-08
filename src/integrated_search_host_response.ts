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
 * `highlights` is NEVER removed.
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
    hasCanonicalHighlights(item);

  if (mayElideMarkdown) {
    delete item.markdown;
  }

  return item;
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
    let kept = safeTruncateMarkdown(md, quota[i]);
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
  result: Record<string, any>,
  options: IntegratedSearchHostResponseOptions = {},
): Record<string, any> {
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

  // Preserve legacy pretty JSON for the default/full path.
  // Evidence mode uses compact JSON because the caller explicitly requested
  // a token-conscious Host surface.
  return options.responseMode === 'evidence' && options.verbose !== true
    ? JSON.stringify(formatted)
    : JSON.stringify(formatted, null, 2);
}
