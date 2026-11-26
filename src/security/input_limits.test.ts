import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { app } from '../index.js';
import { createMcpServer } from '../mcp.js';
import * as searchWebFormats from '../search_web_formats.js';
import { findOversizedInput } from './input_limits.js';
import { STANDARD_LIMITS, STRICT_LIMITS } from './limits.js';

// 利用者が送る文字列の長さの上限。長い入力は、全員の要求を処理するメインスレッドを、二乗の時間の処理で止められる

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

const withIsolation = (level: string) => {
  const before = process.env.SORA_ISOLATION;
  process.env.SORA_ISOLATION = level;
  restore.push(() => {
    if (before === undefined) delete process.env.SORA_ISOLATION;
    else process.env.SORA_ISOLATION = before;
  });
};

describe('findOversizedInput', () => {
  const text = STANDARD_LIMITS.inputTextChars;
  const long = STANDARD_LIMITS.inputLongTextChars;
  const url = STANDARD_LIMITS.inputUrlChars;

  test('ふつうの欄は inputTextChars まで。超えると、欄の名前と字数と上限を返す', () => {
    expect(findOversizedInput({ query: 'a'.repeat(text) }, STANDARD_LIMITS)).toBeUndefined();
    expect(findOversizedInput({ query: 'a'.repeat(text + 1) }, STANDARD_LIMITS)).toBe(`「query」が長すぎます（${text + 1} 字。上限は ${text} 字です）`);
  });

  test('長い文章の欄（description・text・script・headers・cookies など）は inputLongTextChars まで。中の値も同じ', () => {
    for (const input of [
      { description: 'a'.repeat(long) },
      { productDescription: 'a'.repeat(long) },
      { actions: [{ type: 'evaluate', script: 'a'.repeat(long) }] },
      { actions: [{ type: 'fill', text: 'a'.repeat(long) }] },
      { headers: { cookie: 'a'.repeat(long) } },
      { cookies: [{ name: 'n', value: 'a'.repeat(long) }] },
    ]) expect(findOversizedInput(input, STANDARD_LIMITS)).toBeUndefined();
    expect(findOversizedInput({ cookies: [{ name: 'n', value: 'a'.repeat(long + 1) }] }, STANDARD_LIMITS)).toContain('「cookies[0].value」');
  });

  test('URL の欄（url・urls・webhookUrl）は inputUrlChars まで', () => {
    const at = (n: number) => `https://example.com/${'a'.repeat(n - 'https://example.com/'.length)}`;
    expect(findOversizedInput({ url: at(url), urls: [at(url)], webhookUrl: at(url) }, STANDARD_LIMITS)).toBeUndefined();
    for (const input of [{ url: at(url + 1) }, { urls: ['https://example.com/', at(url + 1)] }, { webhookUrl: at(url + 1) }]) {
      expect(findOversizedInput(input, STANDARD_LIMITS)).toContain(`上限は ${url} 字です`);
    }
  });

  test('指紋（signature）は、スキーマの上限の 65,536 字まで（strict でも）', () => {
    expect(findOversizedInput({ signature: 'a'.repeat(65_536) }, STRICT_LIMITS)).toBeUndefined();
    expect(findOversizedInput({ signature: 'a'.repeat(65_537) }, STRICT_LIMITS)).toContain('「signature」');
  });

  test('欄の名前（キー）も数える。長いキーは、エラーの文で切る', () => {
    const key = 'k'.repeat(STANDARD_LIMITS.inputTextChars + 1);
    const message = findOversizedInput({ selectors: { [key]: 'p' } }, STANDARD_LIMITS)!;
    expect(message).toContain('長すぎます');
    expect(message.length).toBeLessThan(300);
  });

  test('1 つずつは短くても、合計が inputTotalChars を超えたら断る', () => {
    const one = 'a'.repeat(1000);
    const count = Math.floor(STRICT_LIMITS.inputTotalChars / 1000);
    expect(findOversizedInput({ orWords: Array.from({ length: count - 1 }, () => one) }, STRICT_LIMITS)).toBeUndefined();
    expect(findOversizedInput({ orWords: Array.from({ length: count + 1 }, () => one) }, STRICT_LIMITS)).toBe(`入力の文字の合計が大きすぎます（上限は ${STRICT_LIMITS.inputTotalChars} 字です）`);
  });

  test('深い入れ子でも、調べるのに時間がかからず、スタックもあふれない', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 100_000; i++) deep = { a: deep };
    const started = performance.now();
    expect(findOversizedInput(deep, STANDARD_LIMITS)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test('strict は standard より小さい', () => {
    expect(STRICT_LIMITS.inputTextChars).toBeLessThan(STANDARD_LIMITS.inputTextChars);
    expect(STRICT_LIMITS.inputLongTextChars).toBeLessThan(STANDARD_LIMITS.inputLongTextChars);
    expect(STRICT_LIMITS.inputUrlChars).toBeLessThan(STANDARD_LIMITS.inputUrlChars);
    expect(STRICT_LIMITS.inputTotalChars).toBeLessThan(STANDARD_LIMITS.inputTotalChars);
  });
});

describe('REST で掛ける', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

  const stubWebSearch = () => {
    const spy = spyOn(searchWebFormats, 'searchWebForRest').mockResolvedValue({ query: 'q', data: { items: [], count: 0 } });
    restore.push(() => spy.mockRestore());
    return spy;
  };

  test('本文の欄が長すぎると、処理の前に 400 INVALID_INPUT。content-type が無くても同じ', async () => {
    const spy = stubWebSearch();
    for (const headers of [{ 'content-type': 'application/json' }, {} as Record<string, string>]) {
      const res = await post('/search/web', { query: 'a'.repeat(STANDARD_LIMITS.inputTextChars + 1), formats: ['markdown'] }, headers);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', error: expect.stringContaining('「query」が長すぎます') });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test('strict では strict の上限で断る', async () => {
    withIsolation('strict');
    stubWebSearch();
    const res = await post('/search/web', { query: 'a'.repeat(STRICT_LIMITS.inputTextChars + 1) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(`上限は ${STRICT_LIMITS.inputTextChars} 字です`);
  });

  test('クエリ文字列（GET）の欄も調べる', async () => {
    // /tools は手元で答える経路（上限が無ければ 200）
    const res = await app.request(`/tools?q=${'a'.repeat(STANDARD_LIMITS.inputTextChars + 1)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', error: expect.stringContaining('「q」が長すぎます') });
    expect((await app.request('/tools?q=scrape')).status).toBe(200);
  });

  test('上限の内の要求は、そのまま経路に届く', async () => {
    const spy = stubWebSearch();
    const res = await post('/search/web', { query: 'a'.repeat(STANDARD_LIMITS.inputTextChars), formats: ['markdown'] });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('MCP で掛ける', () => {
  const withClient = async <T>(fn: (client: Client) => Promise<T>, extra: Parameters<typeof createMcpServer>[0] = {}): Promise<T> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false, sessionState: { activatedTools: new Set<string>(), tenantId: 'name:x' }, ...extra });
    const client = new Client({ name: 'input-limits', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  };
  const textOf = (result: any) => (result.content?.[0]?.text ?? '') as string;

  test('ツールの引数が長すぎると、ハンドラを呼ばずに isError と理由を返す', async () => {
    const spy = spyOn(searchWebFormats, 'searchWebWithFormats').mockResolvedValue({ items: [], count: 0 });
    restore.push(() => spy.mockRestore());
    const result = await withClient((client) => client.callTool({ name: 'search_web', arguments: { query: 'a'.repeat(STANDARD_LIMITS.inputTextChars + 1), formats: ['markdown'] } }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('「query」が長すぎます');
    expect(spy).not.toHaveBeenCalled();
  });

  test('構造化した出力を返すツール（registerStructuredTool）も同じ', async () => {
    let called = false;
    const result = await withClient(
      (client) => client.callTool({ name: 'research_country_context', arguments: { region: 'JP', query: 'a'.repeat(STANDARD_LIMITS.inputTextChars + 1) } }),
      { intelResearch: async () => { called = true; return {}; } },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('「query」が長すぎます');
    expect(called).toBe(false);
  });

  test('search_tools も同じ', async () => {
    const result = await withClient((client) => client.callTool({ name: 'search_tools', arguments: { query: 'a '.repeat(STANDARD_LIMITS.inputTextChars) } }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('「query」が長すぎます');
  });
});
