// tenant の保存済みの状態（Cookie・localStorage）で得た結果の、キャッシュの読み書き（設計 5。穴 16・17）。
// 取得の側（静的取得・ブラウザ）が、状態つきで始めたときに印を立て（tenant_state.ts）、置く側が、その印で置く先を決める。
// scrapeUrl・integratedSearch・mapSiteUrl・searchWebForRest が、同じ規則で使う。
import { getFromCache, setToCache } from '../cache.js';
import { incrementSecurityCounter } from './metrics.js';
import { tenantCacheKey, tenantStateUsed } from './tenant_state.js';

/** 読む: その tenant のキー、共有のキーの順。外れは、1 回の読みにつき 1 回だけ数える */
export function getFromTenantCache<T>(tenantId: string, key: string): ReturnType<typeof getFromCache<T>> {
  return getFromCache<T>(tenantCacheKey(tenantId, key), { countMiss: false }) ?? getFromCache<T>(key);
}

/**
 * 置く: いまの範囲（trackTenantState）で、取得が tenant の保存済みの状態を使ったなら、その tenant のキーにだけ置く。
 * 使わなかったなら、共有のキーに置く。範囲の外では、状態を使っていない扱い
 */
export function setToTenantCache<T>(tenantId: string, key: string, data: T, ttlMs?: number): void {
  const own = tenantStateUsed();
  if (own) incrementSecurityCounter('sora_tenant_cache_write_total');
  setToCache(own ? tenantCacheKey(tenantId, key) : key, data, ttlMs);
}
