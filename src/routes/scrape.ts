import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import {
  assertScrapeInputs,
  scrapeUrl,
  scrapeBatchUrls,
  mapSiteUrl,
  crawlSiteUrl,
} from '../scraper.js';
import { formatCompactScrapeResult } from '../response_cleaner.js';
import {
  ScrapeRequestSchema,
  BatchScrapeRequestSchema,
  CrawlRequestSchema,
  MapRequestSchema,
} from '../types.js';
import { dropNullFields, formatError } from './utils.js';
import { errorMessage, ScrapeInputError } from '../errors.js';

export const scrapeRoutes = new Hono();

/** 取得系の失敗を HTTP ステータスとエラーコードに分類する（/scrape・/map・/crawl で同じ規則を使う） */
function classifyFetchError(msg: string, fallbackCode: string) {
  const isSecurity = msg.includes('セキュリティ上の理由') || msg.includes('遮断') || msg.includes('DNS Rebinding') || msg.includes('Forbidden');
  const isTimeout = msg.includes('timeout') || msg.includes('タイムアウト') || msg.includes('timed out');
  const code = isSecurity ? 'SSRF_BLOCKED' : isTimeout ? 'TIMEOUT' : fallbackCode;
  const status = isSecurity ? 403 : isTimeout ? 408 : 500;
  return { code, status: status as 403 | 408 | 500, retryable: !isSecurity };
}

/** verbose は、本文の指定を優先し、無ければ ?verbose=true を使う（/scrape・/scrape/stream・/scrape/batch で同じ） */
function resolveVerbose(c: Context, bodyVerbose: boolean | undefined): boolean {
  return bodyVerbose ?? c.req.query('verbose') === 'true';
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

/** url を必須とする本文を読み、スキーマの範囲（/crawl の maxDepth 5・/map の limit 1000 など）も確かめて 400 にする。null の項目は未指定として扱う */
async function readValidatedRequestBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ data: z.infer<S> } | { error: Response }> {
  const input = await readUrlRequestBody(c);
  if ('error' in input) return input;
  const parsed = schema.safeParse(dropNullFields(input.body));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'invalid request';
    return { error: formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format()) };
  }
  return { data: parsed.data };
}

// 単一 URL / PDF スクレイプ (マルチフォーマット対応)
scrapeRoutes.post('/scrape', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = ScrapeRequestSchema.safeParse(dropNullFields(rawBody));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const verbose = resolveVerbose(c, parsed.data.verbose);
    const tenantId = c.get('tenant')?.tenantId ?? 'legacy';
    const result = await scrapeUrl({ ...parsed.data, verbose, tenantId });
    return c.json(formatCompactScrapeResult(result, { verbose }));
  } catch (err) {
    const msg = errorMessage(err) || 'Scrape failed';
    if (err instanceof ScrapeInputError) return formatError(c, msg, 'INVALID_INPUT', 400, false);
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

  const parsed = ScrapeRequestSchema.safeParse(dropNullFields(rawBody));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }
  // 入力の誤りは、ストリームを開く前に 400 で返す（/scrape と同じ）
  try {
    assertScrapeInputs(parsed.data);
  } catch (err) {
    if (err instanceof ScrapeInputError) return formatError(c, err.message, 'INVALID_INPUT', 400, false);
    throw err;
  }

  return streamSSE(c, async (stream) => {
    try {
      await scrapeUrl({
        ...parsed.data,
        verbose: resolveVerbose(c, parsed.data.verbose),
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

  const parsed = BatchScrapeRequestSchema.safeParse(dropNullFields(rawBody));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue && issue.path[0] !== 'urls' ? `${issue.path.join('.')}: ${issue.message}` : 'urls must be a non-empty array of URLs (max: 20)';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const verbose = resolveVerbose(c, parsed.data.verbose);
    const tenantId = c.get('tenant')?.tenantId ?? 'legacy';
    // ?verbose=true も scrapeBatchUrls に渡し、webhook の中身を応答と同じ整形にする
    const result = await scrapeBatchUrls({ ...parsed.data, verbose, tenantId });
    const formattedResults = result.results?.map((r) => formatCompactScrapeResult(r, { verbose })) ?? [];
    return c.json({ ...result, results: formattedResults });
  } catch (err) {
    const msg = errorMessage(err) || 'Batch scrape failed';
    if (err instanceof ScrapeInputError) return formatError(c, msg, 'INVALID_INPUT', 400, false);
    const isSecurity = msg.includes('セキュリティ上の理由') || msg.includes('遮断') || msg.includes('DNS Rebinding') || msg.includes('Forbidden');
    const code = isSecurity ? 'SSRF_BLOCKED' : 'BATCH_SCRAPE_ERROR';
    return formatError(c, msg, code, isSecurity ? 403 : 500, !isSecurity);
  }
});

// サイトマップ URL マッピング (/map)
scrapeRoutes.post('/map', async (c) => {
  const input = await readValidatedRequestBody(c, MapRequestSchema);
  if ('error' in input) return input.error;

  try {
    const result = await mapSiteUrl(input.data);

    return c.json(result);
  } catch (err) {
    const msg = errorMessage(err) || 'Map failed';
    const { code, status, retryable } = classifyFetchError(msg, 'MAP_ERROR');
    return formatError(c, msg, code, status, retryable);
  }
});

// サブページ再帰的クロール (/crawl)
scrapeRoutes.post('/crawl', async (c) => {
  const input = await readValidatedRequestBody(c, CrawlRequestSchema);
  if ('error' in input) return input.error;

  try {
    const tenantId = c.get('tenant')?.tenantId ?? 'legacy';
    const result = await crawlSiteUrl({ ...input.data, tenantId });

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
  const input = await readValidatedRequestBody(c, CrawlRequestSchema);
  if ('error' in input) return input.error;
  const { data } = input;

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'start',
      data: JSON.stringify({ url: data.url, status: 'crawling' }),
    });

    try {
      const streamTenant = c.get('tenant')?.tenantId ?? 'legacy';
      const result = await crawlSiteUrl({
        ...data,
        tenantId: streamTenant,
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
