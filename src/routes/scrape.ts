import { Hono } from 'hono';
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

export const scrapeRoutes = new Hono();

// 単一 URL / PDF スクレイプ (マルチフォーマット対応)
scrapeRoutes.post('/scrape', async (c) => {
  let rawBody: any;
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
    const result = await scrapeUrl(parsed.data);
    return c.json(formatCompactScrapeResult(result, { verbose }));
  } catch (err: any) {
    const msg = err.message || 'Scrape failed';
    const isSecurity = msg.includes('セキュリティ上の理由') || msg.includes('遮断') || msg.includes('DNS Rebinding') || msg.includes('Forbidden');
    const isTimeout = msg.includes('timeout') || msg.includes('タイムアウト') || msg.includes('timed out');
    const code = isSecurity ? 'SSRF_BLOCKED' : isTimeout ? 'TIMEOUT' : 'SCRAPE_ERROR';
    const status = isSecurity ? 403 : isTimeout ? 408 : 500;
    return formatError(c, msg, code, status, !isSecurity);
  }
});

// 単一 URL スクレイプ SSE ストリーミング (POST /scrape/stream)
scrapeRoutes.post('/scrape/stream', async (c) => {
  let rawBody: any;
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
        onProgress: async (evt) => {
          await stream.writeSSE({
            event: evt.stage === 'done' ? 'done' : 'progress',
            data: JSON.stringify(evt),
          });
        },
      });
    } catch (err: any) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          error: err.message || 'Scrape failed',
          code: 'SCRAPE_ERROR',
        }),
      });
    }
  });
});

// 複数 URL 一括並行スクレイプ (POST /scrape/batch)
scrapeRoutes.post('/scrape/batch', async (c) => {
  let rawBody: any;
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
    const result = await scrapeBatchUrls(parsed.data);
    const formattedResults = result.results?.map((r: any) => formatCompactScrapeResult(r, { verbose })) ?? [];
    return c.json({ ...result, results: formattedResults });
  } catch (err: any) {
    const msg = err.message || 'Batch scrape failed';
    const isSecurity = msg.includes('セキュリティ上の理由') || msg.includes('遮断') || msg.includes('DNS Rebinding') || msg.includes('Forbidden');
    const code = isSecurity ? 'SSRF_BLOCKED' : 'BATCH_SCRAPE_ERROR';
    return formatError(c, msg, code, isSecurity ? 403 : 500, !isSecurity);
  }
});

// サイトマップ URL マッピング (/map)
scrapeRoutes.post('/map', async (c) => {
  try {
    const body = await c.req.json();
    if (!body || !body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    const result = await mapSiteUrl({
      url: body.url,
      limit: body.limit,
      includeSubdomains: body.includeSubdomains,
      timeoutMs: body.timeoutMs,
      since: body.since,
    });

    return c.json(result);
  } catch (err: any) {
    const isSecurity = err.message?.includes('セキュリティ上の理由');
    return c.json({ error: err.message || 'Map failed' }, isSecurity ? 403 : 500);
  }
});

// サブページ再帰的クロール (/crawl)
scrapeRoutes.post('/crawl', async (c) => {
  try {
    const body = await c.req.json();
    if (!body || !body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    const result = await crawlSiteUrl({
      url: body.url,
      maxPages: body.maxPages,
      maxDepth: body.maxDepth,
      maxChars: body.maxChars,
      timeoutMs: body.timeoutMs,
      concurrency: body.concurrency,
      includePatterns: body.includePatterns,
      excludePatterns: body.excludePatterns,
      formats: body.formats,
      webhookUrl: body.webhookUrl,
      query: body.query,
      extractHighlights: body.extractHighlights,
      onlyHighlights: body.onlyHighlights,
      noCache: body.noCache,
    });

    return c.json(result);
  } catch (err: any) {
    const isSecurity = err.message?.includes('セキュリティ上の理由');
    return c.json({ error: err.message || 'Crawl failed' }, isSecurity ? 403 : 500);
  }
});

// サブページ再帰的クロール SSE ストリーミング (/crawl/stream)
scrapeRoutes.post('/crawl/stream', async (c) => {
  try {
    const body = await c.req.json();
    if (!body || !body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'start',
        data: JSON.stringify({ url: body.url, status: 'crawling' }),
      });

      const result = await crawlSiteUrl({
        url: body.url,
        maxPages: body.maxPages,
        maxDepth: body.maxDepth,
        maxChars: body.maxChars,
        timeoutMs: body.timeoutMs,
        concurrency: body.concurrency,
        includePatterns: body.includePatterns,
        excludePatterns: body.excludePatterns,
        formats: body.formats,
        query: body.query,
        extractHighlights: body.extractHighlights,
        onlyHighlights: body.onlyHighlights,
        noCache: body.noCache,
        onPageCrawled: (page: any, count: number) => {
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
    });
  } catch (err: any) {
    const isSecurity = err.message?.includes('セキュリティ上の理由');
    return c.json({ error: err.message || 'Crawl stream failed' }, isSecurity ? 403 : 500);
  }
});
