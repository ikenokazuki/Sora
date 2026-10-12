import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { scrapeUrl } from '../scraper.js';
import { clearCache } from '../cache.js';
import { dbGetTenantCookies, dbSaveTenantCookies, dbGetTenantStorage } from '../db.js';
import { closeHttpSession, credentialScopeFor, sessionKey } from '../http_fetcher.js';
import { fetchWithStealthBrowser } from '../browser_stealth.js';
import { resolveChromiumPath } from '../browser_engine.js';

// 認証付きで取得したときの Cookie が、資格情報なしの別リクエスト・別テナントへ引き継がれないこと。
// 以前は (1) ブラウザ経路が Cookie を常に 'legacy' テナントへ保存し、(2) 静的取得が Set-Cookie を共有ジャーに残して、
// ログイン済みの内容が共有キャッシュ経由で他のテナントに見えていた。

const HOST = '127.0.0.1';
const ALICE = 'key:cred-iso-alice';
const BOB = 'key:cred-iso-bob';
const CAROL = 'key:cred-iso-carol';

let prevAllow: string | undefined;

/** 認証済みなら Alice 専用の内容、そうでなければゲスト向けの内容を返す。認証済みリクエストにはセッション Cookie を再発行する。 */
function startAccountServer() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const cookie = req.headers.get('cookie') ?? '';
      const loggedIn = cookie.includes('auth=secret') || cookie.includes('sid=SESSION-OF-ALICE');
      const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
      if (cookie.includes('auth=secret')) headers.append('set-cookie', 'sid=SESSION-OF-ALICE; Path=/');
      const body = (loggedIn ? 'Welcome back Alice. Your private invoice total is 123456 yen. ' : 'Welcome guest. Please log in to see your invoices. ')
        + 'This sentence only makes the page long enough to be treated as real content. '.repeat(12);
      return new Response(`<html><head><title>Account</title></head><body><main><p>${body}</p></main></body></html>`, { headers });
    },
  });
}

const aliceCookie = [{ name: 'auth', value: 'secret', domain: HOST }] as any;

function cookieNames(tenant: string): string[] {
  return (dbGetTenantCookies(tenant, HOST) ?? []).map((c) => c.name);
}

beforeAll(() => {
  prevAllow = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
});

afterAll(() => {
  if (prevAllow !== undefined) process.env.ALLOW_LOCAL_FETCH = prevAllow;
  else delete process.env.ALLOW_LOCAL_FETCH;
});

afterEach(async () => {
  clearCache();
  for (const tenant of [ALICE, BOB, CAROL]) {
    await closeHttpSession(HOST, tenant, credentialScopeFor(undefined, aliceCookie));
    await closeHttpSession(HOST, tenant);
    dbSaveTenantCookies(tenant, HOST, []);
  }
});

describe('credentialScopeFor / sessionKey', () => {
  test('資格情報が無ければ undefined（通常セッションを使う）', () => {
    expect(credentialScopeFor(undefined, undefined)).toBeUndefined();
    expect(credentialScopeFor({ Accept: 'text/html', Referer: 'https://example.com/' }, [])).toBeUndefined();
  });

  test('同じ資格情報は同じ分離キー、違う資格情報は違うキー（ヘッダー名の大文字小文字は区別しない）', () => {
    const a1 = credentialScopeFor({ Authorization: 'Bearer A' });
    const a2 = credentialScopeFor({ authorization: 'Bearer A', Accept: 'text/html' });
    const b = credentialScopeFor({ Authorization: 'Bearer B' });
    expect(a1).toBeDefined();
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(credentialScopeFor(undefined, [{ name: 'auth', value: 'x' }])).not.toBe(credentialScopeFor(undefined, [{ name: 'auth', value: 'y' }]));
  });

  test('分離キーに資格情報の値そのものを含めない', () => {
    const scope = credentialScopeFor({ Authorization: 'Bearer super-secret-token' }, [{ name: 'sid', value: 'cookie-secret-value' }]);
    expect(scope).toBeDefined();
    expect(scope).not.toContain('super-secret-token');
    expect(scope).not.toContain('cookie-secret-value');
  });

  test('scope を付けたセッションキーは通常のキーと別になり、通常のキー形式は変わらない', () => {
    expect(sessionKey('a', 'Example.COM')).toBe('a:example.com');
    const scoped = sessionKey('a', 'example.com', 'cred-1');
    expect(scoped).not.toBe(sessionKey('a', 'example.com'));
    expect(scoped).toBe('a:example.com#cred-1');
  });
});

describe('静的取得: 認証で得た Set-Cookie を、資格情報なしのリクエストへ引き継がない', () => {
  test('同じテナントの資格情報なしリクエストはゲスト向けの内容を受け取る', async () => {
    const server = startAccountServer();
    const url = `http://${HOST}:${server.port}/account`;
    try {
      const authed = await scrapeUrl({ url, mode: 'fast', cookies: aliceCookie, tenantId: ALICE });
      expect(authed.content).toContain('Welcome back Alice');

      const anonymous = await scrapeUrl({ url, mode: 'fast', tenantId: ALICE });
      expect(anonymous.content).toContain('Welcome guest');
      expect(anonymous.content).not.toContain('private invoice');
    } finally {
      server.stop(true);
    }
  });

  test('別テナントが共有キャッシュ経由でログイン済みの内容を受け取らない', async () => {
    const server = startAccountServer();
    const url = `http://${HOST}:${server.port}/account`;
    try {
      await scrapeUrl({ url, mode: 'fast', cookies: aliceCookie, tenantId: ALICE });
      await scrapeUrl({ url, mode: 'fast', tenantId: ALICE }); // 以前はここでログイン済みの内容が共有キャッシュに入った

      const bob = await scrapeUrl({ url, mode: 'fast', tenantId: BOB });
      expect(bob.content).toContain('Welcome guest');
      expect(bob.content).not.toContain('private invoice');
    } finally {
      server.stop(true);
    }
  });

  test('同じ資格情報での連続リクエストは、専用セッションの Cookie を引き継げる（ログイン状態を保てる）', async () => {
    const server = startAccountServer();
    const url = `http://${HOST}:${server.port}/account`;
    try {
      const first = await scrapeUrl({ url, mode: 'fast', cookies: aliceCookie, tenantId: ALICE, noCache: true });
      const second = await scrapeUrl({ url, mode: 'fast', cookies: aliceCookie, tenantId: ALICE, noCache: true });
      expect(first.content).toContain('Welcome back Alice');
      expect(second.content).toContain('Welcome back Alice');
    } finally {
      server.stop(true);
    }
  });

  test('資格情報付きセッションは Cookie を永続化せず、通常セッションは自分のテナントへ永続化する', async () => {
    let issueClearance = true;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const cookie = req.headers.get('cookie') ?? '';
        const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
        if (cookie.includes('auth=secret')) headers.append('set-cookie', 'sid=SESSION-OF-ALICE; Path=/; Max-Age=3600');
        else if (issueClearance) headers.append('set-cookie', 'clearance=ok; Path=/; Max-Age=3600');
        return new Response(`<html><head><title>t</title></head><body><main><p>${'persistence check body text. '.repeat(20)}</p></main></body></html>`, { headers });
      },
    });
    const url = `http://${HOST}:${server.port}/p`;
    try {
      await scrapeUrl({ url, mode: 'fast', cookies: aliceCookie, tenantId: ALICE, noCache: true });
      await closeHttpSession(HOST, ALICE, credentialScopeFor(undefined, aliceCookie));
      expect(cookieNames(ALICE)).not.toContain('sid');
      expect(cookieNames('legacy')).not.toContain('sid');

      await scrapeUrl({ url, mode: 'fast', tenantId: CAROL, noCache: true });
      await closeHttpSession(HOST, CAROL);
      expect(cookieNames(CAROL)).toContain('clearance');
      expect(cookieNames('legacy')).not.toContain('clearance');
    } finally {
      issueClearance = false;
      server.stop(true);
    }
  });
});

describe.skipIf(!resolveChromiumPath())('ブラウザ経路: Cookie をテナント別に保存し、資格情報付きの取得では保存しない', () => {
  test('呼び出し側が渡した Cookie は legacy にも自分のテナントにも保存されず、匿名リクエストに見えない', async () => {
    const server = startAccountServer();
    const url = `http://${HOST}:${server.port}/account`;
    try {
      const authed = await fetchWithStealthBrowser(url, 20000, undefined, aliceCookie, 'networkidle2', false, true, ALICE);
      expect(authed.html).toContain('Welcome back Alice');
      expect(cookieNames('legacy')).not.toContain('auth');
      expect(cookieNames(ALICE)).not.toContain('auth');
      expect(dbGetTenantStorage(ALICE, HOST) ?? {}).toEqual({});

      const anonymous = await fetchWithStealthBrowser(url, 20000, undefined, undefined, 'networkidle2', false, true, 'legacy');
      expect(anonymous.html).toContain('Welcome guest');
      expect(anonymous.html).not.toContain('private invoice');
    } finally {
      server.stop(true);
    }
  }, 60000);

  test('資格情報なしの取得で得た Cookie は、取得したテナントへ保存され legacy へは漏れない', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(`<html><head><title>t</title></head><body><main><p>${'tenant scoped cookie body text. '.repeat(20)}</p></main></body></html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'clearance=ok; Path=/; Max-Age=3600' },
        });
      },
    });
    const url = `http://${HOST}:${server.port}/p`;
    try {
      await fetchWithStealthBrowser(url, 20000, undefined, undefined, 'networkidle2', false, true, CAROL);
      expect(cookieNames(CAROL)).toContain('clearance');
      expect(cookieNames('legacy')).not.toContain('clearance');
    } finally {
      server.stop(true);
    }
  }, 60000);
});
