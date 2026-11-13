import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { fetchSitemapEntries, mapSiteUrl, type SitemapContext } from './scraper.js';
import { clearCache } from './cache.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { limits, STANDARD_LIMITS, STRICT_LIMITS } from './security/limits.js';

/**
 * map_site のサイトマップの取得の上限（設計 6。穴 11）。
 * これまで、robots.txt の `Sitemap:` 行の数・索引の子の数・本文の大きさ・全体の時間に上限がなく、クライアントが切断しても止まらなかった
 * （1 回の呼び出しで、攻撃者が決めた多数の第三者へ GET を撃たせられ、メモリも食う）。
 */

const EMPTY = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
const xml = { 'content-type': 'application/xml' };

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let handler: (path: string) => Response | Promise<Response> = () => new Response('not found', { status: 404 });
let requests: string[] = [];
let previousAllow: string | undefined;
let previousIsolation: string | undefined;

beforeAll(() => {
  previousAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  previousIsolation = process.env.SORA_ISOLATION;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      return handler(path);
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  requests = [];
  handler = () => new Response('not found', { status: 404 });
  clearCache();
  resetSecurityMetrics();
  if (previousIsolation === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = previousIsolation;
});
afterAll(() => {
  server.stop(true);
  if (previousAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previousAllow;
});

const page = '<html><head><title>t</title></head><body><main><h1>t</h1><p>地図を作るページの本文です。読めるだけの長さの文章を、ここに置いておきます。抽出器が本文として扱うのに足ります。</p><a href="/x">x</a></main></body></html>';
const level = (value: 'standard' | 'strict') => {
  process.env.SORA_ISOLATION = value;
};
const count = (prefix: string) => requests.filter((path) => path.startsWith(prefix)).length;
const map = (extra: Record<string, unknown> = {}) => mapSiteUrl({ url: `${origin}/`, limit: 50, tenantId: 'name:sitemap-limits', noCache: true, ...extra });

/** robots.txt に Sitemap: を n 行並べ、それぞれ空のサイトマップ（つぎの候補に進む）を返すサイト */
const robotsWith = (lines: number) => (path: string): Response => {
  if (path === '/robots.txt') return new Response(Array.from({ length: lines }, (_, i) => `Sitemap: ${origin}/s/${i}.xml`).join('\n'), { headers: { 'content-type': 'text/plain' } });
  if (path.startsWith('/s/')) return new Response(EMPTY, { headers: xml });
  if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
  return new Response('not found', { status: 404 });
};

describe('robots.txt の Sitemap: 行の数', () => {
  test('strict: 先頭の 5 行だけを取る', async () => {
    level('strict');
    handler = robotsWith(100);
    await map();
    expect(count('/s/')).toBe(STRICT_LIMITS.sitemapRobotsLines);
    expect(getSecurityMetrics().sora_amplification_limit_hit_total).toBeGreaterThan(0);
  }, 30_000);

  test('standard: 緩い値（50 行）まで取る', async () => {
    level('standard');
    handler = robotsWith(100);
    await map();
    expect(count('/s/')).toBe(STANDARD_LIMITS.sitemapRobotsLines);
  }, 60_000);

  test('上限より少ない行は、すべて取る（今までどおり）', async () => {
    level('strict');
    handler = robotsWith(3);
    await map();
    expect(count('/s/')).toBe(3);
    expect(getSecurityMetrics().sora_amplification_limit_hit_total ?? 0).toBe(0);
  }, 30_000);
});

describe('robots.txt の本文の大きさ', () => {
  test('512KiB を超える robots.txt は、読めなかったことにする（Sitemap: 行を拾わない）。上限の中なら、読む', async () => {
    level('strict');
    const lines = `Sitemap: ${origin}/s/0.xml\n`;
    handler = (path) => {
      if (path === '/robots.txt') return new Response(lines + '#'.repeat(512 * 1024 + 10));
      if (path.startsWith('/s/')) return new Response(EMPTY, { headers: xml });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not found', { status: 404 });
    };
    await map();
    expect(count('/s/')).toBe(0);
    requests = [];
    handler = (path) => {
      if (path === '/robots.txt') return new Response(lines + '#'.repeat(100 * 1024));
      if (path.startsWith('/s/')) return new Response(EMPTY, { headers: xml });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not found', { status: 404 });
    };
    await map();
    expect(count('/s/')).toBe(1);
  }, 30_000);
});

describe('サイトマップの索引の子の数', () => {
  const indexWith = (children: number) => (path: string): Response => {
    if (path === '/sitemap.xml') return new Response(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: children }, (_, i) => `<sitemap><loc>${origin}/c/${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`, { headers: xml });
    if (path.startsWith('/c/')) return new Response(EMPTY, { headers: xml });
    if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
    return new Response('not found', { status: 404 });
  };

  test('strict: 先頭の 20 だけを取る', async () => {
    level('strict');
    handler = indexWith(100);
    await map();
    expect(count('/c/')).toBe(STRICT_LIMITS.sitemapChildren);
    expect(getSecurityMetrics().sora_amplification_limit_hit_total).toBeGreaterThan(0);
  }, 30_000);

  test('standard: 100 の子は、すべて取る（緩い値は 500）', async () => {
    level('standard');
    handler = indexWith(100);
    await map();
    expect(count('/c/')).toBe(100);
    expect(getSecurityMetrics().sora_amplification_limit_hit_total ?? 0).toBe(0);
  }, 60_000);
});

describe('サイトマップ 1 本の本文の大きさ', () => {
  /** 正しい小さなサイトマップのあとに、XML のコメントで padding を足して、全体を bytes にする */
  const padded = (bytes: number) => {
    const head = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/from-sitemap</loc></url></urlset><!--`;
    return head + ' '.repeat(Math.max(0, bytes - head.length - 3)) + '-->';
  };

  test('strict: 10MB を超えるサイトマップは、読めなかったことにする（リンクからの map に戻る）', async () => {
    level('strict');
    handler = (path) => (path === '/sitemap.xml' ? new Response(padded(STRICT_LIMITS.sitemapBytes + 1024), { headers: xml }) : path === '/' ? new Response(page, { headers: { 'content-type': 'text/html' } }) : new Response('x', { status: 404 }));
    const result = await map();
    expect(result.source).toBe('links');
    expect(getSecurityMetrics().sora_amplification_limit_hit_total).toBeGreaterThan(0);
  }, 20_000);

  test('strict: 上限の中の大きなサイトマップは、読める', async () => {
    level('strict');
    handler = (path) => (path === '/sitemap.xml' ? new Response(padded(5 * 1024 * 1024), { headers: xml }) : new Response('x', { status: 404 }));
    const result = await map();
    expect(result.source).toBe('sitemap');
    expect(result.links).toEqual([`${origin}/from-sitemap`]);
  }, 20_000);

  test('standard: 10MB を超えるサイトマップも、読める（緩い値は 50MB）', async () => {
    level('standard');
    handler = (path) => (path === '/sitemap.xml' ? new Response(padded(11 * 1024 * 1024), { headers: xml }) : new Response('x', { status: 404 }));
    const result = await map();
    expect(result.source).toBe('sitemap');
  }, 30_000);
});

describe('1 回の map_site で取るサイトマップの総数', () => {
  test('strict: 入れ子の索引（5 行 × 20 の子 × 20 の孫）でも、総数は 50 まで', async () => {
    level('strict');
    handler = (path) => {
      if (path === '/robots.txt') return new Response(Array.from({ length: 5 }, (_, i) => `Sitemap: ${origin}/i/${i}.xml`).join('\n'));
      const index = (prefix: string) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: 20 }, (_, i) => `<sitemap><loc>${origin}/${prefix}/${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`;
      if (path.startsWith('/i/')) return new Response(index(`j${path.slice(3, -4)}`), { headers: xml });
      if (path.startsWith('/j')) return new Response(index('k'), { headers: xml });
      if (path.startsWith('/k/')) return new Response(EMPTY, { headers: xml });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('x', { status: 404 });
    };
    await map();
    const sitemapRequests = requests.filter((path) => path.startsWith('/i/') || path.startsWith('/j') || path.startsWith('/k/')).length + requests.filter((path) => path === '/sitemap.xml' || path === '/sitemap_index.xml' || path === '/sitemap/sitemap.xml').length;
    expect(sitemapRequests).toBe(STRICT_LIMITS.sitemapFetches); // 予算をちょうど使い切る（robots.txt とページの取得は、数えない）
    expect(getSecurityMetrics().sora_amplification_limit_hit_total).toBeGreaterThan(0);
  }, 60_000);
});

describe('全体の時間とクライアントの切断', () => {
  const slow = (delayMs: number) => async (path: string): Promise<Response> => {
    if (path === '/robots.txt') return new Response(Array.from({ length: 5 }, (_, i) => `Sitemap: ${origin}/s/${i}.xml`).join('\n'));
    if (path.startsWith('/s/')) {
      await Bun.sleep(delayMs);
      return new Response(EMPTY, { headers: xml });
    }
    if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
    return new Response('x', { status: 404 });
  };

  test('全体の時間（mapDeadlineMs）を超えたら、サイトマップを取るのをやめる', async () => {
    level('strict');
    handler = slow(400);
    await map({ limits: { ...limits(), mapDeadlineMs: 600 } });
    expect(count('/s/')).toBeLessThan(5);
    expect(count('/s/')).toBeGreaterThanOrEqual(1);
    expect(getSecurityMetrics().sora_amplification_limit_hit_total).toBeGreaterThan(0);
  }, 20_000);

  test('クライアントが切断したら（signal が中止されたら）、そのあとのサイトマップを取らず、中止で終わる', async () => {
    level('strict');
    handler = slow(300);
    const controller = new AbortController();
    const promise = map({ signal: controller.signal });
    await Bun.sleep(450);
    controller.abort();
    await expect(promise).rejects.toThrow();
    const seen = count('/s/');
    await Bun.sleep(1200);
    expect(count('/s/')).toBe(seen); // 中止のあとに、新しい要求が出ていない
    expect(seen).toBeLessThan(5);
  }, 20_000);

  test('取得中の通信も、切断で止める（サイトマップの応答を待ち続けない）', async () => {
    level('strict');
    handler = slow(2000);
    const controller = new AbortController();
    const promise = map({ signal: controller.signal });
    await Bun.sleep(500); // robots.txt のあと、最初のサイトマップの応答を待っている
    const abortedAt = performance.now();
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(performance.now() - abortedAt).toBeLessThan(800); // 応答（2 秒）を待たずに終わる
  }, 20_000);

  test('robots.txt の取得中も、切断で止める', async () => {
    level('strict');
    handler = async (path) => {
      if (path === '/robots.txt') await Bun.sleep(2000);
      return new Response('x', { status: 404 });
    };
    const controller = new AbortController();
    const promise = map({ signal: controller.signal });
    await Bun.sleep(300);
    const abortedAt = performance.now();
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(performance.now() - abortedAt).toBeLessThan(800);
  }, 20_000);

  test('すでに中止された signal では、何も取らない', async () => {
    level('strict');
    handler = slow(10);
    const controller = new AbortController();
    controller.abort();
    await expect(map({ signal: controller.signal })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  test('すでに中止された signal は、キャッシュに結果があっても、結果を返さず、中止で終わる', async () => {
    level('strict');
    handler = (path) => {
      if (path === '/robots.txt') return new Response(`Sitemap: ${origin}/s.xml`);
      if (path === '/s.xml') return new Response(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/from-sitemap</loc></url></urlset>`, { headers: xml });
      return new Response('not found', { status: 404 });
    };
    expect((await map({ noCache: false })).links).toEqual([`${origin}/from-sitemap`]);
    expect((await map({ noCache: false })).cached).toBe(true); // 2 回目はキャッシュ（対照）
    const controller = new AbortController();
    controller.abort();
    await expect(map({ noCache: false, signal: controller.signal })).rejects.toThrow();
  }, 20_000);

  test('全体の時間を超えたあとは、残りの子のサイトマップを、1 組ずつ待たずに捨てる', async () => {
    level('strict');
    handler = async (path) => {
      if (path === '/index.xml') {
        const children = Array.from({ length: 60 }, (_, i) => `<sitemap><loc>${origin}/c/${i}.xml</loc></sitemap>`).join('');
        return new Response(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`, { headers: xml });
      }
      if (path.startsWith('/c/')) {
        await Bun.sleep(100);
        return new Response(EMPTY, { headers: xml });
      }
      return new Response('not found', { status: 404 });
    };
    const ctx: SitemapContext = { tenantId: 'name:sitemap-limits', limits: { ...limits(), sitemapChildren: 60 }, signal: AbortSignal.timeout(500), fetched: 0 };
    const started = performance.now();
    expect(await fetchSitemapEntries(`${origin}/index.xml`, ctx)).toEqual([]);
    // 子は 3 つずつ並べて取る。1 組ごとに、同じサイトへの間隔の待ち（150〜250 ミリ秒）があるので、時間を超えたあとも、残りを同じに続けると、20 組で 4 秒かかる
    expect(performance.now() - started).toBeLessThan(2000);
    expect(count('/c/')).toBeLessThan(10);
  }, 30_000);
});
