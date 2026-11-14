import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { createMcpServer } from '../mcp.js';
import { browserRoutes } from './browser.js';

/**
 * browser_action の入力の上限（設計 6。穴 23）を、REST と MCP の入口から確かめる。超えた入力は、ブラウザも枠も使う前に、
 * REST は 400（INVALID_INPUT）、MCP はエラーの文にする。ブラウザは起動しない。
 */

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.SORA_ISOLATION;
});
afterEach(() => {
  if (previous === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = previous;
});

const press = (count: number) => Array.from({ length: count }, () => ({ type: 'press', key: 'a' }));
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const app = () => new Hono().route('/', browserRoutes);

describe('POST /browser/action', () => {
  test('strict: 21 個のアクションは 400（INVALID_INPUT。上限を添える）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    const res = await app().request('/browser/action', post({ url: 'https://example.com/', actions: press(21) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', retryable: false, error: expect.stringContaining('20') });
  });

  test('standard（既定）: 101 個のアクションは 400。wait に 1e9 ミリ秒も 400（以前は、ブラウザの枠を何日も持てた）', async () => {
    delete process.env.SORA_ISOLATION;
    const tooMany = await app().request('/browser/action', post({ url: 'https://example.com/', actions: press(101) }));
    expect(tooMany.status).toBe(400);
    const longWait = await app().request('/browser/action', post({ url: 'https://example.com/', actions: [{ type: 'wait', ms: 1e9 }] }));
    expect(longWait.status).toBe(400);
    expect(await longWait.json()).toMatchObject({ code: 'INVALID_INPUT', error: expect.stringContaining('120000') });
  });

  test('負の ms・delay は 400（合計の検査を、負の値で減らして迂回できない）', async () => {
    delete process.env.SORA_ISOLATION;
    const typing = { type: 'type', selector: '#b', text: 'x'.repeat(100_000), delay: 10_000 };
    for (const negative of [{ type: 'wait', ms: -1e9 }, { type: 'click', selector: '#a', delay: -1e9 }]) {
      const res = await app().request('/browser/action', post({ url: 'https://example.com/', actions: [negative, typing] }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    }
  });

  test('sessionId は 128 文字まで・制御文字なし（超えたら 400。セッションを閉じるだけの呼び出しも）', async () => {
    delete process.env.SORA_ISOLATION;
    for (const body of [
      { sessionId: 'x'.repeat(129), createSession: true },
      { sessionId: 'x'.repeat(129), closeSession: true },
      { sessionId: 'a\nb', url: 'https://example.com/' },
    ]) {
      const res = await app().request('/browser/action', post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', retryable: false, error: expect.stringContaining('sessionId') });
    }
  });

  test('timeout と extract.maxChars の上限も 400', async () => {
    process.env.SORA_ISOLATION = 'strict';
    expect((await app().request('/browser/action', post({ url: 'https://example.com/', timeout: 60_001 }))).status).toBe(400);
    expect((await app().request('/browser/action', post({ url: 'https://example.com/', extract: { maxChars: 100_001 } }))).status).toBe(400);
  });
});

describe('MCP の browser_action', () => {
  test('strict: 21 個のアクションは、エラーの文（上限を添える）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'browser-input-limits', version: '1.0.0' });
    await mcp.connect(st);
    await client.connect(ct);
    try {
      const out: any = await client.callTool({ name: 'browser_action', arguments: { url: 'https://example.com/', actions: press(21) } });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain('actions は 20 個まで');
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
