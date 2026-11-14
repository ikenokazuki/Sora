import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDb } from '../db.js';
import { WatchLimitError } from '../errors.js';
import { app as fullApp } from '../index.js';
import { createMcpServer } from '../mcp.js';
import { registerWatchTarget } from '../services/watch.js';
import { withEnv } from '../test_fixtures/env.js';
import { createWatchRoutes, type WatchRouteDeps } from './watch.js';

/**
 * ウォッチの上限の応答（設計 6。穴 18・24）: 登録数の上限と、同じウォッチの確認の最小の間隔を超えた呼び出しは、429。
 * 上限そのもの（数え方）は services/watch_limits.test.ts。ここは、REST と MCP が、上限の例外を 429 とエラーの文にすること
 */

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const appWith = (deps: WatchRouteDeps) => {
  const app = new Hono();
  app.route('/', createWatchRoutes(deps));
  return app;
};

describe('REST は、上限の例外を 429 にする', () => {
  test('登録数の上限: 429・WATCH_LIMIT_EXCEEDED・retryable false。上限といまの数を返す', async () => {
    const app = appWith({
      registerWatchTarget: (async () => {
        throw new WatchLimitError('WATCH_LIMIT_EXCEEDED', '登録できるウォッチは 1 人 50 件までです（いま 50 件）。', 50, 50);
      }) as never,
    });
    const res = await app.request('/watch/register', json({ url: 'https://example.com/a' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeNull(); // 待っても空かない（delete が要る）
    expect(await res.json()).toMatchObject({ code: 'WATCH_LIMIT_EXCEEDED', status: 429, retryable: false, error: expect.stringContaining('50 件'), details: { limit: 50, current: 50 } });
  });

  test('確認の最小の間隔: 429・WATCH_TOO_FREQUENT・retryable true・Retry-After（あと何秒か）', async () => {
    const app = appWith({
      checkWatchTarget: (async () => {
        throw new WatchLimitError('WATCH_TOO_FREQUENT', 'このウォッチは…あと 321 秒', 900, 0, 321);
      }) as never,
    });
    const res = await app.request('/watch/check', json({ id: 'wt_1' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('321');
    expect(await res.json()).toMatchObject({ code: 'WATCH_TOO_FREQUENT', status: 429, retryable: true, details: { limit: 900, retryAfterSec: 321 } });
  });

  test('一括の確認は 200 のまま、見送ったウォッチを skipped で載せる', async () => {
    const skipped = { targetId: 'wt_1', url: 'https://example.com/a', changed: false, currentHash: 'h', checkedAt: '2026-11-14T00:00:00Z', skipped: true, retryAfterSec: 120 };
    const app = appWith({ checkAllWatchTargets: (async () => [skipped]) as never });
    const res = await app.request('/watch/check', json({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [skipped] });
  });

  test('ほかの失敗は、これまでどおり 500（WATCH_ERROR）', async () => {
    const app = appWith({ registerWatchTarget: (async () => { throw new Error('壊れた'); }) as never });
    const res = await app.request('/watch/register', json({ url: 'https://example.com/a' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'WATCH_ERROR' });
  });
});

describe('本物のサービスで: strict の上限が、REST と MCP に届く', () => {
  let site: ReturnType<typeof Bun.serve>;
  let siteUrl = '';
  let previousAllowLocal: string | undefined;
  beforeAll(() => {
    site = Bun.serve({ port: 0, fetch: (req) => new Response(`<!doctype html><html><head><title>w</title></head><body><h1>w</h1><p>ウォッチの確認用ページ ${new URL(req.url).pathname}</p></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) });
    siteUrl = `http://127.0.0.1:${site.port}/`;
    previousAllowLocal = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  });
  afterAll(() => {
    // このテストの登録を消す（共有の DB に残して、ほかのテストのウォッチの件数を変えない）
    getDb().query('DELETE FROM watch_targets WHERE url LIKE ?').run(`${siteUrl}%`);
    site?.stop(true);
    if (previousAllowLocal === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previousAllowLocal;
  });

  const post = (path: string, body: unknown) => fullApp.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('REST: 51 件目の登録は 429。登録の直後の確認は 429（最小の間隔）、間隔が過ぎれば通る。一括は見送りが載る。standard は何も変わらない', async () => {
    await withEnv({ SORA_ISOLATION: 'strict', SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined }, async () => {
      // legacy の tenant（鍵なし）。ほかのテストの登録が残っていても、数えた数との差で上限に届かせる
      const ids: string[] = [];
      for (;;) {
        const count = ((await (await fullApp.request('/watch/list')).json()) as { count: number }).count;
        if (count >= 50) break;
        const res = await post('/watch/register', { url: `${siteUrl}w${count}` });
        expect(res.status).toBe(200);
        ids.push(((await res.json()) as { target: { id: string } }).target.id);
      }
      const over = await post('/watch/register', { url: `${siteUrl}over` });
      expect(over.status).toBe(429);
      expect(await over.json()).toMatchObject({ code: 'WATCH_LIMIT_EXCEEDED', details: { limit: 50, current: 50 } });
      // 登録の直後の確認は、間隔の中
      const tooSoon = await post('/watch/check', { id: ids[0] });
      expect(tooSoon.status).toBe(429);
      expect(Number(tooSoon.headers.get('Retry-After'))).toBeGreaterThan(800);
      // 一括: 登録で確認したものは見送り。確認した記録を 20 分前にした 1 件だけ、取得する
      getDb().query('UPDATE watch_targets SET last_checked_at = ? WHERE id = ?').run(Date.now() - 20 * 60_000, ids[0]);
      const all = await post('/watch/check', {});
      expect(all.status).toBe(200);
      const results = ((await all.json()) as { results: Array<{ targetId: string; skipped?: boolean }> }).results;
      expect(results.filter((r) => r.skipped).length).toBe(results.length - 1);
      expect(results.find((r) => r.targetId === ids[0])?.skipped).toBeUndefined();
    });
    // standard（未設定）: 同じ登録・続けての確認が、これまでどおり通る
    await withEnv({ SORA_ISOLATION: undefined, SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined }, async () => {
      const reg = await post('/watch/register', { url: `${siteUrl}standard` });
      expect(reg.status).toBe(200);
      const id = ((await reg.json()) as { target: { id: string } }).target.id;
      for (let i = 0; i < 3; i++) expect((await post('/watch/check', { id })).status).toBe(200);
    });
  }, 120_000);

  test('MCP: 登録数の上限に届いた利用者の watch register は、エラーの文で断られる', async () => {
    await withEnv({ SORA_ISOLATION: 'strict' }, async () => {
      const tenant = 'name:mcp-watch-limit';
      for (let i = 0; i < 50; i++) await registerWatchTarget({ tenantId: tenant, url: `${siteUrl}m${i}`, initialFetch: false });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer({ deferTools: false, sessionState: { activatedTools: new Set<string>(), tenantId: tenant } });
      const client = new Client({ name: 'watch-limits', version: '1.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = (await client.callTool({ name: 'watch', arguments: { action: 'register', url: `${siteUrl}over` } })) as { isError?: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('登録できるウォッチは 1 人 50 件まで');
      } finally {
        await client.close();
        await server.close();
      }
    });
  }, 60_000);
});
