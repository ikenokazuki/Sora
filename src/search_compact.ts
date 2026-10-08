/**
 * Search compact response serializers (Token Optimization v1).
 *
 * Retrieve wide → rank well → return compact.
 *
 * These helpers are pure response shaping applied at public boundaries
 * (MCP handlers, REST routes). Retrieval, waves, rerank, dedup, provider
 * call counts, and internal models are untouched: removing the serializer
 * call restores the previous response shape (rollback-safe).
 *
 * Convention follows the existing verbose architecture:
 * - default (verbose !== true): compact, answer-generation fields only.
 * - verbose === true: identity passthrough, full diagnostics preserved.
 */

export interface CompactResponseOptions {
  verbose?: boolean;
}

export interface SerializedResponseSize {
  chars: number;
  bytes: number;
}

/**
 * Deterministic response size metric for Before/After comparison.
 * Uses JSON serialized length (chars) and UTF-8 byte count.
 * Test/diagnostics use only; never embedded in production responses.
 */
export function measureSerializedResponseSize(value: unknown): SerializedResponseSize {
  const json = JSON.stringify(value) ?? '';
  return { chars: json.length, bytes: new TextEncoder().encode(json).length };
}

/** Verbose-only realtime provenance keys: safe to omit in compact mode. */
const REALTIME_VERBOSE_KEYS = [
  'retrievalQueries',
  'contributingQueries',
  'resultsMerged',
  'executedWaves',
  'stopReason',
  'requiredTerms',
  'coveredTerms',
  'anchorTerm',
  'anchorFiltered',
] as const;

/**
 * Compact Yahoo Realtime response.
 * Keeps: source, originalQuery, effectiveQuery, isFallback, count, items
 * (item order, ids, urls, core text, author constraints untouched),
 * plus missingTerms (only when non-empty) and aliasTerms as answer-gap signals.
 */
export function formatCompactRealtimeResponse<T extends Record<string, any> | null | undefined>(
  result: T,
  options: CompactResponseOptions = {},
): T {
  if (!result || typeof result !== 'object' || options?.verbose === true) return result;
  const out: Record<string, any> = { ...result };
  for (const key of REALTIME_VERBOSE_KEYS) delete out[key];
  if (Array.isArray(out.missingTerms) && out.missingTerms.length === 0) delete out.missingTerms;
  if (Array.isArray(out.items)) {
    out.items = out.items.map(stripInternalItemKeys);
  }
  return out as T;
}

/** Per-item internal routing/scoring keys (RFC compatibility).
 * Provider ranks, fusion scores, lexical diagnostics and selection
 * reasons are verbose-only; compact responses keep evidence fields.
 */
const INTERNAL_ITEM_KEYS = [
  'providerRank',
  'providerRanks',
  'providerSort',
  'retrievalQuery',
  'retrievalQueryIndex',
  'retrievalWave',
  'rrfScore',
  'lexicalScore',
  'selectionReason',
] as const;

function stripInternalItemKeys<T>(item: T): T {
  if (!item || typeof item !== 'object') return item;
  const compact: Record<string, any> = { ...(item as Record<string, any>) };
  for (const key of INTERNAL_ITEM_KEYS) delete compact[key];
  return compact as T;
}

/**
 * Compact Yahoo Web Search response.
 * Keeps item evidence fields (title, url, snippet, description, highlights)
 * and small root scalars; drops union provenance.
 */
export function formatCompactWebSearchResponse<T extends Record<string, any> | null | undefined>(
  result: T,
  options: CompactResponseOptions = {},
): T {
  if (!result || typeof result !== 'object' || options?.verbose === true) return result;
  const out: Record<string, any> = { ...result };
  delete out.retrievalQueries;
  // bindingQuery always duplicates originalQuery on the union path.
  delete out.bindingQuery;
  if (Array.isArray(out.items)) {
    out.items = out.items.map(stripInternalItemKeys);
  }
  return out as T;
}

/** Verbose-only integrated realtime provenance keys. */
const INTEGRATED_REALTIME_VERBOSE_KEYS = [
  'retrievalQueries',
  'contributingQueries',
  'resultsMerged',
  'anchorTerm',
  'anchorFiltered',
] as const;

function searchItemIdentity(item: Record<string, any>): string | undefined {
  const rawUrl = item.url || item.link;
  try {
    const url = new URL(rawUrl);
    if (/^(?:www\.)?(?:x|twitter)\.com$/i.test(url.hostname)) {
      const id = url.pathname.match(/\/(?:i\/web\/)?status\/(\d+)(?:\/|$)/)?.[1];
      if (id) return `x:${id}`;
    }
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(?:fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `url:${url.toString()}`;
  } catch {
    if (item.source === 'x' && /^\d+$/.test(String(item.id))) return `x:${item.id}`;
    return undefined;
  }
}

function mergeSearchItems(first: Record<string, any>, next: Record<string, any>, sources: string[]): Record<string, any> {
  const out = { ...next, ...first };
  for (const key of ['markdown', 'content', 'text', 'snippet', 'description']) {
    if (typeof next[key] === 'string' && (!first[key] || next[key].length > first[key].length)) out[key] = next[key];
  }
  if (first.isOfficial === true || next.isOfficial === true) out.isOfficial = true;
  out.retrievalSources = [...new Set([...(first.retrievalSources || []), ...(next.retrievalSources || []), ...sources])];
  return out;
}

/** Exact identity merging always runs, including full/verbose output. */
function mergeIntegratedSearchDuplicates<T extends Record<string, any>>(result: T): T {
  if (!Array.isArray(result.results)) return result;
  let changed = false;
  const mergeBranch = (items: Record<string, any>[], source: string) => {
    const unique: Record<string, any>[] = [];
    const positions = new Map<string, number>();
    for (const item of items) {
      const key = searchItemIdentity(item);
      const position = key ? positions.get(key) : undefined;
      if (position !== undefined) {
        unique[position] = mergeSearchItems(unique[position], item, [source]);
        changed = true;
      } else {
        if (key) positions.set(key, unique.length);
        unique.push(item);
      }
    }
    return unique;
  };
  let results = mergeBranch(result.results, 'web');
  let realtime = result.realtime;
  if (Array.isArray(realtime?.items)) {
    const webByIdentity = new Map(results.map((item) => [searchItemIdentity(item), item]).filter(([key]) => key !== undefined) as [string, Record<string, any>][]);
    const mergedWeb = new Set<Record<string, any>>();
    const items = mergeBranch(realtime.items, 'realtime').map((item) => {
      const key = searchItemIdentity(item);
      const web = key?.startsWith('x:') ? webByIdentity.get(key) : undefined;
      if (!web) return item;
      changed = true;
      mergedWeb.add(web);
      return mergeSearchItems(item, web, ['web', 'realtime']);
    });
    results = results.filter((item) => !mergedWeb.has(item));
    realtime = { ...realtime, items, ...('count' in realtime ? { count: items.length } : {}) };
  }
  return changed ? { ...result, results, ...('count' in result ? { count: results.length } : {}), ...(realtime ? { realtime } : {}) } : result;
}

/**
 * Compact integrated search response.
 * Item order and evidence fields pass through untouched; per-item
 * internal routing/scoring keys are verbose-only.
 * searchDiagnostics is already verbose-gated upstream; left as-is.
 */
export function formatCompactIntegratedSearchResponse<
  T extends Record<string, any> | null | undefined,
>(result: T, options: CompactResponseOptions = {}): T {
  if (!result || typeof result !== 'object') return result;
  const merged = mergeIntegratedSearchDuplicates(result);
  if (options?.verbose === true) return merged;
  const out: Record<string, any> = { ...merged };
  if (Array.isArray(out.results)) {
    out.results = out.results.map(stripInternalItemKeys);
  }
  if (out.realtime && typeof out.realtime === 'object') {
    const realtime: Record<string, any> = { ...out.realtime };
    for (const key of INTEGRATED_REALTIME_VERBOSE_KEYS) delete realtime[key];
    if (Array.isArray(realtime.items)) {
      realtime.items = realtime.items.map(stripInternalItemKeys);
    }
    out.realtime = realtime;
  }
  return out as T;
}
