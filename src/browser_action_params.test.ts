import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { clearCache, setToCache } from './cache.js';
import { resolveChromiumPath } from './browser_engine.js';
import { createMcpServer } from './mcp.js';
import { browserRoutes } from './routes/browser.js';
import * as scraper from './scraper.js';
import { BrowserActionRequestSchema, BrowserActionStepSchema, generateOpenApiDocument } from './types.js';

// browser_action・inspect_image の引数が、手元のサーバーで説明どおりに働くことを確かめる（外へは出ない）
const browserTest = resolveChromiumPath() ? test : test.skip;
const RED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#f00"/></svg>';
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** PNG（8 bit の RGB・RGBA）を読んで、赤い画素の数を返す */
function redPixels(base64: string): number {
  const png = Buffer.from(base64, 'base64');
  const [width, height, , colorType] = [png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]];
  const bpp = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) {
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + png.readUInt32BE(at)));
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const prev = rows[y - 1] ?? Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      row[i] = (row[i] + predictor) & 0xff;
    }
    rows.push(row);
  }
  let count = 0;
  for (const row of rows) for (let x = 0; x < width; x++) if (row[x * bpp] > 200 && row[x * bpp + 1] < 60 && row[x * bpp + 2] < 60) count++;
  return count;
}

describe('browser_action・inspect_image（手元のサーバー）', () => {
  let server: ReturnType<typeof Bun.serve>;
  const prevAllow = process.env.ALLOW_LOCAL_FETCH;
  const base = () => `http://127.0.0.1:${server.port}`;
  const restore: Array<() => void> = [];

  beforeAll(() => {
    process.env.ALLOW_LOCAL_FETCH = 'true';
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/red.svg') return new Response(RED_SVG, { headers: { 'content-type': 'image/svg+xml' } });
        if (path === '/clip') {
          return new Response('<!doctype html><html><body style="margin:0"><img id="pic" src="/red.svg" width="60" height="40"></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (path === '/page.png') return new Response(PNG_1X1, { headers: { 'content-type': 'image/png' } });
        if (path === '/mislabeled.png') return new Response(PNG_1X1, { headers: { 'content-type': 'application/octet-stream' } });
        return new Response('<!doctype html><html><body>画像ではなくページです</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    if (prevAllow === undefined) delete process.env.ALLOW_LOCAL_FETCH;
    else process.env.ALLOW_LOCAL_FETCH = prevAllow;
  });
  afterEach(() => { while (restore.length) restore.pop()!(); });

  browserTest('extract.clipSelector だけでも、要素の画像（img）は空白にならない', async () => {
    const clipOnly = await scraper.executeBrowserActions({ url: `${base()}/clip`, extract: { markdown: false, clipSelector: '#pic' } });
    expect(clipOnly.screenshot).toBeDefined();
    expect(redPixels(clipOnly.screenshot!)).toBeGreaterThan(2000);
    const withScreenshot = await scraper.executeBrowserActions({ url: `${base()}/clip`, extract: { markdown: false, screenshot: true, clipSelector: '#pic' } });
    expect(redPixels(withScreenshot.screenshot!)).toBe(redPixels(clipOnly.screenshot!));
  }, 60_000);

  test('REST の本文の ownerToken はスキーマにも OpenAPI にも無く、持ち主の確認には Authorization ヘッダーの値だけを使う', async () => {
    expect((BrowserActionRequestSchema.shape as any).ownerToken).toBeUndefined();
    const doc: any = generateOpenApiDocument();
    for (const path of ['/browser/action', '/action']) {
      const schema = doc.paths[path].post.requestBody.content['application/json'].schema;
      expect(Object.keys(schema.properties)).not.toContain('ownerToken');
    }
    const spy = spyOn(scraper, 'executeBrowserActions').mockResolvedValue({ success: true, url: 'http://127.0.0.1/' } as any);
    restore.push(() => spy.mockRestore());
    const res = await browserRoutes.request('/browser/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer header-token' },
      body: JSON.stringify({ sessionId: 'sess_x', ownerToken: 'body-token', actions: [] }),
    });
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0][0].ownerToken).toBe('header-token');
  });

  test('MCP の browser_action には、本文の ownerToken が今のまま残る', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'browser-params', version: '1.0.0' });
    await mcp.connect(st);
    await client.connect(ct);
    try {
      const { tools } = await client.listTools();
      const props = (tools.find((t) => t.name === 'browser_action')!.inputSchema as any).properties;
      expect(props.ownerToken).toBeDefined();
      expect(props.timeout.description).toContain('ページ遷移');
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  test('timeout・actions の evaluate・delay・screenshot の説明が、実際の働きと合っている', () => {
    const request = (BrowserActionRequestSchema.shape as any);
    expect(request.timeout.description).toContain('ページ遷移');
    expect(request.timeout.description).toContain('全体');
    const step = BrowserActionStepSchema.shape as any;
    expect(step.type.description).toContain('ALLOW_BROWSER_EVALUATE=true');
    expect(step.delay.description).toContain('click');
    expect(step.delay.description).toContain('1 文字');
    expect(step.type.description).toContain('extract.screenshot');
  });

  test('inspect_image は、画像でない応答（HTML）をエラーにする', async () => {
    await expect(scraper.inspectImage({ url: `${base()}/article` })).rejects.toThrow(/画像ではありません.*text\/html/);
  });

  test('inspect_image は、画像でない応答を成功として保存していた古いキャッシュ（v1 のキー）を読まない', async () => {
    const url = `${base()}/article`;
    setToCache(`img_inspect:${url}`, { success: true, url, mimeType: 'image/jpeg', sizeBytes: 1, base64: 'AA==', imageContent: { type: 'image', data: 'AA==', mimeType: 'image/jpeg' } }, 60_000);
    try {
      await expect(scraper.inspectImage({ url })).rejects.toThrow(/画像ではありません/);
    } finally {
      clearCache();
    }
  });

  test('inspect_image は、画像の応答は今までどおり返し、Content-Type が不明でも中身が画像なら返す', async () => {
    const png = await scraper.inspectImage({ url: `${base()}/page.png` });
    expect(png.mimeType).toBe('image/png');
    const mislabeled = await scraper.inspectImage({ url: `${base()}/mislabeled.png` });
    expect(mislabeled.mimeType).toBe('image/png');
  });
});
