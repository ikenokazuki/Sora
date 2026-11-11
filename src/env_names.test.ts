import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createAuthMiddleware, resolvePeerLocal } from './auth.js';
import { browserIdleTtlMs, closeSharedBrowser, defaultBrowserConcurrency, detectMemoryLimitBytes, getProxyConfig, resolveChromiumPath, validateHostIpDns } from './browser_engine.js';
import { handleBrowserSessionAction } from './browser_session.js';
import { extractMainContentWithRs } from './extractor/rs_trafilatura.js';
import { deliverWebhook } from './enrichment.js';
import * as httpFetcher from './http_fetcher.js';
import { defaultReferrerHeaders, pickProxyUrl } from './http_fetcher.js';
import { app } from './index.js';
import { createMcpServer, sanitizeMcpResponse, toolCatalogOf } from './mcp.js';
import { isModuleActive } from './mcp/registry.js';
import { integratedSearch } from './scraper.js';
import { resolveMcpOriginConfig, resolveMcpPort } from './security/mcp_origin.js';
import { addressEnabled, loadAddressConfig } from './services/address_config.js';
import { startAddressPreload } from './services/address_preload.js';
import { crossSource } from './services/cbp_cross.js';
import { createBlueskyProvider } from './services/country_intel/providers/bluesky.js';
import { createDefaultCountryIntelDependencies, disabledCountryIntelProviders } from './services/country_intel/runtime.js';
import { CROSS_INDEX_URL, ensureCrossIndex, resetCrossIndexForTest } from './services/cross_index.js';
import { sendAdminAlert } from './services/health.js';
import { htsDirectory } from './services/hts_data.js';
import { openPoiBaseUrl } from './services/poi.js';
import { dhlAdapter, dhlApiKey } from './services/tracking/carriers/dhl.js';
import { fedexAdapter, fedexApiCredentials } from './services/tracking/carriers/fedex.js';
import { upsAdapter, upsApiCredentials } from './services/tracking/carriers/ups.js';
import { FxTwitterDetailProvider } from './services/x_detail.js';
import * as yahoo from './services/yahoo.js';
import { withEnv } from './test_fixtures/env.js';

// v5.0.0 の環境変数の名前（全体・認証・ログ・通知・MCP・ブラウザ・静的取得・プロキシ・検索・Yahoo・X・OpenPOI・住所・HTS・追跡・国地域）。新しい名前で効き、旧名は別名として読まない（旧名を知らせるのは起動時の検査）。
// 旧名を書くテストは、このファイルと config.test.ts だけにする（ほかのテストは新しい名前だけを使う）。

/**
 * モジュールの読み込み時に読む値は、子プロセスで確かめる（このプロセスの値は、読み込んだときのまま）。
 * code は `RESULT <値>` の行を出す。names は親の環境から外してから vars を足す。
 */
async function loadTimeResult(code: string, names: string[], vars: Record<string, string>): Promise<string> {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !names.includes(k)));
  const proc = Bun.spawn([process.execPath, '-e', code], { cwd: new URL('..', import.meta.url).pathname, env: { ...base, NODE_ENV: 'test', SORA_DB_PATH: ':memory:', ...vars }, stdout: 'pipe', stderr: 'pipe' });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.split('\n').find((line) => line.startsWith('RESULT ')) ?? `no RESULT: ${out}`;
}

describe('SORA_MODULES', () => {
  const modules = (value: string | undefined, old?: string) => withEnv({ SORA_MODULES: value, ENABLED_MODULES: old }, () => ({
    web: isModuleActive('web'),
    trade: isModuleActive('trade'),
    lyrics: isModuleActive('lyrics'),
    shazam: isModuleActive('shazam'),
  }));

  test('新しい名前で絞り、旧名 ENABLED_MODULES だけでは絞らない', async () => {
    expect(await modules('web')).toEqual({ web: true, trade: false, lyrics: false, shazam: false });
    expect(await modules(undefined, 'web')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
    expect(await modules(undefined, 'all,lyrics')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
  });

  test('列の読み方: 大文字小文字を問わず、知らない名前は除き、all と * は値のどこにあっても全部', async () => {
    expect(await modules('Web,weeb')).toEqual({ web: true, trade: false, lyrics: false, shazam: false });
    expect(await modules('web,*')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
    expect(await modules('lyrics,ALL')).toEqual({ web: true, trade: true, lyrics: true, shazam: false });
    // 正しい名前が 1 つも無いのは未設定と同じ（起動時の検査が止める）
    expect(await modules('weeb')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
    expect(await modules(' , ')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
  });

  test('引数で渡したモジュールは環境変数より優先する', async () => {
    await withEnv({ SORA_MODULES: 'web' }, () => expect(isModuleActive('trade', ['all'])).toBe(true));
  });
});

describe('SORA_MCP_DEFER_TOOLS', () => {
  // 遅延した（search_tools で有効にするまで無効の）ツールがあるか。ツールの名前に頼らず、モジュールも全部にして数える
  const deferred = (vars: Record<string, string | undefined>, deferTools?: boolean) =>
    withEnv({ SORA_MCP_DEFER_TOOLS: undefined, SORA_DEFER_TOOLS: undefined, SORA_MODULES: undefined, ...vars }, () =>
      [...toolCatalogOf(createMcpServer(deferTools === undefined ? undefined : { deferTools })).values()].some((entry) => entry.handle.enabled === false));

  test('既定は遅延。false・0・off・no（大文字小文字は問わない）で全部を最初から有効にする', async () => {
    expect(await deferred({})).toBe(true);
    for (const value of ['false', '0', 'off', 'no', 'OFF']) expect(await deferred({ SORA_MCP_DEFER_TOOLS: value }), value).toBe(false);
    for (const value of ['true', '1', 'on', 'abc']) expect(await deferred({ SORA_MCP_DEFER_TOOLS: value }), value).toBe(true);
  });

  test('旧名 SORA_DEFER_TOOLS は読まない。引数の deferTools は環境変数より優先する', async () => {
    expect(await deferred({ SORA_DEFER_TOOLS: 'false' })).toBe(true);
    expect(await deferred({ SORA_MCP_DEFER_TOOLS: 'off' }, true)).toBe(true);
  });
});

describe('SORA_MCP_OUTPUT_SCHEMA', () => {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 't', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }] } });
  const listed = (vars: Record<string, string | undefined>) => withEnv({ SORA_MCP_OUTPUT_SCHEMA: undefined, SORA_TOOL_OUTPUT_SCHEMA: undefined, ...vars }, async () =>
    (await (await sanitizeMcpResponse(new Response(payload, { headers: { 'content-type': 'application/json' } }))).text()).includes('outputSchema'));

  test('新しい名前（1 も真）で outputSchema を残し、旧名 SORA_TOOL_OUTPUT_SCHEMA は読まない', async () => {
    expect(await listed({})).toBe(false);
    expect(await listed({ SORA_MCP_OUTPUT_SCHEMA: '1' })).toBe(true);
    expect(await listed({ SORA_TOOL_OUTPUT_SCHEMA: 'true' })).toBe(false);
  });
});

describe('SORA_LOG_FORMAT', () => {
  const logged = (vars: Record<string, string | undefined>) => withEnv({ SORA_LOG_FORMAT: undefined, LOG_FORMAT: undefined, ...vars }, async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await app.request('/env-names-log-probe');
      return log.mock.calls.some(([line]) => typeof line === 'string' && line.includes('"path":"/env-names-log-probe"'));
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test('json（大文字小文字は問わない）で要求のログを JSON で出し、旧名 LOG_FORMAT は読まない', async () => {
    expect(await logged({})).toBe(false);
    expect(await logged({ SORA_LOG_FORMAT: 'JSON' })).toBe(true);
    expect(await logged({ LOG_FORMAT: 'json' })).toBe(false);
  });
});

describe('PORT・SORA_ALLOWED_HOSTS・SORA_ALLOWED_ORIGINS（Origin の中間層）', () => {
  test('PORT は 1〜65535 の整数。不正な値は既定の 8000、引数のポートが優先', async () => {
    await withEnv({ PORT: '3016' }, () => expect(resolveMcpPort()).toBe(3016));
    for (const raw of ['abc', '3016abc', '0', '70000']) await withEnv({ PORT: raw }, () => expect(resolveMcpPort(), raw).toBe(8000));
    await withEnv({ PORT: '3016' }, () => expect(resolveMcpPort(1234)).toBe(1234));
  });

  test('環境変数の列は、正しい要素を正規化して残し、不正な要素は例外にせず除く（起動時の検査が止める）', async () => {
    await withEnv({ SORA_ALLOWED_HOSTS: ' Sora.Example.com:8443 , bad/entry ', SORA_ALLOWED_ORIGINS: 'https://Sora.Example.com:8443,javascript:x' }, () => {
      const config = resolveMcpOriginConfig();
      expect([...config.allowedHosts]).toEqual(['sora.example.com:8443']);
      expect([...config.allowedOrigins]).toEqual(['https://sora.example.com:8443']);
      expect(config.primaryOrigin).toBe('https://sora.example.com:8443');
      expect(config.allowLoopbackAnyPort).toBe(false);
    });
  });

  test('引数で渡した不正な要素は、これまでどおり例外にする', () => {
    expect(() => resolveMcpOriginConfig({ allowedHosts: ['bad/entry'] })).toThrow('Invalid SORA_ALLOWED_HOSTS entry: bad/entry');
  });
});

describe('認証の旧名は読まない（新しい名前の動きは auth.test.ts）', () => {
  const app = (key?: string) => {
    const a = new Hono();
    a.use('*', createAuthMiddleware(key));
    a.get('/p', (c) => c.json({ ok: true }));
    return a;
  };
  const clean = { SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_LOOPBACK_NO_KEY: undefined, SORA_AUTH_TRUST_PROXY: undefined, SORA_AUTH_DAILY_LIMIT: undefined };

  test('WEB_FETCHER_API_KEY・API_KEY だけでは認証を掛けない（Fail-Open。起動の拒否は起動時の検査）', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const old of ['WEB_FETCHER_API_KEY', 'API_KEY']) {
        await withEnv({ ...clean, [old]: 'old-key' }, async () => expect((await app().request('/p')).status, old).toBe(200));
      }
    } finally {
      warn.mockRestore();
    }
  });

  test('ALLOW_LOCAL_NO_AUTH・TRUST_PROXY・DAILY_REQUEST_LIMIT は効かない', async () => {
    await withEnv({ ...clean, ALLOW_LOCAL_NO_AUTH: 'true' }, async () => {
      expect((await app('secret-test-key').fetch(new Request('http://localhost/p'), { remoteAddr: '127.0.0.1' })).status).toBe(401);
    });
    await withEnv({ ...clean, TRUST_PROXY: 'true' }, () => {
      expect(resolvePeerLocal({ req: { header: (n: string) => (n === 'x-forwarded-for' ? '127.0.0.1' : undefined) }, env: { remoteAddr: '203.0.113.5' } })).toBe(false);
    });
    await withEnv({ ...clean, DAILY_REQUEST_LIMIT: '1' }, async () => {
      const key = `old-limit-${randomUUID()}`;
      for (let i = 0; i < 3; i++) {
        const res = await app(key).request('/p', { headers: { 'X-API-Key': key } });
        expect(res.status).toBe(200);
        expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
      }
    });
  });
});

describe('通知の旧名は読まない（新しい名前の動きは index.test.ts の SSRF 対策）', () => {
  test('ADMIN_ALERT_WEBHOOK_URL だけでは送らない', async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withEnv({ SORA_ALERT_WEBHOOK_URL: undefined, ADMIN_ALERT_WEBHOOK_URL: 'https://93.184.216.34/hooks/alert' }, async () => {
        sendAdminAlert('test', { a: 1 });
        await Bun.sleep(50);
      });
      expect(fetched).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      globalThis.fetch = realFetch;
    }
  });
});

describe('ブラウザ', () => {
  afterAll(closeSharedBrowser);

  const semaphoreMax = (vars: Record<string, string>) => loadTimeResult(
    `import { browserSemaphore } from './src/browser_engine.ts'; console.log('RESULT', browserSemaphore.max);`,
    ['SORA_BROWSER_MAX_CONCURRENCY', 'MAX_CONCURRENT_BROWSERS'],
    vars,
  );

  test('SORA_BROWSER_MAX_CONCURRENCY は読み込み時に読み、50 で頭打ち。旧名 MAX_CONCURRENT_BROWSERS は読まない', async () => {
    const auto = `RESULT ${defaultBrowserConcurrency(detectMemoryLimitBytes())}`;
    expect(await semaphoreMax({ SORA_BROWSER_MAX_CONCURRENCY: '2' })).toBe('RESULT 2');
    expect(await semaphoreMax({ SORA_BROWSER_MAX_CONCURRENCY: '80' })).toBe('RESULT 50');
    expect(await semaphoreMax({ SORA_BROWSER_MAX_CONCURRENCY: 'abc' })).toBe(auto);
    // 旧名には、自動の値と違う値を入れる
    expect(await semaphoreMax({ MAX_CONCURRENT_BROWSERS: auto === 'RESULT 1' ? '2' : '1' })).toBe(auto);
  }, 60_000);

  test('旧名 BROWSER_IDLE_TTL_MS は読まない（0 にしても既定の 300000 のまま）', async () => {
    await withEnv({ SORA_BROWSER_IDLE_TTL_MS: undefined, BROWSER_IDLE_TTL_MS: '0' }, () => expect(browserIdleTtlMs()).toBe(300_000));
  });

  const evaluate = () => handleBrowserSessionAction({ actions: [{ type: 'evaluate', script: '1 + 1' }] });

  test('旧名 ALLOW_BROWSER_EVALUATE だけでは evaluate を許さない（ブラウザを起動せずに断る）', async () => {
    await withEnv({ SORA_BROWSER_ALLOW_EVALUATE: undefined, ALLOW_BROWSER_EVALUATE: 'true' }, async () => {
      const [log] = (await evaluate()).actionLogs;
      expect(log.success).toBe(false);
      expect(log.message).toContain('set SORA_BROWSER_ALLOW_EVALUATE=true to enable');
    });
  });

  test.skipIf(!resolveChromiumPath())('SORA_BROWSER_ALLOW_EVALUATE（1 も真）で evaluate が動く', async () => {
    await withEnv({ SORA_BROWSER_ALLOW_EVALUATE: '1' }, async () => {
      const [log] = (await evaluate()).actionLogs;
      expect(log.success).toBe(true);
    });
  }, 60_000);

  test('CHROME_PATH は前後の空白を除いて読む', async () => {
    await withEnv({ CHROME_PATH: ` ${process.execPath} ` }, () => expect(resolveChromiumPath()).toBe(process.execPath));
  });
});

describe('静的取得', () => {
  test('SORA_FETCH_ALLOW_PRIVATE_NETWORK（1 も真）で SSRF の防御を外し、旧名 ALLOW_LOCAL_FETCH だけでは外さない（安全な側）', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    const hook = `http://127.0.0.1:${server.port}/hook`;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withEnv({ SORA_FETCH_ALLOW_PRIVATE_NETWORK: '1', ALLOW_LOCAL_FETCH: undefined }, async () => {
        expect(await validateHostIpDns('127.0.0.1')).toEqual([]);
        expect(await deliverWebhook(hook, { a: 1 })).toBe(true);
      });
      await withEnv({ SORA_FETCH_ALLOW_PRIVATE_NETWORK: undefined, ALLOW_LOCAL_FETCH: 'true' }, async () => {
        await expect(validateHostIpDns('127.0.0.1')).rejects.toThrow('プライベートネットワーク');
        expect(await deliverWebhook(hook, { a: 1 })).toBe(false);
      });
    } finally {
      warn.mockRestore();
      server.stop(true);
    }
  });

  const referer = (vars: Record<string, string | undefined>) =>
    withEnv({ SORA_FETCH_DEFAULT_REFERER: undefined, SORA_DEFAULT_REFERER: undefined, ...vars }, () => 'Referer' in defaultReferrerHeaders());

  test('SORA_FETCH_DEFAULT_REFERER は既定で有効。off・0・no・false（大文字小文字は問わない）で無効、不正な値は既定（有効）', async () => {
    expect(await referer({})).toBe(true);
    for (const value of ['off', '0', 'no', 'false', 'OFF']) expect(await referer({ SORA_FETCH_DEFAULT_REFERER: value }), value).toBe(false);
    for (const value of ['on', '1', 'abc']) expect(await referer({ SORA_FETCH_DEFAULT_REFERER: value }), value).toBe(true);
  });

  test('旧名 SORA_DEFAULT_REFERER は読まない', async () => {
    expect(await referer({ SORA_DEFAULT_REFERER: 'off' })).toBe(true);
  });

  test('SORA_RS_TRAFILATURA_PATH のコマンドで本文を取り出し、旧名 RS_TRAFILATURA_PATH は読まない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sora-rs-name-'));
    const bin = join(dir, 'rs');
    writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"page_type":"article","content_html":"<p>本文</p>"}'\n`);
    chmodSync(bin, 0o755);
    try {
      const html = '<html><body><p>本文</p></body></html>';
      await withEnv({ SORA_RS_TRAFILATURA_PATH: ` ${bin} `, RS_TRAFILATURA_PATH: undefined }, async () => {
        expect((await extractMainContentWithRs(html, 'https://example.com/a'))?.contentHtml).toBe('<p>本文</p>');
      });
      await withEnv({ SORA_RS_TRAFILATURA_PATH: undefined, RS_TRAFILATURA_PATH: bin }, async () => {
        expect(await extractMainContentWithRs(html, 'https://example.com/a')).toBeUndefined();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('プロキシ（名前は変えない。登録簿から読む）', () => {
  const none = { SORA_PROXY_URL: undefined, SORA_PROXY_LIST: undefined, HTTPS_PROXY: undefined, https_proxy: undefined, HTTP_PROXY: undefined, http_proxy: undefined, ALL_PROXY: undefined, all_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined };

  test('SORA_PROXY_URL は http・https・socks5 の URL（末尾の / は外す）。読めない値は標準の名前に譲る', async () => {
    await withEnv({ ...none, SORA_PROXY_URL: ' socks5://proxy.example.test:1080/ ', HTTPS_PROXY: 'http://std.example.test:3128' }, () => {
      expect(getProxyConfig().proxyServer).toBe('socks5://proxy.example.test:1080');
    });
    await withEnv({ ...none, SORA_PROXY_URL: 'proxy.example.test:1080', HTTPS_PROXY: 'http://std.example.test:3128' }, () => {
      expect(getProxyConfig().proxyServer).toBe('http://std.example.test:3128');
    });
  });

  test('標準の名前は検査しない（scheme の無い host:port も、前後の空白を除いてそのまま）。小文字の綴りも読む', async () => {
    await withEnv({ ...none, http_proxy: ' std.example.test:3128 ', no_proxy: ' localhost,.local ' }, () => {
      expect(getProxyConfig()).toEqual({ proxyServer: 'std.example.test:3128', proxyBypassList: 'localhost,.local' });
    });
  });

  test('SORA_PROXY_LIST は正しい URL だけから選び、正しい URL が無ければ SORA_PROXY_URL に戻る', async () => {
    await withEnv({ ...none, SORA_PROXY_LIST: 'http://p1.example.test:8080, bad entry ,ftp://p2.example.test' }, () => {
      for (let i = 0; i < 10; i++) expect(pickProxyUrl()).toBe('http://p1.example.test:8080');
    });
    await withEnv({ ...none, SORA_PROXY_LIST: 'bad entry', SORA_PROXY_URL: 'http://single.example.test:9090' }, () => {
      expect(pickProxyUrl()).toBe('http://single.example.test:9090');
    });
  });
});

describe('検索', () => {
  test('SORA_SEARCH_SCRAPE_DEADLINE_MS は search_deep の本文取得の既定の締切。0・不正な値と、旧名 SORA_SCRAPE_DEADLINE_MS は既定の 0（打ち切り無し）', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      await Bun.sleep(1000);
      return new Response(`<html><head><title>t</title></head><body><main><h1>${new URL(req.url).pathname}</h1><p>${'本文の段落です。'.repeat(40)}</p></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    } });
    const webSpy = spyOn(yahoo, 'searchYahooWeb');
    const realtimeSpy = spyOn(yahoo, 'searchYahooRealtime').mockResolvedValue({ items: [] } as never);
    let run = 0;
    const cut = (vars: Record<string, string>) => withEnv({ SORA_SEARCH_SCRAPE_DEADLINE_MS: undefined, SORA_SCRAPE_DEADLINE_MS: undefined, SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true', ...vars }, async () => {
      // 締切で打ち切った取得も裏で続いてキャッシュに残るので、回ごとに別の URL にする
      const items = ['a', 'b', 'c'].map((p) => ({ title: p, url: `http://127.0.0.1:${server.port}/${run}/${p}`, snippet: `${p} の抜粋` }));
      run++;
      webSpy.mockResolvedValue({ items, count: items.length } as never);
      const result = await integratedSearch({ query: '締切 確認', limit: 3, includeRealtime: false, noCache: true });
      return (result.results as { deadlineExceeded?: boolean }[]).some((r) => r.deadlineExceeded === true);
    });
    try {
      expect(await cut({ SORA_SEARCH_SCRAPE_DEADLINE_MS: ' 300 ' })).toBe(true);
      for (const value of ['0', '-1', 'abc', '1.5']) expect(await cut({ SORA_SEARCH_SCRAPE_DEADLINE_MS: value }), value).toBe(false);
      expect(await cut({ SORA_SCRAPE_DEADLINE_MS: '300' })).toBe(false);
    } finally {
      webSpy.mockRestore();
      realtimeSpy.mockRestore();
      server.stop(true);
    }
  }, 30_000);
});

describe('Yahoo', () => {
  test('SORA_YAHOO_MCP_PATH は読み込み時に読み、前後の空白を除く。旧名 YAHOO_MCP_PATH は読まない', async () => {
    const path = (vars: Record<string, string>) => loadTimeResult(
      `import { YAHOO_MCP_EXECUTABLE_PATH } from './src/services/yahoo.ts'; console.log('RESULT', YAHOO_MCP_EXECUTABLE_PATH);`,
      ['SORA_YAHOO_MCP_PATH', 'YAHOO_MCP_PATH'],
      vars,
    );
    const auto = await path({});
    expect(auto.startsWith('RESULT '), auto).toBe(true);
    expect(await path({ SORA_YAHOO_MCP_PATH: ' /opt/fake/yahoo-search-mcp ' })).toBe('RESULT /opt/fake/yahoo-search-mcp');
    expect(await path({ YAHOO_MCP_PATH: '/opt/old/yahoo-search-mcp' })).toBe(auto);
  }, 30_000);

  test('SORA_YAHOO_MIN_INTERVAL_MS・SORA_YAHOO_BREAKER_COOLDOWN_MS は 0 以上の整数。不正な値は既定（500・120000）', async () => {
    const read = (value: string | undefined) => withEnv({ SORA_YAHOO_MIN_INTERVAL_MS: value, SORA_YAHOO_BREAKER_COOLDOWN_MS: value }, () => [yahoo.yahooMinIntervalMs(), yahoo.yahooBreakerCooldownMs()]);
    expect(await read(undefined)).toEqual([500, 120_000]);
    expect(await read(' 250 ')).toEqual([250, 250]);
    expect(await read('0')).toEqual([0, 0]);
    for (const value of ['abc', '-1', '1.5', '250ms']) expect(await read(value), value).toEqual([500, 120_000]);
  });
});

describe('X の投稿の詳細（FxTwitter 互換の API）', () => {
  let seq = 0;
  /**
   * vars の環境で provider を作り、環境を戻してから 1 件を取る（構築時に読むことも確かめる）。
   * 呼んだ URL（投稿の ID は <id>）と待ち時間を返す。呼ばなければ undefined。
   */
  async function detailCall(vars: Record<string, string>): Promise<[string, unknown] | undefined> {
    const spy = spyOn(httpFetcher, 'fetchWithSafeRedirects').mockResolvedValue({ finalUrl: '', response: new Response('{}', { status: 404 }) });
    try {
      const provider = await withEnv({ SORA_X_DETAIL_BASE_URL: undefined, SORA_X_DETAIL_TIMEOUT_MS: undefined, SORA_X_DETAIL_PROVIDER: undefined, FXTWITTER_API_BASE: undefined, FXTWITTER_TIMEOUT_MS: undefined, ...vars }, () => new FxTwitterDetailProvider());
      // 取得の結果はキャッシュされうるので、回ごとに別の ID にする
      const statusId = `1900000000000${seq++}`;
      await provider.fetchStatus(statusId);
      const call = spy.mock.calls[0];
      return call && [call[0].replace(statusId, '<id>'), call[1]];
    } finally {
      spy.mockRestore();
    }
  }
  const DEFAULT_CALL: [string, unknown] = ['https://api.fxtwitter.com/2/status/<id>', 1500];

  test('SORA_X_DETAIL_BASE_URL・SORA_X_DETAIL_TIMEOUT_MS は構築時に読む。URL の前後の空白と末尾の / は外す', async () => {
    expect(await detailCall({})).toEqual(DEFAULT_CALL);
    expect(await detailCall({ SORA_X_DETAIL_BASE_URL: ' http://fx.example.test:8080/ ', SORA_X_DETAIL_TIMEOUT_MS: ' 2500 ' })).toEqual(['http://fx.example.test:8080/2/status/<id>', 2500]);
  });

  test('URL でない値・http(s) でない値、1 未満・整数でない待ち時間は既定', async () => {
    for (const value of ['fx.example.test', 'ftp://fx.example.test']) expect(await detailCall({ SORA_X_DETAIL_BASE_URL: value }), value).toEqual(DEFAULT_CALL);
    for (const value of ['0', 'abc', '-5', '1.5']) expect(await detailCall({ SORA_X_DETAIL_TIMEOUT_MS: value }), value).toEqual(DEFAULT_CALL);
  });

  test('旧名 FXTWITTER_API_BASE・FXTWITTER_TIMEOUT_MS は読まない', async () => {
    expect(await detailCall({ FXTWITTER_API_BASE: 'https://old.example.test', FXTWITTER_TIMEOUT_MS: '2500' })).toEqual(DEFAULT_CALL);
  });

  test('SORA_X_DETAIL_PROVIDER は既定で有効。off・false・0・no（大文字小文字は問わない）で無効、不正な値は既定（有効）', async () => {
    for (const value of ['off', 'false', '0', 'no', 'OFF']) expect(await detailCall({ SORA_X_DETAIL_PROVIDER: value }), value).toBeUndefined();
    for (const value of ['on', '1', 'abc']) expect(await detailCall({ SORA_X_DETAIL_PROVIDER: value }), value).toEqual(DEFAULT_CALL);
  });
});

describe('OpenPOI', () => {
  test('SORA_OPENPOI_BASE_URL は前後の空白と末尾の / を外す。空・URL でない値・http(s) でない値は既定', async () => {
    const base = (value: string | undefined) => withEnv({ SORA_OPENPOI_BASE_URL: value }, () => openPoiBaseUrl());
    expect(await base(undefined)).toBe('https://api.openpoiapi.com');
    expect(await base(' https://poi.example.test/ ')).toBe('https://poi.example.test');
    expect(await base('https://poi.example.test//')).toBe('https://poi.example.test');
    for (const value of ['', 'poi.example.test', 'ftp://poi.example.test']) expect(await base(value), value).toBe('https://api.openpoiapi.com');
  });
});

describe('住所（新しい名前の読み方は address_config.test.ts）', () => {
  test('旧名 SORA_ADDRESS だけでは動作モードを変えない（off にしても止まらない。起動の拒否は起動時の検査）', () => {
    expect(addressEnabled({ SORA_ADDRESS: 'off' })).toBe(true);
    expect(loadAddressConfig({ SORA_ADDRESS: 'eager' }, '/data/sora.db').mode).toBe('lazy');
    const timer = startAddressPreload({ SORA_ADDRESS: 'off', SORA_ADDRESS_PRELOAD: '13' }, { delayMs: 3_600_000 });
    expect(timer).not.toBeNull();
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  });
});

describe('HTS', () => {
  test('SORA_HTS_CROSS_SOURCE は local・api（大文字小文字は問わない）。知らない値と、旧名 CROSS_SOURCE は既定の local', async () => {
    const source = (vars: Record<string, string>) => withEnv({ SORA_HTS_CROSS_SOURCE: undefined, CROSS_SOURCE: undefined, ...vars }, () => crossSource());
    expect(await source({})).toBe('local');
    expect(await source({ SORA_HTS_CROSS_SOURCE: ' API ' })).toBe('api');
    expect(await source({ SORA_HTS_CROSS_SOURCE: 'local' })).toBe('local');
    expect(await source({ SORA_HTS_CROSS_SOURCE: 'remote' })).toBe('local');
    expect(await source({ CROSS_SOURCE: 'api' })).toBe('local');
  });

  test('SORA_HTS_DIR は前後の空白を除いて読む', async () => {
    await withEnv({ SORA_HTS_DIR: ' /data/hts-example ' }, () => expect(htsDirectory()).toBe('/data/hts-example'));
  });

  describe('判例の索引（SORA_HTS_CROSS_INDEX_URL・SORA_HTS_CROSS_INDEX_SHA256）', () => {
    const NAMES = { SORA_HTS_CROSS_INDEX_URL: undefined, SORA_HTS_CROSS_INDEX_SHA256: undefined, SORA_CROSS_INDEX_URL: undefined, SORA_CROSS_INDEX_SHA256: undefined, SORA_HTS_DIR: undefined };
    const SHA = 'a'.repeat(64);

    /** 索引の取得を試み、呼んだ URL（fetch は 503 を返す）と、失敗の文を返す。 */
    async function attempt(vars: Record<string, string>): Promise<{ urls: string[]; error: string }> {
      const urls: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request) => {
        urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return new Response('unavailable', { status: 503 });
      }) as typeof fetch;
      resetCrossIndexForTest();
      try {
        const error = await withEnv({ ...NAMES, ...vars }, () => ensureCrossIndex().then(() => 'resolved', (e: unknown) => String(e)));
        return { urls, error };
      } finally {
        globalThis.fetch = original;
        resetCrossIndexForTest();
      }
    }

    test('新しい名前の URL（https・file）から取る', async () => {
      const { urls } = await attempt({ SORA_HTS_CROSS_INDEX_URL: ' https://index.example.test/cross.jsonl.gz ', SORA_HTS_CROSS_INDEX_SHA256: SHA });
      expect(urls).toEqual(['https://index.example.test/cross.jsonl.gz']);
    });

    test('旧名 SORA_CROSS_INDEX_URL・SORA_CROSS_INDEX_SHA256 は読まず、リリースの索引を取る（起動の拒否は起動時の検査）', async () => {
      const { urls } = await attempt({ SORA_CROSS_INDEX_URL: 'https://index.example.test/cross.jsonl.gz', SORA_CROSS_INDEX_SHA256: SHA });
      expect(urls).toEqual([CROSS_INDEX_URL]);
    });

    test('読めない URL（https・file でない）は、リリースの索引に戻さず、取らずに初回の利用で失敗する', async () => {
      for (const value of ['http://index.example.test/cross.jsonl.gz', 'index.example.test/cross.jsonl.gz']) {
        const { urls, error } = await attempt({ SORA_HTS_CROSS_INDEX_URL: value, SORA_HTS_CROSS_INDEX_SHA256: SHA });
        expect(urls, value).toEqual([]);
        expect(error, value).toContain('SORA_HTS_CROSS_INDEX_URL');
      }
    });

    test('URL に SHA-256 が無い・形が違う（大文字・旧名だけ）ときは、取らずに初回の利用で失敗する', async () => {
      for (const vars of [{}, { SORA_HTS_CROSS_INDEX_SHA256: 'A'.repeat(64) }, { SORA_HTS_CROSS_INDEX_SHA256: 'abc' }, { SORA_CROSS_INDEX_SHA256: SHA }] as Record<string, string>[]) {
        const { urls, error } = await attempt({ SORA_HTS_CROSS_INDEX_URL: 'https://index.example.test/cross.jsonl.gz', ...vars });
        expect(urls).toEqual([]);
        expect(error).toContain('SORA_HTS_CROSS_INDEX_SHA256');
      }
    });
  });
});

describe('追跡（運送会社の API の鍵）', () => {
  const ID = 'example-client-id';
  const SECRET = 'example-client-secret';

  test('FedEx は ID と秘密を組で読む。片方だけ（空白だけを含む）は、どちらも無いのと同じ（API を使わずブラウザで照会する）', () => {
    expect(fedexApiCredentials({ SORA_TRACKING_FEDEX_CLIENT_ID: ID, SORA_TRACKING_FEDEX_CLIENT_SECRET: SECRET })).toEqual({ clientId: ID, clientSecret: SECRET });
    expect(fedexApiCredentials({})).toBeUndefined();
    expect(fedexApiCredentials({ SORA_TRACKING_FEDEX_CLIENT_ID: ID })).toBeUndefined();
    expect(fedexApiCredentials({ SORA_TRACKING_FEDEX_CLIENT_SECRET: SECRET })).toBeUndefined();
    expect(fedexApiCredentials({ SORA_TRACKING_FEDEX_CLIENT_ID: ID, SORA_TRACKING_FEDEX_CLIENT_SECRET: '  ' })).toBeUndefined();
  });

  test('FedEx の旧名（FEDEX_API_KEY・FEDEX_API_SECRET と FEDEX_CLIENT_ID・FEDEX_CLIENT_SECRET）は読まず、組をまたいで混ぜない', () => {
    expect(fedexApiCredentials({ FEDEX_API_KEY: 'old-key', FEDEX_API_SECRET: 'old-secret' })).toBeUndefined();
    expect(fedexApiCredentials({ FEDEX_CLIENT_ID: 'old-id', FEDEX_CLIENT_SECRET: 'old-secret' })).toBeUndefined();
    expect(fedexApiCredentials({ FEDEX_API_KEY: 'old-key', FEDEX_CLIENT_SECRET: 'old-secret' })).toBeUndefined();
    // 新しい名前の片方と旧名の片方は、組にならない
    expect(fedexApiCredentials({ SORA_TRACKING_FEDEX_CLIENT_ID: ID, FEDEX_API_SECRET: 'old-secret' })).toBeUndefined();
    expect(fedexApiCredentials({ FEDEX_CLIENT_ID: 'old-id', SORA_TRACKING_FEDEX_CLIENT_SECRET: SECRET })).toBeUndefined();
    expect(fedexApiCredentials({
      SORA_TRACKING_FEDEX_CLIENT_ID: ID, SORA_TRACKING_FEDEX_CLIENT_SECRET: SECRET, FEDEX_API_KEY: 'old-key', FEDEX_CLIENT_SECRET: 'old-secret',
    })).toEqual({ clientId: ID, clientSecret: SECRET });
  });

  test('UPS は SORA_TRACKING_UPS_CLIENT_ID・SORA_TRACKING_UPS_CLIENT_SECRET を組で読み、旧名 UPS_CLIENT_ID・UPS_CLIENT_SECRET は読まない', () => {
    expect(upsApiCredentials({ SORA_TRACKING_UPS_CLIENT_ID: ID, SORA_TRACKING_UPS_CLIENT_SECRET: SECRET })).toEqual({ clientId: ID, clientSecret: SECRET });
    expect(upsApiCredentials({ SORA_TRACKING_UPS_CLIENT_ID: ID })).toBeUndefined();
    expect(upsApiCredentials({ SORA_TRACKING_UPS_CLIENT_SECRET: SECRET })).toBeUndefined();
    expect(upsApiCredentials({ UPS_CLIENT_ID: ID, UPS_CLIENT_SECRET: SECRET })).toBeUndefined();
    expect(upsApiCredentials({ SORA_TRACKING_UPS_CLIENT_ID: ID, UPS_CLIENT_SECRET: SECRET })).toBeUndefined();
    expect(upsApiCredentials({ UPS_CLIENT_ID: ID, SORA_TRACKING_UPS_CLIENT_SECRET: SECRET })).toBeUndefined();
  });

  test('DHL は SORA_TRACKING_DHL_API_KEY だけを読み、旧名 DHL_EXPRESS_API_KEY・DHL_API_KEY は読まない', () => {
    expect(dhlApiKey({ SORA_TRACKING_DHL_API_KEY: 'example-dhl-key' })).toBe('example-dhl-key');
    expect(dhlApiKey({ SORA_TRACKING_DHL_API_KEY: ' ' })).toBeUndefined();
    expect(dhlApiKey({ DHL_EXPRESS_API_KEY: 'old-key', DHL_API_KEY: 'old-key' })).toBeUndefined();
  });

  test('照会は、新しい名前の鍵で API を呼ぶ（API の応答を差し替える。ブラウザは使わない）', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const responses: Record<string, unknown> = {
      'https://onlinetools.ups.com/security/v1/oauth/token': { access_token: 'ups-token' },
      'https://onlinetools.ups.com/api/track/v1/details/1Z999AA10123456784': { trackResponse: { shipment: [{ package: [{ currentStatus: { description: 'Delivered' }, activity: [] }] }] } },
      'https://apis.fedex.com/oauth/token': { access_token: 'fedex-token', expires_in: 3600 },
      'https://apis.fedex.com/track/v1/trackingnumbers': { output: { completeTrackResults: [{ trackResults: [{ latestStatusDetail: { description: 'Delivered' }, scanEvents: [] }] }] } },
      'https://api-eu.dhl.com/track/shipments?trackingNumber=1234567890': { shipments: [{ status: { description: 'Delivered' }, events: [] }] },
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, init });
      return url in responses ? Response.json(responses[url]) : new Response('not stubbed', { status: 500 });
    }) as typeof fetch;
    try {
      await withEnv({
        SORA_TRACKING_UPS_CLIENT_ID: 'ups-id', SORA_TRACKING_UPS_CLIENT_SECRET: 'ups-secret',
        SORA_TRACKING_FEDEX_CLIENT_ID: 'fedex-id', SORA_TRACKING_FEDEX_CLIENT_SECRET: 'fedex-secret',
        SORA_TRACKING_DHL_API_KEY: 'dhl-key',
      }, async () => {
        expect((await upsAdapter.track('1Z999AA10123456784')).status).toBe('delivered');
        expect((await fedexAdapter.track('123456789012')).status).toBe('delivered');
        expect((await dhlAdapter.track('1234567890')).status).toBe('delivered');
      });
      const header = (url: string, name: string) => new Headers(requests.find((r) => r.url === url)?.init?.headers).get(name);
      expect(header('https://onlinetools.ups.com/security/v1/oauth/token', 'Authorization')).toBe(`Basic ${Buffer.from('ups-id:ups-secret').toString('base64')}`);
      const fedexToken = new URLSearchParams(String(requests.find((r) => r.url === 'https://apis.fedex.com/oauth/token')?.init?.body));
      expect([fedexToken.get('client_id'), fedexToken.get('client_secret')]).toEqual(['fedex-id', 'fedex-secret']);
      expect(header('https://api-eu.dhl.com/track/shipments?trackingNumber=1234567890', 'DHL-API-Key')).toBe('dhl-key');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('国・地域の情報', () => {
  const region = { id: 'country:CN', name: 'China', countryCode: 'CN' as string, languages: ['zh'] as string[], aliases: [] as string[], confidence: 'high' as const };
  const input = { request: { region: 'China', includeSocial: true } as never, region, queries: [] };
  const post = (did: string) => ({ uri: `at://${did}/app.bsky.feed.post/abc123`, author: { did, handle: 'user.example' }, record: { text: `post by ${did}`, createdAt: '2026-09-21T00:00:00Z' } });
  /** 投稿を残した DID。 */
  const kept = (vars: Record<string, string>) => withEnv({ SORA_INTEL_BLUESKY_DIDS: undefined, SORA_BLUESKY_DIDS: undefined, ...vars }, async () => {
    const provider = createBlueskyProvider((async () => Response.json({ posts: [post('did:plc:keep'), post('did:plc:other')] })) as never);
    const { items } = await provider.run(input, AbortSignal.timeout(2000));
    return items.map((item) => item.detail?.structuredData?.did);
  });

  test('SORA_INTEL_BLUESKY_DIDS は、その DID の投稿だけを残す。未設定は全員', async () => {
    expect(await kept({})).toEqual(['did:plc:keep', 'did:plc:other']);
    expect(await kept({ SORA_INTEL_BLUESKY_DIDS: ' did:plc:keep , ' })).toEqual(['did:plc:keep']);
  });

  test('不正な要素は除いて、正しい DID で絞る。正しい DID が 1 つも無ければ、全員に開かず、誰の投稿も残さない（起動時の検査が止める）', async () => {
    expect(await kept({ SORA_INTEL_BLUESKY_DIDS: 'did:plc:keep,not-a-did' })).toEqual(['did:plc:keep']);
    expect(await kept({ SORA_INTEL_BLUESKY_DIDS: 'not-a-did' })).toEqual([]);
  });

  test('旧名 SORA_BLUESKY_DIDS は読まない', async () => {
    expect(await kept({ SORA_BLUESKY_DIDS: 'did:plc:keep' })).toEqual(['did:plc:keep', 'did:plc:other']);
  });

  test('SORA_INTEL_DISABLED は取得先の ID の列。不正な要素（大文字など）は除く', async () => {
    const disabled = (value: string) => withEnv({ SORA_INTEL_DISABLED: value }, () => [...disabledCountryIntelProviders()].sort());
    expect(await disabled(' usgs, eonet,,usgs ')).toEqual(['eonet', 'usgs']);
    expect(await disabled('USGS,eonet')).toEqual(['eonet']);
    // 引数の上書きは、環境変数より優先する
    await withEnv({ SORA_INTEL_DISABLED: 'usgs' }, () => expect([...disabledCountryIntelProviders([' gdacs '])]).toEqual(['gdacs']));
  });

  test('SORA_INTEL_SCRAPE は既定で有効。off・false・0・no（大文字小文字は問わない）で本文の取得を止め、不正な値は既定（有効）', async () => {
    const scrape = (value: string | undefined) => withEnv({ SORA_INTEL_SCRAPE: value }, () => typeof createDefaultCountryIntelDependencies().scrapeArticle);
    expect(await scrape(undefined)).toBe('function');
    for (const value of ['off', 'false', '0', 'no', 'OFF']) expect(await scrape(value), value).toBe('undefined');
    for (const value of ['on', '1', 'abc']) expect(await scrape(value), value).toBe('function');
  });
});
