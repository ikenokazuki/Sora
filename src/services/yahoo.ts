import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import * as cheerio from 'cheerio';
import { filterByDomains } from '../enrichment.js';

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

/** Yahoo Web 検索 (プレフィルタリング site: / -site: 対応) */
export async function searchYahooWeb(options: {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: 'all' | 'day' | 'week' | 'year';
}): Promise<any> {
  let effectiveWebQuery = options.query;
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

  const mcpRes = await callYahooMcp('yahoo_web_search', {
    query: effectiveWebQuery,
    ...(webSiteArg ? { site: webSiteArg } : {}),
    ...(options.updated && options.updated !== 'all' ? { updated: options.updated } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '[]';
  let parsedData: any = content;
  try {
    const json = JSON.parse(content);
    if (json && Array.isArray(json.items)) {
      const filtered = filterByDomains(json.items, options.includeDomains, options.excludeDomains);
      json.items = filtered.map((item: any) => ({ source: 'web' as const, ...item }));
      json.count = json.items.length;
      json.source = 'web';
      parsedData = json;
    }
  } catch {}

  return parsedData;
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
