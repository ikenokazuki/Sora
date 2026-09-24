/**
 * X Long-form Detail Provider (FxTwitter v2)
 *
 * Provides bounded, fail-soft detail enrichment for selected X posts.
 * - Single status ID only (^\d+$)
 * - Cached (5-min TTL) & Single-flight deduplication
 * - 1500ms timeout with zero-retry fail-soft fallback
 * - Disabled if SORA_X_DETAIL_PROVIDER=off
 */

import { getFromCache, setToCache, runWithSingleFlight } from '../cache.js';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import { tokenizeAndSelectTerms, type ParsedSection } from '../rho_select.js';
import { rerankSearchResults } from '../enrichment.js';

export interface XPostDetail {
  statusId: string;
  text: string;
  isNoteTweet?: boolean;
  author?: {
    name?: string;
    screenName?: string;
  };
  createdAt?: string;
  media?: string[];
  provider: 'fxtwitter';
}

export interface XPostDetailProvider {
  fetchStatus(statusId: string): Promise<XPostDetail | null>;
}

const DEFAULT_FXTWITTER_BASE = 'https://api.fxtwitter.com';
const DEFAULT_TIMEOUT_MS = 1500;
const DETAIL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const X_DETAIL_INSPECT_LIMIT = 5;
export const X_DETAIL_MAX_CALLS = 2;
/**
 * 経験的な保守的閾値 (conservative threshold)。
 * Yahoo Realtimeで長文切断が疑われる候補を拾うためのUTF-16 code unit長基準 (text.length)。
 * X仕様上の絶対上限という意味ではない。
 */
export const YAHOO_REALTIME_TRUNCATION_SUSPECT_MIN_CHARS = 240;

export class FxTwitterDetailProvider implements XPostDetailProvider {
  private base: string;
  private timeoutMs: number;
  private enabled: boolean;

  constructor() {
    this.base = (process.env.FXTWITTER_API_BASE || DEFAULT_FXTWITTER_BASE).replace(/\/+$/, '');
    this.timeoutMs = parseInt(process.env.FXTWITTER_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
    this.enabled = process.env.SORA_X_DETAIL_PROVIDER !== 'off';
  }

  async fetchStatus(rawStatusId: string): Promise<XPostDetail | null> {
    if (!this.enabled) {
      return null;
    }

    const statusId = (rawStatusId || '').trim();
    // Strict statusId validation: numeric digits only
    if (!/^\d+$/.test(statusId)) {
      return null;
    }

    const cacheKey = `x-detail:fxtwitter:${statusId}`;
    const cached = getFromCache<XPostDetail>(cacheKey);
    if (cached) {
      return cached;
    }

    return runWithSingleFlight(`x-detail:${statusId}`, async () => {
      // Check cache again inside single-flight
      const doubleCheck = getFromCache<XPostDetail>(cacheKey);
      if (doubleCheck) return doubleCheck;

      try {
        const url = `${this.base}/2/status/${statusId}`;
        // 指紋・間隔・SSRF検証は http_fetcher に集約。独自UAは付けない。
        const { response: res } = await fetchWithSafeRedirects(url, this.timeoutMs, 2, { Accept: 'application/json' });

        if (!res.ok) {
          return null;
        }

        const data = (await res.json()) as any;
        // Support both FxTwitter v2 { tweet: ... } and { status: ... } envelopes
        const tweetObj = data?.tweet || data?.status || data;
        if (!tweetObj) {
          return null;
        }

        const returnedId = String(tweetObj.id || tweetObj.status_id || '');
        if (returnedId !== statusId) {
          // Status ID mismatch: reject
          return null;
        }

        const text = typeof tweetObj.text === 'string' ? tweetObj.text.trim() : '';
        if (!text) {
          return null;
        }

        const isNoteTweet = Boolean(tweetObj.is_note_tweet || tweetObj.note_tweet);
        const mediaUrls: string[] = [];

        // Extract media URLs safely if present
        const mediaList = tweetObj.media?.all || tweetObj.media?.photos || tweetObj.media?.videos || [];
        if (Array.isArray(mediaList)) {
          for (const m of mediaList) {
            const mUrl = m?.url || m?.thumbnail_url;
            if (typeof mUrl === 'string' && mUrl.startsWith('http')) {
              mediaUrls.push(mUrl);
            }
          }
        }

        const authorObj = tweetObj.author;
        const author = authorObj
          ? {
              name: typeof authorObj.name === 'string' ? authorObj.name : undefined,
              screenName: typeof authorObj.screen_name === 'string' ? authorObj.screen_name : undefined,
            }
          : undefined;

        let createdAt: string | undefined;
        if (typeof tweetObj.created_at === 'string') {
          createdAt = tweetObj.created_at;
        } else if (typeof tweetObj.created_timestamp === 'number') {
          createdAt = new Date(tweetObj.created_timestamp * 1000).toISOString();
        }

        const result: XPostDetail = {
          statusId,
          text,
          isNoteTweet,
          author,
          createdAt,
          media: mediaUrls.length > 0 ? mediaUrls : undefined,
          provider: 'fxtwitter',
        };

        setToCache(cacheKey, result, DETAIL_CACHE_TTL);
        return result;
      } catch {
        // Fail-soft: timeouts, network errors, JSON parse errors immediately return null
        return null;
      }
    });
  }
}

export const defaultXDetailProvider: XPostDetailProvider = new FxTwitterDetailProvider();

// -----------------------------------------------------------------------------
// Adaptive Enrichment Trigger & Requirement Observation
// -----------------------------------------------------------------------------

export interface RequirementObservation {
  requirements: string[];
  observed: string[];
  missing: string[];
}

/**
 * Extracts pure semantic search query by removing operational modifiers
 * (e.g. id:xxx, from:xxx, @mention, -exclude, and URLs)
 */
export function extractSemanticQuery(query: string): string {
  if (!query || typeof query !== 'string') return '';
  return query
    .replace(/https?:\/\/[^\s]+/gi, ' ')
    .replace(/\b(?:id|ID|from|FROM):[a-zA-Z0-9_]+\b/g, ' ')
    .replace(/(?:^|\s)@[a-zA-Z0-9_]+\b/g, ' ')
    .replace(/(?:^|\s)-[^\s]+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Observes which query requirements appear in the candidate text.
 * Reuses tokenizeAndSelectTerms for standard Japanese/English segmentation.
 */
export function observeRequirements(
  semanticQuery: string,
  text: string,
  contextTexts: string[] = [],
): RequirementObservation {
  if (!semanticQuery || !text) {
    return { requirements: [], observed: [], missing: [] };
  }

  const allTexts = [text, ...contextTexts];
  const dummySections: ParsedSection[] = allTexts.map((t, idx) => ({
    rawHeading: '',
    heading: '',
    headingLevel: 2,
    paragraphs: [t],
    fullText: t,
    charLength: t.length,
    startIndex: idx,
  }));

  const { terms } = tokenizeAndSelectTerms(semanticQuery, dummySections, 6);
  if (terms.length === 0) {
    return { requirements: [], observed: [], missing: [] };
  }

  const lowerText = text.toLowerCase();
  const observed: string[] = [];
  const missing: string[] = [];

  for (const term of terms) {
    if (lowerText.includes(term.toLowerCase())) {
      observed.push(term);
    } else {
      missing.push(term);
    }
  }

  return { requirements: terms, observed, missing };
}

/**
 * Determines whether a Yahoo Realtime item is suspected of being truncated.
 * Gate: text.length >= YAHOO_REALTIME_TRUNCATION_SUSPECT_MIN_CHARS (240).
 * Skips already enriched items, items without valid statusId, or empty text.
 */
export function isLikelyYahooRealtimeTruncated(item: Record<string, any>): boolean {
  if (!item || typeof item !== 'object') return false;
  if (item.detailEnriched === true) return false;

  const statusId = String(item.id || item.statusId || item.status_id || item.tweetId || '').trim();
  if (!/^\d+$/.test(statusId)) return false;

  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text) return false;

  return text.length >= YAHOO_REALTIME_TRUNCATION_SUSPECT_MIN_CHARS;
}

/**
 * Realtime 専用リランキングラッパー。
 * 内部で一時的に { title, snippet, url, originalIndex } に投影し、既存 rerankSearchResults を利用。
 * ランキング後に元の item 配列へ復元し、一時プロパティを漏らさない。
 */
export function rerankRealtimeItems(
  items: Array<Record<string, any>>,
  query: string,
): Array<Record<string, any>> {
  if (!Array.isArray(items) || items.length <= 1 || !query) {
    return items || [];
  }

  const projected = items.map((item, originalIndex) => {
    const authorName = item.author_name || '';
    const authorHandle = item.author_handle ? `@${String(item.author_handle).replace(/^@/, '')}` : '';
    const title = [authorName, authorHandle].filter(Boolean).join(' ');
    const snippet = typeof item.text === 'string' ? item.text : '';
    const url = typeof item.url === 'string' ? item.url : typeof item.link === 'string' ? item.link : '';
    return {
      title,
      snippet,
      url,
      originalIndex,
    };
  });

  const ranked = rerankSearchResults(projected, query);
  return ranked.map((p) => items[p.originalIndex]);
}

export interface EnrichRealtimeOptions {
  verbose?: boolean;
}

/**
 * Canonical X realtime response cleaner.
 * - text を canonical 本文に一本化
 * - author_name + author_handle を canonical author 表現にする
 * - snippet, markdown, author, originalText, author_url, siteName などの重複を除去
 * - verbose: true の場合のみ detailDiagnostics を保持
 * - Yahoo tracking parameter (?utm_source=... 等) を url から除去
 */
export function cleanRealtimeItem(
  item: Record<string, any>,
  verbose = false,
): Record<string, any> {
  let url = typeof item.url === 'string' ? item.url : typeof item.link === 'string' ? item.link : undefined;
  if (url) {
    try {
      const u = new URL(url);
      u.searchParams.delete('utm_source');
      u.searchParams.delete('utm_medium');
      u.searchParams.delete('utm_campaign');
      url = u.toString().replace(/\?$/, '');
    } catch {}
  }

  let authorName = item.author_name;
  let authorHandle = item.author_handle;
  if (!authorName && !authorHandle && typeof item.author === 'string') {
    const m = item.author.match(/^(.*?)(?:\s*\(@?([a-zA-Z0-9_]+)\))?$/);
    if (m) {
      if (m[1]?.trim()) authorName = m[1].trim();
      if (m[2]?.trim()) authorHandle = m[2].trim();
    }
  }
  if (authorHandle) {
    authorHandle = String(authorHandle).replace(/^@/, '');
  }

  const cleaned: Record<string, any> = {
    source: 'x' as const,
    id: String(item.id || item.statusId || ''),
    ...(authorName ? { author_name: authorName } : {}),
    ...(authorHandle ? { author_handle: authorHandle } : {}),
    text: typeof item.text === 'string' ? item.text : '',
    ...(url ? { url } : {}),
    ...(item.publishedTime ? { publishedTime: item.publishedTime } : {}),
    ...(typeof item.like_count === 'number' ? { like_count: item.like_count } : {}),
    ...(typeof item.reply_count === 'number' ? { reply_count: item.reply_count } : {}),
    ...(typeof item.repost_count === 'number' ? { repost_count: item.repost_count } : {}),
    ...(Array.isArray(item.media) && item.media.length > 0 ? { media: item.media } : {}),
    ...(item.isOfficial !== undefined ? { isOfficial: item.isOfficial } : {}),
    ...(item.detailEnriched !== undefined ? { detailEnriched: item.detailEnriched } : {}),
    ...(item.detailProvider !== undefined ? { detailProvider: item.detailProvider } : {}),
    ...(item.isNoteTweet !== undefined ? { isNoteTweet: item.isNoteTweet } : {}),
  };

  if (verbose && item.detailDiagnostics) {
    cleaned.detailDiagnostics = item.detailDiagnostics;
  }

  return cleaned;
}

/**
 * Applies bounded adaptive detail enrichment to Realtime/X search items.
 *
 * Architecture (v2.24.1):
 * - Inspect up to top 5 candidates locally (X_DETAIL_INSPECT_LIMIT = 5).
 * - Gate: text.length >= 240 (isLikelyYahooRealtimeTruncated).
 * - Selector: query relevance (observed.length > 0 against author_name + author_handle + text).
 * - Relevance ranking via rerankRealtimeItems with semanticQuery.
 * - Cap external FxTwitter calls at 2 (X_DETAIL_MAX_CALLS = 2).
 * - Canonical response: text is single source of truth; snippet/markdown/originalText/author stripped.
 * - Fail-soft on all errors.
 */
export async function enrichRealtimeItemsWithXDetail(
  items: Array<Record<string, any>>,
  rawQuery: string,
  provider: XPostDetailProvider = defaultXDetailProvider,
  options?: EnrichRealtimeOptions,
): Promise<{ items: Array<Record<string, any>>; fxCalls: number }> {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: (items || []).map((it) => cleanRealtimeItem(it, options?.verbose === true)), fxCalls: 0 };
  }

  const semanticQuery = extractSemanticQuery(rawQuery);
  if (!semanticQuery) {
    return { items: items.map((it) => cleanRealtimeItem(it, options?.verbose === true)), fxCalls: 0 };
  }

  const resultItems = items.map((it) => ({ ...it }));
  let fxCalls = 0;

  const inspectItems = resultItems.slice(0, X_DETAIL_INSPECT_LIMIT);
  const contextTexts = inspectItems.map((it) => String(it.text || ''));

  // 1. Gate: Yahoo text truncation suspects
  const suspects = inspectItems.filter(isLikelyYahooRealtimeTruncated);

  // 2. Selector: Query relevance on (author_name + author_handle + text)
  const relevantSuspects = suspects.filter((item) => {
    const evidenceText = [item.author_name, item.author_handle, item.text].filter(Boolean).join('\n');
    const obs = observeRequirements(semanticQuery, evidenceText, contextTexts);
    return obs.observed.length > 0;
  });

  // 3. Ranking: Rank relevant suspects by original semantic query
  const ranked = rerankRealtimeItems(relevantSuspects, semanticQuery);

  // 4. Bounded FxTwitter fetch (capped at X_DETAIL_MAX_CALLS = 2)
  for (const item of ranked) {
    if (fxCalls >= X_DETAIL_MAX_CALLS) break;

    const statusId = String(item.id || item.statusId || item.status_id || item.tweetId || '').trim();
    if (!/^\d+$/.test(statusId)) continue;

    fxCalls++;
    const detail = await provider.fetchStatus(statusId);

    if (detail && detail.text) {
      const originalText = item.text;
      item.text = detail.text;
      item.detailEnriched = true;
      item.detailProvider = 'fxtwitter';

      if (detail.isNoteTweet) {
        item.isNoteTweet = true;
      }
      if (detail.media && detail.media.length > 0) {
        item.media = detail.media;
      }

      delete item.snippet;
      delete item.markdown;
      delete item.originalText;

      if (options?.verbose) {
        item.detailDiagnostics = {
          provider: 'fxtwitter',
          originalText: typeof originalText === 'string' ? originalText : '',
          originalLength: typeof originalText === 'string' ? originalText.length : 0,
          enrichedLength: detail.text.length,
        };
      }
    }
  }

  const cleanedItems = resultItems.map((it) => cleanRealtimeItem(it, options?.verbose === true));
  return { items: cleanedItems, fxCalls };
}
