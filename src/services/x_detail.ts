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
import { tokenizeAndSelectTerms, type ParsedSection } from '../rho_select.js';

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
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Sora-Search/2.23 (Detail-Enrichment; +https://github.com/ikenokazuki/Sora)',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

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
 * Applies bounded adaptive detail enrichment to Realtime/X search items.
 *
 * Constraints (Section 9):
 * - Never fetch all candidates.
 * - Inspect only top 2 candidates.
 * - Case A: Top candidate has all requirements -> 0 requests.
 * - Case B: Top1 has relevant seed (observed >= 1) but evidence gap (missing > 0) -> fetch top1.
 * - Case C: Top1 has 0 observed terms -> do not fetch top1, inspect top2.
 * - Case D: Top1 fetch failed/unusable and top2 has partial terms -> fetch top2.
 * - Maximum 2 FxTwitter calls per search.
 */
export async function enrichRealtimeItemsWithXDetail(
  items: Array<Record<string, any>>,
  rawQuery: string,
  provider: XPostDetailProvider = defaultXDetailProvider,
): Promise<{ items: Array<Record<string, any>>; fxCalls: number }> {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: items || [], fxCalls: 0 };
  }

  const semanticQuery = extractSemanticQuery(rawQuery);
  if (!semanticQuery) {
    return { items, fxCalls: 0 };
  }

  const resultItems = items.map((it) => ({ ...it }));
  let fxCalls = 0;
  const maxCalls = 2;

  const candidateTexts = resultItems.slice(0, 5).map((it) => String(it.text || it.content || it.snippet || ''));

  // Inspect up to top 2 items
  for (let i = 0; i < Math.min(resultItems.length, 2) && fxCalls < maxCalls; i++) {
    const item = resultItems[i];
    const itemText = String(item.text || item.content || item.snippet || '');
    const statusId = String(item.id || item.statusId || item.status_id || item.tweetId || '').trim();

    if (!/^\d+$/.test(statusId)) {
      continue;
    }

    const obs = observeRequirements(semanticQuery, itemText, candidateTexts);

    const isTruncatedSnippet = /[\u2026\.\.]$/.test(itemText.trim()) || itemText.endsWith('…') || itemText.endsWith('...');

    // Case A: Top candidate already observes all requirements and is NOT truncated -> No need for enrichment
    if (obs.requirements.length > 0 && obs.missing.length === 0 && !isTruncatedSnippet) {
      if (i === 0) {
        // Top1 is sufficient; stop immediately
        break;
      }
      continue;
    }

    // Case B & Case D: Relevant seed (observed >= 1) but evidence gap (missing > 0 or truncated snippet)
    if (obs.observed.length > 0 && (obs.missing.length > 0 || isTruncatedSnippet)) {
      fxCalls++;
      const detail = await provider.fetchStatus(statusId);

      if (detail && detail.text) {
        // Success: Merge full text
        item.originalText = itemText;
        item.text = detail.text;
        item.snippet = detail.text;
        item.markdown = detail.text;
        if (detail.isNoteTweet) {
          item.isNoteTweet = true;
        }
        if (detail.media && detail.media.length > 0) {
          item.media = detail.media;
        }
        item.detailEnriched = true;
        item.detailProvider = 'fxtwitter';
      }
    }
    // Case C: observed === 0 -> Skip without calling Fx, loop will inspect top2
  }

  return { items: resultItems, fxCalls };
}
