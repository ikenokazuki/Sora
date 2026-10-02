import { detectMetaPlatform } from './meta.js';
import type { SocialPlatform } from './types.js';

export interface DiscoveryHit { url: string; title?: string; snippet?: string; }

export interface DiscoveryWebSearch {
  search(query: string, maxItems: number, opts: { updated?: 'day' | 'week' | 'year' }, signal: AbortSignal): Promise<DiscoveryHit[]>;
}

const PLATFORM_DOMAIN: Record<SocialPlatform, string> = {
  weibo: 'm.weibo.cn',
  threads: 'threads.com',
  instagram: 'instagram.com',
  facebook: 'facebook.com',
};

/** lookbackHours を検索期間へ丸める。 */
export function lookbackToUpdated(lookbackHours: number): 'day' | 'week' | 'year' {
  if (lookbackHours <= 24) return 'day';
  if (lookbackHours <= 168) return 'week';
  return 'year';
}

/** Web索引から対象プラットフォームの公開投稿URLだけを拾う。スニペットは本文扱いしない。
 * status: ok (取得成功) | empty (正常検索0件) | unavailable (検索失敗) 。失敗文字列から状態を推定しない。 */
export type DiscoveryStatus = 'ok' | 'empty' | 'unavailable';
export interface DiscoveryResult {
  status: DiscoveryStatus;
  urls: string[];
  failures: string[];
}
export async function discoverMetaPosts(
  webSearch: DiscoveryWebSearch,
  platform: SocialPlatform,
  query: string,
  limit: number,
  lookbackHours: number,
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  const failures: string[] = [];
  let hits: DiscoveryHit[];
  try {
    hits = await webSearch.search('site:' + PLATFORM_DOMAIN[platform] + ' ' + query, Math.min(Math.max(limit * 2, limit), 20), { updated: lookbackToUpdated(lookbackHours) }, signal);
  } catch (e) {
    return { status: 'unavailable', urls: [], failures: ['discovery: ' + String((e as Error)?.message ?? e).slice(0, 160)] };
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (urls.length >= limit) break;
    if (!hit?.url) continue;
    if (detectMetaPlatform(hit.url) !== platform) continue;
    const key = hit.url.replace(/\/*(\?.*)?$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(hit.url);
  }
  if (urls.length > 0) return { status: 'ok', urls, failures };
  if (!failures.length) failures.push('discovery: no post urls found');
  return { status: failures.length > 1 || failures[0] !== 'discovery: no post urls found' ? 'unavailable' : 'empty', urls, failures };
}
