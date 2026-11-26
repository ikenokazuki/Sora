import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import * as engine from './browser_engine.js';
import { resolveChromiumPath, setupPageSecurity, toBrowserUrl } from './browser_engine.js';
import { closeAllBrowserSessions, handleBrowserSessionAction, runActionsOnPage } from './browser_session.js';
import { fetchWithStealthBrowser } from './browser_stealth.js';
import { ScrapeInputError } from './errors.js';
import { scrapeRoutes } from './routes/scrape.js';
import { scrapeUrl } from './scraper.js';
import { createProdMetaBrowser } from './services/social/transport.js';
import { failureOf, within } from './test_fixtures/wait.js';

// ブラウザで開く URL は http・https だけ。ほかの種類は、ブラウザの内部の画面（chrome:）やサーバー側のファイル（file:）を読んだり、
// 任意の JavaScript の実行の禁止を抜けたり（javascript:）できるので、ブラウザも枠も使う前に断る
const REJECTED = ['chrome://version', 'CHROME://gpu', 'file:///etc/hostname', 'view-source:http://example.com/', 'javascript:void(0)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<p>x</p>', 'about:blank', 'devtools://devtools/bundled/inspector.html', 'filesystem:http://example.com/temporary/x', 'ftp://example.com/', 'example.com/no-scheme', ''];

describe('toBrowserUrl', () => {
  test('http・https は通し、読み直した形を返す', () => {
    expect(toBrowserUrl('https://example.com')).toBe('https://example.com/');
    expect(toBrowserUrl('  HTTP://Example.com/a b?q=1#f ')).toBe('http://example.com/a%20b?q=1#f');
  });

  test.each(REJECTED)('%j は断る', (url) => {
    expect(() => toBrowserUrl(url)).toThrow(ScrapeInputError);
  });
});

describe('ブラウザを使う入口は、http・https でない URL を、ブラウザも枠も使う前に断る', () => {
  let getBrowser: ReturnType<typeof spyOn<typeof engine, 'getBrowser'>>;
  const spies: Array<{ mockRestore: () => void }> = [];
  beforeEach(() => {
    getBrowser = spyOn(engine, 'getBrowser').mockRejectedValue(new Error('ブラウザは使わないはず'));
    spies.push(getBrowser, spyOn(engine, 'resolveChromiumPath').mockReturnValue('/test/chromium'));
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });
  const refusedBeforeBrowser = async (work: Promise<unknown>) => {
    const error = await within(5000, failureOf(work));
    expect(error).toBeInstanceOf(ScrapeInputError);
    expect(getBrowser).not.toHaveBeenCalled();
    expect(engine.browserSemaphore.activeCount).toBe(0);
  };

  test('scrape の描画', async () => {
    for (const url of ['chrome://version', 'javascript:void(0)']) await refusedBeforeBrowser(fetchWithStealthBrowser(url, 1000));
  });

  test('browser_action の url', async () => {
    for (const url of ['chrome://version', 'file:///etc/hostname']) await refusedBeforeBrowser(handleBrowserSessionAction({ tenantId: 'name:scheme', url }));
  });

  test('REST の /scrape（mode: browser）は 400', async () => {
    const res = await scrapeRoutes.request('/scrape', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'chrome://version', mode: 'browser', noCache: true }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('INVALID_INPUT');
    expect(getBrowser).not.toHaveBeenCalled();
  });

  test('SNS の投稿の描画', async () => {
    await refusedBeforeBrowser(createProdMetaBrowser('name:scheme').readPage('file://threads.com/@a/post/b', 1000, new AbortController().signal));
  });
});

describe('ブラウザに渡すのは、確かめて読み直した URL', () => {
  const prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  beforeEach(() => { process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true'; }); // 名前の解決をしない
  afterEach(() => {
    if (prevAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
  });
  const recordingPage = (visited: string[]) => new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'url') return () => 'about:blank';
      if (prop === 'viewport') return () => null;
      if (prop === 'goto') return async (url: string) => { visited.push(url); };
      return async () => null;
    },
  }) as unknown as Page;

  test('navigate は、http・https でなければ失敗し、通すときは読み直した形を渡す', async () => {
    const visited: string[] = [];
    const { actionLogs } = await runActionsOnPage(recordingPage(visited), [{ type: 'navigate', url: 'view-source:http://example.com/' }, { type: 'navigate', url: ' HTTP://Example.com' }], 1000);
    expect(actionLogs.map((log) => log.success)).toEqual([false, true]);
    expect(visited).toEqual(['http://example.com/']);
  });

  test('browser_action の最初の url も、読み直した形を渡す', async () => {
    const visited: string[] = [];
    const spy = spyOn(engine, 'getBrowser').mockResolvedValue({ browser: { createBrowserContext: async () => ({ newPage: async () => recordingPage(visited), close: async () => {} }) }, isDedicated: false } as never);
    try {
      await within(20_000, handleBrowserSessionAction({ tenantId: 'name:scheme', url: ' HTTP://Example.com', extract: { markdown: false } }));
      expect(visited).toEqual(['http://example.com/']);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  test('内部の宛先を許す設定でも、ページの要求の割り込みは、http・https のほかを通さない', async () => {
    let handler: ((req: unknown) => Promise<void>) | undefined;
    const page = { setRequestInterception: async () => {}, on: (_event: string, listener: (req: unknown) => Promise<void>) => { handler = listener; }, mainFrame: () => null } as unknown as Page;
    await setupPageSecurity(page);
    const send = async (url: string) => {
      const calls: string[] = [];
      await handler?.({ url: () => url, resourceType: () => 'document', isNavigationRequest: () => true, frame: () => null, headers: () => ({}), continue: async () => void calls.push('continue'), abort: async (reason: string) => void calls.push(`abort:${reason}`) });
      return calls;
    };
    expect(await send('file:///etc/hostname')).toEqual(['abort:blockedbyclient']);
    expect(await send('http://127.0.0.1:1/')).toEqual(['continue']);
    expect(await send('data:text/plain,x')).toEqual(['continue']);
  });
});

describe.skipIf(!resolveChromiumPath())('本物の Chromium', () => {
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  const marker = 'SORA_SCHEME_MARKER_5e0c';
  const prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  beforeAll(() => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    dir = mkdtempSync(join(tmpdir(), 'sora-scheme-'));
    writeFileSync(join(dir, 'marker.txt'), `${marker} 目印のファイルの本文です。`.repeat(5));
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<html><body><p id="a">before-javascript-url</p></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  });
  afterAll(async () => {
    if (prevAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
    await closeAllBrowserSessions();
    await engine.closeSharedBrowser();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('javascript: の url は、開いているページで実行されない', async () => {
    const act = (extra: Record<string, unknown>) => handleBrowserSessionAction({ tenantId: 'name:scheme', sessionId: 'sess_js', extract: { markdown: false, html: true }, ...extra });
    await act({ createSession: true, url: `http://127.0.0.1:${server.port}/` });
    const error = await failureOf(act({ url: 'javascript:void(document.getElementById("a").textContent="JS-RAN")' }));
    const after = await act({});
    expect(after.html).toContain('before-javascript-url');
    expect(after.html).not.toContain('JS-RAN');
    expect(error).toBeInstanceOf(ScrapeInputError);
  }, 60_000);

  test('内部の宛先を許す設定でも、file: の URL は読めない', async () => {
    const url = `file://${join(dir, 'marker.txt')}`;
    const outcomes = await Promise.all([
      handleBrowserSessionAction({ tenantId: 'name:scheme', url, extract: { markdown: true, html: true } }).then((r) => `${r.content ?? ''}${r.html ?? ''}`, (e: Error) => `refused:${e.constructor.name}`),
      scrapeUrl({ tenantId: 'name:scheme', url, mode: 'browser', formats: ['markdown', 'rawHtml'], noCache: true, timeoutMs: 8000 }).then((r) => `${r.content ?? ''}${r.rawHtml ?? ''}`, (e: Error) => `refused:${e.constructor.name}`),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).not.toContain(marker);
      expect(outcome).toBe('refused:ScrapeInputError');
    }
  }, 60_000);
});
