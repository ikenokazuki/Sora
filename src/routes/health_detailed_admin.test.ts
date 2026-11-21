import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { loadApiKeyStore, resetApiKeyStoreCache } from '../security/api_keys.js';
import { resetHealthProbeCache } from '../services/health.js';
import { withEnv } from '../test_fixtures/env.js';
import { systemRoutes } from './system.js';

/**
 * GET /health?detailed=true は、strict では管理者の鍵だけが開ける（設計 5・穴 14。決定 8。段階 8）。
 * ふつうの /health（コンテナの死活確認）は、水準によらず公開のまま。standard の挙動は変わらない。
 * /health は鍵なしで開く経路（auth.ts の公開の一覧）なので、認証の中間層は通らない。この経路が、自分で鍵を調べる。
 */

let dir: string;
let keysFile: string;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
let probed: string[];

const ADMIN = 'admin-key-0123456789abcdef';
const ALICE = 'alice-key-0123456789abcdef';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-health-admin-'));
  keysFile = join(dir, 'keys.json');
  writeFileSync(keysFile, JSON.stringify({ keys: [{ name: 'ops', key: ADMIN, admin: true }, { name: 'alice', key: ALICE }] }), { mode: 0o600 });
  resetApiKeyStoreCache();
  resetHealthProbeCache();
  resetSecurityMetrics();
  probed = [];
  // 外部への確認（気象庁・P2PQuake・e-Gov）は、実際には通信しない
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    probed.push(String(input));
    return new Response('ok', { status: 200 });
  }) as never);
});
afterEach(() => {
  fetchSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  resetApiKeyStoreCache();
  resetHealthProbeCache();
  resetSecurityMetrics();
});

const app = new Hono().route('/', systemRoutes);
const call = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const strict = <T>(fn: () => Promise<T>) => withEnv({ SORA_ISOLATION: 'strict', SORA_AUTH_KEYS_FILE: keysFile }, fn);

describe('GET /health?detailed=true（strict）', () => {
  test('鍵なしは 401。外部への確認もしない', async () => {
    await strict(async () => {
      for (const query of ['true', '1']) {
        const res = await call(`/health?detailed=${query}`);
        expect(res.status, query).toBe(401);
        expect(await res.json()).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
      }
      expect(probed).toEqual([]);
      expect(getSecurityMetrics()).toMatchObject({ sora_auth_rejected_missing_total: 2 });
    });
  });

  test('知らない鍵は 401（鍵なしと数え分ける）。管理者でない鍵は 403 で、外部への確認はしない', async () => {
    await strict(async () => {
      const wrong = await call('/health?detailed=true', { 'x-api-key': 'not-a-key-0123456789' });
      expect(wrong.status).toBe(401);
      expect(getSecurityMetrics()).toMatchObject({ sora_auth_rejected_invalid_total: 1 });
      const alice = await call('/health?detailed=true', { authorization: `Bearer ${ALICE}` });
      expect(alice.status).toBe(403);
      expect(await alice.json()).toMatchObject({ code: 'FORBIDDEN', status: 403, retryable: false });
      expect(getSecurityMetrics()).toMatchObject({ sora_auth_rejected_not_admin_total: 1 });
      expect(probed).toEqual([]);
    });
  });

  test('管理者の鍵（Authorization: Bearer でも X-API-Key でも）は、詳細を返す', async () => {
    await strict(async () => {
      for (const headers of [{ authorization: `Bearer ${ADMIN}` }, { 'x-api-key': ADMIN }] as Array<Record<string, string>>) {
        resetHealthProbeCache();
        const res = await call('/health?detailed=true', headers);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; dependencies?: unknown };
        expect(body.status).toBe('ok');
        expect(body.dependencies).toBeDefined();
      }
    });
  });

  test('ふつうの /health（detailed なし・detailed=false など）は、strict でも鍵なしで開く（コンテナの死活確認）', async () => {
    await strict(async () => {
      for (const path of ['/health', '/health?detailed=false', '/health?detailed=', '/health?x=1']) {
        const res = await call(path);
        expect(res.status, path).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'ok', service: 'sora' });
      }
      expect(probed).toEqual([]);
    });
  });

  test('鍵の表を読めないときは 503（匿名にも、詳細を返すことにもしない）', async () => {
    await withEnv({ SORA_ISOLATION: 'strict', SORA_AUTH_KEYS_FILE: join(dir, 'missing.json') }, async () => {
      const res = await call('/health?detailed=true', { authorization: `Bearer ${ADMIN}` });
      expect(res.status).toBe(503);
      expect(probed).toEqual([]);
    });
  });

  test('鍵ファイルが無い組み立て（起動の検査を通らない経路）でも、詳細は開けない（閉じる側に倒す）', async () => {
    await withEnv({ SORA_ISOLATION: 'strict', SORA_AUTH_KEYS_FILE: undefined }, async () => {
      const res = await call('/health?detailed=true', { authorization: `Bearer ${ADMIN}` });
      expect(res.status).toBe(401);
      expect(probed).toEqual([]);
    });
  });
});

describe('GET /health?detailed=true（standard。今までどおり）', () => {
  test('鍵が要らず、鍵ファイルがあっても、鍵なしで詳細を返す', async () => {
    for (const vars of [{ SORA_ISOLATION: undefined, SORA_AUTH_KEYS_FILE: undefined }, { SORA_ISOLATION: 'standard', SORA_AUTH_KEYS_FILE: keysFile }]) {
      await withEnv(vars, async () => {
        resetHealthProbeCache();
        const res = await call('/health?detailed=true');
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'ok' });
      });
    }
  });
});

/**
 * 実アプリ（index.ts の app。認証の中間層・公開の経路の一覧・Origin の検査を通る）で確かめる。素の systemRoutes だけでは、
 * 経路の書き方の違い（末尾のスラッシュ・大文字・二重のスラッシュ・パーセント符号化）が、公開の経路の判定をすり抜けるかを検出できない。
 */
describe('GET /health?detailed=true（strict。実アプリを通す）', () => {
  const realApp = async () => (await import('../index.js')).app;
  const callReal = async (path: string, init: RequestInit = {}) => (await realApp()).request(path, init);

  test('鍵なしは、経路の書き方を変えても、詳細を返さない', async () => {
    await strict(async () => {
      for (const path of ['/health?detailed=true', '/health/?detailed=true', '//health?detailed=true', '/Health?detailed=true', '/%68ealth?detailed=true', '/health?detailed=1', '/health?detailed=true&detailed=false']) {
        const res = await callReal(path);
        const body = await res.text();
        expect(body, path).not.toContain('"dependencies"');
        expect(probed, path).toEqual([]);
      }
      const plain = await callReal('/health?detailed=true');
      expect(plain.status).toBe(401);
      const head = await callReal('/health?detailed=true', { method: 'HEAD' });
      expect(head.status).toBe(401);
    });
  });

  test('管理者の鍵なら、実アプリでも詳細を返す。管理者でない鍵は 403', async () => {
    await strict(async () => {
      const admin = await callReal('/health?detailed=true', { headers: { authorization: `Bearer ${ADMIN}` } });
      expect(admin.status).toBe(200);
      expect(await admin.json()).toHaveProperty('dependencies');
      const alice = await callReal('/health?detailed=true', { headers: { 'x-api-key': ALICE } });
      expect(alice.status).toBe(403);
    });
  });

  test('ふつうの /health は、strict の実アプリでも鍵なしで開く', async () => {
    await strict(async () => {
      const res = await callReal('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok', service: 'sora' });
    });
  });
});

/**
 * 隔離の状態（設計 8）: strict の管理者にだけ、詳細に isolation を付ける（サンドボックスが off など、守りの弱いところを、
 * ほかの利用者に見せない）。standard は、応答の項目を増やさない（今までどおり）。
 */
describe('GET /health?detailed=true の隔離の状態', () => {
  type Isolation = {
    level: string;
    browser: { sandbox: string; connection: string; processes: { active: number; max: number } };
    egressGateway: { enabled: boolean; started: boolean };
    authKeys?: { keys: number; tenants: number; stale: boolean; staleSeconds: number };
  };
  const admin = { authorization: `Bearer ${ADMIN}` };
  const DETAILED_KEYS = ['activeBrowserSessions', 'cachedEntries', 'dependencies', 'service', 'status', 'timestamp', 'uptimeSeconds', 'version'];
  const PLAIN_KEYS = ['activeMcpSessions', 'cachedEntries', 'chromiumAvailable', 'mcpConnected', 'service', 'status', 'timestamp', 'version', 'yahooMcpAvailable'];

  test('strict の管理者には、isolation（水準・ブラウザ・ゲートウェイ・鍵の表）が付く', async () => {
    await strict(async () => {
      const res = await call('/health?detailed=true', admin);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { isolation?: Isolation };
      const iso = body.isolation;
      expect(iso?.level).toBe('strict');
      expect(['on', 'off', 'unknown']).toContain(iso?.browser.sandbox as string);
      expect(['pipe', 'port']).toContain(iso?.browser.connection as string);
      expect(iso?.browser.processes.max).toBeGreaterThan(0);
      expect(typeof iso?.egressGateway.enabled).toBe('boolean');
      expect(typeof iso?.egressGateway.started).toBe('boolean');
      expect(iso?.authKeys).toEqual({ keys: 2, tenants: 2, stale: false, staleSeconds: 0 });
    });
  });

  test('前の鍵で動いている間は authKeys.stale が true（消した鍵が有効なことを、運用者が見られる）。それだけでは degraded にしない', async () => {
    await strict(async () => {
      expect((await call('/health?detailed=true', admin)).status).toBe(200);
      writeFileSync(keysFile, '{ broken', { mode: 0o600 });
      loadApiKeyStore(keysFile, Date.now() + 5000); // 1 秒に 1 回の確認を、進めた時刻で起こす（読み直しに失敗して、前の表で動き始める）
      resetHealthProbeCache();
      const res = await call('/health?detailed=true', admin);
      expect(res.status).toBe(200); // 前の表で、管理者の鍵は通る。degraded（503）にすると、オーケストレーターが再起動を繰り返しうる
      const body = (await res.json()) as { status: string; isolation?: Isolation };
      expect(body.status).toBe('ok');
      expect(body.isolation?.authKeys).toMatchObject({ keys: 2, tenants: 2, stale: true });
    });
  });

  test('鍵なし・知らない鍵・管理者でない鍵への応答には、隔離の状態を出さない', async () => {
    await strict(async () => {
      for (const headers of [{}, { 'x-api-key': 'not-a-key-0123456789' }, { authorization: `Bearer ${ALICE}` }] as Array<Record<string, string>>) {
        const res = await call('/health?detailed=true', headers);
        expect([401, 403]).toContain(res.status);
        expect(await res.text()).not.toContain('isolation');
      }
    });
  });

  test('ふつうの /health（コンテナの死活確認）には、strict でも隔離の状態を出さない（項目も増えない）', async () => {
    await strict(async () => {
      const text = await (await call('/health')).text();
      expect(text).not.toContain('isolation');
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(PLAIN_KEYS);
    });
  });

  test('standard では、詳細にも付かない: 応答の項目は今までどおり（鍵ファイルがあっても）', async () => {
    for (const vars of [{ SORA_ISOLATION: undefined, SORA_AUTH_KEYS_FILE: undefined }, { SORA_ISOLATION: 'standard', SORA_AUTH_KEYS_FILE: keysFile }]) {
      await withEnv(vars, async () => {
        resetHealthProbeCache();
        const text = await (await call('/health?detailed=true')).text();
        expect(text).not.toContain('isolation');
        expect(Object.keys(JSON.parse(text)).sort()).toEqual(DETAILED_KEYS);
      });
    }
  });
});
