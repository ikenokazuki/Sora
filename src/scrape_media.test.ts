import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrapeUrl } from './scraper.js';

describe('scrape の includeMedia と rs-trafilatura への引数（手元のサーバー）', () => {
  let server: ReturnType<typeof Bun.serve>;
  const prev = { allow: process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK, rs: process.env.SORA_RS_TRAFILATURA_PATH };
  beforeAll(() => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    delete process.env.SORA_RS_TRAFILATURA_PATH;
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(
        `<!doctype html><html><head><title>Live</title><meta property="og:image" content="https://example.com/og.jpg"></head><body><main><h1>公演</h1><p>${'公演の案内の文です。'.repeat(30)}<img src="/flyer.jpg" alt="フライヤー"></p></main></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    });
  });
  afterAll(() => {
    server.stop(true);
    for (const [key, value] of [['SORA_FETCH_ALLOW_PRIVATE_NETWORK', prev.allow], ['SORA_RS_TRAFILATURA_PATH', prev.rs]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('includeMedia: false なら本文の画像を [画像: alt] にし、ogImage を省く', async () => {
    const url = `http://127.0.0.1:${server.port}/media`;
    const off = await scrapeUrl({ tenantId: 'legacy', url, mode: 'fast', includeMedia: false, noCache: true });
    expect(off.content).toContain('[画像: フライヤー]');
    expect(off.content).not.toContain('flyer.jpg');
    expect(off.ogImage).toBeUndefined();
    const on = await scrapeUrl({ tenantId: 'legacy', url, mode: 'fast', noCache: true });
    expect(on.content).toContain('flyer.jpg');
    expect(on.ogImage).toBe('https://example.com/og.jpg');
  });

  test('removeSelectors の要素は rs-trafilatura に渡す前に消える', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sora-rs-wire-'));
    const bin = join(dir, 'rs');
    writeFileSync(bin, `#!/bin/sh\ncat > "${bin}.stdin"\nprintf '%s' '{"page_type":"listing","content_html":"<p>一覧</p>"}'\n`);
    chmodSync(bin, 0o755);
    process.env.SORA_RS_TRAFILATURA_PATH = bin;
    try {
      await scrapeUrl({ tenantId: 'legacy', url: `http://127.0.0.1:${server.port}/rs-wire`, mode: 'fast', removeSelectors: ['h1'], noCache: true });
      expect(readFileSync(`${bin}.stdin`, 'utf8')).not.toContain('<h1>');
    } finally {
      delete process.env.SORA_RS_TRAFILATURA_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
