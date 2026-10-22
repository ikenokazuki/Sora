import {
  type ScrapeFormat,
  SEARCH_WEB_INPUT_SHAPE,
  SearchWebRequestSchema,
  type SearchWebRequest,
} from './types.js';
import { getFromCache, searchCacheTtl, setToCache } from './cache.js';
import { normalizeDomainList, searchYahooWeb } from './services/yahoo.js';
import { scrapeUrl } from './scraper.js';
import { projectRequestedScrapeFormats } from './search_format_projection.js';
import { formatCompactWebSearchResponse } from './search_compact.js';

export { SEARCH_WEB_INPUT_SHAPE, SearchWebRequestSchema, type SearchWebRequest };
export interface SearchWebFormatDependencies { searchYahooWeb: typeof searchYahooWeb; scrapeUrl: typeof scrapeUrl; }
const DEFAULT_DEPS: SearchWebFormatDependencies={searchYahooWeb,scrapeUrl};
export function buildSearchWebCacheKey(o: SearchWebRequest): string {
  const formats=o.formats?.slice().sort().join(',')||'none';
  const limit=o.limit ?? (o.formats&&o.formats.length>0?5:'provider');
  return ['search:web',o.query,(normalizeDomainList(o.includeDomains)||[]).join(','),(normalizeDomainList(o.excludeDomains)||[]).join(','),o.updated||'all',`formats=${formats}`,`limit=${limit}`,`maxChars=${o.maxChars??'default'}`,`main=${o.onlyMainContent!==false}`].join(':');
}
/** 検索元が制限中（throttled）か、古い結果を返した（stale）応答。取り直せるように、キャッシュしない。 */
export function isTransientWebSearch(result: unknown): boolean {
  const r = result as { throttled?: unknown; stale?: unknown } | null | undefined;
  return r?.throttled === true || r?.stale === true;
}

/** REST の POST /search/web。キャッシュを読み、検索し、取り直す必要のない応答だけを書く（制限中の空の結果を 30 分残さない）。 */
export async function searchWebForRest(body: SearchWebRequest, deps: SearchWebFormatDependencies = DEFAULT_DEPS): Promise<any> {
  const cacheKey = `${buildSearchWebCacheKey(body)}:${body.verbose === true ? 'verbose' : 'compact'}`;
  if (!body.noCache) { const cached = getFromCache<unknown>(cacheKey); if (cached) return cached; }
  const data = await searchWebWithFormats(body, deps);
  const response = { query: body.query, source: 'web', type: 'web', data, cached: false };
  // 0 件の答えは一時的な不調かもしれないので、短くだけ残す
  if (!body.noCache && !isTransientWebSearch(data)) setToCache(cacheKey, response, searchCacheTtl(data));
  return response;
}

export async function searchWebWithFormats(o: SearchWebRequest,deps: SearchWebFormatDependencies=DEFAULT_DEPS): Promise<any> {
  const base=await deps.searchYahooWeb({query:o.query,includeDomains:o.includeDomains,excludeDomains:o.excludeDomains,updated:o.updated,noCache:o.noCache});
  const formats=o.formats as ScrapeFormat[]|undefined; const has=Array.isArray(formats)&&formats.length>0;
  const compactOpt={verbose:(o as any).verbose};
  if(!has && o.limit===undefined) return formatCompactWebSearchResponse(base,compactOpt);
  const items=Array.isArray(base?.items)?base.items:[];
  const limit=Math.min(Math.max(o.limit ?? (has?5:items.length||1),1),20); const selected=items.slice(0,limit);
  if(!has) return formatCompactWebSearchResponse({...base,items:selected,count:selected.length},compactOpt);
  const enriched=await Promise.all(selected.map(async (item:any)=>{
    const url=item?.url||item?.link; if(!url) return item; const snippet=item?.snippet||item?.description||'';
    try {
      const scrape=await deps.scrapeUrl({url,contextTitle:item?.title,snippet,maxChars:o.maxChars,timeoutMs:12_000,query:o.query,extractHighlights:false,onlyMainContent:o.onlyMainContent,formats,noCache:o.noCache});
      return {...item,...projectRequestedScrapeFormats(scrape,formats,{minMarkdownChars:50,markdownFallback:snippet?`# ${item?.title||'Web Search Result'}\n\nURL: ${url}\n\n${snippet}`:undefined})};
    } catch(e:any) { return {...item,scrapeError:e?.message||String(e)}; }
  }));
  return formatCompactWebSearchResponse({...base,items:enriched,count:enriched.length},compactOpt);
}
