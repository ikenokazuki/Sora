import { z } from 'zod';
import { ScrapeFormatSchema, type ScrapeFormat } from './types.js';
import { searchYahooWeb } from './services/yahoo.js';
import { scrapeUrl } from './scraper.js';
import { projectRequestedScrapeFormats } from './search_format_projection.js';

export const SEARCH_WEB_INPUT_SHAPE = {
  query: z.string().min(1).describe('検索キーワード'),
  includeDomains: z.array(z.string()).optional().describe('結果を絞り込むドメインリスト'),
  excludeDomains: z.array(z.string()).optional().describe('結果から除外するドメインリスト'),
  updated: z.enum(['all','day','week','year']).optional().describe('期間指定'),
  formats: z.array(ScrapeFormatSchema).optional().describe('指定時のみ上位検索結果をスクレイプし、要求形式を付与する'),
  limit: z.number().int().min(1).max(20).optional().describe('返却件数。formats指定時のデフォルトは5'),
  maxChars: z.number().int().min(1).max(50_000).optional().describe('formats指定時の各ページ最大文字数'),
  onlyMainContent: z.boolean().optional().describe('formats指定時に本文領域のみ抽出するか'),
  noCache: z.boolean().optional().describe('RESTレスポンス/ページキャッシュをバイパスするか'),
};
export const SearchWebRequestSchema = z.object(SEARCH_WEB_INPUT_SHAPE);
export type SearchWebRequest = z.infer<typeof SearchWebRequestSchema>;
export interface SearchWebFormatDependencies { searchYahooWeb: typeof searchYahooWeb; scrapeUrl: typeof scrapeUrl; }
const DEFAULT_DEPS: SearchWebFormatDependencies={searchYahooWeb,scrapeUrl};
export function buildSearchWebCacheKey(o: SearchWebRequest): string {
  const formats=o.formats?.slice().sort().join(',')||'none';
  const limit=o.limit ?? (o.formats&&o.formats.length>0?5:'provider');
  return ['search:web',o.query,(o.includeDomains||[]).join(','),(o.excludeDomains||[]).join(','),o.updated||'all',`formats=${formats}`,`limit=${limit}`,`maxChars=${o.maxChars??'default'}`,`main=${o.onlyMainContent!==false}`].join(':');
}
export async function searchWebWithFormats(o: SearchWebRequest,deps: SearchWebFormatDependencies=DEFAULT_DEPS): Promise<any> {
  const base=await deps.searchYahooWeb({query:o.query,includeDomains:o.includeDomains,excludeDomains:o.excludeDomains,updated:o.updated});
  const formats=o.formats as ScrapeFormat[]|undefined; const has=Array.isArray(formats)&&formats.length>0;
  if(!has && o.limit===undefined) return base;
  const items=Array.isArray(base?.items)?base.items:[];
  const limit=Math.min(Math.max(o.limit ?? (has?5:items.length||1),1),20); const selected=items.slice(0,limit);
  if(!has) return {...base,items:selected,count:selected.length};
  const enriched=await Promise.all(selected.map(async (item:any)=>{
    const url=item?.url||item?.link; if(!url) return item; const snippet=item?.snippet||item?.description||'';
    try {
      const scrape=await deps.scrapeUrl({url,contextTitle:item?.title,snippet,maxChars:o.maxChars,timeoutMs:12_000,query:o.query,extractHighlights:false,onlyMainContent:o.onlyMainContent,formats,noCache:o.noCache});
      return {...item,...projectRequestedScrapeFormats(scrape,formats,{minMarkdownChars:50,markdownFallback:snippet?`# ${item?.title||'Web Search Result'}\n\nURL: ${url}\n\n${snippet}`:undefined})};
    } catch(e:any) { return {...item,scrapeError:e?.message||String(e)}; }
  }));
  return {...base,items:enriched,count:enriched.length};
}
