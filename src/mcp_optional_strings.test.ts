import { afterEach, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import * as scraper from './scraper.js';
import * as poi from './services/poi.js';

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

// LLM は、使わない任意の文字列の引数に "" を入れることがある。排他・モード専用の引数は "" を「指定なし」と読む
// （src/mcp/args.ts の given）のに、スキーマの minLength・format（.url()）・pattern は zod の段で "" を断ってしまう。
// 形の検査は、ハンドラの中で、空でないときだけ行う。必須の引数と列挙型（enum）は対象外。
// 例外: 排他でもモード専用でもない、独立の任意の引数で、形の制約が入力の契約のもの（理由つき）。
const ALLOWED: Record<string, string> = {
  'check_product_compliance.url': '独立の任意の引数（品名・説明と併用する商品ページ）',
  'recognize_song.country': '独立の任意の引数。REST と同じスキーマで、形（2 文字の国コード）を示す',
  'search_poi.query': '独立の任意の引数（検索語）。空白だけの語を断る',
  'search_route.date': '独立の任意の引数。REST と同じスキーマで、形（YYYYMMDD）を示す',
  'search_route.time': '独立の任意の引数。REST と同じスキーマで、形（HHMM）を示す',
};

test('必須でない自由な文字列の引数に、minLength・format・pattern が付いていない（例外は ALLOWED）', async () => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  // 名前を挙げたときだけ有効になるモジュールも含め、全部のツールを見る
  const server = createMcpServer({ deferTools: false, modules: ['all', 'lyrics', 'shazam', 'hts-archive'] });
  const client = new Client({ name: 'optional-strings', version: '1.0.0' });
  await server.connect(st);
  await client.connect(ct);
  try {
    const { tools } = await client.listTools();
    const constrained: string[] = [];
    for (const tool of tools) {
      const required = new Set(tool.inputSchema.required ?? []);
      for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {}) as Array<[string, Record<string, unknown>]>) {
        if (required.has(key) || prop.type !== 'string' || prop.enum) continue;
        if (['minLength', 'format', 'pattern'].some((c) => c in prop)) constrained.push(`${tool.name}.${key}`);
      }
    }
    expect(constrained.sort()).toEqual(Object.keys(ALLOWED).sort());
  } finally {
    await client.close();
    await server.close();
  }
});

// 統合したツールの "" の扱いは、src/mcp_tool_params.test.ts の各ツールの節で確かめる
async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false });
  const client = new Client({ name: 'optional-strings', version: '1.0.0' });
  await server.connect(st);
  await client.connect(ct);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}
const textOf = (res: any): string => res.content?.[0]?.text ?? '';

test('search_poi: lat・lon と center: "" は座標の検索（"" の地名を座標化しない）', async () => {
  const spy = spyOn(poi, 'searchOpenPoi').mockResolvedValue({ count: 0, pois: [] } as any);
  restore.push(() => spy.mockRestore());
  const res = await callTool('search_poi', { lat: 35.68, lon: 139.76, center: '' });
  expect(res.isError, textOf(res)).toBeFalsy();
  expect((spy.mock.calls[0][0] as { center?: string }).center).toBeUndefined();
});

test('browser_action: sessionId と url: "" はセッションの続き。URL として読めない url は、操作せずに入力の誤り', async () => {
  const spy = spyOn(scraper, 'executeBrowserActions').mockResolvedValue({ success: true } as any);
  restore.push(() => spy.mockRestore());
  const res = await callTool('browser_action', { sessionId: 's1', url: '' });
  expect(res.isError, textOf(res)).toBeFalsy();
  expect(spy).toHaveBeenCalledTimes(1);
  const bad = await callTool('browser_action', { url: 'example.com' });
  expect(bad.isError).toBe(true);
  expect(textOf(bad)).toContain('url は URL として読めません（いま: "example.com"）');
  expect(spy).toHaveBeenCalledTimes(1);
});
