import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createAuthMiddleware } from './auth.js';
import { browserRoutes } from './routes/browser.js';
import * as scraper from './scraper.js';
import { ApiKeyStore, parseApiKeyFile, resetApiKeyStoreCache } from './security/api_keys.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { removedSettings, withEnv } from './test_fixtures/env.js';

/**
 * 鍵ファイル（SORA_AUTH_KEYS_FILE）での認証: 鍵ごとに別の tenant（`name:<name>`）。匿名は認めない（設計 4）。
 * 回数は DB に残るので、日次の上限の試験は、呼ぶたびに新しい name にする。
 */

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-auth-keys-'));
  resetApiKeyStoreCache();
  resetSecurityMetrics();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetApiKeyStoreCache();
});

function keyFile(keys: unknown[], mode = 0o600): string {
  const path = join(dir, `keys-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ keys }), { mode });
  chmodSync(path, mode);
  return path;
}

const clean = { SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_DAILY_LIMIT: undefined };
const app = () => {
  const a = new Hono();
  a.use('*', createAuthMiddleware());
  a.get('/p', (c) => c.json({ tenant: c.get('tenant') }));
  a.get('/health', (c) => c.json({ ok: true }));
  return a;
};
const get = (headers: Record<string, string> = {}, remoteAddr: string | null = null) => app().fetch(new Request('http://localhost/p', { headers }), { remoteAddr });
const tenantOf = async (res: Response) => ((await res.json()) as { tenant: { tenantId: string; authMode: string; name?: string } }).tenant;

describe('鍵ファイルでの認証', () => {
  test('鍵ごとに別の tenant（name:<name>）。X-API-Key でも、Bearer の大文字小文字違いでも同じ。ハッシュの鍵も引ける', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }, { name: 'bob', keyHash: `sha256:${sha('bob-key-0123456789abcdefgh')}` }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      const sameKey: Record<string, string>[] = [
        { 'X-API-Key': 'alice-key-0123456789abcdef' },
        { Authorization: 'Bearer alice-key-0123456789abcdef' },
        { Authorization: 'bearer alice-key-0123456789abcdef' },
        { Authorization: 'BEARER alice-key-0123456789abcdef' },
      ];
      for (const headers of sameKey) {
        const res = await get(headers);
        expect(res.status, JSON.stringify(headers)).toBe(200);
        expect(await tenantOf(res)).toMatchObject({ tenantId: 'name:alice', authMode: 'api_key', name: 'alice' });
      }
      const bob = await get({ 'X-API-Key': 'bob-key-0123456789abcdefgh' });
      expect(bob.status).toBe(200);
      expect(await tenantOf(bob)).toMatchObject({ tenantId: 'name:bob', name: 'bob' });
    });
  });

  test('tenant の ID は、鍵の値を含まない（鍵を入れ替えても同じ）', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }, { name: 'alice', key: 'alice-second-key-0123456789' }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      const first = await tenantOf(await get({ 'X-API-Key': 'alice-key-0123456789abcdef' }));
      const second = await tenantOf(await get({ 'X-API-Key': 'alice-second-key-0123456789' }));
      expect(first.tenantId).toBe('name:alice');
      expect(second.tenantId).toBe('name:alice');
      expect(JSON.stringify(first)).not.toContain('alice-key');
    });
  });

  test('知らない鍵・誤った鍵・鍵なし・空の鍵は 401（標準の本文）。誤った Bearer と正しい X-API-Key の併用も 401', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      const rejected: Record<string, string>[] = [
        {},
        { 'X-API-Key': 'unknown-key-0123456789abcdef' },
        { Authorization: 'Bearer unknown-key-0123456789abcdef' },
        { Authorization: 'Bearer ' },
        { 'X-API-Key': '' },
        { Authorization: 'bearer wrong', 'X-API-Key': 'alice-key-0123456789abcdef' },
        { 'X-API-Key': 'alice-key-0123456789abcde' },
        { 'X-API-Key': 'ALICE-KEY-0123456789ABCDEF' },
      ];
      for (const headers of rejected) {
        const res = await get(headers);
        expect(res.status, JSON.stringify(headers)).toBe(401);
        expect(await res.json()).toMatchObject({ code: 'UNAUTHORIZED', status: 401, retryable: false, message: 'Please provide a valid API key via Authorization: Bearer <key> or X-API-Key header.' });
      }
    });
  });

  test('匿名は認めない: SORA_ALLOW_ANONYMOUS=true でも 401', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path, SORA_ALLOW_ANONYMOUS: 'true' }, async () => {
      expect((await get()).status).toBe(401);
      expect((await get({ Authorization: 'Bearer junk-token-0123456789' })).status).toBe(401);
    });
  });

  test('公開の経路（/health など）は、認証なしで開く', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      const res = await app().fetch(new Request('http://localhost/health'), { remoteAddr: null });
      expect(res.status).toBe(200);
    });
  });

  test('ループバックからでも、鍵が要る（鍵なしの通過は、v5 で廃止した。旧い設定が残っていても効かない）。鍵があれば、ループバックでも鍵の tenant', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path, ...removedSettings() }, async () => {
      for (const remoteAddr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', null]) {
        expect((await get({}, remoteAddr)).status, String(remoteAddr)).toBe(401);
      }
      // 接続元を示すヘッダーも、認証の代わりにならない
      const peerHeaders: Record<string, string>[] = [{ 'X-Forwarded-For': '127.0.0.1' }, { 'X-Forwarded-For': '203.0.113.9, 127.0.0.1' }, { 'X-Real-IP': '127.0.0.1' }];
      for (const headers of peerHeaders) {
        expect((await get(headers, '127.0.0.1')).status, JSON.stringify(headers)).toBe(401);
      }
      const keyed = await get({ 'X-API-Key': 'alice-key-0123456789abcdef' }, '127.0.0.1');
      expect(await tenantOf(keyed)).toMatchObject({ tenantId: 'name:alice', authMode: 'api_key' });
    });
  });

  test('日次の上限は、tenant ごとに数える（同じ tenant の 2 つの鍵は合算。別の tenant は別）', async () => {
    const [alice, bob] = [`limit-${randomUUID().slice(0, 8)}`, `limit-${randomUUID().slice(0, 8)}`];
    const path = keyFile([
      { name: alice, key: 'alice-key-0123456789abcdef' },
      { name: alice, key: 'alice-second-key-0123456789' },
      { name: bob, key: 'bob-key-0123456789abcdefgh' },
    ]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path, SORA_AUTH_DAILY_LIMIT: '2' }, async () => {
      expect((await get({ 'X-API-Key': 'alice-key-0123456789abcdef' })).status).toBe(200);
      expect((await get({ 'X-API-Key': 'alice-second-key-0123456789' })).status).toBe(200);
      const over = await get({ 'X-API-Key': 'alice-key-0123456789abcdef' });
      expect(over.status).toBe(429);
      expect(over.headers.get('X-RateLimit-Limit')).toBe('2');
      expect(await over.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', limit: 2, current: 3 });
      expect((await get({ 'X-API-Key': 'bob-key-0123456789abcdefgh' })).status).toBe(200);
    });
  });

  test('拒否の回数を数える（鍵なしと、誤った鍵を分ける）', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      await get();
      await get({ 'X-API-Key': 'wrong-key-0123456789abcdef' });
      await get({ Authorization: 'Bearer wrong-key-0123456789abcdef' });
      await get({ 'X-API-Key': 'alice-key-0123456789abcdef' });
    });
    expect(getSecurityMetrics()).toMatchObject({ sora_auth_rejected_missing_total: 1, sora_auth_rejected_invalid_total: 2 });
  });

  test('単一の鍵（SORA_API_KEY）の拒否も、同じ名前で数える', async () => {
    const single = new Hono();
    single.use('*', createAuthMiddleware('single-key-0123456789'));
    single.get('/p', (c) => c.json({ ok: true }));
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: undefined }, async () => {
      await single.request('/p');
      await single.request('/p', { headers: { 'X-API-Key': 'wrong' } });
    });
    expect(getSecurityMetrics()).toMatchObject({ sora_auth_rejected_missing_total: 1, sora_auth_rejected_invalid_total: 1 });
  });

  test('鍵ファイルを読めないときは、すべての要求を 503 で断る（匿名にも、鍵なしの通過にもしない）。理由は 1 回だけログに出す', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: join(dir, 'missing.json'), SORA_ALLOW_ANONYMOUS: 'true' }, async () => {
        for (const [headers, remoteAddr] of [[{}, '127.0.0.1'], [{ 'X-API-Key': 'alice-key-0123456789abcdef' }, null], [{}, '203.0.113.5']] as [Record<string, string>, string | null][]) {
          const res = await get(headers, remoteAddr);
          expect(res.status, JSON.stringify(headers)).toBe(503);
          expect(await res.json()).toMatchObject({ code: 'AUTH_UNAVAILABLE', status: 503, retryable: false });
        }
        const health = await app().fetch(new Request('http://localhost/health'), { remoteAddr: null });
        expect(health.status).toBe(200);
      });
      const lines = error.mock.calls.map((call) => call.map(String).join(' '));
      expect(lines.filter((line) => line.includes('ENOENT'))).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test('createAuthMiddleware に鍵を直接渡したとき（テスト用）は、その鍵が先。環境の鍵ファイルは見ない', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }]);
    const direct = new Hono();
    direct.use('*', createAuthMiddleware('direct-key-0123456789'));
    direct.get('/p', (c) => c.json({ tenant: c.get('tenant') }));
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      expect((await direct.request('/p', { headers: { 'X-API-Key': 'direct-key-0123456789' } })).status).toBe(200);
      expect((await direct.request('/p', { headers: { 'X-API-Key': 'alice-key-0123456789abcdef' } })).status).toBe(401);
    });
  });

  test('ブラウザセッションの持ち主は、名前つきの鍵では tenant に任せる（鍵の値を持ち主にしない。同じ tenant の別の鍵でも続けられる）', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }, { name: 'alice', key: 'alice-second-key-0123456789' }]);
    const spy = spyOn(scraper, 'executeBrowserActions').mockResolvedValue({ success: true, url: 'http://127.0.0.1/' } as never);
    const browser = new Hono();
    browser.use('*', createAuthMiddleware());
    browser.route('/', browserRoutes);
    const post = (headers: Record<string, string>) =>
      browser.fetch(new Request('http://localhost/browser/action', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ sessionId: 'sess_x', actions: [] }) }), { remoteAddr: null });
    try {
      await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
        expect((await post({ 'X-API-Key': 'alice-key-0123456789abcdef' })).status).toBe(200);
        expect((await post({ Authorization: 'Bearer alice-second-key-0123456789' })).status).toBe(200);
      });
      expect(spy.mock.calls.map(([options]) => [options.tenantId, options.ownerToken])).toEqual([['name:alice', undefined], ['name:alice', undefined]]);
      // 単一の鍵では、従来どおり、鍵の値が持ち主の確認に使われる
      spy.mockClear();
      await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: undefined, SORA_API_KEY: 'single-key-0123456789' }, async () => {
        expect((await post({ 'X-API-Key': 'single-key-0123456789' })).status).toBe(200);
      });
      expect(spy.mock.calls[0][0].ownerToken).toBe('single-key-0123456789');
    } finally {
      spy.mockRestore();
    }
  });

  test('鍵の表を直接渡したとき（テスト用）は、環境に何も無くても、その表で認証する（Fail-Open にならない）', async () => {
    const { entries, errors } = parseApiKeyFile(JSON.stringify({ keys: [{ name: 'dave', key: 'dave-key-0123456789abcdef' }] }));
    expect(errors).toEqual([]);
    const direct = new Hono();
    direct.use('*', createAuthMiddleware(undefined, new ApiKeyStore(entries)));
    direct.get('/p', (c) => c.json({ tenant: c.get('tenant') }));
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: undefined }, async () => {
      const ok = await direct.request('/p', { headers: { 'X-API-Key': 'dave-key-0123456789abcdef' } });
      expect(ok.status).toBe(200);
      expect(await tenantOf(ok)).toMatchObject({ tenantId: 'name:dave' });
      expect((await direct.request('/p')).status).toBe(401);
      expect((await direct.request('/p', { headers: { 'X-API-Key': 'unknown-key-0123456789abcdef' } })).status).toBe(401);
    });
  });
});
