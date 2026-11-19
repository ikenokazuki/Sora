import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createAuthMiddleware, requireAdminKey } from './auth.js';
import { resetApiKeyStoreCache } from './security/api_keys.js';
import { resetSecurityMetrics } from './security/metrics.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * 鍵ファイルを書き換えると、再起動なしで、認証に効く(自動発行で、鍵を足す運用)。実際の認証の中間層と、実際のファイルの置き換えで確かめる。
 * 確認の間隔(1 秒)は、本物の待ちで越える。計算の細かい所は security/api_keys_reload.test.ts。
 */

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const row = (name: string, key: string, extra: Record<string, unknown> = {}) => ({ name, keyHash: `sha256:${sha(key)}`, ...extra });
const ALICE = 'alice-key-0123456789abcdef';
const BOB = 'bob-key-0123456789abcdefgh';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let path: string;
let spies: Array<() => void>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-auth-reload-'));
  path = join(dir, 'keys.json');
  writeFileSync(path, JSON.stringify({ keys: [row('alice', ALICE)] }), { mode: 0o600 });
  resetApiKeyStoreCache();
  resetSecurityMetrics();
  spies = [spyOn(console, 'warn').mockImplementation(() => {}), spyOn(console, 'error').mockImplementation(() => {})].map((spy) => () => spy.mockRestore());
});
afterEach(() => {
  for (const undo of spies) undo();
  rmSync(dir, { recursive: true, force: true });
  resetApiKeyStoreCache();
});

const replace = (content: unknown[] | string) => {
  const tmp = join(dir, `keys-${randomUUID()}.tmp`);
  writeFileSync(tmp, typeof content === 'string' ? content : JSON.stringify({ keys: content }), { mode: 0o600 });
  renameSync(tmp, path);
};
const app = () => {
  const a = new Hono();
  a.use('*', createAuthMiddleware());
  a.get('/p', (c) => c.json({ tenant: c.get('tenant') }));
  return a;
};
const call = async (key: string) => {
  const res = await app().fetch(new Request('http://localhost/p', { headers: { 'X-API-Key': key } }), { remoteAddr: null });
  const body = res.status === 200 ? ((await res.json()) as { tenant: { name?: string; admin?: boolean } }) : undefined;
  return { status: res.status, name: body?.tenant.name, admin: body?.tenant.admin };
};
const clean = { SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_DAILY_LIMIT: undefined };

describe('鍵ファイルを書き換えると、再起動なしで効く', () => {
  test('足した鍵が通り、消した鍵が断られる(約 1 秒以内)', async () => {
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      expect(await call(ALICE)).toMatchObject({ status: 200, name: 'alice' });
      expect((await call(BOB)).status).toBe(401);
      replace([row('bob', BOB)]);
      await sleep(1100);
      expect(await call(BOB)).toMatchObject({ status: 200, name: 'bob' });
      expect((await call(ALICE)).status).toBe(401);
    });
  }, 15_000);

  test('壊れたファイルに置き換わっても、前の鍵のまま使える。匿名にも、全部を断る状態にもならない。直すと、新しい鍵が効く', async () => {
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      expect((await call(ALICE)).status).toBe(200);
      replace('{ broken');
      await sleep(1100);
      expect(await call(ALICE)).toMatchObject({ status: 200, name: 'alice' });
      expect((await call('no-such-key-0123456789')).status).toBe(401);
      replace([row('alice', ALICE), row('bob', BOB, { admin: true })]);
      await sleep(1100);
      expect(await call(BOB)).toMatchObject({ status: 200, name: 'bob', admin: true });
    });
  }, 15_000);
});

describe('管理者の鍵(strict の GET /health?detailed=true の関所。requireAdminKey)も、同じ表を引く', () => {
  const OPS = 'ops-key-0123456789abcdefgh';
  const adminApp = () => {
    const a = new Hono();
    a.get('/h', (c) => requireAdminKey(c) ?? c.json({ ok: true }));
    return a;
  };
  const status = async (key: string) => (await adminApp().fetch(new Request('http://localhost/h', { headers: { 'X-API-Key': key } }))).status;

  test('管理者の付け外しが、再起動なしで効く(降格 → 403、昇格 → 200)', async () => {
    replace([row('ops', OPS, { admin: true }), row('alice', ALICE)]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      expect(await status(OPS)).toBe(200);
      expect(await status(ALICE)).toBe(403);
      replace([row('ops', OPS), row('alice', ALICE, { admin: true })]);
      await sleep(1100);
      expect(await status(OPS)).toBe(403);
      expect(await status(ALICE)).toBe(200);
    });
  }, 15_000);

  test('壊れた書き換えのあいだは、前の表のまま(降格・失効が効かない)。直すと効く。それまで、1 分ごとのログで知らせる設計', async () => {
    replace([row('ops', OPS, { admin: true }), row('alice', ALICE)]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      expect(await status(OPS)).toBe(200);
      replace('{ broken'); // 降格のつもりの書き換えが、壊れていた
      await sleep(1100);
      expect(await status(OPS)).toBe(200); // 前の表のまま(管理者のまま)
      replace([row('ops', OPS), row('alice', ALICE)]); // 直す
      await sleep(1100);
      expect(await status(OPS)).toBe(403);
    });
  }, 15_000);
});
