/**
 * Yahoo Web search result cache with stale-while-throttled semantics
 * (Retrieval v2, spec sections 30-32).
 *
 * The generic cache (`src/cache.ts`) deletes entries on expiry, so it
 * cannot serve stale results. This Yahoo-side store keeps both a fresh
 * window and a longer stale window per entry. Callers serve stale entries
 * only on provider cooldown, open circuit, 429, or transient errors;
 * generic cache semantics stay untouched.
 */

export interface YahooSearchCacheEntry<T = any> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

export const YAHOO_SEARCH_FRESH_TTL_MS = 5 * 60 * 1000;
export const YAHOO_SEARCH_STALE_TTL_MS = 30 * 60 * 1000;
const MAX_YAHOO_SEARCH_ENTRIES = 500;

const store = new Map<string, YahooSearchCacheEntry>();

export function setYahooSearchCache<T>(
  key: string,
  value: T,
  freshTtlMs: number = YAHOO_SEARCH_FRESH_TTL_MS,
  staleTtlMs: number = YAHOO_SEARCH_STALE_TTL_MS,
  now: number = Date.now(),
): void {
  if (store.size >= MAX_YAHOO_SEARCH_ENTRIES) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, {
    value,
    freshUntil: now + Math.max(0, freshTtlMs),
    staleUntil: now + Math.max(0, Math.max(freshTtlMs, staleTtlMs)),
  });
}

/** Fresh hits only. Never returns stale entries. */
export function getYahooFreshCache<T>(key: string, now: number = Date.now()): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (now > entry.staleUntil) {
    store.delete(key);
    return null;
  }
  if (now > entry.freshUntil) return null;
  return entry.value as T;
}

/** Stale-window hits only (past fresh, within stale). Never returns fresh entries. */
export function getYahooStaleCache<T>(key: string, now: number = Date.now()): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (now > entry.staleUntil) {
    store.delete(key);
    return null;
  }
  if (now <= entry.freshUntil) return null;
  return entry.value as T;
}

/** Test/support escape hatch. */
export function clearYahooSearchCache(): void {
  store.clear();
}
