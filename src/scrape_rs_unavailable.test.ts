import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as browserStealth from './browser_stealth.js';
import * as cache from './cache.js';
import { childDropProbe } from './child_uid.js';
import { formatCompactScrapeResult } from './response_cleaner.js';
import { scrapeUrl } from './scraper.js';
import { projectRequestedScrapeFormats } from './search_format_projection.js';
import { installFakePdfLauncher } from './test_fixtures/pdf_launcher.js';

/**
 * 本文の抽出（rs-trafilatura）が使えず、結果が変わるときは、取得した人に分かるように、応答の warnings に書く（運用者向けのログと数え上げだけにしない）。
 * 使えない状態は、起動用バイナリが終了コード 126 で止まる偽物で作る。
 */
describe('本文の抽出が使えないことが、scrape の応答で分かる（手元のサーバー）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sora-rs-unavailable-'));
  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const listing = script('listing-rs', `cat > /dev/null\nprintf '{"page_type":"listing","content_html":"<p>rs-body</p>"}'`);
  const deny = script('deny-launch', 'cat > /dev/null\nexit 126');
  const page = `<!doctype html><html><head><title>案内</title></head><body><main><h1>案内</h1><p>${'公演の案内の長い本文の文です。'.repeat(30)}</p><img src="https://example.com/a.jpg" alt="a"></main></body></html>`;

  let server: ReturnType<typeof Bun.serve>;
  const prev = { allow: process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK, rs: process.env.SORA_RS_TRAFILATURA_PATH };
  let fake: ReturnType<typeof installFakePdfLauncher>;
  let warn: ReturnType<typeof spyOn>;
  let n = 0;
  const url = () => `http://127.0.0.1:${server.port}/page-${++n}-${Date.now()}`;

  beforeAll(() => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    process.env.SORA_RS_TRAFILATURA_PATH = listing;
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['SORA_FETCH_ALLOW_PRIVATE_NETWORK', prev.allow], ['SORA_RS_TRAFILATURA_PATH', prev.rs]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeEach(() => {
    fake = installFakePdfLauncher();
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    fake.restore();
    warn.mockRestore();
  });

  const unusable = () => {
    childDropProbe.launcher = () => deny;
  };
  const scrape = (extra: Record<string, unknown> = {}) => scrapeUrl({ tenantId: 'legacy', url: url(), mode: 'fast', noCache: true, ...extra });

  test('使えるときは、警告を付けない', async () => {
    const result = await scrape();
    expect(result.content).toContain('rs-body');
    expect(result.warnings).toBeUndefined();
  });

  test('静的な取得: 本文は別の方式で取れて、warnings で分かる。内部の設定や uid は書かない', async () => {
    unusable();
    const result = await scrape();
    expect(result.content).toContain('公演の案内の長い本文の文です。');
    expect(result.content).not.toContain('rs-body');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('rs-trafilatura');
    expect(result.warnings?.[0]).toContain('Readability');
    expect(result.warnings?.[0]).not.toMatch(/uid|SORA_|126|root/);
  });

  test('ブラウザの経路でも分かる。使えるときは、警告を付けない', async () => {
    const spy = spyOn(browserStealth, 'fetchWithStealthBrowser').mockImplementation((async (target: string) => ({ html: page, finalUrl: target, title: '案内', status: 200 })) as typeof browserStealth.fetchWithStealthBrowser);
    try {
      const usable = await scrape({ mode: 'browser' });
      expect(usable.content).toContain('rs-body');
      expect(usable.warnings).toBeUndefined();
      unusable();
      const result = await scrape({ mode: 'browser' });
      expect(result.renderedWithBrowser).toBe(true);
      expect(result.warnings?.join('\n')).toContain('Readability');
      expect(result.warnings).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('onlyMainContent: false は、抽出を使わないので、警告も付けない', async () => {
    unusable();
    expect((await scrape({ onlyMainContent: false })).warnings).toBeUndefined();
  });

  test('画像を戻す処理だけが使えないときは、画像が抜けうることを言う', async () => {
    // 起動用バイナリの 1 回目は通し、2 回目は 126 で止める
    const count = join(dir, 'count');
    const once = script('once-launch', `n=$(cat '${count}' 2>/dev/null || echo 0)\necho $((n + 1)) > '${count}'\n[ "$n" = 0 ] || { cat > /dev/null; exit 126; }\nexec "$SORA_LAUNCH_EXEC" "$@"`);
    childDropProbe.launcher = () => once;
    // includeMedia: false は 2 回目を走らせないので、画像の警告も付かない
    expect((await scrape({ includeMedia: false })).warnings).toBeUndefined();
    rmSync(count, { force: true });
    const result = await scrape();
    expect(result.content).toContain('rs-body');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('画像');
    expect(result.warnings?.[0]).not.toContain('Readability');
  });

  test('ほかの警告（screenshot を撮れない）と、両方残る', async () => {
    unusable();
    const result = await scrape({ formats: ['markdown', 'screenshot'] });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings?.join('\n')).toContain('Readability');
    expect(result.warnings?.join('\n')).toContain('screenshot');
  });

  test('短い形式の応答（MCP・REST）と search_deep の取り込みにも残り、短い時間だけキャッシュする', async () => {
    unusable();
    const setSpy = spyOn(cache, 'setToCache');
    try {
      const target = url();
      const result = await scrapeUrl({ tenantId: 'legacy', url: target, mode: 'fast' });
      expect(formatCompactScrapeResult(result).warnings).toEqual(result.warnings);
      expect(projectRequestedScrapeFormats(result, ['markdown']).warnings).toEqual(result.warnings);
      const ttls = setSpy.mock.calls.filter(([key]) => String(key).includes(target)).map(([, , ttl]) => ttl);
      expect(ttls).toEqual([cache.CACHE_TTL_EMPTY]);
    } finally {
      setSpy.mockRestore();
    }
  });
});
