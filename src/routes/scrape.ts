import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  scrapeUrl,
  scrapeBatchUrls,
  mapSiteUrl,
  crawlSiteUrl,
} from '../scraper.js';
import { formatCompactScrapeResult } from '../response_cleaner.js';
import {
  ScrapeRequestSchema,
  BatchScrapeRequestSchema,
} from '../types.js';
import { formatError } from './utils.js';
import { errorMessage } from '../errors.js';

export const scrapeRoutes = new Hono();

/** 取得系の失敗を HTTP ステータスとエラーコードに分類する（/scrape・/map・/crawl で同じ規則を使う） */
function classifyFetchError(msg: string, fallbackCode: string) {
  const isSecurity = msg.includes('セキュリティ上の理由') || msg.includes('遮断') || msg.includes('DNS Rebinding') || msg.includes('Forbidden');
  const isTimeout = msg.includes('timeout') || msg.includes('タイムアウト') || msg.includes('timed out');
  const code = isSecurity ? 'SSRF_BLOCKED' : isTimeout ? 'TIMEOUT' : fallbackCode;
  const status = isSecurity ? 403 : isTimeout ? 408 : 500;
  return { code, status: status as 403 | 408 | 500, retryable: !isSecurity };
}

/** url を必須とする JSON ボディを読む。JSON が不正、または url が http(s) の URL として読めなければ 400 を返す。 */
async function readUrlRequestBody(
  c: Context,
): Promise<{ body: Record<string, any> } | { error: Response }> {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return { error: formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false) };
  }
  if (!body || typeof body.url !== 'string' || !body.url) {
    return { error: formatError(c, 'url is required', 'INVALID_INPUT', 400, false) };
  }
  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    return { error: formatError(c, 'url must be a valid http(s) URL', 'INVALID_INPUT', 400, false) };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: formatError(c, 'url must be a valid http(s) URL', 'INVALID_INPUT', 400, false) };
  }
  return { body };
}

// 単一 URL / PDF スクレイプ (マルチフォーマット対応)
scrapeRoutes.post('/scrape', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = ScrapeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const verbose = parsed.data.verbose ?? c.req.query('verbose') === 'true';
    const tenantId = c.get('tenant')?.tenantId ?? 'legacy';
    const result = await scrapeUrl({ ...parsed.data, tenantId });
    return c.json(formatCompactScrapeResult(result, { verbose }));
  } catch (err) {
    const msg = errorMessage(err) || 'Scrape failed';
    const { code, status, retryable } = classifyFetchError(msg, 'SCRAPE_ERROR');
    return formatError(c, msg, code, status, retryable);
  }
});

// 単一 URL スクレイプ SSE ストリーミング (POST /scrape/stream)
scrapeRoutes.post('/scrape/stream', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = ScrapeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  return streamSSE(c, async (stream) => {
    try {
      await scrapeUrl({
        ...parsed.data,
        tenantId: c.get('tenant')?.tenantId ?? 'legacy',
        onProgress: async (evt) => {
          await stream.writeSSE({
            event: evt.stage === 'done' ? 'done' : 'progress',
            data: JSON.stringify(evt),
          });
        },
      });
    } catch (err) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          error: errorMessage(err) || 'Scrape failed',
          code: 'SCRAPE_ERROR',
        }),
      });
    }
  });
});

// 複数 URL 一括並行スクレイプ (POST /scrape/batch)
scrapeRoutes.post('/scrape/batch', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = BatchScrapeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'urls must be a non-empty array of URLs (max: 20)', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const verbose = parsed.data.verbose ?? c.req.query('verbose') === 'true';
    const tenantId = c.get('tenant')?.tenantId ?? 'legacy';
    const result = await scrapeBatchUrls({ ...parsed.data, tenantId });
    const formattedResults = result.results?.map((r) => formatCompactScrapeResult(r, { verbose })) ?? [];
    return c.json({ ...result, results: formattedResults });
  } catch (err) {
    const msg = errorMessage(err) || 'Batch scrape failed';
    const isSecurity = msg.includes('セキュリティ上の理由') || msg.includes('遮断') || msg.includes('DNS Rebinding') || msg.includes('Forbidden');
    const code = isSecurity ? 'SSRF_BLOCKED' : 'BATCH_SCRAPE_ERROR';
    return formatError(c, msg, code, isSecurity ? 403 : 500, !isSecurity);
  }
});

// サイトマップ URL マッピング (/map)
scrapeRoutes.post('/map', async (c) => {
  const input = await readUrlRequestBody(c);
  if ('error' in input) return input.error;
  const { body } = input;

  try {
    const result = await mapSiteUrl({
      url: body.url,
      limit: body.limit,
      includeSubdomains: body.includeSubdomains,
      timeoutMs: body.timeoutMs,
      since: body.since,
      until: body.until,
      noCache: body.noCache,
    });

    return c.json(result);
  } catch (err) {
    const msg = errorMessage(err) || 'Map failed';
    const { code, status, retryable } = classifyFetchError(msg, 'MAP_ERROR');
    return formatError(c, msg, code, status, retryable);
  }
});

// サブページ再帰的クロール (/crawl)
scrapeRoutes.post('/crawl', async (c) => {
  const input = await readUrlRequestBody(c);
  if ('error' in input) return input.error;
  const { body } = input;

  try {
    const tenantId = c.get('tenant')?.tenantId ?? 'legacy';
    const result = await crawlSiteUrl({
      url: body.url,
      tenantId,
      maxPages: body.maxPages,
      maxDepth: body.maxDepth,
      maxChars: body.maxChars,
      timeoutMs: body.timeoutMs,
      concurrency: body.concurrency,
      onlyMainContent: body.onlyMainContent,
      includePatterns: body.includePatterns,
      excludePatterns: body.excludePatterns,
      formats: body.formats,
      webhookUrl: body.webhookUrl,
      query: body.query,
      extractHighlights: body.extractHighlights,
      onlyHighlights: body.onlyHighlights,
      reorderUFlat: body.reorderUFlat,
      diversityWeight: body.diversityWeight,
      annotateTemporal: body.annotateTemporal,
      minimizeTables: body.minimizeTables,
      highlightMaxCount: body.highlightMaxCount,
      noCache: body.noCache,
    });

    return c.json(result);
  } catch (err) {
    const msg = errorMessage(err) || 'Crawl failed';
    const { code, status, retryable } = classifyFetchError(msg, 'CRAWL_ERROR');
    return formatError(c, msg, code, status, retryable);
  }
});

// サブページ再帰的クロール SSE ストリーミング (/crawl/stream)
scrapeRoutes.post('/crawl/stream', async (c) => {
  // 入力の誤りは、ストリームを開く前に 400 で返す
  const input = await readUrlRequestBody(c);
  if ('error' in input) return input.error;
  const { body } = input;

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'start',
      data: JSON.stringify({ url: body.url, status: 'crawling' }),
    });

    try {
      const streamTenant = c.get('tenant')?.tenantId ?? 'legacy';
      const result = await crawlSiteUrl({
        url: body.url,
        tenantId: streamTenant,
        maxPages: body.maxPages,
        maxDepth: body.maxDepth,
        maxChars: body.maxChars,
        timeoutMs: body.timeoutMs,
        concurrency: body.concurrency,
        onlyMainContent: body.onlyMainContent,
        includePatterns: body.includePatterns,
        excludePatterns: body.excludePatterns,
        formats: body.formats,
        query: body.query,
        extractHighlights: body.extractHighlights,
        onlyHighlights: body.onlyHighlights,
        reorderUFlat: body.reorderUFlat,
        diversityWeight: body.diversityWeight,
        annotateTemporal: body.annotateTemporal,
        minimizeTables: body.minimizeTables,
        highlightMaxCount: body.highlightMaxCount,
        noCache: body.noCache,
        onPageCrawled: (page, count) => {
          stream.writeSSE({
            event: 'page',
            data: JSON.stringify({ count, page }),
          });
        },
      });

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ count: result.count, url: result.url }),
      });
    } catch (err) {
      // 失敗してもストリームを黙って閉じない。/scrape/stream と同じく error イベントで知らせる
      const msg = errorMessage(err) || 'Crawl failed';
      const { code, status, retryable } = classifyFetchError(msg, 'CRAWL_ERROR');
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: msg, code, status, retryable }),
      });
    }
  });
});
