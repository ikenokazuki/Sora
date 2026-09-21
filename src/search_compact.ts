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
  'missingTerms',
] as const;

/**
 * Compact Yahoo Realtime response.
 * Keeps: source, originalQuery, effectiveQuery, isFallback, count, items
 * (item order, ids, urls, core text, author constraints untouched).
 */
export function formatCompactRealtimeResponse<T extends Record<string, any> | null | undefined>(
  result: T,
  options: CompactResponseOptions = {},
): T {
  if (!result || typeof result !== 'object' || options?.verbose === true) return result;
  const out: Record<string, any> = { ...result };
  for (const key of REALTIME_VERBOSE_KEYS) delete out[key];
  return out as T;
}

/** Per-item web union provenance keys: internal routing only. */
const WEB_ITEM_VERBOSE_KEYS = ['retrievalQuery', 'retrievalQueryIndex'] as const;

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
    out.items = out.items.map((item: any) => {
      if (!item || typeof item !== 'object') return item;
      const compact: Record<string, any> = { ...item };
      for (const key of WEB_ITEM_VERBOSE_KEYS) delete compact[key];
      return compact;
    });
  }
  return out as T;
}

/** Verbose-only integrated realtime provenance keys. */
const INTEGRATED_REALTIME_VERBOSE_KEYS = [
  'retrievalQueries',
  'contributingQueries',
  'resultsMerged',
] as const;

/**
 * Compact integrated search response.
 * Web results and realtime items pass through untouched (order preserved);
 * realtime envelope provenance is verbose-only.
 * searchDiagnostics is already verbose-gated upstream; left as-is.
 */
export function formatCompactIntegratedSearchResponse<
  T extends Record<string, any> | null | undefined,
>(result: T, options: CompactResponseOptions = {}): T {
  if (!result || typeof result !== 'object' || options?.verbose === true) return result;
  const out: Record<string, any> = { ...result };
  if (out.realtime && typeof out.realtime === 'object') {
    const realtime: Record<string, any> = { ...out.realtime };
    for (const key of INTEGRATED_REALTIME_VERBOSE_KEYS) delete realtime[key];
    out.realtime = realtime;
  }
  return out as T;
}
