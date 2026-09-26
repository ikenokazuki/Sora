import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import * as cheerio from 'cheerio';
import { filterByDomains, rerankSearchResults, scoreSearchCandidate, reciprocalRankFusion } from '../enrichment.js';
import {
  enrichRealtimeItemsWithXDetail,
  defaultXDetailProvider,
  rankRealtimeItems,
  classifyRealtimeIntent,
  cleanRealtimeItem,
  type RealtimeIntent,
} from './x_detail.js';
import { incrementSecurityCounter } from '../security/metrics.js';

// Yahoo MCP バイナリのパス
export const YAHOO_MCP_PATH =
  process.env.YAHOO_MCP_PATH ||
  (existsSync('/usr/local/bin/yahoo-search-mcp') ? '/usr/local/bin/yahoo-search-mcp' :
   existsSync(join(import.meta.dir, '../../bin/yahoo-search-mcp')) ? join(import.meta.dir, '../../bin/yahoo-search-mcp') :
   existsSync('/home/ikeno/app/oshiframe/backend/bin/Yahoo-Japan-Search-MCP-v0.1.0-linux-x64/yahoo-search-mcp')
     ? '/home/ikeno/app/oshiframe/backend/bin/Yahoo-Japan-Search-MCP-v0.1.0-linux-x64/yahoo-search-mcp'
     : 'yahoo-search-mcp');

/** Upstream rate discipline for Yahoo MCP calls.
 * Sequential eval and multi-query union can burst against provider
 * limits (observed HTTP 429). A shared gate enforces a minimum
 * interval; rate-limit responses trip a breaker instead of fanning
 * out into fallback and rescue queries.
 */
export function yahooMinIntervalMs(): number {
  const v = parseInt(process.env.SORA_YAHOO_MIN_INTERVAL_MS || '', 10);
  if (Number.isFinite(v) && v >= 0) return v;
  return 500;
}

let yahooCallGate: Promise<void> = Promise.resolve();

export function resetYahooCallGate(): void {
  yahooCallGate = Promise.resolve();
}

async function gateYahooCall(): Promise<void> {
  if (process.env.SORA_YAHOO_THROTTLE === 'off') return;
  const minInterval = yahooMinIntervalMs();
  if (!(minInterval > 0)) return;
  let release!: () => void;
  const prev = yahooCallGate;
  yahooCallGate = new Promise<void>((r) => { release = r; });
  try {
    await prev;
    const last = (gateYahooCall as any)._lastStart || 0;
    const elapsed = Date.now() - last;
    if (elapsed < minInterval) {
      await new Promise((r) => setTimeout(r, minInterval - elapsed));
    }
    (gateYahooCall as any)._lastStart = Date.now();
  } finally {
    release();
  }
}

export function isYahooRateLimitText(text: string): boolean {
  const t = text || '';
  if (/too many requests|rate[\s_-]*limit|request throttl/i.test(t)) return true;
  return /(http|status|error|code)[^0-9a-z]{0,20}429/i.test(t) || /429[^0-9]{0,30}(too many|rate limit|error)/i.test(t);
}

export function yahooResultHasData(rawText: string): boolean {
  try {
    const parsed = JSON.parse(rawText || '');
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && Array.isArray(parsed.items)) return parsed.items.length > 0;
  } catch {}
  return false;
}

export function yahooBreakerCooldownMs(): number {
  const v = parseInt(process.env.SORA_YAHOO_BREAKER_COOLDOWN_MS || '', 10);
  if (Number.isFinite(v) && v >= 0) return v;
  return 120000;
}

let yahooBreakerTrippedAt: number | null = null;

export function isYahooBreakerOpen(): boolean {
  if (yahooBreakerTrippedAt == null) return false;
  if (process.env.SORA_YAHOO_THROTTLE === 'off') return false;
  return yahooBreakerCooldownMs() > (Date.now() - yahooBreakerTrippedAt);
}

export function tripYahooBreaker(): void {
  yahooBreakerTrippedAt = Date.now();
}

export function resetYahooBreaker(): void {
  yahooBreakerTrippedAt = null;
}

export function isYahooRateLimitedError(err: any): boolean {
  return !!err && (err as any).code === 'YAHOO_RATE_LIMITED';
}

/** Yahoo-Japan-Search-MCP 実行 (ステートレス 5ms 起動 & タイムアウト保護) */
export async function callYahooMcp(toolName: string, args: Record<string, any>, timeoutMs = 15000): Promise<any> {
  await gateYahooCall();
  if (isYahooBreakerOpen()) {
    const err: any = new Error('Yahoo provider throttled by breaker');
    err.code = 'YAHOO_RATE_LIMITED';
    try { incrementSecurityCounter('sora_throttled_total'); } catch {}
    throw err;
  }
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
            const rawText = json.result?.content?.[0]?.text || '';
            if (!yahooResultHasData(rawText) && (isYahooRateLimitText(rawText) || isYahooRateLimitText(stderr))) {
              const err: any = new Error(`Yahoo provider rate limited (tool "${toolName}")`);
              err.code = 'YAHOO_RATE_LIMITED';
              try { tripYahooBreaker(); } catch {}
              try { incrementSecurityCounter('sora_throttled_total'); } catch {}
              return reject(err);
            }
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

export function webQueryUnionWeight(queryIndex: number): number {
  if (queryIndex <= 0) return 1.0;
  return 0.6;
}

export function mergeYahooWebQueryBatches(
  batches: YahooWebQueryBatch[],
  bindingQuery: string,
  includeDomains?: string[],
  excludeDomains?: string[],
): any[] {
  const merged: any[] = [];
  const seen = new Map<string, any>();
  let insertionOrder = 0;

  for (const batch of batches) {
    // providerRank は当該SERP内の元の順位 (フィルタ前のindex) を保持する
    const normalized = batch.items.map((item: any, providerRank: number) => ({
      source: 'web' as const,
      snippet: item.description || item.snippet,
      ...item,
      providerRank,
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
      const existing = seen.get(key);
      if (existing) {
        // P2:同一URLで後発SERPのsnippetが豊富な場合は保持 (first-winsによる証拠欠落防止)
        try {
          const curLen = `${existing.title || ""} ${existing.snippet || existing.description || ""}`.length;
          const newLen = `${item.title || ""} ${item.snippet || item.description || ""}`.length;
          if (newLen > curLen) {
            if (item.title) existing.title = item.title;
            if (item.snippet || item.description) { existing.snippet = item.snippet || item.description; if (item.description) existing.description = item.description; }
          }
        } catch {}

        // 重複URLは初出を保持し、providerRanks のみ追記する (RRF入力用)
        existing.providerRanks.push({ queryIndex: batch.queryIndex, rank: item.providerRank });
        continue;
      }
      item.providerRanks = [{ queryIndex: batch.queryIndex, rank: item.providerRank }];
      (item as any).__insertionOrder = insertionOrder++;
      seen.set(key, item);
      merged.push(item);
    }
  }

  // RRF で複数SERP統合 (検索プロバイダ順位を壊さず統合する)
  // 単一バッチ時は RRF 順 = providerRank 順と等価になる
  for (const item of merged) {
    item.rrfScore = reciprocalRankFusion(
      item.providerRanks.map((p: any) => ({ key: String(p.queryIndex), rank: p.rank })),
      60,
      (key) => webQueryUnionWeight(parseInt(key, 10)),
    );
  }

  // 診断用 lexical スコア (ランキング確定には使わない)
  try {
    const scored = scoreSearchCandidate(merged, bindingQuery);
    for (const s of scored) {
      (s.item as any).lexicalScore = s.lexicalScore;
    }
  } catch {
    // 診断失敗時は無視
  }

  if (!isRrfEnabled()) {
    for (const item of merged) {
      delete (item as any).__insertionOrder;
    }
    return merged;
  }
  merged.sort((a: any, b: any) => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    const aMin = Math.min(...a.providerRanks.map((p: any) => p.rank));
    const bMin = Math.min(...b.providerRanks.map((p: any) => p.rank));
    if (aMin !== bMin) return aMin - bMin;
    return (a.__insertionOrder ?? 0) - (b.__insertionOrder ?? 0);
  });
  for (const item of merged) {
    delete (item as any).__insertionOrder;
  }
  return merged;
}

/** Rollback flags (RFC rollback strategy). Default true = Retrieval v2 behavior. */
export function isWebNativeRankingEnabled(): boolean {
  return process.env.SORA_WEB_NATIVE_RANKING !== 'false';
}
export function isRrfEnabled(): boolean {
  return process.env.SORA_RRF_ENABLED !== 'false';
}

/** Retrieval confidence 判定 (追加検索が必要な弱い取得か) */
export function assessRetrievalConfidence(
  items: any[],
  originalQuery: string,
): { good: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!items || items.length === 0) {
    return { good: false, reasons: ['empty'] };
  }
  if (items.length < 3) {
    reasons.push('few-results');
  }
  // クエリ語のカバレッジ (2語以上クエリで要求語がsnippet不在なら弱い)
  try {
    const words = originalQuery
      .toLowerCase()
      .trim()
      .split(/[\s　]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2);
    if (words.length >= 2) {
      const corpus = items
        .slice(0, 5)
        .map((it: any) => `${it.title || ''} \n ${it.snippet || it.description || ''}`.toLowerCase())
        .join('\n');
      const missing = words.filter((w) => !corpus.includes(w));
      if (missing.length > 0) {
        reasons.push(`missing-terms:${missing.join(',')}`);
      }
    }
  } catch {
    // カバレッジ判定失敗時は無視
  }
  // 同一ドメイン偏り (上位5件が単一ホストなら弱い)
  try {
    const hosts = items.slice(0, 5).map((it: any) => {
      try {
        return new URL(it.url || it.link).hostname.toLowerCase();
      } catch {
        return '';
      }
    }).filter(Boolean);
    const uniq = new Set(hosts);
    if (hosts.length >= 3 && uniq.size === 1) {
      reasons.push('single-domain');
    }
  } catch {
    // ドメイン判定失敗時は無視
  }
  return { good: reasons.length === 0, reasons };
}

/** Yahoo Web 検索 (プレフィルタリング site: / -site: 対応 & 0件時スマートフォールバック) */
export async function searchYahooWeb(options: {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: 'all' | 'day' | 'week' | 'year';
  disableFallback?: boolean;
}): Promise<any> {
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
    let webUnionThrottled = false;

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
        const mcpRes = await callYahooMcp('yahoo_web_search', {
          query: effectiveWebQuery,
          ...(webSiteArg ? { site: webSiteArg } : {}),
          ...(options.updated && options.updated !== 'all'
            ? { updated: options.updated }
            : {}),
        });

        const content = mcpRes?.content?.[0]?.text || '[]';
        const json = JSON.parse(content);

        if (json && Array.isArray(json.items)) {
          lastParsedData = json;
          if (json.items.length > 0) {
            batches.push({
              query: q,
              queryIndex: i,
              items: json.items,
            });
          }
        }
      } catch (unionErr) {
        if (isYahooRateLimitedError(unionErr)) {
          webUnionThrottled = true;
          break;
        }
        // One failed rescue query must not discard sibling results.
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

      try { incrementSecurityCounter('sora_search_queries_total'); } catch {}
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
        ...(webUnionThrottled ? { throttled: true } : {}),
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
      throttled: webUnionThrottled ? true : undefined,
    };
  }

  let webSequentialThrottled = false;
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
      const mcpRes = await callYahooMcp('yahoo_web_search', {
        query: effectiveWebQuery,
        ...(webSiteArg ? { site: webSiteArg } : {}),
        ...(options.updated && options.updated !== 'all' ? { updated: options.updated } : {}),
      });

      const content = mcpRes?.content?.[0]?.text || '[]';
      const json = JSON.parse(content);
      if (json && Array.isArray(json.items) && json.items.length > 0) {
        // Provider ranking contains signals that are unavailable
        // to our lightweight lexical scorer. Do not globally
        // rerank a single SERP here. Local scores are used later
        // for diagnostics and deep-retrieval selection only.
        const normalizedItems = json.items.map((item: any, providerRank: number) => ({
          source: 'web' as const,
          snippet: item.description || item.snippet,
          ...item,
          providerRank,
          providerRanks: [{ queryIndex: i, rank: providerRank }],
          retrievalQuery: q,
          retrievalQueryIndex: i,
        }));
        const filtered = filterByDomains(normalizedItems, options.includeDomains, options.excludeDomains);
        // 診断用 lexical スコアのみ付与し、順序は provider順のまま返す
        try {
          const scored = scoreSearchCandidate(filtered, options.query);
          for (const s of scored) {
            (s.item as any).lexicalScore = s.lexicalScore;
          }
        } catch {
          // 診断失敗時は無視
        }
        // Rollback: legacy mode restores BM25 global reorder (providerRank kept for shadow compare).
        if (!isWebNativeRankingEnabled()) {
          json.items = rerankSearchResults(filtered, options.query);
          json.count = json.items.length;
          json.source = 'web';
          json.effectiveQuery = q;
          json.isFallback = i > 0;
          json.nativeRanking = false;
          return json;
        }
        // P1-2: 初回ヒットが弱い場合のみ1回だけ追加検索 (adaptive)
        // 0件時フォールバックとは別に、件数・カバレッジ・ドメイン偏りで判定する
        if (i === 0 && candidateQueries.length > 1) {
          const conf = assessRetrievalConfidence(filtered, options.query);
          if (!conf.good) {
            try {
              const rescueQ = candidateQueries[1];
              let rescueEffective = rescueQ;
              let rescueSiteArg: string | undefined = undefined;
              if (options.includeDomains && options.includeDomains.length === 1) {
                rescueSiteArg = options.includeDomains[0];
              } else if (options.includeDomains && options.includeDomains.length > 1) {
                rescueEffective += ` (${options.includeDomains.map((d) => `site:${d}`).join(' OR ')})`;
              }
              if (options.excludeDomains && options.excludeDomains.length > 0) {
                rescueEffective += ` ${options.excludeDomains.map((d) => `-site:${d}`).join(' ')}`;
              }
              const rescueRes = await callYahooMcp('yahoo_web_search', {
                query: rescueEffective,
                ...(rescueSiteArg ? { site: rescueSiteArg } : {}),
                ...(options.updated && options.updated !== 'all' ? { updated: options.updated } : {}),
              });
              const rescueContent = rescueRes?.content?.[0]?.text || '[]';
              const rescueJson = JSON.parse(rescueContent);
              if (rescueJson && Array.isArray(rescueJson.items) && rescueJson.items.length > 0) {
                const merged = mergeYahooWebQueryBatches(
                  [
                    { query: q, queryIndex: 0, items: json.items },
                    { query: rescueQ, queryIndex: 1, items: rescueJson.items },
                  ],
                  options.query,
                  options.includeDomains,
                  options.excludeDomains,
                );
                if (merged.length > 0) {
                  try { incrementSecurityCounter('sora_search_queries_total'); } catch {}
                  return {
                    items: merged,
                    count: merged.length,
                    source: 'web',
                    originalQuery: options.query,
                    bindingQuery: options.query,
                    retrievalQueries: [q, rescueQ],
                    effectiveQuery: options.query,
                    isFallback: true,
                    queryUnion: false,
                    adaptiveUnion: true,
                    confidenceReasons: conf.reasons,
                  };
                }
              }
            } catch {
              // 追加検索失敗時は初回結果をそのまま返す
            }
          }
        }
        json.items = filtered;
        json.count = json.items.length;
        json.source = 'web';
        json.effectiveQuery = q;
        json.isFallback = i > 0;
        try { incrementSecurityCounter('sora_search_queries_total'); } catch {}
        return json;
      }
      if (json && Array.isArray(json.items)) {
        lastParsedData = json;
      }
    } catch (seqErr) {
      if (isYahooRateLimitedError(seqErr)) {
        webSequentialThrottled = true;
        break;
      }
      // 候補クエリの次を試行
    }
  }

  if (webSequentialThrottled) {
    return {
      ...lastParsedData,
      items: [],
      count: 0,
      source: 'web',
      originalQuery: options.query,
      bindingQuery: options.query,
      retrievalQueries: [options.query],
      effectiveQuery: options.query,
      isFallback: false,
      throttled: true,
    };
  }
  return lastParsedData;
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
    // Preserve upstream retrieval provenance when re-normalizing final items.
    ...(item.providerRank !== undefined ? { providerRank: item.providerRank } : {}),
    ...(item.providerSort ? { providerSort: item.providerSort } : {}),
    ...(item.retrievalQuery ? { retrievalQuery: item.retrievalQuery } : {}),
    ...(item.retrievalQueryIndex !== undefined ? { retrievalQueryIndex: item.retrievalQueryIndex } : {}),
    ...(item.retrievalWave !== undefined ? { retrievalWave: item.retrievalWave } : {}),
    ...(item.providerRanks !== undefined ? { providerRanks: item.providerRanks } : {}),
    ...(item.rrfScore !== undefined ? { rrfScore: item.rrfScore } : {}),
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
export function buildYahooRealtimeQuery(options: YahooRealtimeOptions | string): string {
  if (typeof options === 'string') {
    return options.replace(/\bfrom:([a-zA-Z0-9_]+)/gi, 'id:$1').trim();
  }

  let baseQuery = (options.query || '').trim();
  // from: を id: に自動置換 (X/Twitter 記法への耐性)
  baseQuery = baseQuery.replace(/\bfrom:([a-zA-Z0-9_]+)/gi, 'id:$1').trim();

  const tokens: string[] = [];

  // 特定アカウントの投稿: id:xxx
  const rawAccount = (options.accountId || options.fromUser || '').trim();
  if (rawAccount) {
    const cleanAccount = rawAccount.replace(/^@/, '');
    const accountRegex = new RegExp(`\\b(?:id|ID):${cleanAccount}\\b`, 'i');
    if (!accountRegex.test(baseQuery)) {
      tokens.push(`id:${cleanAccount}`);
    }
  }

  // 特定アカウント宛ての投稿: @xxx
  const rawTo = (options.toAccount || '').trim();
  if (rawTo) {
    const cleanTo = rawTo.replace(/^@/, '');
    const toRegex = new RegExp(`(^|\\s)@${cleanTo}\\b`, 'i');
    if (!toRegex.test(baseQuery)) {
      tokens.push(`@${cleanTo}`);
    }
  }

  // 特定ハッシュタグ: #xxx
  if (options.hashtags) {
    const tagList = Array.isArray(options.hashtags) ? options.hashtags : [options.hashtags];
    for (const rawTag of tagList) {
      const cleanTag = rawTag.trim().replace(/^#/, '');
      if (cleanTag && !baseQuery.includes(`#${cleanTag}`)) {
        tokens.push(`#${cleanTag}`);
      }
    }
  }

  // 除外キーワード: -xxx
  if (options.excludeWords) {
    const exList = Array.isArray(options.excludeWords) ? options.excludeWords : [options.excludeWords];
    for (const rawEx of exList) {
      const cleanEx = rawEx.trim().replace(/^-/, '');
      if (cleanEx && !baseQuery.includes(`-${cleanEx}`)) {
        tokens.push(`-${cleanEx}`);
      }
    }
  }

  // OR検索: (A B)
  if (options.orWords && options.orWords.length > 0) {
    const cleanOr = options.orWords.map((w) => w.trim()).filter(Boolean);
    if (cleanOr.length > 1) {
      tokens.push(`(${cleanOr.join(' ')})`);
    } else if (cleanOr.length === 1) {
      tokens.push(cleanOr[0]);
    }
  }

  // URL / ドメイン指定
  if (options.url) {
    const cleanUrl = options.url.trim();
    if (cleanUrl && !baseQuery.includes(cleanUrl)) {
      tokens.push(cleanUrl);
    }
  }

  const parts = [baseQuery, ...tokens].filter(Boolean);
  return parts.join(' ').trim();
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
  throttled?: boolean;
  wave?: number;
  sort?: 'recent' | 'popular';
}

/**
 * plan順でmergeしcanonical identityでdedupする。Promise completion順にしない。
 * contributingQueriesはmerged poolへunique postを1件以上提供したquery。
 */
export function mergeRealtimeQueryBatches(
  batches: YahooRealtimeQueryBatch[],
): { items: any[]; contributingQueries: string[] } {
  // X retrieval provenance (P0-X-04): providerRank / providerSort /
  // retrievalQuery / retrievalWave are preserved; repeats across
  // waves accumulate providerRanks and an RRF confidence score (P1-X-01).
  const seen = new Map<string, any>();
  const merged: any[] = [];
  const contributed = new Set<string>();
  for (const batch of batches) {
    if (!batch || !Array.isArray(batch.items)) continue;
    batch.items.forEach((raw: any, batchIndex: number) => {
      const key = getRealtimeCanonicalIdentity(raw);
      if (!key) return;
      const existing = seen.get(key);
      if (existing) {
        existing.providerRanks.push({ queryIndex: batch.queryIndex, rank: batchIndex + 1 });
        return;
      }
      const item = {
        ...raw,
        providerRank: batchIndex + 1,
        providerSort: batch.sort,
        retrievalQuery: batch.query,
        retrievalQueryIndex: batch.queryIndex,
        retrievalWave: batch.wave ?? 1,
        providerRanks: [{ queryIndex: batch.queryIndex, rank: batchIndex + 1 }],
      };
      seen.set(key, item);
      contributed.add(batch.query);
      merged.push(item);
    });
  }
  for (const item of merged) {
    try {
      item.rrfScore = reciprocalRankFusion(
        item.providerRanks.map((pr: any) => ({ key: String(pr.queryIndex), rank: pr.rank })),
      );
    } catch {}
  }
  const order = new Map<string, number>();
  batches.forEach((b, i) => {
    if (!order.has(b.query)) order.set(b.query, i);
  });
  const contributingQueries = [...contributed].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { items: merged, contributingQueries };
}

async function fetchRealtimeBatch(
  query: string,
  queryIndex: number,
  sort: 'recent' | 'popular',
  limit: number | undefined,
  page: number | undefined,
  callMcp: typeof callYahooMcp,
  wave = 1,
): Promise<YahooRealtimeQueryBatch> {
  try {
    const mcpRes = await callMcp('yahoo_realtime_search', {
      query,
      sort,
      ...(limit ? { limit } : {}),
      ...(page ? { page } : {}),
    });
    const content = mcpRes?.content?.[0]?.text || '';
    if (!content) return { query, queryIndex, wave, sort, items: [] };
    const parsed = JSON.parse(content);
    const rawList = Array.isArray(parsed) ? parsed : parsed?.items || [];
    return { query, queryIndex, wave, sort, items: rawList.map((item: any) => normalizeRealtimeItem(item)) };
  } catch (batchErr) {
    if (isYahooRateLimitedError(batchErr)) {
      return { query, queryIndex, wave, sort, items: [], throttled: true };
    }
    try { incrementSecurityCounter('sora_x_provider_error_total'); } catch {}
    return { query, queryIndex, wave, sort, items: [] };
  }
}

async function runRealtimeWave(
  queries: string[],
  startIndex: number,
  sort: 'recent' | 'popular',
  limit: number | undefined,
  page: number | undefined,
  callMcp: typeof callYahooMcp,
  wave = 1,
): Promise<YahooRealtimeQueryBatch[]> {
  const settled = await Promise.allSettled(
    queries.map((q, i) => fetchRealtimeBatch(q, startIndex + i, sort, limit, page, callMcp, wave)),
  );

  return settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { query: queries[i], queryIndex: startIndex + i, wave, sort, items: [] },
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
  intent: RealtimeIntent;
  retrievalQueries: string[];
  contributingQueries: string[];
  resultsMerged: boolean;
  executedWaves: number;
  stopReason: string;
  requiredTerms: string[];
  coveredTerms: string[];
  missingTerms: string[];
  throttled?: boolean;
}> {
  const builtQuery = buildYahooRealtimeQuery(options);
  const originalQuery = builtQuery || (typeof options === 'object' ? options.query || '' : options);
  const sort = options.sort || 'recent';
  const limit = options.limit;
  const page = options.page;
  const detailEnrichment = typeof options === 'object' && options.detailEnrichment !== undefined
    ? options.detailEnrichment
    : true;
  const callMcp: typeof callYahooMcp = (options as any)?._callMcp || callYahooMcp;

  const finish = async (
    batches: YahooRealtimeQueryBatch[],
    executedWaves: number,
    stopReason: string,
    coverage: RealtimeCoverageEvaluation,
    exactVariants: string[],
  ) => {
    const { items: merged, contributingQueries } = mergeRealtimeQueryBatches(batches);
    try {
      incrementSecurityCounter('sora_x_stop_total');
      if (stopReason === 'query_budget') incrementSecurityCounter('sora_x_query_budget_stop_total');
      if (stopReason === 'full_coverage') incrementSecurityCounter('sora_x_full_coverage_stop_total');
    } catch {}
    try { incrementSecurityCounter('sora_x_wave_total', Math.max(1, executedWaves)); } catch {}
    const retrievalQueries = batches.map((b) => b.query);
    const resultsMerged = contributingQueries.length >= 2;
    const exactSet = new Set(exactVariants);
    const isFallback = contributingQueries.some((q) => !exactSet.has(q));
    const effectiveQuery = contributingQueries.length === 1
      ? contributingQueries[0]
      : originalQuery;
    // X-native policy: recent/popular preserve provider order (no generic BM25 rerank).
    let finalItems = merged.length > 0 && originalQuery ? rankRealtimeItems(merged, { query: originalQuery, mode: sort }) : merged;
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
    const intent = classifyRealtimeIntent(originalQuery);
    return {
      source: 'x' as const,
      originalQuery,
      effectiveQuery,
      isFallback,
      intent,
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
    };
  };

  if ((options as any)?.disableFallback === true) {
    const q = builtQuery;
    const batches = q ? await runRealtimeWave([q], 0, sort, limit, page, callMcp) : [];
    if (batches.some((b) => b.throttled)) {
      const dfReq = extractRealtimeIntentRequirements(originalQuery);
      const dfCov = evaluateRealtimeRetrievalCoverage([], dfReq);
      const dfDone = await finish([], 0, 'throttled', dfCov, q ? [q] : []);
      return { ...dfDone, throttled: true };
    }
    const requirements = extractRealtimeIntentRequirements(originalQuery);
    const merged = mergeRealtimeQueryBatches(batches);
    const coverage = evaluateRealtimeRetrievalCoverage(merged.items, requirements);
    return finish(batches, batches.length > 0 ? 1 : 0, 'fallback_disabled', coverage, q ? [q] : []);
  }

  const requirements = extractRealtimeIntentRequirements(originalQuery);
  const exactVariants = buildRealtimeExactQueryVariants(builtQuery);
  const batches: YahooRealtimeQueryBatch[] = [];
  const executed = new Set<string>();
  let executedWaves = 0;
  let sawThrottle = false;

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
    const res = await runRealtimeWave(wave1Queries, batches.length, sort, limit, page, callMcp);
    for (const b of res) {
      batches.push(b);
      executed.add(b.query);
      if (b.throttled) sawThrottle = true;
    }
    executedWaves = 1;
    if (sawThrottle) {
      const w1Cov = evaluateRealtimeRetrievalCoverage(mergeRealtimeQueryBatches(batches).items, requirements);
      const w1Done = await finish(batches, executedWaves, 'throttled', w1Cov, exactVariants);
      return { ...w1Done, throttled: true };
    }
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
    const res2 = await runRealtimeWave(wave2Queries, batches.length, sort, limit, page, callMcp, 2);
    for (const b of res2) {
      batches.push(b);
      executed.add(b.query);
      if (b.throttled) sawThrottle = true;
    }
    executedWaves = 2;
    if (sawThrottle) {
      const w2Cov = evaluateRealtimeRetrievalCoverage(mergeRealtimeQueryBatches(batches).items, requirements);
      const w2Done = await finish(batches, executedWaves, 'throttled', w2Cov, exactVariants);
      return { ...w2Done, throttled: true };
    }
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
  const res3 = await runRealtimeWave(wave3Queries, batches.length, sort, limit, page, callMcp, 3);
  for (const b of res3) {
    if (b.throttled) sawThrottle = true;
  }
  for (const b of res3) {
    batches.push(b);
    executed.add(b.query);
  }
  executedWaves = 3;
  coverage = evaluateRealtimeRetrievalCoverage(mergeRealtimeQueryBatches(batches).items, requirements);
  if (sawThrottle) {
    const done = await finish(batches, executedWaves, 'throttled', coverage, exactVariants);
    return { ...done, throttled: true };
  }
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
      const res = await callYahooMcp('yahoo_realtime_search', { query: q, sort: 'recent', limit: options.limit || 15 });
      const content = res?.content?.[0]?.text || '';
      const parsed = JSON.parse(content);
      const items = Array.isArray(parsed) ? parsed : parsed?.items || [];
      if (items.length > 0) {
        // handle がある場合は、その本人のポストを優先、なければ関連ポスト
        if (handle) {
          const lowerHandle = handle.toLowerCase();
          const selfTweets = items.filter(
            (it: any) => (it.author_handle || '').replace(/^@/, '').toLowerCase() === lowerHandle,
          );
          if (selfTweets.length > 0) {
            matchedItems = selfTweets;
            authorName = selfTweets[0].author_name || selfTweets[0].author || handle;
            break;
          }
        }
        if (matchedItems.length === 0) {
          matchedItems = items;
          authorName = items[0].author_name || items[0].author || handle;
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
