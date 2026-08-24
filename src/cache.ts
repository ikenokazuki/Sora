import {
  dbGetCache,
  dbSetCache,
  dbDeleteCache,
  dbClearExpiredCache,
  dbClearAllCache,
} from './db.js';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  createdAt: number;
}

export const CACHE_TTL_DEFAULT = 30 * 60 * 1000; // 30分
export const CACHE_TTL_WEATHER = 60 * 60 * 1000; // 1時間
export const CACHE_TTL_TREND = 2 * 60 * 1000;   // 2分
export const CACHE_TTL_REALTIME = 3 * 60 * 1000; // 3分

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

export function getFromCache<T>(key: string): (T & { cached: true; cachedAt?: string; ageSeconds?: number }) | null {
  const now = Date.now();

  // 1. L1 メモリキャッシュの参照 (0ms)
  const entry = memoryCache.get(key);
  if (entry) {
    if (now > entry.expiresAt) {
      memoryCache.delete(key);
      dbDeleteCache(key);
      cacheMisses++;
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
    const createdAt = persistent.expiresAt - CACHE_TTL_DEFAULT;
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

  cacheMisses++;
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

export async function runWithSingleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = fn().finally(() => {
    inFlightRequests.delete(key);
  });

  inFlightRequests.set(key, promise);
  return promise;
}
