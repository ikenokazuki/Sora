import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { clearCache, getFromCache, setToCache } from '../cache.js';
import { app as soraApp } from '../index.js';
import { getSecurityMetrics, resetSecurityMetrics } from './metrics.js';
import { createRestOriginPolicy, isBrowserRequest } from './rest_origin.js';

// REST の信頼境界。以前は MCP だけが Host と Origin を検査し、REST 全体は CORS が `*` だった。そのため手元で動かすサーバーに対して、
// 別サイトのページの fetch と DNS rebinding で、監視設定の読み取り・キャッシュの消去・利用者の回線を使った取得ができた。

function buildApp(options?: Parameters<typeof createRestOriginPolicy>[0]) {
  const policy = createRestOriginPolicy({ port: 8000, ...options });
  const state = { hits: 0 };
  const app = new Hono();
  app.use('*', policy.guard);
  app.use('*', cors({ origin: policy.corsOrigin, allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'] }));
  app.all('/scrape', (c) => { state.hits++; return c.json({ ok: true }); });
  app.all('/health', (c) => c.json({ ok: true }));
  app.all('/mcp', (c) => c.json({ ok: true }));
  return { app, state };
}

/** ブラウザが付けるヘッダー。Origin と Sec-Fetch-* はページ上のスクリプトから書き換えられない */
const browser = (site: 'cross-site' | 'same-site' | 'same-origin' | 'none', headers: Record<string, string> = {}) =>
  ({ 'sec-fetch-site': site, 'sec-fetch-mode': site === 'none' ? 'navigate' : 'cors', ...headers });

const send = (app: Hono, path: string, method: string, headers: Record<string, string>) =>
  app.request(path, { method, headers });

afterEach(() => {
  resetSecurityMetrics();
});

describe('isBrowserRequest', () => {
  test('Origin があるか、Sec-Fetch-Site が none 以外ならブラウザの要求', () => {
    expect(isBrowserRequest('https://a.example', undefined)).toBe(true);
    for (const site of ['cross-site', 'same-site', 'same-origin']) expect(isBrowserRequest(undefined, site)).toBe(true);
  });

  test('どちらも無い（curl・サーバー間通信）、空の Origin、利用者が直接開いた none はブラウザの要求ではない', () => {
    expect(isBrowserRequest(undefined, undefined)).toBe(false);
    expect(isBrowserRequest('', undefined)).toBe(false);
    expect(isBrowserRequest(undefined, 'none')).toBe(false);
  });
});

describe('既定の構成（SORA_ALLOWED_HOSTS・SORA_ALLOWED_ORIGINS 未設定）', () => {
  test('ブラウザを介さない要求は、Host が何でも従来どおり通る', async () => {
    const { app } = buildApp();
    for (const host of ['localhost:8000', 'evil.example', '192.168.1.10:3016', 'sora.internal']) {
      const res = await send(app, '/scrape', 'POST', { host, 'user-agent': 'curl/8.0' });
      expect(res.status, host).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('別サイトのページからの fetch は 403。ハンドラーは実行されず、CORS ヘッダーも付かない', async () => {
    const { app, state } = buildApp();
    const res = await send(app, '/scrape', 'POST', { host: 'localhost:8000', origin: 'https://evil.example', ...browser('cross-site') });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED', status: 403, retryable: false });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(state.hits).toBe(0);
    expect(getSecurityMetrics().sora_rest_origin_rejected_total).toBe(1);
  });

  test('別サイトからのプリフライトも 403（許可するヘッダーを返さない）', async () => {
    const { app } = buildApp();
    const res = await send(app, '/scrape', 'OPTIONS', {
      host: 'localhost:8000',
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
      ...browser('cross-site'),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
  });

  test('他サイトが埋め込んだ <img>・リンク遷移（Origin なしの cross-site）も 403', async () => {
    const { app, state } = buildApp();
    const image = await send(app, '/scrape', 'GET', { host: 'localhost:8000', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' });
    const link = await send(app, '/scrape', 'GET', { host: 'localhost:8000', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    expect([image.status, link.status]).toEqual([403, 403]);
    expect(state.hits).toBe(0);
  });

  test('DNS rebinding（攻撃者のドメインが 127.0.0.1 に解決される）は、同一オリジンに見えても Host で 403', async () => {
    const { app, state } = buildApp();
    const post = await send(app, '/scrape', 'POST', { host: 'evil.example:8000', origin: 'http://evil.example:8000', ...browser('same-origin') });
    const get = await send(app, '/scrape', 'GET', { host: 'evil.example:8000', ...browser('same-origin') });
    expect([post.status, get.status]).toEqual([403, 403]);
    expect(await post.json()).toMatchObject({ code: 'HOST_NOT_ALLOWED' });
    expect(state.hits).toBe(0);
  });

  test('利用者がアドレスバーから直接開いた要求（Sec-Fetch-Site: none）は、LAN の IP でも通る', async () => {
    const { app } = buildApp();
    const res = await send(app, '/scrape', 'GET', { host: '192.168.1.10:3016', ...browser('none') });
    expect(res.status).toBe(200);
  });

  test('ポートを割り当てた構成（-p 3016:8000）の同一オリジン呼び出し（/docs・/swagger の「試す」）は通る', async () => {
    const { app } = buildApp();
    const res = await send(app, '/scrape', 'POST', { host: 'localhost:3016', origin: 'http://localhost:3016', ...browser('same-origin') });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3016');
  });

  test('手元の別ポートのページ（例: 開発サーバー）は、許可するまで 403', async () => {
    const { app } = buildApp();
    const res = await send(app, '/scrape', 'POST', { host: 'localhost:3016', origin: 'http://localhost:5173', ...browser('same-site') });
    expect(res.status).toBe(403);
    const hint = ((await res.json()) as { hint: string }).hint;
    expect(hint).toContain('SORA_ALLOWED_ORIGINS');
  });

  test('null・複数・不正な Origin は 403', async () => {
    const { app } = buildApp();
    for (const origin of ['null', 'https://a.example, https://b.example', 'not-a-url', 'ftp://localhost']) {
      const res = await send(app, '/scrape', 'POST', { host: 'localhost:8000', origin, ...browser('cross-site') });
      expect(res.status, origin).toBe(403);
    }
  });

  test('公開経路（/health など）は、どの Origin からでも読める（従来どおり `*`）', async () => {
    const { app } = buildApp();
    const get = await send(app, '/health', 'GET', { host: 'evil.example', origin: 'https://evil.example', ...browser('cross-site') });
    expect(get.status).toBe(200);
    expect(get.headers.get('access-control-allow-origin')).toBe('*');
    const preflight = await send(app, '/health', 'OPTIONS', { host: 'evil.example', origin: 'https://evil.example', 'access-control-request-method': 'GET', ...browser('cross-site') });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('MCP の経路は REST の検査を通さない（mcp_origin.ts が別に検査する）', async () => {
    const { app } = buildApp();
    const res = await send(app, '/mcp', 'POST', { host: 'evil.example', origin: 'https://evil.example', ...browser('cross-site') });
    expect(res.status).toBe(200);
    expect(getSecurityMetrics().sora_rest_origin_rejected_total).toBeUndefined();
  });
});

describe('許可リストを設定した構成', () => {
  test('SORA_ALLOWED_ORIGINS に入れたページは通り、その Origin だけが CORS で返る。プリフライトも通る', async () => {
    const { app } = buildApp({ allowedOrigins: ['http://localhost:5173'] });
    const res = await send(app, '/scrape', 'POST', { host: 'localhost:3016', origin: 'http://localhost:5173', ...browser('same-site') });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('vary')).toContain('Origin');

    const preflight = await send(app, '/scrape', 'OPTIONS', {
      host: 'localhost:3016',
      origin: 'http://localhost:5173',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
      ...browser('same-site'),
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');

    const other = await send(app, '/scrape', 'POST', { host: 'localhost:3016', origin: 'https://evil.example', ...browser('cross-site') });
    expect(other.status).toBe(403);
  });

  test('SORA_ALLOWED_HOSTS を設定すると、書いた Host だけをブラウザ由来の要求に許す（ポート込みで厳密）', async () => {
    const { app } = buildApp({ allowedHosts: ['api.example.com'], allowedOrigins: ['https://app.example.com'] });
    const own = await send(app, '/scrape', 'POST', { host: 'api.example.com', origin: 'https://api.example.com', ...browser('same-origin') });
    expect(own.status).toBe(200);
    const app2 = await send(app, '/scrape', 'POST', { host: 'api.example.com', origin: 'https://app.example.com', ...browser('cross-site') });
    expect(app2.status).toBe(200);
    expect(app2.headers.get('access-control-allow-origin')).toBe('https://app.example.com');

    const local = await send(app, '/scrape', 'POST', { host: 'localhost:8000', origin: 'http://localhost:8000', ...browser('same-origin') });
    expect(local.status).toBe(403);
    expect(await local.json()).toMatchObject({ code: 'HOST_NOT_ALLOWED' });
    const other = await send(app, '/scrape', 'POST', { host: 'api.example.com:8443', origin: 'https://api.example.com:8443', ...browser('same-origin') });
    expect(other.status).toBe(403);

    // ブラウザを介さない要求は、Host を設定していても従来どおり通る
    const curl = await send(app, '/scrape', 'POST', { host: 'localhost:8000' });
    expect(curl.status).toBe(200);
  });
});

describe('実際のアプリ（index.ts）', () => {
  const attacker = (path: string, method: string, headers: Record<string, string> = {}) =>
    soraApp.request(path, { method, headers: { host: 'localhost:8000', origin: 'https://evil.example', ...browser('cross-site'), ...headers } });

  test('別サイトのページから、監視設定の読み取りも、プリフライトも通らない（以前は 200・204 と ACAO: *）', async () => {
    const read = await attacker('/watch/list', 'GET');
    expect(read.status).toBe(403);
    expect(read.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await attacker('/watch/list', 'OPTIONS', { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' });
    expect(preflight.status).toBe(403);
  });

  test('DNS rebinding の POST /cache/clear は実行されない。ブラウザを介さない同じ要求は従来どおり実行される', async () => {
    setToCache('rest-origin:test', { value: 1 });
    const rebinding = await soraApp.request('/cache/clear', {
      method: 'POST',
      headers: { host: 'evil.example:8000', origin: 'http://evil.example:8000', ...browser('same-origin') },
    });
    expect(rebinding.status).toBe(403);
    expect(getFromCache('rest-origin:test')).not.toBeNull();

    const curl = await soraApp.request('/cache/clear', { method: 'POST', headers: { host: 'localhost:8000' } });
    expect(curl.status).toBe(200);
    expect(getFromCache('rest-origin:test')).toBeNull();
    clearCache();
  });

  test('正しい API キーを付けても、許可されていない Origin のブラウザ要求は 403（検査は認証より先）', async () => {
    const previous = process.env.WEB_FETCHER_API_KEY;
    process.env.WEB_FETCHER_API_KEY = 'rest-origin-test-key';
    try {
      const res = await attacker('/watch/list', 'GET', { authorization: 'Bearer rest-origin-test-key' });
      expect(res.status).toBe(403);
      const direct = await soraApp.request('/watch/list', { headers: { host: 'localhost:8000', authorization: 'Bearer rest-origin-test-key' } });
      expect(direct.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.WEB_FETCHER_API_KEY;
      else process.env.WEB_FETCHER_API_KEY = previous;
    }
  });

  test('ブラウザを介さない REST、同一オリジンの /docs からの呼び出し、公開経路は従来どおり', async () => {
    expect((await soraApp.request('/watch/list', { headers: { host: 'localhost:8000' } })).status).toBe(200);
    expect((await soraApp.request('/watch/list', { headers: { host: 'sora.internal:3016', 'user-agent': 'curl/8.0' } })).status).toBe(200);

    const docs = await soraApp.request('/watch/list', { headers: { host: 'localhost:3016', origin: 'http://localhost:3016', ...browser('same-origin') } });
    expect(docs.status).toBe(200);

    const health = await attacker('/health', 'GET');
    expect(health.status).toBe(200);
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
  });
});
