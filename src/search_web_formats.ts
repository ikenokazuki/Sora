import {
  type ScrapeFormat,
  SEARCH_WEB_INPUT_SHAPE,
  SearchWebRequestSchema,
  type SearchWebRequest,
} from './types.js';
import { searchCacheTtl } from './cache.js';
import { ResourceBusyError } from './errors.js';
import { normalizeDomainList, searchYahooWeb } from './services/yahoo.js';
import { scrapeUrl } from './scraper.js';
import { projectRequestedScrapeFormats } from './search_format_projection.js';
import { formatCompactWebSearchResponse } from './search_compact.js';
import { getFromTenantCache, setToTenantCache } from './security/tenant_cache.js';
import { trackTenantState } from './security/tenant_state.js';

export { SEARCH_WEB_INPUT_SHAPE, SearchWebRequestSchema, type SearchWebRequest };
export interface SearchWebFormatDependencies { searchYahooWeb: typeof searchYahooWeb; scrapeUrl: typeof scrapeUrl; }
const DEFAULT_DEPS: SearchWebFormatDependencies={searchYahooWeb,scrapeUrl};
/** 自由な文字列を区切りの文字でつなぐと、区切りの位置を変えた別の指定が同じキーになるので、項目は JSON の配列にする */
export function buildSearchWebCacheKey(o: SearchWebRequest): string {
  const formats=o.formats?.slice().sort()??[];
  const limit=o.limit ?? (o.formats&&o.formats.length>0?5:'provider');
  return `search:web:v4:${JSON.stringify([o.query,normalizeDomainList(o.includeDomains)??[],normalizeDomainList(o.excludeDomains)??[],o.updated||'all',formats,limit,o.maxChars??'default',o.onlyMainContent!==false])}`;
}
/**
 * 結果のページの読み取りが、順番・予算で断られた（ResourceBusyError）応答。断った利用者の欠けた結果（scrapeError つき）を、共有のキャッシュに入れると、
 * 余裕のある別の利用者にも返るので、残さない（設計 6。穴 26。5f の教訓）。応答の型は変えないので、応答のオブジェクトで覚える
 */
const busyDegraded = new WeakSet<object>();

/** 検索元が制限中（throttled）か、古い結果を返した（stale）か、結果のページの読み取りが断られた応答。取り直せるように、キャッシュしない。 */
export function isTransientWebSearch(result: unknown): boolean {
  const r = result as { throttled?: unknown; stale?: unknown } | null | undefined;
  return r?.throttled === true || r?.stale === true || (typeof result === 'object' && result !== null && busyDegraded.has(result));
}

/** REST の POST /search/web。キャッシュを読み、検索し、取り直す必要のない応答だけを書く（制限中の空の結果を 30 分残さない）。 */
export async function searchWebForRest(body: SearchWebRequest, tenantId: string, deps: SearchWebFormatDependencies = DEFAULT_DEPS): Promise<any> {
  // 結果のページの取得が、tenant の保存済みの状態を使ったなら、応答は、その tenant のキーにだけ置く（置く側が、この範囲の印を見る。設計 5・穴 17）
  return (await trackTenantState(() => searchWebForRestTracked(body, tenantId, deps))).value;
}

async function searchWebForRestTracked(body: SearchWebRequest, tenantId: string, deps: SearchWebFormatDependencies): Promise<any> {
  const cacheKey = `${buildSearchWebCacheKey(body)}:${body.verbose === true ? 'verbose' : 'compact'}`;
  if (!body.noCache) { const cached = getFromTenantCache<unknown>(tenantId, cacheKey); if (cached) return cached; }
  const data = await searchWebWithFormats(body, tenantId, deps);
  const response = { query: body.query, source: 'web', type: 'web', data, cached: false };
  // 0 件の答えは一時的な不調かもしれないので、短くだけ残す
  if (!body.noCache && !isTransientWebSearch(data)) setToTenantCache(tenantId, cacheKey, response, searchCacheTtl(data));
  return response;
}

/** 検索の結果のページを読むとき（formats の指定）は、呼んだ tenant の保存済みのセッションで読む */
export async function searchWebWithFormats(o: SearchWebRequest,tenantId: string,deps: SearchWebFormatDependencies=DEFAULT_DEPS): Promise<any> {
  const base=await deps.searchYahooWeb({query:o.query,includeDomains:o.includeDomains,excludeDomains:o.excludeDomains,updated:o.updated,noCache:o.noCache});
  const formats=o.formats as ScrapeFormat[]|undefined; const has=Array.isArray(formats)&&formats.length>0;
  const compactOpt={verbose:(o as any).verbose};
  if(!has && o.limit===undefined) return formatCompactWebSearchResponse(base,compactOpt);
  const items=Array.isArray(base?.items)?base.items:[];
  const limit=Math.min(Math.max(o.limit ?? (has?5:items.length||1),1),20); const selected=items.slice(0,limit);
  if(!has) return formatCompactWebSearchResponse({...base,items:selected,count:selected.length},compactOpt);
  let busyHit=false;
  const enriched=await Promise.all(selected.map(async (item:any)=>{
    const url=item?.url||item?.link; if(!url) return item; const snippet=item?.snippet||item?.description||'';
    try {
      const scrape=await deps.scrapeUrl({url,tenantId,contextTitle:item?.title,snippet,maxChars:o.maxChars,timeoutMs:12_000,query:o.query,extractHighlights:false,onlyMainContent:o.onlyMainContent,formats,noCache:o.noCache});
      return {...item,...projectRequestedScrapeFormats(scrape,formats,{minMarkdownChars:50,markdownFallback:snippet?`# ${item?.title||'Web Search Result'}\n\nURL: ${url}\n\n${snippet}`:undefined})};
    } catch(e:any) { if(e instanceof ResourceBusyError) busyHit=true; return {...item,scrapeError:e?.message||String(e)}; }
  }));
  const response=formatCompactWebSearchResponse({...base,items:enriched,count:enriched.length},compactOpt);
  if(busyHit&&typeof response==='object'&&response!==null) busyDegraded.add(response);
  return response;
}
