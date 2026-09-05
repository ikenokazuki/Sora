import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import * as cheerio from 'cheerio';
import { filterByDomains, rerankSearchResults } from '../enrichment.js';

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
        return json;
      }
      if (json && Array.isArray(json.items)) {
        lastParsedData = json;
      }
    } catch {
      // 候補クエリの次を試行
    }
  }

  return lastParsedData;
}

/** リアルタイムアイテムの正規化 (publishedTime, author, siteName 付与) */
export function normalizeRealtimeItem(item: any): Record<string, any> {
  const createdAtSec = typeof item.created_at === 'number' ? item.created_at : parseInt(item.created_at, 10);
  const publishedTime =
    !isNaN(createdAtSec) && createdAtSec > 0
      ? new Date(createdAtSec * 1000).toISOString()
      : undefined;

  const authorHandle = item.author_handle ? `@${item.author_handle.replace(/^@/, '')}` : '';
  const authorName = item.author_name || '';
  const author = authorName && authorHandle ? `${authorName} (${authorHandle})` : authorName || authorHandle || undefined;

  return {
    source: 'x' as const,
    ...item,
    publishedTime: publishedTime || item.publishedTime,
    author: author || item.author,
    siteName: 'X (Twitter)',
  };
}

/** 検索向けフォールバック候補クエリの自動抽出 (JST 相対日付解決・記号/日付正規化・ノイズ語句パージ・重要語抽出) */
export function extractRealtimeFallbackQueries(query: string): string[] {
  if (!query || typeof query !== 'string') return [];
  const normalized = query.normalize('NFKC').trim();
  const candidates: string[] = [query.trim()];
  if (normalized !== query.trim()) {
    candidates.push(normalized);
  }

  // 1. 日付の検出 (絶対日付 or JST 相対日付, 年月日 / スラッシュ / ハイフン / ドット)
  let targetDateStr: string | null = null;
  const kanjiDateMatch = normalized.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  if (kanjiDateMatch) {
    const month = parseInt(kanjiDateMatch[2], 10);
    const day = parseInt(kanjiDateMatch[3], 10);
    targetDateStr = `${month}/${day}`;
  } else {
    const ymSeparatedMatch = normalized.match(/(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})/);
    if (ymSeparatedMatch) {
      targetDateStr = `${parseInt(ymSeparatedMatch[2], 10)}/${parseInt(ymSeparatedMatch[3], 10)}`;
    } else {
      // 相対日付の判定（日本時間 JST: UTC+9）
      const now = new Date();
      const jstNow = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
      if (/(?:明日|あした|あす)/.test(normalized)) {
        const tomorrow = new Date(jstNow.getTime() + 24 * 60 * 60 * 1000);
        targetDateStr = `${tomorrow.getMonth() + 1}/${tomorrow.getDate()}`;
      } else if (/(?:今日|本日|きょう)/.test(normalized)) {
        targetDateStr = `${jstNow.getMonth() + 1}/${jstNow.getDate()}`;
      } else if (/(?:明後日|あさって)/.test(normalized)) {
        const dayAfter = new Date(jstNow.getTime() + 48 * 60 * 60 * 1000);
        targetDateStr = `${dayAfter.getMonth() + 1}/${dayAfter.getDate()}`;
      } else if (/(?:昨日|きのう)/.test(normalized)) {
        const yesterday = new Date(jstNow.getTime() - 24 * 60 * 60 * 1000);
        targetDateStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}`;
      }
    }
  }

  // 2. ノイズ語句の除去 (自然言語フレーズ、助詞、冗長語)
  const noisePattern = /(?:明日|あした|あす|今日|本日|きょう|昨日|きのう|明後日|あさって|予定|スケジュール|情報|一覧|最新|公式|について|まとめ|何時|何時から|いつ|どこ|どこで|教えて|ライブ予定|ライブ情報|チケット情報|チケット一覧|開催情報|詳細|概要|購入方法|チケット購入方法|タイムテーブル|タイテ|出演時間)/g;
  const cleaned = normalized
    .replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}日/g, '')
    .replace(/(?:\d{4}[-/.])?\d{1,2}[-/.]\d{1,2}/g, '')
    .replace(noisePattern, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter((w) => w.length > 0);
  const mainEntity = words[0] || '';

  // 3. 候補クエリの優先度生成
  if (mainEntity && targetDateStr) {
    candidates.push(`${mainEntity} ${targetDateStr}`);
    const [m, d] = targetDateStr.split('/');
    candidates.push(`${mainEntity} ${m}月${d}日`);
  }

  if (words.length > 1) {
    candidates.push(words.join(' '));
  }

  if (mainEntity && !candidates.includes(mainEntity)) {
    candidates.push(mainEntity);
  }

  return Array.from(new Set(candidates.map((c) => c.trim()).filter((c) => c.length > 0)));
}

/** Yahoo リアルタイム検索 (スマートフォールバック・正規化付き) */
export async function searchYahooRealtime(options: {
  query: string;
  sort?: 'recent' | 'popular';
  limit?: number;
  page?: number;
  disableFallback?: boolean;
}): Promise<{
  items: any[];
  count: number;
  effectiveQuery: string;
  originalQuery: string;
  isFallback: boolean;
  source: 'x';
}> {
  const originalQuery = options.query;
  const sort = options.sort || 'recent';
  const limit = options.limit;
  const page = options.page;

  const candidateQueries = options.disableFallback
    ? [originalQuery]
    : extractRealtimeFallbackQueries(originalQuery);

  let finalItems: any[] = [];
  let effectiveQuery = originalQuery;
  let isFallback = false;

  for (let i = 0; i < candidateQueries.length; i++) {
    const q = candidateQueries[i];
    try {
      const mcpRes = await callYahooMcp('yahoo_realtime_search', {
        query: q,
        sort,
        ...(limit ? { limit } : {}),
        ...(page ? { page } : {}),
      });
      const content = mcpRes?.content?.[0]?.text || '';
      if (!content) continue;

      const parsed = JSON.parse(content);
      const rawList = Array.isArray(parsed) ? parsed : parsed?.items || [];
      if (rawList.length > 0) {
        finalItems = rawList.map((item: any) => normalizeRealtimeItem(item));
        effectiveQuery = q;
        isFallback = i > 0;
        break;
      }
    } catch {
      // 次の候補を試行
    }
  }

  return {
    source: 'x',
    originalQuery,
    effectiveQuery,
    isFallback,
    count: finalItems.length,
    items: finalItems,
  };
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
  for (const tweet of matchedItems.slice(0, options.limit || 10)) {
    const dateStr = tweet.created_at
      ? new Date(tweet.created_at * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : '';
    const author = tweet.author_name ? `${tweet.author_name} (@${tweet.author_handle})` : `@${tweet.author_handle}`;
    markdown += `### ${author} [${dateStr}]\n${tweet.text}\n\n`;
  }

  return {
    title: `${displayAuthor} (@${handle}) / X`,
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
      json.items = json.items.map((item: any) => ({
        source: 'chiebukuro' as const,
        siteName: 'Yahoo!知恵袋',
        publishedTime: item.posted_at || item.updated_at,
        ...item,
      }));
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
