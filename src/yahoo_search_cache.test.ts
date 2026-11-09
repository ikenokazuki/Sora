// MCP の Yahoo の 6 ツール（画像・動画・ニュース・知恵袋・サジェスト・リアルタイム）は、REST と同じキー・同じ時間のキャッシュを共有する。
// Yahoo は送り先（同梱のバイナリの呼び出しと、リアルタイムの JSON の取得）を偽物にする。
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as cache from './cache.js';
import { app } from './index.js';
import { createMcpServer } from './mcp.js';
import * as yahoo from './services/yahoo.js';
import { defaultXDetailProvider } from './services/x_detail.js';

const sent: Array<{ tool: string; args: Record<string, any> }> = [];
const spies: Array<{ mockRestore: () => void }> = [];
let setSpy: ReturnType<typeof spyOn<typeof cache, 'setToCache'>>;
let client: Client;
let server: ReturnType<typeof createMcpServer>;

beforeAll(async () => {
  server = createMcpServer({ deferTools: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'yahoo-cache-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  sent.length = 0;
});

function fakeYahoo(items: unknown[] = [{ title: 'item', url: 'https://example.com/a' }]) {
  spies.push(spyOn(yahoo, 'callYahooMcp').mockImplementation(async (tool: string, args: Record<string, any>) => {
    sent.push({ tool, args });
    return { content: [{ type: 'text', text: JSON.stringify({ items }) }] };
  }));
  setSpy = spyOn(cache, 'setToCache');
  spies.push(setSpy);
}

async function callMcp(name: string, args: Record<string, unknown>): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0].text);
}

const ttlOf = (key: string) => setSpy.mock.calls.filter(([k]) => k === key).map(([, , ttl]) => ttl);

describe('MCP page', () => {
  test('search_image・search_video・search_chiebukuro は page を受けて Yahoo に渡し、page ごとに別に残す', async () => {
    fakeYahoo();
    const tools = (await client.listTools()).tools as any[];
    const props = (name: string) => tools.find((t) => t.name === name).inputSchema.properties;
    expect(props('search_news').page).toBeUndefined();
    for (const [name, binaryTool] of [['search_image', 'yahoo_image_search'], ['search_video', 'yahoo_video_search'], ['search_chiebukuro', 'yahoo_chiebukuro_search']]) {
      expect(props(name).page).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
      const query = `yahoo cache page ${name}`;
      const first = await callMcp(name, { query, page: 2 });
      const again = await callMcp(name, { query, page: 2 });
      const next = await callMcp(name, { query, page: 3 });
      expect(sent.filter((s) => s.tool === binaryTool).map((s) => s.args)).toEqual([{ query, page: 2 }, { query, page: 3 }]);
      expect(first.cached).toBeUndefined();
      expect(again.cached).toBe(true);
      expect(next.cached).toBeUndefined();
    }
  });
});

describe('MCP の Yahoo の検索のキャッシュ', () => {
  test('search_news・suggest_keywords も 2 回目はキャッシュから返る（30 分）', async () => {
    fakeYahoo();
    for (const [name, key] of [['search_news', 'search:news:yahoo cache news:'], ['suggest_keywords', 'search:suggest:yahoo cache suggest:']]) {
      const query = key.split(':')[2];
      await callMcp(name, { query });
      expect((await callMcp(name, { query })).cached).toBe(true);
      expect(ttlOf(key)).toEqual([cache.CACHE_TTL_DEFAULT]);
    }
    expect(sent.map((s) => s.tool)).toEqual(['yahoo_news_search', 'yahoo_suggest_keywords']);
  });

  test('REST と同じキーを使う: REST で引いた結果を MCP が使い、空の結果は 1 分だけ残す。noCache は REST だけ', async () => {
    fakeYahoo([]);
    const query = 'yahoo cache shared image';
    const rest = (body: Record<string, unknown>) =>
      app.request('/search/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, ...body }) });
    expect((await rest({ limit: 5, page: 2 })).status).toBe(200);
    expect(ttlOf(`search:image:${query}:5:2`)).toEqual([cache.CACHE_TTL_EMPTY]);
    expect((await callMcp('search_image', { query, limit: 5, page: 2 })).cached).toBe(true);
    expect(sent).toHaveLength(1);
    expect(((await (await rest({ limit: 5, page: 2, noCache: true })).json()) as any).cached).toBeUndefined();
    expect(sent).toHaveLength(2);
    expect(ttlOf(`search:image:${query}:5:2`)).toHaveLength(1);
  });

  test('同梱のバイナリが返したエラーの文（JSON でない isError）は 1 分だけ残し、次は取り直す', async () => {
    let calls = 0;
    spies.push(spyOn(yahoo, 'callYahooMcp').mockImplementation(async () => {
      calls++;
      return calls === 1
        ? { content: [{ type: 'text', text: 'Error: HTTP 503 Service Unavailable for url (https://search.yahoo.co.jp/image/search?p=x)' }], isError: true }
        : { content: [{ type: 'text', text: JSON.stringify({ items: [{ title: 'ok', url: 'https://e/1.jpg' }] }) }] };
    }));
    setSpy = spyOn(cache, 'setToCache');
    spies.push(setSpy);
    const query = 'yahoo cache raw error';
    const first = await callMcp('search_image', { query });
    expect(first.raw).toContain('HTTP 503');
    expect(ttlOf(`search:image:${query}::`)).toEqual([cache.CACHE_TTL_EMPTY]);
    setSystemTime(new Date(Date.now() + 61_000));
    try {
      expect((await callMcp('search_image', { query })).items).toHaveLength(1);
    } finally {
      setSystemTime();
    }
    expect(calls).toBe(2);
  });

  test('search_realtime は 2 回目がキャッシュから返り、REST と同じキーで 2 分だけ残す', async () => {
    const query = 'キャッシュ確認 リアルタイム';
    const realtimeCalls: string[] = [];
    spies.push(spyOn(yahoo, 'callYahooRealtimeJson').mockImplementation(async (_tool: string, args: Record<string, any>) => {
      realtimeCalls.push(args.query);
      return { content: [{ text: JSON.stringify({ items: [{ id: '2100000000000000001', text: `${query} の投稿`, url: 'https://x.com/fan/status/2100000000000000001', author_handle: 'fan' }] }) }] };
    }));
    spies.push(spyOn(defaultXDetailProvider, 'fetchStatus').mockResolvedValue(null));
    setSpy = spyOn(cache, 'setToCache');
    spies.push(setSpy);

    const first = await callMcp('search_realtime', { query });
    const again = await callMcp('search_realtime', { query });
    expect(first.items).toHaveLength(1);
    expect(again.items).toEqual(first.items);
    expect(again.cached).toBe(true);
    expect(realtimeCalls).toEqual([query]);
    expect(ttlOf(`${yahoo.buildRealtimeSearchCacheKey({ query, sort: 'recent' })}:compact`)).toEqual([cache.CACHE_TTL_TREND]);

    const res = await app.request('/search/realtime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    const body = (await res.json()) as any;
    expect(body.cached).toBe(true);
    expect(body.data.items.map((i: any) => i.id)).toEqual(['2100000000000000001']);
    expect(realtimeCalls).toHaveLength(1);
  });
});
