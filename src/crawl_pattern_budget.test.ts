import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearCache } from './cache.js';
import { crawlSiteUrl } from './scraper.js';
import { limits } from './security/limits.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';

/**
 * crawl のリンクの絞り込み（includePatterns・excludePatterns）が使える仕事の量は、crawl 1 回で決まった量まで（設計 6。穴 21）。
 * 超えたら、新しいリンクをたどらない（悪意のあるパターンと、長い URL を並べたサイトの組で、メインのスレッドを使い切らせない）。
 */

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let links: string[] = [];
let requests: string[] = [];
let previousAllow: string | undefined;

const body = (title: string, hrefs: string[]) =>
  `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${(`${title} のページの本文です。読めるだけの長さの文章を、ここに置いておきます。`).repeat(6)}</p>${hrefs.map((href) => `<a href="${href}">${href.slice(0, 40)}</a>`).join(' ')}</main></body></html>`;

beforeAll(() => {
  previousAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      return new Response(body(path === '/' ? 'root' : path.slice(0, 12), path === '/' ? links : []), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  links = [];
  requests = [];
  clearCache();
  resetSecurityMetrics();
});
afterAll(() => {
  server.stop(true);
  if (previousAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previousAllow;
});

const crawl = (extra: Record<string, unknown> = {}) =>
  crawlSiteUrl({ url: `${origin}/`, tenantId: 'name:crawl-budget', maxPages: 5, maxDepth: 1, noCache: true, ...extra });

describe('crawl のパターンの照合の予算', () => {
  test('予算が十分なら、パターンに当たるリンクをたどる（今までどおり）', async () => {
    links = [`${origin}/docs/a`, `${origin}/docs/b`, `${origin}/other/c`];
    const result = await crawl({ includePatterns: ['/docs/**'] });
    expect(result.pages.map((page) => new URL(page.url).pathname).toSorted()).toEqual(['/', '/docs/a', '/docs/b']);
    expect(getSecurityMetrics().sora_amplification_limit_hit_total ?? 0).toBe(0);
  }, 60_000);

  test('予算を使い切ったら、新しいリンクをたどらない（起点のページだけ）。上限に当たったと数える', async () => {
    links = [`${origin}/docs/a`, `${origin}/docs/b`, `${origin}/docs/c`];
    const result = await crawl({ includePatterns: ['/docs/**'], limits: { ...limits(), patternSteps: 3 } });
    expect(result.pages.map((page) => new URL(page.url).pathname)).toEqual(['/']);
    expect(requests.filter((path) => path.startsWith('/docs/'))).toEqual([]);
    // 3 つのリンクがあっても、予算の上限に当たったと数えるのは 1 回だけ（リンクごとに数えない）
    expect(getSecurityMetrics().sora_amplification_limit_hit_total).toBe(1);
  }, 60_000);

  test('exclude でも同じ: 予算を使い切ったら、除外の判定ができないので、たどらない（除外のパターンを素通りしない）', async () => {
    links = [`${origin}/private/a`, `${origin}/public/b`];
    const result = await crawl({ excludePatterns: ['/private/**'], limits: { ...limits(), patternSteps: 2 } });
    expect(requests.filter((path) => path.startsWith('/private/'))).toEqual([]);
    expect(result.pages.map((page) => new URL(page.url).pathname)).toEqual(['/']);
  }, 60_000);

  test('星の多いパターンと、長い a だけのリンクでも、strict の予算で、すぐ終わる（以前の実装は、止まった）', async () => {
    links = Array.from({ length: 30 }, (_, i) => `${origin}/${'a'.repeat(3000 + i)}`);
    const started = performance.now();
    const result = await crawl({ includePatterns: ['*a*a*a*a*a*a*a*a*b'], limits: { ...limits({ SORA_ISOLATION: 'strict' }) } });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result.pages.map((page) => new URL(page.url).pathname)).toEqual(['/']);
  }, 60_000);

  test('長すぎる URL（8192 文字より長い）のリンクは、たどらない', async () => {
    links = [`${origin}/${'a'.repeat(9000)}`, `${origin}/ok`];
    const result = await crawl();
    expect(result.pages.map((page) => new URL(page.url).pathname)).toEqual(['/', '/ok']);
  }, 60_000);
});
