import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import * as cheerio from 'cheerio';
import { filterByDomains, rerankSearchResults, scoreSearchCandidate, reciprocalRankFusion } from '../enrichment.js';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import {
  enrichRealtimeItemsWithXDetail,
  defaultXDetailProvider,
  cleanRealtimeItem,
} from './x_detail.js';
import { incrementSecurityCounter } from '../security/metrics.js';
import { ProviderPressureController, getYahooQueryBudget, defaultYahooPressureOptions } from '../retrieval/provider_pressure.js';
import { setYahooSearchCache, getYahooFreshCache, getYahooStaleCache } from '../retrieval/yahoo_cache.js';
import { getFromCache, runWithSingleFlight, setToCache } from '../cache.js';
import { searchYahooRealtimePage } from './yahoo_realtime_api.js';
import {
  anchorCandidates,
  detectAliasFromOfficialPosts,
  detectRealtimeAnchor,
  detectRealtimeFocus,
  isAnchorBroken,
  isPublicFocusTerm,
  isSearchExcludedTerm,
  postMentions,
  selectRealtimeItems,
  termHits,
  type RealtimeFocus,
} from '../retrieval/realtime_anchor.js';

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

/** Structured Yahoo provider failure: keeps status + Retry-After (spec section 6). */
export class YahooProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'YahooProviderError';
  }
}

/** Parse Retry-After (delta seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

/** Provider-wide Yahoo Web pressure controller (spec section 11). Never shared with X Realtime. */
export const yahooWebPressure = new ProviderPressureController(defaultYahooPressureOptions());

/** Test/support escape hatch. */
export function resetYahooWebPressure(): void {
  yahooWebPressure.reset();
}

function pressureBypassed(): boolean {
  return process.env.SORA_YAHOO_THROTTLE === 'off';
}

/** Short bounded pacing between queries (spec section 5: never sleep long). */
async function paceForYahooPressure(): Promise<void> {
  if (pressureBypassed()) return;
  const waitMs = Math.min(yahooWebPressure.snapshot().spacingMs, 250);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
}

/**
 * Feed one provider outcome into the pressure controller.
 * Structured 429s win; legacy MCP text is the regex fallback (spec section 9).
 * Returns true when the outcome was a rate limit.
 */
export function recordYahooWebResult(err: unknown): boolean {
  try { incrementSecurityCounter('yahoo_request_total'); } catch {}
  if (pressureBypassed()) return false;
  const limited =
    (err instanceof YahooProviderError && err.status === 429) ||
    isYahooRateLimitedError(err) ||
    (err instanceof Error && /429|too many requests|rate limit/i.test(err.message));
  if (limited) {
    const circuitBefore = yahooWebPressure.snapshot().circuit;
    yahooWebPressure.onRateLimit(err instanceof YahooProviderError ? err.retryAfterMs : undefined);
    try { incrementSecurityCounter('yahoo_429_total'); } catch {}
    if (circuitBefore !== 'open' && yahooWebPressure.snapshot().circuit === 'open') {
      try { incrementSecurityCounter('yahoo_circuit_open_total'); } catch {}
    }
  }
  return limited;
}

export function recordYahooWebSuccess(): void {
  try { incrementSecurityCounter('yahoo_request_total'); } catch {}
  if (pressureBypassed()) return;
  yahooWebPressure.onSuccess();
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

/**
 * ドメイン絞り込み配列の正規化。空文字・空白のみの要素を除き、前後の空白を除去して重複を除く。
 * API ドキュメントの「試す」フォームは配列項目を [""] で送りがちで、そのまま "site:" を組み立てると
 * 検索結果が0件になる。有効な要素が残らなければ undefined（絞り込みなし）を返す。
 */
export function normalizeDomainList(list: readonly string[] | undefined): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const cleaned = [...new Set(list.map((d) => (typeof d === 'string' ? d.trim() : '')).filter((d) => d.length > 0))];
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Yahoo Web 検索 (プレフィルタリング site: / -site: 対応 & 0件時スマートフォールバック) */
/** Stable coalescing key for one Yahoo Web search (flags included). */
export function yahooWebSearchFlightKey(options: {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: string;
  disableFallback?: boolean;
}): string {
  const union = process.env.SORA_WEB_QUERY_UNION === 'true' ? 'wqu-on' : 'wqu-off';
  const native = process.env.SORA_WEB_NATIVE_RANKING !== 'false' ? 'native' : 'legacy';
  const v = (options as any)?.verbose === true ? 'verbose' : 'compact';
  return 'yahooweb:v1:' + options.query + ':' + (normalizeDomainList(options.includeDomains) || []).join(',') + ':' + (normalizeDomainList(options.excludeDomains) || []).join(',') + ':' + (options.updated || 'all') + ':' + (options.disableFallback ? 'nofb' : 'fb') + ':' + union + ':' + native + ':' + v;
}

/**
 * Yahoo Web execution order (spec section 30):
 * Fresh Cache -> SingleFlight -> Provider Controller -> Yahoo -> Stale fallback.
 */
export async function searchYahooWeb(options: {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: 'all' | 'day' | 'week' | 'year';
  disableFallback?: boolean;
  noCache?: boolean;
}, deps?: { callYahooMcp?: typeof callYahooMcp }): Promise<any> {
  options = { ...options, includeDomains: normalizeDomainList(options.includeDomains), excludeDomains: normalizeDomainList(options.excludeDomains) };
  const flightKey = yahooWebSearchFlightKey(options);
  const fresh = options.noCache ? null : getYahooFreshCache<any>(flightKey);
  if (fresh) {
    try { incrementSecurityCounter('yahoo_cache_hit_total'); } catch {}
    return { ...fresh, cached: true };
  }
  const res = await runWithSingleFlight(
    flightKey,
    () => searchYahooWebUncached(options, deps, flightKey),
    () => { try { incrementSecurityCounter('yahoo_singleflight_join_total'); } catch {} },
  );
  if (res && Array.isArray(res.items) && res.items.length > 0 && !res.throttled) {
    setYahooSearchCache(flightKey, res);
  }
  return res;
}

async function searchYahooWebUncached(options: {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: 'all' | 'day' | 'week' | 'year';
  disableFallback?: boolean;
}, deps: { callYahooMcp?: typeof callYahooMcp } | undefined, flightKey: string): Promise<any> {
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
  const candidateQueries = options.disableFallback
    ? [options.query]
    : extractRealtimeFallbackQueries(options.query);

  // Pressure-aware query budget (spec sections 15-17): provider health wins over flags.
  const yahooPressureLevel = pressureBypassed() ? 'low' as const : yahooWebPressure.getLevel();
  const yahooQueryBudget = getYahooQueryBudget(yahooPressureLevel);
  const verboseDiag = (options as any)?.verbose === true;

  let lastParsedData: any = { items: [], count: 0, source: 'web' };

  const queryUnionEnabled =
    process.env.SORA_WEB_QUERY_UNION === 'true' &&
    options.disableFallback !== true;

  if (queryUnionEnabled) {
    const boundedQueries = candidateQueries.slice(0, Math.min(2, yahooQueryBudget));
    const batches: YahooWebQueryBatch[] = [];
    const retrievalQueries: string[] = [];
    let webUnionThrottled = false;

    for (let i = 0; i < boundedQueries.length; i++) {
      const q = boundedQueries[i];
      if (!q) continue;
      if (isYahooBreakerOpen()) {
        webUnionThrottled = true;
        break;
      }
      if (!pressureBypassed() && !yahooWebPressure.canRequest()) {
        webUnionThrottled = true;
        break;
      }
      if (i > 0) await paceForYahooPressure();
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
          recordYahooWebResult(err);
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
            if (recordYahooWebResult(new Error(String(content).slice(0, 300)))) {
              webUnionThrottled = true;
              break;
            }
            if (i < boundedQueries.length - 1) await paceForYahooPressure();
            continue;
          }
          batchJson = JSON.parse(content);
        }

        if (batchJson && Array.isArray(batchJson.items)) {
          lastParsedData = batchJson;
          if (batchJson.items.length > 0) {
            recordYahooWebSuccess();
            batches.push({
              query: q,
              queryIndex: i,
              items: batchJson.items,
            });
          }
        }
      } catch (unionErr) {
        const message = ((unionErr as Error)?.message ?? String(unionErr)).slice(0, 300);
        providerErrors.push({ query: q, message });
        const unionLimited = recordYahooWebResult(unionErr);
        if (unionLimited || isYahooRateLimitedError(unionErr)) {
          webUnionThrottled = true;
          break;
        }
        // One failed rescue query must not discard sibling results.
        if (i < boundedQueries.length - 1) await paceForYahooPressure();
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
        ...(webUnionThrottled ? { throttled: true, partial: true, stopReason: 'provider_rate_limited' } : {}),
        ...(providerErrors.length > 0 ? { providerErrors } : {}),
        ...(verboseDiag ? { pressure: yahooWebPressure.getLevel(), queryBudget: yahooQueryBudget } : {}),
      };
    }

    if (webUnionThrottled || providerErrors.length > 0) {
      const staleUnion = getYahooStaleCache<any>(flightKey);
      if (staleUnion) {
        try { incrementSecurityCounter('yahoo_stale_hit_total'); } catch {}
        return { ...staleUnion, stale: true, throttled: webUnionThrottled ? true : undefined, stopReason: webUnionThrottled ? 'provider_rate_limited' : undefined };
      }
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
      stopReason: webUnionThrottled ? 'provider_rate_limited' : undefined,
      providerErrors,
      ...(verboseDiag ? { pressure: yahooWebPressure.getLevel(), queryBudget: yahooQueryBudget } : {}),
    };
  }

  let webSequentialThrottled = false;
  for (let i = 0; i < candidateQueries.length; i++) {
    const q = candidateQueries[i];
    if (isYahooBreakerOpen()) {
      webSequentialThrottled = true;
      break;
    }
    if (!pressureBypassed() && !yahooWebPressure.canRequest()) {
      webSequentialThrottled = true;
      break;
    }
    if (i > 0) await paceForYahooPressure();
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
        recordYahooWebResult(err);
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
          if (recordYahooWebResult(new Error(message))) {
            webSequentialThrottled = true;
            break;
          }
          if (i < candidateQueries.length - 1) await paceForYahooPressure();
          continue;
        }
        json = JSON.parse(content);
      }
      if (json && Array.isArray(json.items) && json.items.length > 0) {
        recordYahooWebSuccess();
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
        if (i === 0 && candidateQueries.length > 1 && yahooQueryBudget >= 2 && (pressureBypassed() || yahooWebPressure.canRequest())) {
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
                    ...(verboseDiag ? { pressure: yahooWebPressure.getLevel(), queryBudget: yahooQueryBudget } : {}),
                  };
                }
              }
            } catch (rescueErr) {
              // 追加検索失敗時は初回結果をそのまま返す
              recordYahooWebResult(rescueErr);
            }
          }
        }
        json.items = filtered;
        json.count = json.items.length;
        json.source = 'web';
        json.effectiveQuery = q;
        json.isFallback = i > 0;
        try { incrementSecurityCounter('sora_search_queries_total'); } catch {}
        if (providerErrors.length > 0) json.providerErrors = providerErrors;
        if (verboseDiag) {
          json.pressure = yahooWebPressure.getLevel();
          json.queryBudget = yahooQueryBudget;
        }
        return json;
      }
      if (json && Array.isArray(json.items)) {
        lastParsedData = json;
      }
    } catch (seqErr) {
      const message = ((seqErr as Error)?.message ?? String(seqErr)).slice(0, 300);
      providerErrors.push({ query: q, message });
      const seqLimited = recordYahooWebResult(seqErr);
      if (seqLimited || isYahooRateLimitedError(seqErr)) {
        webSequentialThrottled = true;
        break;
      }
      // 候補クエリの次を試行（失敗は記録する）
      if (i < candidateQueries.length - 1) await paceForYahooPressure();
    }
  }

  if (webSequentialThrottled) {
    const staleSeq = getYahooStaleCache<any>(flightKey);
    if (staleSeq) {
      try { incrementSecurityCounter('yahoo_stale_hit_total'); } catch {}
      return { ...staleSeq, stale: true, throttled: true, stopReason: 'provider_rate_limited' };
    }
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
      stopReason: 'provider_rate_limited',
      ...(providerErrors.length > 0 ? { providerErrors } : {}),
      ...(verboseDiag ? { pressure: yahooWebPressure.getLevel(), queryBudget: yahooQueryBudget } : {}),
    };
  }
  if (providerErrors.length > 0) {
    const staleTail = getYahooStaleCache<any>(flightKey);
    if (staleTail) {
      try { incrementSecurityCounter('yahoo_stale_hit_total'); } catch {}
      return { ...staleTail, stale: true };
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
  if (!res.ok) {
    throw new YahooProviderError(
      `Yahoo direct fetch failed: ${res.status}`,
      res.status,
      parseRetryAfterMs(res.headers.get('retry-after')),
    );
  }
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
  /** 固有名詞の判定材料。渡した時だけ、wave1 で網羅できない場合に固有名詞を守る緩和をする */
  anchorHints?: RealtimeAnchorHints;
  /** 優先する発信者。省略時はクエリの語から推定する（評判系の目印が無ければ公式優先） */
  focus?: RealtimeFocus;
  /** 返す投稿の上限（既定は limit、それも無ければ20）。deep search の realtimeLimit 用 */
  maxItems?: number;
}

/** 返す投稿の既定の上限（search_realtime の limit の既定値と同じ）。 */
export const DEFAULT_REALTIME_ITEM_CAP = 20;

/** 固有名詞の判定材料。どちらも必要になった時だけ呼ばれる。 */
export interface RealtimeAnchorHints {
  /** Web 検索上位のタイトル */
  webTitles: () => Promise<string[]>;
  /** 固有名詞の公式 X アカウントの最近の投稿（別名の検出用）。公式が分からなければ空 */
  officialPosts: (anchor: string) => Promise<Array<{ text?: string }>>;
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
    'search:realtime:json-v2',
    buildYahooRealtimeQuery(options),
    options.sort ?? 'recent',
    options.limit ?? 20,
    options.page ?? 1,
    options.disableFallback === true,
    (options as any)?.verbose === true,
    options.focus ?? 'auto',
    process.env.SORA_REALTIME_ANCHOR === 'off' ? 'rta-off' : 'rta-on',
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
 * keepTerm（固有名詞）を落とす候補は作らない。
 */
export function buildRealtimeRelaxationCandidates(
  semanticRequirements: string[],
  protectedModifiers: string[],
  missingTerms: string[],
  executedQueries: Set<string> | string[],
  keepTerm?: string,
): string[] {
  if (!Array.isArray(semanticRequirements) || semanticRequirements.length <= 1) return [];
  const executed = executedQueries instanceof Set ? executedQueries : new Set(executedQueries || []);
  const missingSet = new Set((missingTerms || []).map((t) => t.toLowerCase()));
  const prefix = (protectedModifiers || []).join(' ').trim();
  const scored: Array<{ query: string; score: number; dropped: number }> = [];
  for (let drop = 0; drop < semanticRequirements.length; drop++) {
    if (keepTerm !== undefined && semanticRequirements[drop] === keepTerm) continue;
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
  /** 全ての語を含む投稿の数（hasFullCoverage は1件でも真になるため、割合の判断用） */
  itemsWithAllTerms: number;
  itemCount: number;
}

/**
 * per-item coverageでretrieval qualityを判定する。corpus全体の分散存在では判定しない。
 * -excludeはpositive coverage requirementにしない。authorはid: constraintのみ検証する。
 * termAliasesの別名を含む投稿は、その語を含むとみなす（=LOVE → イコラブ）。照合はNFKCで行う。
 */
export function evaluateRealtimeRetrievalCoverage(
  items: Array<Record<string, any>>,
  requirements: RealtimeIntentRequirements,
  termAliases: Record<string, string[]> = {},
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
      itemsWithAllTerms: requiredTerms.length === 0 && Array.isArray(items) ? items.length : 0,
      itemCount: Array.isArray(items) ? items.length : 0,
    };
  }
  const norm = (s: string) => s.normalize('NFKC').toLowerCase();
  let itemsWithAllTerms = 0;
  for (const item of items) {
    const haystack = norm([
      item?.author_name || '',
      item?.author_handle || '',
      item?.author_handle ? `@${String(item.author_handle).replace(/^@/, '')}` : '',
      item?.text || '',
    ].join(' '));
    const covered = requiredTerms.filter((t) => [t, ...(termAliases[t] || [])].some((v) => haystack.includes(norm(v))));
    if (covered.length === requiredTerms.length) itemsWithAllTerms++;
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
    itemsWithAllTerms,
    itemCount: items.length,
  };
}

/** 全語を含む投稿がこの割合未満なら、1件だけ全語に一致しても網羅できたとみなさない（Yahoo が記号を無視している等）。 */
export const WEAK_COVERAGE_RATIO = 0.5;
/** 割合で判断するのに必要な最小の件数（少ない件数のぶれで追加の検索をしない）。 */
export const WEAK_COVERAGE_MIN_ITEMS = 6;

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
  wave = 1,
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
    return { query, queryIndex, wave, sort, items: rawList.map((item: any) => normalizeRealtimeItem(item)) };
  } catch (batchErr: any) {
    errors?.push({ query, message: batchErr?.message || String(batchErr) });
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
  errors?: Array<{ query: string; message: string }>,
): Promise<YahooRealtimeQueryBatch[]> {
  const settled = await Promise.allSettled(
    queries.map((q, i) => fetchRealtimeBatch(q, startIndex + i, sort, limit, page, callMcp, wave, errors)),
  );

  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    errors?.push({ query: queries[i], message: 'wave settled without a response' });
    return { query: queries[i], queryIndex: startIndex + i, wave, sort, items: [] };
  });
}

const REALTIME_TERM_TOTAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 語ごとの X 総ヒット数（固有名詞の判定で、ありふれた語を下げる）。24時間キャッシュし、取得できなかった語は省く。
 * 取得件数は既定のまま問い合わせる。1件だけ取ると総ヒット数が過少に返る語がある（「内山優花」で 250 → 6）。
 */
export async function fetchRealtimeTermTotals(
  terms: string[],
  searchPage: typeof searchYahooRealtimePage = searchYahooRealtimePage,
): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  await Promise.all(terms.map(async (term) => {
    const key = `rt-term-total:v2:${term.normalize('NFKC').toLowerCase()}`;
    const cached = getFromCache<{ total: number }>(key);
    if (cached) {
      totals[term] = cached.total;
      return;
    }
    const page = await searchPage({ query: term }).catch(() => null);
    if (page?.total === undefined) return;
    totals[term] = page.total;
    setToCache(key, { total: page.total }, REALTIME_TERM_TOTAL_TTL_MS);
  }));
  return totals;
}

interface ResolvedRealtimeAnchor {
  term: string;
  alias?: string;
  /** wave1 で固有名詞を含む投稿が少ない（Yahoo が記号を無視する等）。最後に固有名詞も別名も無い投稿を除く */
  broken: boolean;
}

/** 固有名詞の解決。判定材料（Web タイトル・総ヒット数）は候補が2語以上の時だけ、別名は壊れている時だけ取りに行く。 */
async function resolveRealtimeAnchor(
  terms: string[],
  wave1Items: any[],
  hints: RealtimeAnchorHints,
  termTotals: (terms: string[]) => Promise<Record<string, number>>,
): Promise<ResolvedRealtimeAnchor | undefined> {
  const candidates = anchorCandidates(terms);
  const [titles, totals] = candidates.length > 1
    ? await Promise.all([hints.webTitles().catch(() => []), termTotals(candidates).catch(() => ({}))])
    : [[], {}];
  const term = detectRealtimeAnchor(terms, titles, totals);
  if (!term) return undefined;
  const broken = isAnchorBroken(term, wave1Items);
  const alias = broken ? detectAliasFromOfficialPosts(await hints.officialPosts(term).catch(() => []), terms) : undefined;
  return { term, ...(alias ? { alias } : {}), broken };
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
  focus: RealtimeFocus;
  retrievalQueries: string[];
  contributingQueries: string[];
  resultsMerged: boolean;
  executedWaves: number;
  stopReason: string;
  requiredTerms: string[];
  coveredTerms: string[];
  missingTerms: string[];
  anchorTerm?: string;
  aliasTerms?: string[];
  anchorFiltered?: number;
  omittedCount?: number;
  throttled?: boolean;
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
  const termTotals: typeof fetchRealtimeTermTotals = (options as any)?._termTotals || fetchRealtimeTermTotals;
  // wave1 で網羅できなかった時だけ解決する（それまで undefined = 従来の緩和）
  let anchor: ResolvedRealtimeAnchor | undefined;
  const anchorAliases = (): Record<string, string[]> => (anchor?.alias ? { [anchor.term]: [anchor.alias] } : {});
  const focus: RealtimeFocus = (options as YahooRealtimeOptions).focus ?? detectRealtimeFocus(originalQuery);
  // 第三者優先: 評判・感想などの目印は必須語にしない（「内山優花 感想」に揃う投稿は1件しかない）
  const parsedRequirements = extractRealtimeIntentRequirements(originalQuery);
  const focusMarkers = focus === 'public' ? parsedRequirements.semanticRequirements.filter(isPublicFocusTerm) : [];
  const contentTerms = parsedRequirements.semanticRequirements.filter((t) => !focusMarkers.includes(t));
  const requirements: RealtimeIntentRequirements = focusMarkers.length > 0 && contentTerms.length > 0
    ? { semanticRequirements: contentTerms, protectedModifiers: parsedRequirements.protectedModifiers }
    : parsedRequirements;

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
    // throttled終端は正常な停止状態（throttledマーカー付きで返却）のため除外する。
    if (stopReason !== 'throttled') throwIfTotalFailure(mergeRealtimeQueryBatches(batches).items);
    // 固有名詞が壊れている時は、固有名詞も別名も含まない投稿（記号を無視された別物）を除く
    let anchorFiltered = 0;
    if (anchor?.broken) {
      const keep = [anchor.term, ...(anchor.alias ? [anchor.alias] : [])];
      const before = mergeRealtimeQueryBatches(batches).items.length;
      batches = batches.map((b) => ({ ...b, items: b.items.filter((i) => postMentions(i, keep)) }));
      const kept = mergeRealtimeQueryBatches(batches).items;
      anchorFiltered = before - kept.length;
      coverage = evaluateRealtimeRetrievalCoverage(kept, requirements, anchorAliases());
    }
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
    // 上限は返す件数だけに効く。取得は上の wave で済んでおり、省いた件数は omittedCount で返す
    const selection = selectRealtimeItems(merged, {
      cap: (options as YahooRealtimeOptions).maxItems ?? limit ?? DEFAULT_REALTIME_ITEM_CAP,
      focus,
      terms: coverage.requiredTerms,
      aliases: anchorAliases(),
    });
    let finalItems = selection.items;
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
      focus,
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
      ...(anchor ? { anchorTerm: anchor.term } : {}),
      ...(anchor?.alias ? { aliasTerms: [anchor.alias] } : {}),
      ...(anchor?.broken ? { anchorFiltered } : {}),
      ...(selection.omitted > 0 ? { omittedCount: selection.omitted } : {}),
      ...(providerErrors.length > 0 ? { partial: true, providerErrors: [...providerErrors] } : {}),
    };
  };

  if ((options as any)?.disableFallback === true) {
    const q = builtQuery;
    const batches = q ? await runRealtimeWave([q], 0, sort, limit, page, callMcp, 1, providerErrors) : [];
    if (batches.some((b) => b.throttled)) {
      const dfCov = evaluateRealtimeRetrievalCoverage([], requirements);
      const dfDone = await finish([], 0, 'throttled', dfCov, q ? [q] : []);
      return { ...dfDone, throttled: true };
    }
    const merged = mergeRealtimeQueryBatches(batches);
    throwIfTotalFailure(merged.items);
    const coverage = evaluateRealtimeRetrievalCoverage(merged.items, requirements);
    return finish(batches, batches.length > 0 ? 1 : 0, 'fallback_disabled', coverage, q ? [q] : []);
  }

  // 複雑な式・2ページ目以降は原式の単発取得に固定し、意味を変えるrelaxを行わない。
  if (requiresExactRealtimeQuery(builtQuery) || (page !== undefined && page > 1)) {
    const batches = builtQuery
      ? await runRealtimeWave([builtQuery], 0, sort, limit, page, callMcp, 1, providerErrors)
      : [];
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

  const prefix = requirements.protectedModifiers.join(' ').trim();
  const withPrefix = (body: string) => (prefix ? `${prefix} ${body}` : body).trim();
  // 第三者優先で目印がある時は、目印つき（投稿に書かれない「評判」などは外す）と目印なしを並行して検索する
  const exactVariants = requirements === parsedRequirements
    ? buildRealtimeExactQueryVariants(builtQuery)
    : [...new Set([
        withPrefix(parsedRequirements.semanticRequirements.filter((t) => !isSearchExcludedTerm(t)).join(' ')),
        withPrefix(contentTerms.join(' ')),
      ])];
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
    const res = await runRealtimeWave(wave1Queries, batches.length, sort, limit, page, callMcp, 1, providerErrors);
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
  const anchorHints = (options as YahooRealtimeOptions).anchorHints;
  const anchorEnabled = anchorHints !== undefined && process.env.SORA_REALTIME_ANCHOR !== 'off';
  // 1件だけ全語に一致しても、大半が全語を含まなければ網羅できたとはみなさない（判定材料がある時だけ）
  const weakCoverage = anchorEnabled && coverage.hasFullCoverage
    && coverage.itemCount >= WEAK_COVERAGE_MIN_ITEMS
    && coverage.itemsWithAllTerms / coverage.itemCount < WEAK_COVERAGE_RATIO;
  if (coverage.hasFullCoverage && !weakCoverage) {
    return finish(batches, executedWaves, 'full_coverage', coverage, exactVariants);
  }
  if (requirements.semanticRequirements.length === 0) {
    return finish(batches, executedWaves, 'no_semantic_requirements', coverage, exactVariants);
  }

  // 固有名詞（anchor）: 判定材料を渡された時だけ解決する。解決できなければ従来の緩和。
  if (anchorEnabled && anchorHints) {
    anchor = await resolveRealtimeAnchor(
      requirements.semanticRequirements,
      mergeRealtimeQueryBatches(batches).items,
      anchorHints,
      termTotals,
    ).catch(() => undefined);
  }
  // 全語に一致した投稿が少ないだけで、固有名詞は壊れていなければ、従来どおり網羅できたものとして終える
  if (weakCoverage && !anchor?.broken) {
    anchor = undefined;
    return finish(batches, executedWaves, 'full_coverage', coverage, exactVariants);
  }
  // 固有名詞を落とす緩和はしない。壊れていて別名があれば、別名に置き換えて緩和する（=LOVE → イコラブ）
  const toRelaxed = (t: string) => (anchor?.alias && t === anchor.term ? anchor.alias : t);
  const relaxTerms = requirements.semanticRequirements.map(toRelaxed);
  const relaxAnchor = anchor ? toRelaxed(anchor.term) : undefined;
  const evaluate = () => evaluateRealtimeRetrievalCoverage(mergeRealtimeQueryBatches(batches).items, requirements, anchorAliases());

  // Wave 2: minimal relaxation (missing-term-driven drop-one, max 2)。別名があれば別名での全語検索を先頭に置く
  const wave2Candidates = [
    ...(anchor?.alias ? [withPrefix(relaxTerms.join(' '))] : []),
    ...buildRealtimeRelaxationCandidates(
      relaxTerms,
      requirements.protectedModifiers,
      coverage.missingTerms.map(toRelaxed),
      executed,
      relaxAnchor,
    ),
  ];
  const wave2Queries = takeBudget(wave2Candidates);
  if (wave2Queries.length > 0) {
    const res2 = await runRealtimeWave(wave2Queries, batches.length, sort, limit, page, callMcp, 2, providerErrors);
    for (const b of res2) {
      batches.push(b);
      executed.add(b.query);
      if (b.throttled) sawThrottle = true;
    }
    executedWaves = 2;
    if (sawThrottle) {
      const w2Done = await finish(batches, executedWaves, 'throttled', evaluate(), exactVariants);
      return { ...w2Done, throttled: true };
    }
  }
  coverage = evaluate();
  if (coverage.hasFullCoverage) {
    return finish(batches, executedWaves, 'full_coverage', coverage, exactVariants);
  }
  if (batches.length >= MAX_REALTIME_RETRIEVAL_QUERIES) {
    return finish(batches, executedWaves, 'query_budget', coverage, exactVariants);
  }

  // Wave 3: bounded rescue (unexecuted drop-one remainder + missing-term singles)。
  // 固有名詞があれば、不足語の単独検索（無関係な投稿ばかりになる）の代わりに固有名詞だけで検索する
  const rescue: string[] = [];
  const remainder = buildRealtimeRelaxationCandidates(
    relaxTerms,
    requirements.protectedModifiers,
    coverage.missingTerms.map(toRelaxed),
    executed,
    relaxAnchor,
  );
  for (const q of remainder) {
    if (!executed.has(q) && !rescue.includes(q)) rescue.push(q);
  }
  for (const term of relaxAnchor ? [relaxAnchor] : coverage.missingTerms) {
    const q = withPrefix(term);
    if (q && !executed.has(q) && !rescue.includes(q) && term.trim()) rescue.push(q);
  }
  const wave3Queries = takeBudget(rescue);
  if (wave3Queries.length === 0) {
    return finish(batches, executedWaves, 'no_candidates', coverage, exactVariants);
  }
  const res3 = await runRealtimeWave(wave3Queries, batches.length, sort, limit, page, callMcp, 3, providerErrors);
  for (const b of res3) {
    batches.push(b);
    executed.add(b.query);
  }
  executedWaves = 3;
  coverage = evaluate();
  if (sawThrottle) {
    const done = await finish(batches, executedWaves, 'throttled', coverage, exactVariants);
    return { ...done, throttled: true };
  }
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

  // 検索クエリ: ハンドルが分かれば本人の投稿（id:）だけを使う。表示名での検索は別人の投稿を拾うため
  // （「＝LOVE_official」で「LOVE off vocal」の投稿など）、ハンドルが分からない時だけ使う
  const searchQueries: string[] = [];
  if (handle) {
    searchQueries.push(`id:${handle}`);
  } else if (options.contextTitle) {
    const cleanTitle = options.contextTitle
      .replace(/\s*\(@?[a-zA-Z0-9_]+\)\s*\/.*$/, '')
      .replace(/\s*\/\s*(?:X|Twitter)\s*$/i, '')
      .replace(/^[^\s]+ on X:\s*"?/i, '')
      .trim();
    if (cleanTitle.length > 2) searchQueries.push(cleanTitle);
  }

  const searchPage: typeof searchYahooRealtimePage = (options as any)._searchPage || searchYahooRealtimePage;
  let matchedItems: any[] = [];
  let authorName = '';

  for (const q of searchQueries) {
    try {
      const page = await searchPage({ query: q, sort: 'recent', limit: options.limit || 15 });
      const lowerHandle = handle.toLowerCase();
      const items = handle
        ? page.items.filter((it: any) => (it.author_handle || '').replace(/^@/, '').toLowerCase() === lowerHandle)
        : page.items;
      if (items.length > 0) {
        matchedItems = items;
        authorName = items[0].author_name || (items[0] as any).author || handle;
        break;
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

/** 上流の item.source（例: "YouTube"）は platform に移し、Sora の source を固定する。 */
export function normalizeYahooMediaItems(json: any, source: 'image' | 'video'): any {
  json.source = source;
  if (Array.isArray(json.items)) {
    json.items = json.items.map((item: any) => ({
      ...item,
      ...(item.source && item.source !== source ? { platform: item.source } : {}),
      source,
    }));
  }
  return json;
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
    return normalizeYahooMediaItems(JSON.parse(content), 'image');
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
    return normalizeYahooMediaItems(JSON.parse(content), 'video');
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
 * 固有名詞の公式 X アカウントを探す。表示名（Web 結果のタイトル）が固有名詞を含むアカウントだけを採る
 * （「ライブ 予定 =LOVE」の結果に出る @LoveLive_staff を拾わない）。
 * クエリの Web 結果に無ければ、固有名詞を x.com に絞って Web 検索する（通常の検索は公式が出たり出なかったりする）。
 */
export async function findOfficialXHandle(anchor: string, webItems: any[] = []): Promise<string | undefined> {
  const pick = (items: any[]) => extractOfficialXHandleFromWebResults(items.filter((i) => termHits(anchor, String(i?.title || ''))));
  const fromQuery = pick(webItems);
  if (fromQuery) return fromQuery;
  const res: any = await searchYahooWeb({ query: anchor, includeDomains: ['x.com'], disableFallback: true }).catch(() => null);
  return pick(Array.isArray(res?.items) ? res.items : []);
}

/**
 * search_realtime 単体用の固有名詞の判定材料。Web 検索は必要になった時に1回だけ行い、
 * 公式アカウントの投稿は別名が必要な時だけ取得する。
 */
export function createWebAnchorHints(query: string): RealtimeAnchorHints {
  let webItems: Promise<any[]> | undefined;
  const items = () => (webItems ??= searchYahooWeb({
    query: extractRealtimeIntentRequirements(query).semanticRequirements.join(' '),
    disableFallback: true,
  })
    .then((r: any) => (Array.isArray(r?.items) ? r.items : []))
    .catch(() => []));
  return {
    webTitles: async () => (await items()).map((i: any) => String(i?.title || '')),
    officialPosts: async (anchor) => {
      const handle = await findOfficialXHandle(anchor, await items());
      if (!handle) return [];
      const res = await searchYahooRealtime({ accountId: handle, limit: 20, sort: 'recent', detailEnrichment: false });
      return res.items;
    },
  };
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
