import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createAuthMiddleware, hashApiKey } from './auth.js';
import { dbAddApiUsage, dbGetApiUsage } from './db.js';
import { app } from './index.js';
import { createMcpServer } from './mcp.js';
import { ScrapeInputError } from './errors.js';
import { scrapeRoutes } from './routes/scrape.js';
import { crawlPageBudget, crawlSiteUrl, scrapeBatchUrls } from './scraper.js';
import { resetApiKeyStoreCache } from './security/api_keys.js';
import * as quotaModule from './security/quota.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * 日次クォータの重み（設計 6。穴 26）: 一括は URL の件数、crawl はページ数を数える。
 * 本物のサービス（手元のテスト用ページ）を、REST（認証のミドルウェアを通す）と、サービスの直接の呼び出し（MCP と同じ）で動かす。
 */
const today = () => new Date().toISOString().slice(0, 10);

let site: ReturnType<typeof Bun.serve>;
let siteUrl = '';
let hits = 0;
let previousAllowLocal: string | undefined;

beforeAll(() => {
  site = Bun.serve({
    port: 0,
    fetch: (req) => {
      hits++;
      const path = new URL(req.url).pathname;
      // ルートだけ、3 つの子ページへのリンク（子ページはリンクなし）= crawl で取れるのは全部で 4 ページ
      const links = path === '/' ? '<a href="/c1">c1</a> <a href="/c2">c2</a> <a href="/c3">c3</a>' : '';
      return new Response(`<!doctype html><html><head><title>t ${path}</title></head><body><h1>t ${path}</h1><p>本文 ${path} のテスト用ページです。</p>${links}</body></html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  });
  siteUrl = `http://127.0.0.1:${site.port}/`;
  previousAllowLocal = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
});

afterAll(() => {
  site?.stop(true);
  if (previousAllowLocal === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previousAllowLocal;
});

beforeEach(() => {
  hits = 0;
});

const urlsOf = (n: number, tag = randomUUID()) => Array.from({ length: n }, (_, i) => `${siteUrl}${tag}-${i}`);

/** 鍵 1 つで、REST を呼ぶ。日次の上限は limit（undefined なら無制限） */
async function rest(limit: string | undefined, run: (call: (path: string, body: unknown) => Promise<Response>, usage: () => number) => Promise<void>): Promise<void> {
  const key = `quota-weights-${randomUUID()}`;
  await withEnv({ SORA_API_KEY: key, SORA_AUTH_DAILY_LIMIT: limit, SORA_ALLOW_ANONYMOUS: undefined }, async () => {
    const call = async (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify(body) });
    await run(call, () => dbGetApiUsage(hashApiKey(key), today()));
  });
}

describe('一括（/scrape/batch）は URL の件数を数える', () => {
  test('20 件の一括は 20 回と数える（要求の 1 回と、件数の残り 19 回）', async () => {
    await rest('100', async (call, usage) => {
      const res = await call('/scrape/batch', { urls: urlsOf(20), fastOnly: true, noCache: true });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { total: number }).total).toBe(20);
      expect(usage()).toBe(20);
    });
  });

  test('残りの回数を超える件数は、1 件も取らずに 429（RATE_LIMIT_EXCEEDED・Retry-After・上限・いまの回数・求めた件数）', async () => {
    await rest('25', async (call, usage) => {
      expect((await call('/scrape/batch', { urls: urlsOf(20), fastOnly: true, noCache: true })).status).toBe(200);
      expect(usage()).toBe(20);
      hits = 0;
      const res = await call('/scrape/batch', { urls: urlsOf(20), fastOnly: true, noCache: true });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', status: 429, retryable: false, limit: 25, current: 21, requested: 19 });
      expect(hits).toBe(0); // 1 件も取っていない
      expect(usage()).toBe(21); // 断った呼び出しの分は足さない（要求の 1 回だけ）
      // 残りに収まる件数は通る（21 + 3 = 24 ≤ 25）
      expect((await call('/scrape/batch', { urls: urlsOf(3), fastOnly: true, noCache: true })).status).toBe(200);
      expect(usage()).toBe(24);
    });
  });

  test('1 件の一括は、増えない（要求の 1 回のまま）', async () => {
    await rest('100', async (call, usage) => {
      expect((await call('/scrape/batch', { urls: urlsOf(1), fastOnly: true, noCache: true })).status).toBe(200);
      expect(usage()).toBe(1);
    });
  });

  test('上限を決めていなければ、断らず、数える', async () => {
    await rest(undefined, async (call, usage) => {
      expect((await call('/scrape/batch', { urls: urlsOf(20), fastOnly: true, noCache: true })).status).toBe(200);
      expect(usage()).toBe(20);
    });
  });

  test('MCP と同じ、サービスの直接の呼び出しも、tenant の分を数える（鍵ファイルの tenant は tenant の ID の行）', async () => {
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '10' }, async () => {
      const tenant = `name:svc-${randomUUID()}`;
      const result = await scrapeBatchUrls({ urls: urlsOf(6), tenantId: tenant, fastOnly: true, noCache: true });
      expect(result.total).toBe(6);
      expect(dbGetApiUsage(tenant, today())).toBe(5); // 要求の 1 回は、HTTP の層が数える。ここは残りの 5 回
      await expect(scrapeBatchUrls({ urls: urlsOf(7), tenantId: tenant, fastOnly: true, noCache: true })).rejects.toThrow('日次クォータ');
      expect(dbGetApiUsage(tenant, today())).toBe(5);
    });
  });
});

describe('crawl は取ったページ数を数える（先に最大ページ数を数え、使わなかった分を戻す）', () => {
  test('4 ページしかないサイトを maxPages=50 で巡回しても、4 回と数える', async () => {
    await rest('100', async (call, usage) => {
      const res = await call('/crawl', { url: siteUrl, maxPages: 50, maxDepth: 1, noCache: true });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { count: number }).count).toBe(4);
      expect(usage()).toBe(4); // 要求の 1 回 + 取った 4 ページのうちの 3 ページ分
    });
  });

  test('最大ページ数が残りを超えるなら、1 ページも取らずに 429', async () => {
    await rest('10', async (call, usage) => {
      const res = await call('/crawl', { url: siteUrl, maxPages: 50, maxDepth: 1, noCache: true });
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', limit: 10, requested: 49 });
      expect(hits).toBe(0);
      expect(usage()).toBe(1);
      // 残りに収まる最大ページ数なら通る
      expect((await call('/crawl', { url: siteUrl, maxPages: 5, maxDepth: 1, noCache: true })).status).toBe(200);
      expect(usage()).toBe(1 + 1 + 3); // 断った分の要求 1 + 次の要求 1 + 取った 4 ページのうちの 3 ページ分
    });
  });

  test('/crawl/stream は、ストリームを開く前に 429（SSE の error イベントではなく、JSON の 429）', async () => {
    await rest('10', async (call) => {
      const res = await call('/crawl/stream', { url: siteUrl, maxPages: 50, maxDepth: 1, noCache: true });
      expect(res.status).toBe(429);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(hits).toBe(0);
    });
  });

  test('/crawl/stream も、取ったページ数を数える', async () => {
    await rest('100', async (call, usage) => {
      const res = await call('/crawl/stream', { url: siteUrl, maxPages: 50, maxDepth: 1, noCache: true });
      expect(res.status).toBe(200);
      await res.text(); // 最後まで読む
      expect(usage()).toBe(4);
    });
  });

  test('入力の誤り（パターンが多すぎる）は、数える前に断る（数えない）', async () => {
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '100' }, async () => {
      const tenant = `name:bad-${randomUUID()}`;
      await expect(crawlSiteUrl({ url: siteUrl, maxPages: 20, tenantId: tenant, includePatterns: Array.from({ length: 101 }, (_, i) => `/p${i}`) })).rejects.toThrow('includePatterns');
      expect(dbGetApiUsage(tenant, today())).toBe(0);
    });
  });

  test('crawl が取るページ数の上限（crawlPageBudget）: 省くと 10、最大 50、小数は切り捨て、負は 0、数でないものは 10', () => {
    expect(crawlPageBudget(undefined)).toBe(10);
    expect(crawlPageBudget(5)).toBe(5);
    expect(crawlPageBudget(50)).toBe(50);
    expect(crawlPageBudget(500)).toBe(50);
    expect(crawlPageBudget(3.9)).toBe(3);
    expect(crawlPageBudget(-4)).toBe(0);
    expect(crawlPageBudget(Number.NaN)).toBe(10);
    expect(crawlPageBudget(Number.POSITIVE_INFINITY)).toBe(10);
  });

  test('crawl を呼んだ側の onPageScraped も、取ったページごとに呼ばれる（数えるための包みが、呼び出し側の関数を潰さない）', async () => {
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '100' }, async () => {
      const tenant = `name:callback-${randomUUID()}`;
      const seen: string[] = [];
      const result = await crawlSiteUrl({ url: siteUrl, maxPages: 10, maxDepth: 1, tenantId: tenant, noCache: true, onPageScraped: (page) => void seen.push(page.url) });
      expect(seen).toHaveLength(result.count);
      expect(result.count).toBe(4);
    });
  });

  test('入力の誤りは、クォータの 429 より先に断る（上限が足りなくても、400 の入力の誤り）', async () => {
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '3' }, async () => {
      const tenant = `name:order-${randomUUID()}`;
      const patterns = Array.from({ length: 101 }, (_, i) => `/p${i}`);
      await expect(crawlSiteUrl({ url: siteUrl, maxPages: 50, tenantId: tenant, includePatterns: patterns })).rejects.toBeInstanceOf(ScrapeInputError);
    });
  });

  test('/crawl/stream: 開く前の確認を通ったあと、数える段で断られたら、error イベントで知らせる（RATE_LIMIT_EXCEEDED）', async () => {
    // 同時に 2 本。どちらも開く前の確認は通る（まだ数えていない）。先に数えた 1 本で上限に届き、もう 1 本は数える段で断られる
    await rest('11', async (call) => {
      const [a, b] = await Promise.all([
        call('/crawl/stream', { url: siteUrl, maxPages: 10, maxDepth: 1, noCache: true }),
        call('/crawl/stream', { url: siteUrl, maxPages: 10, maxDepth: 1, noCache: true }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const texts = [await a.text(), await b.text()];
      const refused = texts.filter((t) => t.includes('event: error'));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain('RATE_LIMIT_EXCEEDED');
      expect(texts.filter((t) => t.includes('event: done'))).toHaveLength(1);
    });
  });

  test('1 ページも取れずに失敗しても、先に数えた分は戻す（取ったページの分だけ残る）', async () => {
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '100', SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'false' }, async () => {
      const tenant = `name:fail-${randomUUID()}`;
      // 内部のアドレスは取れない（取得の前に断られる）ので、取れたページは 0
      await crawlSiteUrl({ url: siteUrl, maxPages: 20, tenantId: tenant }).catch(() => undefined);
      expect(dbGetApiUsage(tenant, today())).toBe(0);
    });
  });

  test('Sora 自身の取得（public）は数えない', async () => {
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '1' }, async () => {
      await scrapeBatchUrls({ urls: urlsOf(5), tenantId: 'public', fastOnly: true, noCache: true });
      expect(dbGetApiUsage('public', today())).toBe(0);
    });
  });
});

describe('MCP（scrape の urls・crawl_site）も、同じ件数を数え、超えるなら始める前に断る', () => {
  const asTenant = async <T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false, sessionState: { activatedTools: new Set<string>(), tenantId } });
    const client = new Client({ name: 'quota-weights', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  };
  const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '');

  test('scrape の urls: 残りに収まれば取り、超えるなら 1 件も取らずに、エラーの文で断る', async () => {
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '5' }, async () => {
      const tenant = `name:mcp-batch-${randomUUID()}`;
      const ok = await asTenant(tenant, (client) => client.callTool({ name: 'scrape', arguments: { urls: urlsOf(5), fastOnly: true, noCache: true } }));
      expect((ok as { isError?: boolean }).isError).toBeFalsy();
      expect(dbGetApiUsage(tenant, today())).toBe(4); // 要求の 1 回は HTTP の層が数える。ここは残りの 4 回
      hits = 0;
      const refused = await asTenant(tenant, (client) => client.callTool({ name: 'scrape', arguments: { urls: urlsOf(3), fastOnly: true, noCache: true } }));
      expect((refused as { isError?: boolean }).isError).toBe(true);
      expect(textOf(refused)).toContain('日次クォータ');
      expect(hits).toBe(0);
      expect(dbGetApiUsage(tenant, today())).toBe(4);
    });
  });

  test('crawl_site: 最大ページ数が残りを超えるなら、1 ページも取らずに断る', async () => {
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '5' }, async () => {
      const tenant = `name:mcp-crawl-${randomUUID()}`;
      const refused = await asTenant(tenant, (client) => client.callTool({ name: 'crawl_site', arguments: { url: siteUrl, maxPages: 20, maxDepth: 1, noCache: true } }));
      expect((refused as { isError?: boolean }).isError).toBe(true);
      expect(textOf(refused)).toContain('日次クォータ');
      expect(hits).toBe(0);
      expect(dbGetApiUsage(tenant, today())).toBe(0);
    });
  });
});

describe('crawl の取得に失敗したリンクも、試みた回数として数える（数えずに無制限に試せない）', () => {
  /** ルートだけ、60 本の同じサイトのリンクを返し、ほかの取得は接続を切る（失敗させる）素の TCP サーバー */
  async function failingLinksSite(): Promise<{ url: string; requests: () => number; stop: () => void }> {
    let requests = 0;
    const links = Array.from({ length: 60 }, (_, i) => `<a href="/dead${i}">d${i}</a>`).join(' ');
    const html = `<!doctype html><html><head><title>root</title></head><body><h1>root</h1><p>起点のページです。</p>${links}</body></html>`;
    const server = createTcpServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', (data) => {
        requests++;
        const first = data.toString('utf8').split('\r\n')[0] ?? '';
        if (first.startsWith('GET / ')) {
          socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`);
        } else {
          socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/`, requests: () => requests, stop: () => server.close() };
  }

  test('起点だけ成功し、60 本のリンクがすべて失敗しても、試みる回数に上限（最大ページ数の 3 倍）があり、最大ページ数ぶんは数える', async () => {
    const dead = await failingLinksSite();
    try {
      await rest('100', async (call, usage) => {
        const res = await call('/crawl', { url: dead.url, maxPages: 3, maxDepth: 2, noCache: true });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { count: number }).count).toBe(1);
        // 取得を試みたのは、最大で 3 × 3 = 9 回（起点 1 回 + 失敗 8 回）。60 回まで試みない
        expect(dead.requests()).toBe(9);
        // 試みた回数が最大ページ数（3）以上なので、先に数えた分（要求の 1 回 + 2）がそのまま残る
        expect(usage()).toBe(3);
      });
    } finally {
      dead.stop();
    }
  });

  test('試みる回数は、並行数（3）の端数が出ても、最大ページ数の 3 倍を超えない（最大ページ数 4 で 12 回ちょうど）', async () => {
    const dead = await failingLinksSite();
    try {
      await withEnv({ SORA_AUTH_DAILY_LIMIT: '100' }, async () => {
        const result = await crawlSiteUrl({ url: dead.url, maxPages: 4, maxDepth: 2, tenantId: `name:attempts-${randomUUID()}`, noCache: true });
        expect(result.count).toBe(1);
        expect(dead.requests()).toBe(12);
      });
    } finally {
      dead.stop();
    }
  });

  test('起点が取れずに失敗した crawl は、先に数えた分をすべて戻し、要求の 1 回（認証が数えた分）だけが残る', async () => {
    await withEnv({ SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'false' }, async () => {
      await rest('100', async (call, usage) => {
        const res = await call('/crawl', { url: siteUrl, maxPages: 20, maxDepth: 1, noCache: true });
        expect(res.status).not.toBe(200); // 内部のアドレスは取れない
        expect(usage()).toBe(1);
      });
    });
  });
});

describe('呼び出し側の関数が投げても、数えは落ちない', () => {
  test('onPageCrawled が投げても、取ったページは数える（戻し過ぎない）', async () => {
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '100' }, async () => {
      const tenant = `name:throw-${randomUUID()}`;
      const result = await crawlSiteUrl({
        url: siteUrl,
        maxPages: 4,
        maxDepth: 1,
        tenantId: tenant,
        noCache: true,
        onPageCrawled: () => {
          throw new Error('boom');
        },
      });
      expect(result.count).toBe(4);
      expect(dbGetApiUsage(tenant, today())).toBe(3); // 4 ページのうち、要求の 1 回の分を除いた 3
    });
  });
});

describe('crawl は、足した日の行から戻す（UTC の日の変わり目をまたいでも）', () => {
  /**
   * quotaDay を差し替えて、日が変わるようにする: 始めに取る日（D）を 1 回返し、そのあとは翌日（D+1）を返す。
   * 足す・戻すのどちらも、始めに取った D を使い、D+1 の行（翌日の要求の回数）は触らない。
   * 時計そのものを進める方法（setSystemTime）は、取得の間隔を時刻で管理する部品が未来の時刻を覚えて、時計を戻したあとの取得を止めるので使わない。
   */
  test('始めに取った日（D）の行に足し、D の行から戻す。日が変わったあとの日（D+1）の行は減らさない', async () => {
    const tenant = `name:midnight-${randomUUID()}`;
    const spy = spyOn(quotaModule, 'quotaDay').mockReturnValueOnce('2031-03-10').mockReturnValue('2031-03-11');
    try {
      await withEnv({ SORA_AUTH_DAILY_LIMIT: '1000' }, async () => {
        dbAddApiUsage(tenant, '2031-03-11', 60); // 翌日の行（その日の要求が数えた回数）
        await crawlSiteUrl({ url: siteUrl, maxPages: 20, maxDepth: 1, tenantId: tenant, noCache: true }); // 4 ページしかないサイト。19 を先に足し、16 を戻す
        expect(dbGetApiUsage(tenant, '2031-03-10')).toBe(3); // 19 − 16
        expect(dbGetApiUsage(tenant, '2031-03-11')).toBe(60);
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('数える行が、認証のミドルウェアの数える行と同じ（匿名・鍵ファイル）', () => {
  test('鍵なし（匿名）の運用: 要求の 1 回と一括の件数が、同じ行（anonymous）に合算され、上限が効く', async () => {
    await withEnv({ SORA_API_KEY: undefined, SORA_AUTH_KEYS_FILE: undefined, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_DAILY_LIMIT: '500' }, async () => {
      const before = dbGetApiUsage('anonymous', today());
      const res = await app.request('/scrape/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: urlsOf(4), fastOnly: true, noCache: true }) });
      expect(res.status).toBe(200);
      expect(dbGetApiUsage('anonymous', today()) - before).toBe(4); // 要求の 1 回 + 件数の残り 3
    });
  });

  test('鍵ファイルの運用: 要求の 1 回と一括の件数が、同じ行（name:<name>）に合算される', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sora-quota-keys-'));
    try {
      const name = `weights-${randomUUID().slice(0, 8)}`;
      const path = join(dir, 'keys.json');
      writeFileSync(path, JSON.stringify({ keys: [{ name, key: `quota-weights-key-${randomUUID()}` }] }), { mode: 0o600 });
      const key = (JSON.parse(await Bun.file(path).text()) as { keys: Array<{ key: string }> }).keys[0].key;
      await withEnv({ SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_KEYS_FILE: path, SORA_AUTH_DAILY_LIMIT: '500' }, async () => {
        resetApiKeyStoreCache();
        try {
          const keyed = new Hono();
          keyed.use('*', createAuthMiddleware());
          keyed.route('/', scrapeRoutes);
          const res = await keyed.request('/scrape/batch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify({ urls: urlsOf(4), fastOnly: true, noCache: true }) });
          expect(res.status).toBe(200);
          expect(dbGetApiUsage(`name:${name}`, today())).toBe(4);
        } finally {
          resetApiKeyStoreCache();
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MCP の JSON-RPC のバッチ（配列）は、入っている呼び出しの数を数える', () => {
  const batchOf = (n: number) => Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' }));

  test('残りを超える数の配列は、MCP に渡さず 429。収まる数は渡し、増えた分を数える', async () => {
    await rest('5', async (call, usage) => {
      const send = (n: number) => call('/mcp', batchOf(n));
      const refused = await send(10);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', limit: 5, requested: 9 });
      expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(usage()).toBe(1); // 断った分の要求 1 回だけ
      const accepted = await send(3);
      expect(accepted.status).not.toBe(429);
      expect(usage()).toBe(1 + 1 + 2); // 断った分 1 + 要求 1 + 配列の残り 2
    });
  });

  test('配列でない（1 つの呼び出し）本文は、これまでどおり増えない', async () => {
    await rest('5', async (call, usage) => {
      const res = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(res.status).not.toBe(429);
      expect(usage()).toBe(1);
    });
  });
});

