import { createHash } from 'crypto';
import {
  dbGetCache,
  dbSetCache,
  dbDeleteCache,
  dbClearExpiredCache,
  dbClearAllCache,
  dbClearCacheByPrefix,
  dbPurgeOldApiUsage,
  dbPurgeOldWatchHistory,
} from './db.js';
import { tenantCacheKey } from './security/tenant_state.js';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  createdAt: number;
}

export const CACHE_TTL_DEFAULT = 30 * 60 * 1000; // 30分
export const CACHE_TTL_WEATHER = 60 * 60 * 1000; // 1時間
export const CACHE_TTL_TREND = 2 * 60 * 1000;   // 2分
/** 結果が空・使える中身が無い応答の TTL。一時的な不調を長く残さず、同じ検索の連打だけを防ぐ。 */
export const CACHE_TTL_EMPTY = 60 * 1000; // 1分

/** 検索系の応答が空か（items / results が 0 件、またはそれらが無く count が 0）。 */
export function isEmptySearchResult(result: unknown): boolean {
  const r = result as { items?: unknown; results?: unknown; count?: unknown } | null | undefined;
  if (!r || typeof r !== 'object') return false;
  if (Array.isArray(r.items)) return r.items.length === 0;
  if (Array.isArray(r.results)) return r.results.length === 0;
  return r.count === 0;
}

/**
 * 検索系の応答を残す期間。空なら短く、そうでなければ既定。同梱のバイナリが返したエラーの文（JSON でない応答。
 * items が無く raw に入る）も一時的な不調なので短くする
 */
export function searchCacheTtl(result: unknown): number {
  const r = result as { raw?: unknown; items?: unknown } | null | undefined;
  const upstreamError = Boolean(r) && typeof r === 'object' && 'raw' in (r as object) && !('items' in (r as object));
  return isEmptySearchResult(result) || upstreamError ? CACHE_TTL_EMPTY : CACHE_TTL_DEFAULT;
}
/**
 * キャッシュキーの本体を、結果に影響する入力から作る。
 *
 * `Options` の項目は、`parts` に入れるか `Ignored` に挙げるかのどちらかを必ず選ぶ（どちらでもないと型エラー）。
 * 項目を足したときにキーへの追加を忘れ、別のリクエストの結果を返してしまうのを防ぐ。
 * 既定値の解決は呼び出し側で済ませてから渡す（未指定と既定値が同じキーになる）。
 */
export function cacheKeyDigest<Options, Ignored extends keyof Options = never>(
  parts: Record<Exclude<keyof Options, Ignored>, unknown>,
): string {
  const json = JSON.stringify(parts, (_key, value) => (value === undefined ? null : value));
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

const MAX_CACHE_SIZE = 3000;
const MAX_CACHE_ENTRY_BYTES = 2 * 1024 * 1024; // 1エントリ最大2MB

const memoryCache = new Map<string, CacheEntry<any>>();

let cacheHits = 0;
let cacheMisses = 0;

export function getCacheMetrics() {
  const total = cacheHits + cacheMisses;
  return {
    size: memoryCache.size,
    maxSize: MAX_CACHE_SIZE,
    hits: cacheHits,
    misses: cacheMisses,
    hitRatio: total > 0 ? parseFloat((cacheHits / total).toFixed(4)) : 0,
  };
}

export function getCacheSize(): number {
  return memoryCache.size;
}

export function clearCache(): number {
  const count = memoryCache.size;
  memoryCache.clear();
  dbClearAllCache();
  cacheHits = 0;
  cacheMisses = 0;
  return count;
}

/**
 * その tenant のキャッシュだけを消す（tenant の保存済みの状態で得た結果のキー `tenant:<ID>:…`。security/tenant_state.ts）。
 * 共有のキー（状態を使わずに得た結果）と、ほかの tenant のキーは残す。全体の統計（hits・misses）も消さない。消したメモリの行の数を返す
 */
export function clearTenantCache(tenantId: string): number {
  const prefix = tenantCacheKey(tenantId, '');
  let count = 0;
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) {
      memoryCache.delete(key);
      count++;
    }
  }
  dbClearCacheByPrefix(prefix);
  return count;
}

/** 期限切れキャッシュエントリの一括スイープ（定期 GC） */
export function sweepExpiredEntries(): number {
  const now = Date.now();
  let deletedCount = 0;
  for (const [key, entry] of memoryCache.entries()) {
    if (now > entry.expiresAt) {
      memoryCache.delete(key);
      deletedCount++;
    }
  }
  dbClearExpiredCache();
  dbPurgeOldApiUsage();
  dbPurgeOldWatchHistory();
  return deletedCount;
}

// 10分おきに期限切れキャッシュの自動スイープを実行
if (typeof setInterval !== 'undefined') {
  const sweepTimer = setInterval(() => {
    sweepExpiredEntries();
  }, 10 * 60 * 1000);
  // プロセス終了をブロックしない
  if (sweepTimer.unref) sweepTimer.unref();
}

/**
 * キャッシュを読む。countMiss: false は、外れを数えない（tenant のキーを先に読み、外れたら共有のキーを読むときに、1 回の読みを 2 回の外れとして数えないため）。
 */
export function getFromCache<T>(key: string, { countMiss = true }: { countMiss?: boolean } = {}): (T & { cached: true; cachedAt?: string; ageSeconds?: number }) | null {
  const now = Date.now();

  // 1. L1 メモリキャッシュの参照 (0ms)
  const entry = memoryCache.get(key);
  if (entry) {
    if (now > entry.expiresAt) {
      memoryCache.delete(key);
      dbDeleteCache(key);
      if (countMiss) cacheMisses++;
      return null;
    }
    // 真の LRU: 参照されたエントリを末尾（最新）に移動
    memoryCache.delete(key);
    memoryCache.set(key, entry);

    cacheHits++;
    const ageSeconds = Math.max(0, Math.floor((now - entry.createdAt) / 1000));
    return {
      ...entry.data,
      cached: true,
      cachedAt: new Date(entry.createdAt).toISOString(),
      ageSeconds,
    };
  }

  // 2. L2 SQLite 永続キャッシュの参照 (プロセス再起動後の復元)
  const persistent = dbGetCache<T>(key);
  if (persistent) {
    // L2 行の作成時刻をそのまま使う。欠損時のみ旧来の推定にフォールバック。
    const createdAt =
      typeof persistent.createdAt === 'number' && Number.isFinite(persistent.createdAt)
        ? persistent.createdAt
        : persistent.expiresAt - CACHE_TTL_DEFAULT;
    // L1 メモリキャッシュへ昇格
    memoryCache.set(key, {
      data: { ...persistent.value, cached: false },
      expiresAt: persistent.expiresAt,
      createdAt,
    });
    cacheHits++;
    const ageSeconds = Math.max(0, Math.floor((now - createdAt) / 1000));
    return {
      ...persistent.value,
      cached: true,
      cachedAt: new Date(createdAt).toISOString(),
      ageSeconds,
    };
  }

  if (countMiss) cacheMisses++;
  return null;
}

export function setToCache<T>(key: string, data: T, ttlMs = CACHE_TTL_DEFAULT): boolean {
  // 巨大エントリ（2MB 超過）のキャッシュ保存スキップによるメモリ保護
  try {
    const serialized = JSON.stringify(data);
    if (serialized && serialized.length > MAX_CACHE_ENTRY_BYTES) {
      return false;
    }
  } catch {
    return false;
  }

  if (memoryCache.size >= MAX_CACHE_SIZE) {
    // LRU: 最も古い（先頭の）15% を削除
    const keysToDelete = Array.from(memoryCache.keys()).slice(0, Math.floor(MAX_CACHE_SIZE * 0.15));
    for (const k of keysToDelete) memoryCache.delete(k);
  }

  // 既存キーがあれば一度削除して末尾に追加
  if (memoryCache.has(key)) {
    memoryCache.delete(key);
  }

  const now = Date.now();
  const expiresAt = now + ttlMs;
  memoryCache.set(key, {
    data: { ...data, cached: false },
    expiresAt,
    createdAt: now,
  });

  // L2 SQLite へ非同期的に永続保存
  dbSetCache(key, data, Math.ceil(ttlMs / 1000));
  return true;
}

// ==========================================
// Single-Flight (In-flight Deduplication)
// ==========================================
const inFlightRequests = new Map<string, Promise<any>>();

export async function runWithSingleFlight<T>(key: string, fn: () => Promise<T>, onJoin?: () => void): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) {
    try { onJoin?.(); } catch {}
    return existing as Promise<T>;
  }

  const promise = fn().finally(() => {
    inFlightRequests.delete(key);
  });

  inFlightRequests.set(key, promise);
  return promise;
}
