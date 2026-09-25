import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import * as cheerio from 'cheerio';
import { filterByDomains, rerankSearchResults } from '../enrichment.js';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import {
  enrichRealtimeItemsWithXDetail,
  defaultXDetailProvider,
  rerankRealtimeItems,
  cleanRealtimeItem,
} from './x_detail.js';
import { searchYahooRealtimePage } from './yahoo_realtime_api.js';

// Yahoo MCP バイナリのパス
export const YAHOO_MCP_PATH =
  process.env.YAHOO_MCP_PATH ||
  (existsSync('/usr/local/bin/yahoo-search-mcp') ? '/usr/local/bin/yahoo-search-mcp' :
   existsSync(join(import.meta.dir, '../../bin/yahoo-search-mcp')) ? join(import.meta.dir, '../../bin/yahoo-search-mcp') :
   existsSync('/home/ikeno/app/oshiframe/backend/bin/Yahoo-Japan-Search-MCP-v0.1.0-linux-x64/yahoo-search-mcp')
     ? '/home/ikeno/app/oshiframe/backend/bin/Yahoo-Japan-Search-MCP-v0.1.0-linux-x64/yahoo-search-mcp'
     : 'yahoo-search-mcp');

/** Yahoo-Japan-Search-MCP 実行 (ステートレス 5ms 起動 & タイムアウト保護) */
export async function callYahooMcp(toolName: string, args: Record<string, any>, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    let timer: any = null;
    let isSettled = false;

    const child = spawn(YAHOO_MCP_PATH, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        reject(new Error(`Yahoo MCP tool "${toolName}" timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to spawn Yahoo MCP (${YAHOO_MCP_PATH}): ${err.message}`));
      }
    });

    child.on('close', (code) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);

      if (code !== 0 && !stdout) {
        return reject(new Error(`Yahoo MCP exited with code ${code}: ${stderr}`));
      }

      const lines = stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const json = JSON.parse(lines[i]);
          if (json.id === 1 && json.result) {
            return resolve(json.result);
          }
        } catch {}
      }

      reject(new Error(`Invalid JSON-RPC response from Yahoo MCP: ${stdout}`));
    });

    const rpcPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }) + '\n';

    child.stdin.write(rpcPayload);
    child.stdin.end();
  });
}

export interface YahooWebQueryBatch {
  query: string;
  queryIndex: number;
  items: any[];
}

export function mergeYahooWebQueryBatches(
  batches: YahooWebQueryBatch[],
  bindingQuery: string,
  includeDomains?: string[],
  excludeDomains?: string[],
): any[] {
  const merged: any[] = [];
  const seen = new Set<string>();

  for (const batch of batches) {
    const normalized = batch.items.map((item: any) => ({
      source: 'web' as const,
      snippet: item.description || item.snippet,
      ...item,
      retrievalQuery: batch.query,
      retrievalQueryIndex: batch.queryIndex,
    }));

    const filtered = filterByDomains(
      normalized,
      includeDomains,
      excludeDomains,
    );

    for (const item of filtered) {
      const urlKey =
        typeof (item.url || item.link) === 'string'
          ? `url:${item.url || item.link}`
          : '';
      const textKey =
        `text:${item.title || ''}\n${item.snippet || item.description || ''}`;
      const key = urlKey || textKey;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  return rerankSearchResults(merged, bindingQuery);
}

/** Yahoo Web 検索 (プレフィルタリング site: / -site: 対応 & 0件時スマートフォールバック) */
export async function searchYahooWeb(options: {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: 'all' | 'day' | 'week' | 'year';
  disableFallback?: boolean;
}, deps?: { callYahooMcp?: typeof callYahooMcp }): Promise<any> {
  const callMcp: typeof callYahooMcp =
    (deps as any)?.callYahooMcp ?? (options as any)?._callMcp ?? callYahooMcp;
  const providerErrors: Array<{ query: string; message: string }> = [];
  const fetchDirect: typeof fetchYahooWebDirect =
    (deps as any)?.fetchYahooWebDirect ?? fetchYahooWebDirect;
  // The bundled MCP binary carries a fingerprint Yahoo currently rate-limits
  // (HTTP 429) while direct fetches with a browser fingerprint succeed.
  // Direct fetch is therefore the primary route; the binary is the alternate.
  const normDirectItem = (item: any): any => ({
    source: 'web' as const,
    title: item.title,
    url: item.url,
    description: item.snippet,
    snippet: item.snippet,
    ...(item.domain ? { domain: item.domain } : {}),
    directFetch: true,
  });
  // Burst calls trigger upstream 429. Wait once (bounded) after a
  // rate-limit failure before the next candidate; never retry unboundedly.
  const retryWaitMs = Math.min(Math.max(Number(process.env.SORA_WEB_RETRY_WAIT_MS ?? 1200), 0), 5000);
  let waitedOnce = false;
  const maybeWaitAfterRateLimit = async (message: string): Promise<void> => {
    if (waitedOnce || retryWaitMs <= 0) return;
    if (!/429|too many requests|rate limit/i.test(message)) return;
    waitedOnce = true;
    await new Promise((r) => setTimeout(r, retryWaitMs));
  };
  const candidateQueries = options.disableFallback
    ? [options.query]
    : extractRealtimeFallbackQueries(options.query);

  let lastParsedData: any = { items: [], count: 0, source: 'web' };

  const queryUnionEnabled =
    process.env.SORA_WEB_QUERY_UNION === 'true' &&
    options.disableFallback !== true;

  if (queryUnionEnabled) {
    const boundedQueries = candidateQueries.slice(0, 2);
    const batches: YahooWebQueryBatch[] = [];
    const retrievalQueries: string[] = [];

    for (let i = 0; i < boundedQueries.length; i++) {
      const q = boundedQueries[i];
      if (!q) continue;
      retrievalQueries.push(q);

      let effectiveWebQuery = q;
      let webSiteArg: string | undefined = undefined;

      if (options.includeDomains && options.includeDomains.length > 0) {
        if (options.includeDomains.length === 1) {
          webSiteArg = options.includeDomains[0];
        } else {
          effectiveWebQuery += ` (${options.includeDomains
            .map((d) => `site:${d}`)
            .join(' OR ')})`;
        }
      }

      if (options.excludeDomains && options.excludeDomains.length > 0) {
        effectiveWebQuery += ` ${options.excludeDomains
          .map((d) => `-site:${d}`)
          .join(' ')}`;
      }

      try {
        let batchJson: any = null;
        try {
          const directItems = await fetchDirect(effectiveWebQuery, 10, undefined, { updated: options.updated, ...(webSiteArg ? { includeDomains: [webSiteArg] } : {}) });
          if (directItems.length > 0) batchJson = { items: directItems.map(normDirectItem) };
        } catch (err) {
          providerErrors.push({ query: q, message: `direct: ${((err as Error)?.message ?? String(err)).slice(0, 280)}` });
        }
        if (!batchJson) {
          const mcpRes = await callMcp('yahoo_web_search', {
            query: effectiveWebQuery,
            ...(webSiteArg ? { site: webSiteArg } : {}),
            ...(options.updated && options.updated !== 'all'
              ? { updated: options.updated }
              : {}),
          });

          const content = mcpRes?.content?.[0]?.text || '[]';
          if (mcpRes?.isError) {
            providerErrors.push({ query: q, message: String(content).slice(0, 300) });
            if (i < boundedQueries.length - 1) await maybeWaitAfterRateLimit(String(content));
            continue;
          }
          batchJson = JSON.parse(content);
        }

        if (batchJson && Array.isArray(batchJson.items)) {
          lastParsedData = batchJson;
          if (batchJson.items.length > 0) {
            batches.push({
              query: q,
              queryIndex: i,
              items: batchJson.items,
            });
          }
        }
      } catch (err) {
        // One failed rescue query must not discard sibling results; record it.
        const message = ((err as Error)?.message ?? String(err)).slice(0, 300);
        providerErrors.push({ query: q, message });
        if (i < boundedQueries.length - 1) await maybeWaitAfterRateLimit(message);
      }
    }

    const ranked = mergeYahooWebQueryBatches(
      batches,
      options.query,
      options.includeDomains,
      options.excludeDomains,
    );

    if (ranked.length > 0) {
      const contributedFallback = ranked.some(
        (item: any) => (item.retrievalQueryIndex ?? 0) > 0,
      );

      return {
        items: ranked,
        count: ranked.length,
        source: 'web',
        originalQuery: options.query,
        bindingQuery: options.query,
        retrievalQueries,
        effectiveQuery: options.query,
        isFallback: contributedFallback,
        queryUnion: true,
        ...(providerErrors.length > 0 ? { providerErrors } : {}),
      };
    }

    return {
      ...lastParsedData,
      items: [],
      count: 0,
      source: 'web',
      originalQuery: options.query,
      bindingQuery: options.query,
      retrievalQueries,
      effectiveQuery: options.query,
      isFallback: false,
      queryUnion: true,
      providerErrors,
    };
  }

  for (let i = 0; i < candidateQueries.length; i++) {
    const q = candidateQueries[i];
    let effectiveWebQuery = q;
    let webSiteArg: string | undefined = undefined;

    if (options.includeDomains && options.includeDomains.length > 0) {
      if (options.includeDomains.length === 1) {
        webSiteArg = options.includeDomains[0];
      } else {
        effectiveWebQuery += ` (${options.includeDomains.map((d) => `site:${d}`).join(' OR ')})`;
      }
    }

    if (options.excludeDomains && options.excludeDomains.length > 0) {
      effectiveWebQuery += ` ${options.excludeDomains.map((d) => `-site:${d}`).join(' ')}`;
    }

    try {
      let json: any = null;
      try {
        const directItems = await fetchDirect(effectiveWebQuery, 10, undefined, { updated: options.updated, ...(webSiteArg ? { includeDomains: [webSiteArg] } : {}) });
        if (directItems.length > 0) json = { items: directItems.map(normDirectItem) };
      } catch (err) {
        providerErrors.push({ query: q, message: `direct: ${((err as Error)?.message ?? String(err)).slice(0, 280)}` });
      }
      if (!json) {
        const mcpRes = await callMcp('yahoo_web_search', {
          query: effectiveWebQuery,
          ...(webSiteArg ? { site: webSiteArg } : {}),
          ...(options.updated && options.updated !== 'all' ? { updated: options.updated } : {}),
        });

        const content = mcpRes?.content?.[0]?.text || '[]';
        if (mcpRes?.isError) {
          const message = String(content).slice(0, 300);
          providerErrors.push({ query: q, message });
          if (i < candidateQueries.length - 1) await maybeWaitAfterRateLimit(message);
          continue;
        }
        json = JSON.parse(content);
      }
      if (json && Array.isArray(json.items) && json.items.length > 0) {
        const normalizedItems = json.items.map((item: any) => ({
          source: 'web' as const,
          snippet: item.description || item.snippet,
          ...item,
        }));
        const filtered = filterByDomains(normalizedItems, options.includeDomains, options.excludeDomains);
        const ranked = rerankSearchResults(filtered, options.query);
        json.items = ranked;
        json.count = json.items.length;
        json.source = 'web';
        json.effectiveQuery = q;
        json.isFallback = i > 0;
        if (providerErrors.length > 0) json.providerErrors = providerErrors;
        return json;
      }
      if (json && Array.isArray(json.items)) {
        lastParsedData = json;
      }
    } catch (err) {
      // 候補クエリの次を試行（失敗は記録する）
      const message = ((err as Error)?.message ?? String(err)).slice(0, 300);
      providerErrors.push({ query: q, message });
      if (i < candidateQueries.length - 1) await maybeWaitAfterRateLimit(message);
    }
  }

  return {
    ...lastParsedData,
    items: [],
    count: 0,
    providerErrors,
  };
}

export interface YahooWebDirectItem { url: string; title?: string; snippet?: string; domain?: string; }

function stripYahooTags(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

/** Yahooの縦断ナビ（画像・動画・地図・リアルタイム等）へのリンクか。結果候補にしない。 */
export function isYahooNavUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== 'yahoo.co.jp' && !u.hostname.endsWith('.yahoo.co.jp')) return false;
    return u.hostname === 'search.yahoo.co.jp' || u.pathname.includes('/search');
  } catch {
    return false;
  }
}

export interface YahooWebDirectOptions {
  updated?: 'all' | 'day' | 'week' | 'year';
  includeDomains?: string[];
}

const UPDATED_TO_VD: Record<string, string> = { day: 'd', week: 'w', year: 'y' };

/** 直接取得用の検索URLを組み立てる。期間と単一ドメイン条件を実パラメーターへ反映する。 */
export function buildYahooWebDirectUrl(query: string, opts: YahooWebDirectOptions = {}): string {
  let q = query;
  if (opts.includeDomains && opts.includeDomains.length === 1) {
    q += ' site:' + opts.includeDomains[0];
  } else if (opts.includeDomains && opts.includeDomains.length > 1) {
    q += ' (' + opts.includeDomains.map((d) => 'site:' + d).join(' OR ') + ')';
  }
  const params = new URLSearchParams({ p: q, ei: 'UTF-8' });
  const vd = opts.updated && opts.updated !== 'all' ? UPDATED_TO_VD[opts.updated] : undefined;
  if (vd) params.set('vd', vd);
  return 'https://search.yahoo.co.jp/search?' + params.toString();
}

/** Yahoo Web検索結果HTMLの直解析。MCPバイナリ429時のフォールバック用。 */
export function parseYahooWebHtml(html: string, maxItems = 10): YahooWebDirectItem[] {
  const out: YahooWebDirectItem[] = [];
  const push = (rawUrl: string, rawTitle: string, rawSnippet: string): void => {
    const url = stripYahooTags(rawUrl ?? '');
    if (!url || out.some((item) => item.url === url)) return;
    if (isYahooNavUrl(url)) return;
    const title = stripYahooTags(rawTitle ?? '');
    const snippet = stripYahooTags(rawSnippet ?? '');
    let domain: string | undefined;
    try {
      domain = new URL(url).hostname.replace(/^www\./, '');
    } catch {}
    out.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(domain ? { domain } : {}) });
  };
  // 現行マークアップ: sw-Card のタイトルリンクと概要文。旧フィクスチャにない場合の第一候補。
  const cardRe = /<a href="(https?:\/\/[^"]+)"[^>]*class="sw-Card__titleInner"[^>]*>(?:<br\/>)?<h3[^>]*><span>(.*?)<\/span>/g;
  let c: RegExpExecArray | null;
  while ((c = cardRe.exec(html)) !== null) {
    const after = html.slice(c.index, c.index + 8000);
    const s = after.match(/<p class="sw-Card__summary">(.*?)<\/p>/s);
    push(c[1] ?? '', c[2] ?? '', s ? s[1] : '');
    if (out.length >= maxItems) return out;
  }
  if (out.length > 0) return out;
  // 旧形式は結果領域 #web 内だけを読む。領域自体がなければ未知HTMLとして空を返す。
  const webSection = html.split('<div id="web">')[1]?.split('<div id="web_19">')[0];
  if (!webSection) return out;
  const itemRe = /<li><a href="(https?:\/\/[^"]+)"[^>]*>(.*?)<\/a>(?:<div>(.*?)<\/div>)?/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(webSection)) !== null) {
    push(m[1] ?? '', m[2] ?? '', m[3] ?? '');
    if (out.length >= maxItems) break;
  }
  return out;
}

/** 直接fetchによるYahoo Web検索。MCPが429/空振りの場合のみ使う。 */
/** 直接fetchによるYahoo Web検索。MCPバイナリの指紋が制限される場合の主経路。 */
// ブラウザ指紋・間隔調整・SSRF検証は http_fetcher に集約。ここでは検索用ヘッダだけ足す。
const YAHOO_WEB_DIRECT_HEADERS: Record<string, string> = {
  Referer: 'https://search.yahoo.co.jp/',
};
export async function fetchYahooWebDirect(query: string, maxItems = 10, signal?: AbortSignal, opts: YahooWebDirectOptions = {}): Promise<YahooWebDirectItem[]> {
  const url = buildYahooWebDirectUrl(query, opts);
  const pending = fetchWithSafeRedirects(url, 15000, 5, { ...YAHOO_WEB_DIRECT_HEADERS });
  const { response: res } = signal
    ? await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ])
    : await pending;
  if (!res.ok) throw new Error('Yahoo direct fetch failed: ' + res.status);
  return parseYahooWebHtml(await res.text(), maxItems);
}

/** リアルタイムアイテムの正規化 (publishedTime, author_name, author_handle, url 正規化) */
export function normalizeRealtimeItem(item: any): Record<string, any> {
  const createdAtSec = typeof item.created_at === 'number' ? item.created_at : parseInt(item.created_at, 10);
  const publishedTime =
    !isNaN(createdAtSec) && createdAtSec > 0
      ? new Date(createdAtSec * 1000).toISOString()
      : undefined;

  let authorHandle = item.author_handle ? String(item.author_handle).replace(/^@/, '') : '';
  let authorName = item.author_name || '';
  if (!authorName && !authorHandle && typeof item.author === 'string') {
    const m = item.author.match(/^(.*?)(?:\s*\(@?([a-zA-Z0-9_]+)\))?$/);
    if (m) {
      if (m[1]?.trim()) authorName = m[1].trim();
      if (m[2]?.trim()) authorHandle = m[2].trim();
    }
  }
  if (authorHandle) {
    authorHandle = authorHandle.replace(/^@/, '');
  }

  let url = item.url;
  if (typeof url === 'string') {
    try {
      const u = new URL(url);
      u.searchParams.delete('utm_source');
      u.searchParams.delete('utm_medium');
      u.searchParams.delete('utm_campaign');
      url = u.toString().replace(/\?$/, '');
    } catch {}
  }

  return {
    source: 'x' as const,
    id: String(item.id || item.statusId || ''),
    ...(authorName ? { author_name: authorName } : {}),
    ...(authorHandle ? { author_handle: authorHandle } : {}),
    text: typeof item.text === 'string' ? item.text : '',
    ...(url ? { url } : {}),
    ...(publishedTime || item.publishedTime ? { publishedTime: publishedTime || item.publishedTime } : {}),
    ...(typeof item.like_count === 'number' ? { like_count: item.like_count } : {}),
    ...(typeof item.reply_count === 'number' ? { reply_count: item.reply_count } : {}),
    ...(typeof item.repost_count === 'number' ? { repost_count: item.repost_count } : {}),
    ...(Array.isArray(item.media) && item.media.length > 0 ? { media: item.media } : {}),
    ...(item.isOfficial !== undefined ? { isOfficial: item.isOfficial } : {}),
    ...(item.detailEnriched !== undefined ? { detailEnriched: item.detailEnriched } : {}),
    ...(item.detailProvider !== undefined ? { detailProvider: item.detailProvider } : {}),
    ...(item.isNoteTweet !== undefined ? { isNoteTweet: item.isNoteTweet } : {}),
  };
}

export interface YahooRealtimeOptions {
  query?: string;
  accountId?: string;
  fromUser?: string;
  toAccount?: string;
  hashtags?: string[] | string;
  excludeWords?: string[] | string;
  orWords?: string[];
  url?: string;
  sort?: 'recent' | 'popular';
  limit?: number;
  page?: number;
  disableFallback?: boolean;
  detailEnrichment?: boolean;
  verbose?: boolean;
}

/**
 * Yahoo リアルタイム検索クエリ構築・サニタイズ
 * - X/Twitter 公式の from:xxx を Yahoo 仕様の id:xxx に自動置換
 * - accountId / fromUser を id:xxx に変換
 * - toAccount を @xxx に変換
 * - hashtags を #xxx に変換
 * - excludeWords を -xxx に変換
 * - orWords を (A B) に変換
 */
const REALTIME_HANDLE_RE = /^[A-Za-z0-9_]{1,30}$/;
const REALTIME_TOKEN_RE = /^[^\s()"'“”‘’『』「」]+$/;

/** URLや引用文字列の内部を除き、単独の from:演算子だけ id:へ変換する */
function convertFromOperatorToId(query: string): string {
  return query.replace(/(^|[\s(])from:([A-Za-z0-9_]+)/gi, '$1id:$2');
}

function hasQueryToken(baseQuery: string, token: string): boolean {
  return baseQuery.split(/\s+/).includes(token);
}

function assertRealtimeHandle(value: string, option: string): string {
  const clean = value.trim().replace(/^@/, '');
  if (!REALTIME_HANDLE_RE.test(clean)) {
    throw new Error(`Invalid ${option}: use 1-30 chars of A-Za-z0-9_ (got "${value}")`);
  }
  return clean;
}

function assertRealtimeToken(value: string, option: string): string {
  const clean = value.trim();
  if (!clean || !REALTIME_TOKEN_RE.test(clean)) {
    throw new Error(`Invalid ${option}: single token without spaces or query syntax (got "${value}")`);
  }
  return clean;
}

export function buildYahooRealtimeQuery(options: YahooRealtimeOptions | string): string {
  if (typeof options === 'string') {
    return convertFromOperatorToId(options).trim();
  }

  let baseQuery = (options.query || '').trim();
  // from: を id: に自動置換 (X/Twitter 記法への耐性)
  baseQuery = convertFromOperatorToId(baseQuery).trim();

  const tokens: string[] = [];

  // 特定アカウントの投稿: id:xxx
  const rawAccount = (options.accountId || options.fromUser || '').trim();
  if (rawAccount) {
    const cleanAccount = assertRealtimeHandle(rawAccount, options.accountId ? 'accountId' : 'fromUser');
    const accountRegex = new RegExp(`\\b(?:id|ID):${cleanAccount}\\b`, 'i');
    if (!accountRegex.test(baseQuery)) {
      tokens.push(`id:${cleanAccount}`);
    }
  }

  // 特定アカウント宛ての投稿: @xxx
  const rawTo = (options.toAccount || '').trim();
  if (rawTo) {
    const cleanTo = assertRealtimeHandle(rawTo, 'toAccount');
    const toRegex = new RegExp(`(^|\\s)@${cleanTo}\\b`, 'i');
    if (!toRegex.test(baseQuery)) {
      tokens.push(`@${cleanTo}`);
    }
  }

  // 特定ハッシュタグ: #xxx
  if (options.hashtags) {
    const tagList = Array.isArray(options.hashtags) ? options.hashtags : [options.hashtags];
    for (const rawTag of tagList) {
      if (!rawTag.trim()) continue;
      const cleanTag = assertRealtimeToken(rawTag.trim().replace(/^#/, ''), 'hashtags');
      if (!hasQueryToken(baseQuery, `#${cleanTag}`)) {
        tokens.push(`#${cleanTag}`);
      }
    }
  }

  // 除外キーワード: -xxx
  if (options.excludeWords) {
    const exList = Array.isArray(options.excludeWords) ? options.excludeWords : [options.excludeWords];
    for (const rawEx of exList) {
      if (!rawEx.trim()) continue;
      const cleanEx = assertRealtimeToken(rawEx.trim().replace(/^-/, ''), 'excludeWords');
      if (!hasQueryToken(baseQuery, `-${cleanEx}`)) {
        tokens.push(`-${cleanEx}`);
      }
    }
  }

  // OR検索: (A B)
  if (options.orWords && options.orWords.length > 0) {
    const cleanOr = options.orWords
      .map((w) => (w || '').trim())
      .filter(Boolean)
      .map((w) => assertRealtimeToken(w, 'orWords'));
    if (cleanOr.length > 1) {
      tokens.push(`(${cleanOr.join(' ')})`);
    } else if (cleanOr.length === 1) {
      tokens.push(cleanOr[0]);
    }
  }

  // URL / ドメイン指定
  if (options.url) {
    const rawUrl = options.url.trim();
    if (rawUrl) {
      if (/\s/.test(rawUrl)) throw new Error(`Invalid url: must not contain spaces (got "${options.url}")`);
      const urlToken = /^(?:URL|url):/.test(rawUrl) ? rawUrl : `URL:${rawUrl}`;
      if (!hasQueryToken(baseQuery, urlToken)) {
        tokens.push(urlToken);
      }
    }
  }

  const parts = [baseQuery, ...tokens].filter(Boolean);
  return parts.join(' ').trim();
}

/**
 * 複雑な検索式の判定。OR括弧・URL条件・引用符・未対応演算子を含む式は
 * 意味を変える自動relaxの対象にせず、原式の単発取得に固定する。
 */
export function requiresExactRealtimeQuery(query: string): boolean {
  const q = (query || '').trim();
  if (!q) return false;
  if (/[()]/.test(q)) return true;
  if (/["'“”‘’『』「」]/.test(q)) return true;
  if (/\bOR\b/i.test(q)) return true;
  if (/https?:\/\//i.test(q)) return true;
  if (/(?:^|\s)(?:URL|url):/.test(q)) return true;
  return false;
}

/** realtime HTTPキャッシュキー。完成クエリで識別し条件の混在を防ぐ。 */
export function buildRealtimeSearchCacheKey(options: YahooRealtimeOptions): string {
  return JSON.stringify([
    'search:realtime:json-v1',
    buildYahooRealtimeQuery(options),
    options.sort ?? 'recent',
    options.limit ?? 20,
    options.page ?? 1,
    options.disableFallback === true,
    (options as any)?.verbose === true,
  ]);
}

/** 検索向けフォールバック候補クエリの自動抽出 (JST 相対日付解決・記号/日付正規化・ノイズ語句パージ・重要語抽出・修飾子保護) */
export function extractRealtimeFallbackQueries(query: string): string[] {
  if (!query || typeof query !== 'string') return [];
  const normalized = query.normalize('NFKC').trim();
  const candidates: string[] = [query.trim()];
  if (normalized !== query.trim()) {
    candidates.push(normalized);
  }

  // 修飾子 (id:xxx, @xxx, #xxx, -xxx) の抽出と保護
  const modifiers: string[] = [];
  let remaining = normalized;

  // id: / ID:
  remaining = remaining.replace(/\b(?:id|ID):([a-zA-Z0-9_]+)/gi, (_, id) => {
    modifiers.push(`id:${id}`);
    return ' ';
  });

  // @mention (単語先頭の @)
  remaining = remaining.replace(/(?:^|\s)@([a-zA-Z0-9_]+)/g, (_, m) => {
    modifiers.push(`@${m}`);
    return ' ';
  });

  // #hashtag
  remaining = remaining.replace(/(?:^|\s)#([^\s#]+)/g, (_, tag) => {
    modifiers.push(`#${tag}`);
    return ' ';
  });

  // -exclude
  remaining = remaining.replace(/(?:^|\s)-([^\s-]+)/g, (_, ex) => {
    modifiers.push(`-${ex}`);
    return ' ';
  });

  const modifierPrefix = modifiers.join(' ').trim();
  remaining = remaining.replace(/\s+/g, ' ').trim();

  // 1. 日付の検出 (絶対日付 or JST 相対日付, 年月日 / スラッシュ / ハイフン / ドット)
  let targetDateStr: string | null = null;
  const kanjiDateMatch = remaining.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  if (kanjiDateMatch) {
    const month = parseInt(kanjiDateMatch[2], 10);
    const day = parseInt(kanjiDateMatch[3], 10);
    targetDateStr = `${month}/${day}`;
  } else {
    const ymSeparatedMatch = remaining.match(/(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})/);
    if (ymSeparatedMatch) {
      targetDateStr = `${parseInt(ymSeparatedMatch[2], 10)}/${parseInt(ymSeparatedMatch[3], 10)}`;
    } else {
      // 相対日付の判定（日本時間 JST: UTC+9）
      const now = new Date();
      const jstNow = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
      if (/(?:明日|あした|あす)/.test(remaining)) {
        const tomorrow = new Date(jstNow.getTime() + 24 * 60 * 60 * 1000);
        targetDateStr = `${tomorrow.getMonth() + 1}/${tomorrow.getDate()}`;
      } else if (/(?:今日|本日|きょう)/.test(remaining)) {
        targetDateStr = `${jstNow.getMonth() + 1}/${jstNow.getDate()}`;
      } else if (/(?:明後日|あさって)/.test(remaining)) {
        const dayAfter = new Date(jstNow.getTime() + 48 * 60 * 60 * 1000);
        targetDateStr = `${dayAfter.getMonth() + 1}/${dayAfter.getDate()}`;
      } else if (/(?:昨日|きのう)/.test(remaining)) {
        const yesterday = new Date(jstNow.getTime() - 24 * 60 * 60 * 1000);
        targetDateStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}`;
      }
    }
  }

  // 2. ノイズ語句の除去 (自然言語フレーズ、助詞、冗長語)
  const noisePattern = /(?:明日|あした|あす|今日|本日|きょう|昨日|きのう|明後日|あさって|予定|スケジュール|情報|一覧|最新|公式|について|まとめ|何時|何時から|いつ|どこ|どこで|教えて|ライブ予定|ライブ情報|チケット情報|チケット一覧|開催情報|詳細|概要|購入方法|チケット購入方法|タイムテーブル|タイテ|出演時間)/g;
  const cleaned = remaining
    .replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}日/g, '')
    .replace(/(?:\d{4}[-/.])?\d{1,2}[-/.]\d{1,2}/g, '')
    .replace(noisePattern, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter((w) => w.length > 0);
  const mainEntity = words[0] || '';

  // 3. 候補クエリの優先度生成 (修飾子を維持)
  const attachModifiers = (str: string) => {
    return modifierPrefix ? `${modifierPrefix} ${str}`.trim() : str.trim();
  };

  if (mainEntity && targetDateStr) {
    candidates.push(attachModifiers(`${mainEntity} ${targetDateStr}`));
    const [m, d] = targetDateStr.split('/');
    candidates.push(attachModifiers(`${mainEntity} ${m}月${d}日`));
  }

  if (words.length > 1) {
    candidates.push(attachModifiers(words.join(' ')));
  }

  if (mainEntity) {
    candidates.push(attachModifiers(mainEntity));
  }

  // 修飾子が存在し、キーワード単体でヒットしなかった場合のフォールバック（例: id:xxx 単体、#tag 単体）
  if (modifierPrefix) {
    candidates.push(modifierPrefix);
  }

  return Array.from(new Set(candidates.map((c) => c.trim()).filter((c) => c.length > 0)));
}

/** Realtime Retrieval v1: retrieval bounds (wave max 2, total max 5) */
export const MAX_REALTIME_RETRIEVAL_QUERIES = 5;
export const MAX_REALTIME_QUERIES_PER_WAVE = 2;

export interface RealtimeIntentRequirements {
  semanticRequirements: string[];
  protectedModifiers: string[];
}

function splitRealtimeQueryParts(query: string): { semantics: string[]; modifiers: string[] } {
  const normalized = (query || '').replace(/\bfrom:([a-zA-Z0-9_]+)/gi, 'id:$1').normalize('NFKC');
  const modifiers: string[] = [];
  let remaining = ` ${normalized} `;
  remaining = remaining.replace(/\b(?:id|ID):([a-zA-Z0-9_]+)/gi, (_, id) => {
    modifiers.push(`id:${id}`);
    return ' ';
  });
  remaining = remaining.replace(/(?:^|\s)@([a-zA-Z0-9_]+)/g, (_, m) => {
    modifiers.push(`@${m}`);
    return ' ';
  });
  remaining = remaining.replace(/(?:^|\s)#([^\s#]+)/g, (_, tag) => {
    modifiers.push(`#${tag}`);
    return ' ';
  });
  remaining = remaining.replace(/(?:^|\s)-([^\s-]+)/g, (_, ex) => {
    modifiers.push(`-${ex}`);
    return ' ';
  });
  const semantics = remaining.replace(/\s+/g, ' ').trim().split(' ').filter((w) => w.length > 0);
  return { semantics, modifiers };
}

/**
 * Realtime Retrieval v1: original queryのみからintent requirementsを決定論的に抽出する。
 * candidate contextに依存するobserveRequirements()は停止判定に使わない。
 * 空白区切りsemantic termsはatomic requirementとして保持し、bigram縮約しない。
 */
export function extractRealtimeIntentRequirements(query: string): RealtimeIntentRequirements {
  if (!query || typeof query !== 'string') return { semanticRequirements: [], protectedModifiers: [] };
  const { semantics, modifiers } = splitRealtimeQueryParts(query);
  return { semanticRequirements: semantics, protectedModifiers: modifiers };
}

/**
 * Wave 1 exact-intent variants: original + 意味を削らないcanonical syntax variant
 * (protected modifiersを先頭へ移動)。同一文字列なら重複排除。semantic fallbackではない。
 */
export function buildRealtimeExactQueryVariants(query: string): string[] {
  const original = (query || '').trim();
  if (!original) return [];
  const { semantics, modifiers } = splitRealtimeQueryParts(original);
  const canonical = [...modifiers, ...semantics].join(' ').trim();
  const variants = [original];
  if (canonical && canonical !== original) variants.push(canonical);
  return variants.slice(0, MAX_REALTIME_QUERIES_PER_WAVE);
}

/**
 * Wave 2 minimal relaxation: drop-oneのみ。全subset(2^N)生成は禁止。
 * best itemのmissing termsを多く保持するcandidateを優先し、同点はoriginal順序で決定論的に並べる。
 * protected modifiersは常に維持し、modifier-only queryは生成しない。
 */
export function buildRealtimeRelaxationCandidates(
  semanticRequirements: string[],
  protectedModifiers: string[],
  missingTerms: string[],
  executedQueries: Set<string> | string[],
): string[] {
  if (!Array.isArray(semanticRequirements) || semanticRequirements.length <= 1) return [];
  const executed = executedQueries instanceof Set ? executedQueries : new Set(executedQueries || []);
  const missingSet = new Set((missingTerms || []).map((t) => t.toLowerCase()));
  const prefix = (protectedModifiers || []).join(' ').trim();
  const scored: Array<{ query: string; score: number; dropped: number }> = [];
  for (let drop = 0; drop < semanticRequirements.length; drop++) {
    const retained = semanticRequirements.filter((_, i) => i !== drop);
    if (retained.length === 0) continue;
    const body = retained.join(' ').trim();
    const q = prefix ? `${prefix} ${body}`.trim() : body;
    if (!q || executed.has(q)) continue;
    let score = 0;
    for (const term of retained) {
      if (missingSet.has(term.toLowerCase())) score++;
    }
    scored.push({ query: q, score, dropped: drop });
  }
  scored.sort((a, b) => b.score - a.score || a.dropped - b.dropped);
  return scored.map((s) => s.query);
}

export interface RealtimeCoverageEvaluation {
  requiredTerms: string[];
  bestCoveredTerms: string[];
  missingTerms: string[];
  hasFullCoverage: boolean;
  authorConstraintSatisfied: boolean;
}

/**
 * per-item coverageでretrieval qualityを判定する。corpus全体の分散存在では判定しない。
 * -excludeはpositive coverage requirementにしない。authorはid: constraintのみ検証する。
 */
export function evaluateRealtimeRetrievalCoverage(
  items: Array<Record<string, any>>,
  requirements: RealtimeIntentRequirements,
): RealtimeCoverageEvaluation {
  const requiredTerms = requirements?.semanticRequirements || [];
  const protectedModifiers = requirements?.protectedModifiers || [];
  const idHandles = protectedModifiers
    .filter((m) => /^id:/i.test(m))
    .map((m) => m.slice(3).replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  let bestCovered: string[] = [];
  let bestMissing: string[] = [...requiredTerms];
  let authorSatisfied = idHandles.length === 0;
  if (!Array.isArray(items) || items.length === 0 || requiredTerms.length === 0) {
    if (Array.isArray(items)) {
      for (const item of items) {
        const handle = String(item?.author_handle || '').replace(/^@/, '').toLowerCase();
        if (idHandles.length > 0 && idHandles.includes(handle)) {
          authorSatisfied = true;
          break;
        }
      }
      if (idHandles.length === 0) authorSatisfied = true;
    }
    return {
      requiredTerms,
      bestCoveredTerms: bestCovered,
      missingTerms: bestMissing,
      hasFullCoverage: requiredTerms.length === 0 && authorSatisfied && items.length > 0,
      authorConstraintSatisfied: authorSatisfied,
    };
  }
  for (const item of items) {
    const haystack = [
      item?.author_name || '',
      item?.author_handle || '',
      item?.author_handle ? `@${String(item.author_handle).replace(/^@/, '')}` : '',
      item?.text || '',
    ].join(' ').toLowerCase();
    const covered = requiredTerms.filter((t) => haystack.includes(t.toLowerCase()));
    if (covered.length > bestCovered.length) {
      bestCovered = covered;
      const coveredSet = new Set(covered.map((t) => t.toLowerCase()));
      bestMissing = requiredTerms.filter((t) => !coveredSet.has(t.toLowerCase()));
    }
    const handle = String(item?.author_handle || '').replace(/^@/, '').toLowerCase();
    if (idHandles.length > 0 && idHandles.includes(handle)) authorSatisfied = true;
  }
  if (idHandles.length === 0) authorSatisfied = true;
  return {
    requiredTerms,
    bestCoveredTerms: bestCovered,
    missingTerms: bestMissing,
    hasFullCoverage: bestMissing.length === 0 && authorSatisfied,
    authorConstraintSatisfied: authorSatisfied,
  };
}

/**
 * canonical post identity: status ID > URL内status ID > normalized URL > stable fallback。
 * text単独をidentityにしない。同一本文・別IDは別postとして保持する。
 */
export function getRealtimeCanonicalIdentity(item: Record<string, any>): string {
  if (!item || typeof item !== 'object') return '';
  const directId = String(item.id || item.statusId || item.status_id || item.tweetId || '').trim();
  if (/^\d+$/.test(directId)) return `status:${directId}`;
  const url = typeof item.url === 'string' ? item.url : typeof item.link === 'string' ? item.link : '';
  if (url) {
    const m = url.match(/(?:\/status\/|\/i\/web\/status\/)(\d+)/i);
    if (m && m[1]) return `status:${m[1]}`;
    try {
      const u = new URL(url);
      u.searchParams.delete('utm_source');
      u.searchParams.delete('utm_medium');
      u.searchParams.delete('utm_campaign');
      const normalized = u.toString().replace(/\?$/, '').toLowerCase();
      if (normalized) return `url:${normalized}`;
    } catch {
      return `url:${url.trim().toLowerCase()}`;
    }
  }
  const handle = String(item.author_handle || item.author_name || '').replace(/^@/, '').trim().toLowerCase();
  const time = String(item.publishedTime || item.created_at || '').trim();
  const text = (typeof item.text === 'string' ? item.text : '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (text) return `fallback:${handle}|${time}|${text.slice(0, 240)}`;
  return '';
}

export interface YahooRealtimeQueryBatch {
  query: string;
  queryIndex: number;
  items: any[];
}

/**
 * plan順でmergeしcanonical identityでdedupする。Promise completion順にしない。
 * contributingQueriesはmerged poolへunique postを1件以上提供したquery。
 */
export function mergeRealtimeQueryBatches(
  batches: YahooRealtimeQueryBatch[],
): { items: any[]; contributingQueries: string[] } {
  const seen = new Set<string>();
  const merged: any[] = [];
  const contributed = new Set<string>();
  for (const batch of batches) {
    if (!batch || !Array.isArray(batch.items)) continue;
    for (const item of batch.items) {
      const key = getRealtimeCanonicalIdentity(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      contributed.add(batch.query);
      merged.push(item);
    }
  }
  const order = new Map<string, number>();
  batches.forEach((b, i) => {
    if (!order.has(b.query)) order.set(b.query, i);
  });
  const contributingQueries = [...contributed].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { items: merged, contributingQueries };
}

/** provider応答の読み取り。JSON直取得の {items} と既存MCP形状の両方を受け付ける。 */
function readRealtimeProviderList(res: any): any[] {
  if (!res || typeof res !== 'object') throw new Error('Invalid realtime provider response shape');
  if (Array.isArray((res as any).items)) return (res as any).items;
  const content = (res as any)?.content?.[0]?.text;
  if (typeof content !== 'string' || !content) throw new Error('Invalid realtime provider response shape');
  const parsed = JSON.parse(content);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray((parsed as any).items)) return (parsed as any).items;
  throw new Error('Invalid realtime provider response shape');
}

/** 既定の realtime 取得。Yahoo JSON を直接呼び、MCP互換形状で返す。バイナリ不使用。 */
export async function callYahooRealtimeJson(toolName: string, args: Record<string, any>): Promise<any> {
  void toolName;
  const page = await searchYahooRealtimePage({
    query: args.query,
    sort: args.sort,
    limit: args.limit,
    page: args.page,
  });
  return { content: [{ text: JSON.stringify({ items: page.items }) }] };
}

async function fetchRealtimeBatch(
  query: string,
  queryIndex: number,
  sort: 'recent' | 'popular',
  limit: number | undefined,
  page: number | undefined,
  callMcp: typeof callYahooMcp,
  errors?: Array<{ query: string; message: string }>,
): Promise<YahooRealtimeQueryBatch> {
  try {
    const mcpRes = await callMcp('yahoo_realtime_search', {
      query,
      sort,
      ...(limit ? { limit } : {}),
      ...(page ? { page } : {}),
    });
    const rawList = readRealtimeProviderList(mcpRes);
    return { query, queryIndex, items: rawList.map((item: any) => normalizeRealtimeItem(item)) };
  } catch (err: any) {
    errors?.push({ query, message: err?.message || String(err) });
    return { query, queryIndex, items: [] };
  }
}

function runRealtimeWave(
  queries: string[],
  startIndex: number,
  sort: 'recent' | 'popular',
  limit: number | undefined,
  page: number | undefined,
  callMcp: typeof callYahooMcp,
  errors?: Array<{ query: string; message: string }>,
): Promise<YahooRealtimeQueryBatch[]> {
  return Promise.allSettled(
    queries.map((q, i) => fetchRealtimeBatch(q, startIndex + i, sort, limit, page, callMcp, errors)),
  ).then((settled) =>
    settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      errors?.push({ query: queries[i], message: 'wave settled without a response' });
      return { query: queries[i], queryIndex: startIndex + i, items: [] };
    }),
  );
}

/** Yahoo リアルタイム検索 (Retrieval v1: bounded query union + parallel waves + adaptive stop) */
export async function searchYahooRealtime(options: YahooRealtimeOptions | {
  query: string;
  sort?: 'recent' | 'popular';
  limit?: number;
  page?: number;
  disableFallback?: boolean;
  detailEnrichment?: boolean;
  verbose?: boolean;
}): Promise<{
  items: any[];
  count: number;
  effectiveQuery: string;
  originalQuery: string;
  isFallback: boolean;
  source: 'x';
  retrievalQueries: string[];
  contributingQueries: string[];
  resultsMerged: boolean;
  executedWaves: number;
  stopReason: string;
  requiredTerms: string[];
  coveredTerms: string[];
  missingTerms: string[];
  partial?: boolean;
  providerErrors?: Array<{ query: string; message: string }>;
}> {
  const builtQuery = buildYahooRealtimeQuery(options);
  const originalQuery = builtQuery || (typeof options === 'object' ? options.query || '' : options);
  const sort = options.sort || 'recent';
  const limit = options.limit;
  const page = options.page;
  const detailEnrichment = typeof options === 'object' && options.detailEnrichment !== undefined
    ? options.detailEnrichment
    : true;
  const callMcp: typeof callYahooMcp = (options as any)?._callMcp || callYahooRealtimeJson;

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 40)) {
    throw new Error(`Invalid realtime limit: integer 1-40 expected (got ${String(limit)})`);
  }
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
    throw new Error(`Invalid realtime page: integer >= 1 expected (got ${String(page)})`);
  }

  // provider障害と正常0件を区別する。wave内の1件でも正常応答があれば継続する。
  const providerErrors: Array<{ query: string; message: string }> = [];
  const throwIfTotalFailure = (items: any[]) => {
    if (items.length === 0 && providerErrors.length > 0) {
      throw new Error(
        `Yahoo realtime provider failed: ${providerErrors.map((e) => `${e.query}: ${e.message}`).join('; ')}`,
      );
    }
  };

  const finish = async (
    batches: YahooRealtimeQueryBatch[],
    executedWaves: number,
    stopReason: string,
    coverage: RealtimeCoverageEvaluation,
    exactVariants: string[],
  ) => {
    // 全取得がprovider障害で空の場合は0件成功に見せかけず例外にする。
    throwIfTotalFailure(mergeRealtimeQueryBatches(batches).items);
    const { items: merged, contributingQueries } = mergeRealtimeQueryBatches(batches);
    const retrievalQueries = batches.map((b) => b.query);
    const resultsMerged = contributingQueries.length >= 2;
    const exactSet = new Set(exactVariants);
    const isFallback = contributingQueries.some((q) => !exactSet.has(q));
    const effectiveQuery = contributingQueries.length === 1
      ? contributingQueries[0]
      : originalQuery;
    let finalItems = merged.length > 0 && originalQuery ? rerankRealtimeItems(merged, originalQuery) : merged;
    const requestedLimit = limit;
    if (typeof requestedLimit === 'number' && requestedLimit >= 0) {
      finalItems = finalItems.slice(0, requestedLimit);
    }
    if (detailEnrichment && finalItems.length > 0 && originalQuery) {
      const { items: enriched } = await enrichRealtimeItemsWithXDetail(
        finalItems,
        originalQuery,
        defaultXDetailProvider,
        { verbose: (options as any)?.verbose === true },
      );
      finalItems = enriched;
    } else if (finalItems.length > 0) {
      finalItems = finalItems.map((it) => cleanRealtimeItem(it, (options as any)?.verbose === true));
    }
    return {
      source: 'x' as const,
      originalQuery,
      effectiveQuery,
      isFallback,
      count: finalItems.length,
      items: finalItems,
      retrievalQueries,
      contributingQueries,
      resultsMerged,
      executedWaves,
      stopReason,
      requiredTerms: coverage.requiredTerms,
      coveredTerms: coverage.bestCoveredTerms,
      missingTerms: coverage.missingTerms,
      ...(providerErrors.length > 0 ? { partial: true, providerErrors: [...providerErrors] } : {}),
    };
  };

  if ((options as any)?.disableFallback === true) {
    const q = builtQuery;
    const batches = q ? await runRealtimeWave([q], 0, sort, limit, page, callMcp, providerErrors) : [];
    const requirements = extractRealtimeIntentRequirements(originalQuery);
    const merged = mergeRealtimeQueryBatches(batches);
    throwIfTotalFailure(merged.items);
    const coverage = evaluateRealtimeRetrievalCoverage(merged.items, requirements);
    return finish(batches, batches.length > 0 ? 1 : 0, 'fallback_disabled', coverage, q ? [q] : []);
  }

  // 複雑な式・2ページ目以降は原式の単発取得に固定し、意味を変えるrelaxを行わない。
  if (requiresExactRealtimeQuery(builtQuery) || (page !== undefined && page > 1)) {
    const batches = builtQuery
      ? await runRealtimeWave([builtQuery], 0, sort, limit, page, callMcp, providerErrors)
      : [];
    const requirements = extractRealtimeIntentRequirements(originalQuery);
    const merged = mergeRealtimeQueryBatches(batches);
    throwIfTotalFailure(merged.items);
    const coverage = evaluateRealtimeRetrievalCoverage(merged.items, requirements);
    return finish(
      batches,
      batches.length > 0 ? 1 : 0,
      coverage.hasFullCoverage ? 'full_coverage' : 'no_next_candidate',
      coverage,
      builtQuery ? [builtQuery] : [],
    );
  }

  const requirements = extractRealtimeIntentRequirements(originalQuery);
  const exactVariants = buildRealtimeExactQueryVariants(builtQuery);
  const batches: YahooRealtimeQueryBatch[] = [];
  const executed = new Set<string>();
  let executedWaves = 0;

  const takeBudget = (candidates: string[]): string[] => {
    const out: string[] = [];
    for (const q of candidates) {
      if (batches.length + out.length >= MAX_REALTIME_RETRIEVAL_QUERIES) break;
      if (out.length >= MAX_REALTIME_QUERIES_PER_WAVE) break;
      if (!q || executed.has(q)) continue;
      out.push(q);
    }
    return out;
  };

  // Wave 1: exact intent (original + canonical syntax variant)
  const wave1Queries = takeBudget(exactVariants);
  if (wave1Queries.length > 0) {
    const res = await runRealtimeWave(wave1Queries, batches.length, sort, limit, page, callMcp, providerErrors);
    for (const b of res) {
      batches.push(b);
      executed.add(b.query);
    }
    executedWaves = 1;
  }
  let coverage = evaluateRealtimeRetrievalCoverage(mergeRealtimeQueryBatches(batches).items, requirements);
  if (coverage.hasFullCoverage) {
    return finish(batches, executedWaves, 'full_coverage', coverage, exactVariants);
  }
  if (requirements.semanticRequirements.length === 0) {
    return finish(batches, executedWaves, 'no_semantic_requirements', coverage, exactVariants);
  }

  // Wave 2: minimal relaxation (missing-term-driven drop-one, max 2)
  const wave2Candidates = buildRealtimeRelaxationCandidates(
    requirements.semanticRequirements,
    requirements.protectedModifiers,
    coverage.missingTerms,
    executed,
  );
  const wave2Queries = takeBudget(wave2Candidates);
  if (wave2Queries.length > 0) {
    const res = await runRealtimeWave(wave2Queries, batches.length, sort, limit, page, callMcp, providerErrors);
    for (const b of res) {
      batches.push(b);
      executed.add(b.query);
    }
    executedWaves = 2;
  }
  coverage = evaluateRealtimeRetrievalCoverage(mergeRealtimeQueryBatches(batches).items, requirements);
  if (coverage.hasFullCoverage) {
    return finish(batches, executedWaves, 'full_coverage', coverage, exactVariants);
  }
  if (batches.length >= MAX_REALTIME_RETRIEVAL_QUERIES) {
    return finish(batches, executedWaves, 'query_budget', coverage, exactVariants);
  }

  // Wave 3: bounded rescue (unexecuted drop-one remainder + missing-term singles)
  const rescue: string[] = [];
  const remainder = buildRealtimeRelaxationCandidates(
    requirements.semanticRequirements,
    requirements.protectedModifiers,
    coverage.missingTerms,
    executed,
  );
  for (const q of remainder) {
    if (!executed.has(q) && !rescue.includes(q)) rescue.push(q);
  }
  const prefix = requirements.protectedModifiers.join(' ').trim();
  for (const term of coverage.missingTerms) {
    const q = prefix ? `${prefix} ${term}`.trim() : term.trim();
    if (q && !executed.has(q) && !rescue.includes(q) && term.trim()) rescue.push(q);
  }
  const wave3Queries = takeBudget(rescue);
  if (wave3Queries.length === 0) {
    return finish(batches, executedWaves, 'no_candidates', coverage, exactVariants);
  }
  const res3 = await runRealtimeWave(wave3Queries, batches.length, sort, limit, page, callMcp, providerErrors);
  for (const b of res3) {
    batches.push(b);
    executed.add(b.query);
  }
  executedWaves = 3;
  coverage = evaluateRealtimeRetrievalCoverage(mergeRealtimeQueryBatches(batches).items, requirements);
  throwIfTotalFailure(mergeRealtimeQueryBatches(batches).items);
  if (coverage.hasFullCoverage) {
    return finish(batches, executedWaves, 'full_coverage', coverage, exactVariants);
  }
  if (batches.length >= MAX_REALTIME_RETRIEVAL_QUERIES) {
    return finish(batches, executedWaves, 'query_budget', coverage, exactVariants);
  }
  return finish(batches, executedWaves, 'waves_complete', coverage, exactVariants);
}

/** X (Twitter) アカウントページやポストURLからリアルタイム検索・スニペットを用いてコンテンツを抽出（未ログイン遮断バイパス） */
export async function fetchTweetsForUrlOrUser(
  urlOrHandle: string,
  options: { limit?: number; contextTitle?: string; snippet?: string } = {},
): Promise<{ title: string; content: string; author?: string; publishedTime?: string; siteName: string } | null> {
  let handle = '';
  let statusId = '';

  // 1. 個別ポストURL (/status/123456 または /i/web/status/123456) の判定
  const statusMatch = urlOrHandle.match(/(?:https?:\/\/(?:x\.com|twitter\.com|mobile\.twitter\.com)\/)?(?:i\/web\/status\/|([a-zA-Z0-9_]{1,30})\/status\/)(\d+)/i);
  if (statusMatch) {
    if (statusMatch[1]) handle = statusMatch[1];
    statusId = statusMatch[2];
  } else {
    // アカウントトップ (/username) の判定
    const userMatch = urlOrHandle.match(/(?:https?:\/\/(?:x\.com|twitter\.com|mobile\.twitter\.com)\/)?@?([a-zA-Z0-9_]{1,30})(?:\/|$|\?)/i);
    if (userMatch) {
      const extracted = userMatch[1].toLowerCase();
      const reserved = ['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search'];
      if (!reserved.includes(extracted)) {
        handle = userMatch[1];
      }
    }
  }

  if (!handle && !statusId && !options.contextTitle && !options.snippet) return null;

  // statusId が判明している場合、まず FxTwitter detail を 1回直接試行 (Note Tweet 全文取得)
  if (statusId) {
    try {
      const detail = await defaultXDetailProvider.fetchStatus(statusId);
      if (detail && detail.text) {
        const author = detail.author
          ? `${detail.author.name} (@${detail.author.screenName})`
          : handle ? `@${handle}` : 'X User';
        const title = options.contextTitle || `${author} on X: "${detail.text.slice(0, 50)}..."`;
        const markdown = `# ${title}\n\nURL: ${urlOrHandle}\nAuthor: ${author}\n\n${detail.text}`;
        return {
          title,
          content: markdown.trim(),
          author,
          publishedTime: detail.createdAt,
          siteName: 'X (Twitter)',
        };
      }
    } catch {
      // fail-soft: 失敗時は既存の Yahoo リアルタイム検索・スニペットフォールバックへ
    }
  }

  // 検索クエリ候補: 1) contextTitle (日本語名など), 2) @handle
  const searchQueries: string[] = [];
  if (options.contextTitle) {
    const cleanTitle = options.contextTitle
      .replace(/\s*\(@?[a-zA-Z0-9_]+\)\s*\/.*$/, '')
      .replace(/[\/X Twitter].*$/, '')
      .replace(/^[^\s]+ on X:\s*"?/i, '')
      .replace(/"?\s*\/ X$/i, '')
      .trim();
    if (cleanTitle && cleanTitle.length > 2) searchQueries.push(cleanTitle);
  }
  if (handle) {
    searchQueries.push(`id:${handle}`);
    searchQueries.push(`@${handle}`);
  }

  let matchedItems: any[] = [];
  let authorName = '';

  for (const q of searchQueries) {
    try {
      const page = await searchYahooRealtimePage({ query: q, sort: 'recent', limit: options.limit || 15 });
      const items = page.items;
      if (items.length > 0) {
        // handle がある場合は、その本人のポストを優先、なければ関連ポスト
        if (handle) {
          const lowerHandle = handle.toLowerCase();
          const selfTweets = items.filter(
            (it: any) => (it.author_handle || '').replace(/^@/, '').toLowerCase() === lowerHandle,
          );
          if (selfTweets.length > 0) {
            matchedItems = selfTweets;
            authorName = selfTweets[0].author_name || (selfTweets[0] as any).author || handle;
            break;
          }
        }
        if (matchedItems.length === 0) {
          matchedItems = items;
          authorName = items[0].author_name || (items[0] as any).author || handle;
          break;
        }
      }
    } catch {}
  }

  // リアルタイム検索でヒットしなかった場合、または個別ポストでスニペット/タイトルがある場合のフォールバック
  if (matchedItems.length === 0) {
    if (options.snippet || options.contextTitle) {
      const displayAuthor = authorName || (handle ? `@${handle}` : 'X User');
      const textBody = options.snippet || options.contextTitle || '';
      const markdown = `# ${options.contextTitle || `${displayAuthor} / X`}\n\nURL: ${urlOrHandle}\n\n${textBody}`;
      return {
        title: options.contextTitle || `${displayAuthor} (@${handle}) / X`,
        content: markdown.trim(),
        author: displayAuthor,
        siteName: 'X (Twitter)',
      };
    }
    return null;
  }

  const displayAuthor = authorName || (handle ? `@${handle}` : 'X User');
  const latestPublished = matchedItems[0]?.created_at
    ? new Date(matchedItems[0].created_at * 1000).toISOString()
    : undefined;

  let markdown = `# ${displayAuthor} (@${handle || displayAuthor}) - X (Twitter) 最新ポスト\n\n`;
  if (statusId && options.snippet) {
    markdown += `### ポスト本文\n${options.snippet}\n\n---\n\n`;
  }

  markdown += `### 最新ポスト一覧\n\n`;
  for (const tweet of matchedItems.slice(0, options.limit || 10)) {
    const dateStr = tweet.created_at
      ? new Date(tweet.created_at * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : '';
    const author = tweet.author_name ? `${tweet.author_name} (@${tweet.author_handle})` : `@${tweet.author_handle}`;
    markdown += `#### ${author} [${dateStr}]\n${tweet.text}\n\n`;
  }

  return {
    title: options.contextTitle || `${displayAuthor} (@${handle}) / X`,
    content: markdown.trim(),
    author: displayAuthor,
    publishedTime: latestPublished,
    siteName: 'X (Twitter)',
  };
}

/** Yahoo 画像検索 */
export async function searchYahooImage(options: {
  query: string;
  limit?: number;
  page?: number;
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_image_search', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.page ? { page: options.page } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'image';
    if (Array.isArray(json.items)) {
      json.items = json.items.map((item: any) => ({ source: 'image' as const, ...item }));
    }
    return json;
  } catch {
    return { source: 'image', raw: content };
  }
}

/** Yahoo 動画検索 */
export async function searchYahooVideo(options: {
  query: string;
  limit?: number;
  page?: number;
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_video_search', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.page ? { page: options.page } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'video';
    if (Array.isArray(json.items)) {
      json.items = json.items.map((item: any) => ({ source: 'video' as const, ...item }));
    }
    return json;
  } catch {
    return { source: 'video', raw: content };
  }
}

/** Yahoo ニュース検索 */
export async function searchYahooNews(options: {
  query: string;
  limit?: number;
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_news_search', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'news';
    if (Array.isArray(json.items)) {
      json.items = json.items.map((item: any) => ({
        source: 'news' as const,
        siteName: 'Yahoo!ニュース',
        publisher: item.publisher,
        author: item.publisher,
        publishedTime: item.published_at,
        ...item,
      }));
    }
    return json;
  } catch {
    return { source: 'news', raw: content };
  }
}

/** Yahoo 知恵袋検索 */
export async function searchYahooChiebukuro(options: {
  query: string;
  limit?: number;
  page?: number;
  status?: 'all' | 'open' | 'vote' | 'solved';
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_chiebukuro_search', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.page ? { page: options.page } : {}),
    ...(options.status && options.status !== 'all' ? { status: options.status } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'chiebukuro';
    if (Array.isArray(json.items)) {
      const normalized = json.items.map((item: any) => ({
        source: 'chiebukuro' as const,
        siteName: 'Yahoo!知恵袋',
        publishedTime: item.posted_at || item.updated_at,
        snippet: item.best_answer || item.snippet || item.description || item.content,
        ...item,
      }));
      json.items = rerankSearchResults(normalized, options.query);
      json.count = json.items.length;
    }
    return json;
  } catch {
    return { source: 'chiebukuro', raw: content };
  }
}

/** Yahoo サジェスト（キーワード補完） */
export async function getSuggestedKeywords(options: {
  query: string;
  limit?: number;
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_suggest_keywords', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'suggest';
    return json;
  } catch {
    return { source: 'suggest', raw: content };
  }
}

/** Web 検索結果アイテム一覧から公式 X アカウント (@handle) を自動抽出 */
export function extractOfficialXHandleFromWebResults(items: any[]): string | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  for (const item of items) {
    const url = item.url || item.link || '';
    if (!url) continue;
    // 投稿URL、ハッシュタグ、インテント等は除外
    if (/(?:\/status\/|\/i\/|intent\/|share|search|hashtag)/i.test(url)) {
      continue;
    }
    // x.com または twitter.com のアカウントトップURLを検出
    const match = url.match(/^https?:\/\/(?:x\.com|twitter\.com)\/(?:#!\/)?@?([a-zA-Z0-9_]{1,30})(?:\/?|\?[^/]*)$/i);
    if (match && match[1]) {
      const handle = match[1];
      // 予約語や機能パスを除外
      if (!/^(about|help|settings|login|signup|tos|privacy|download|jobs|home|explore)$/i.test(handle)) {
        return handle;
      }
    }
  }
  return undefined;
}

/**
 * 公式枠と一般枠のリアルタイム検索結果を重複排除し、公式投稿を最上位に配置してマージ
 */
export function mergeRealtimeItemsWithDedup(
  officialItems: any[],
  publicItems: any[],
): any[] {
  const seenKeys = new Set<string>();
  const merged: any[] = [];

  // 1. 公式枠の登録 (最優先)
  if (Array.isArray(officialItems)) {
    for (const item of officialItems) {
      const key = (item.url || item.id || item.text || '').trim();
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        merged.push({
          ...item,
          isOfficial: true,
        });
      }
    }
  }

  // 2. 一般枠の登録 (公式枠と重複しないものを追加)
  if (Array.isArray(publicItems)) {
    for (const item of publicItems) {
      const key = (item.url || item.id || item.text || '').trim();
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        merged.push({
          ...item,
          isOfficial: false,
        });
      }
    }
  }

  return merged;
}
