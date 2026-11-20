import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadApiKeyStore, resetApiKeyStoreCache } from '../security/api_keys.js';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { withEnv } from '../test_fixtures/env.js';
import { systemRoutes } from './system.js';

/**
 * GET /metrics は、strict では管理者の鍵だけが開ける（設計 5。段階 8 の残り）。standard の挙動は変わらない（鍵なしで開く）。
 * /metrics は鍵なしで開く経路（auth.ts の公開の一覧）なので、認証の中間層は通らない。この経路が、自分で鍵を調べる（/health?detailed=true と同じ）。
 * 中身は、プロセス全体の合計の数字だけで、tenant を見分ける情報はない（カウンタの名前は、固定の語か、数えられた理由の語だけ）。
 */

let dir: string;
let keysFile: string;

const ADMIN = 'admin-key-0123456789abcdef';
const ALICE = 'alice-key-0123456789abcdef';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-metrics-admin-'));
  keysFile = join(dir, 'keys.json');
  writeFileSync(keysFile, JSON.stringify({ keys: [{ name: 'ops', key: ADMIN, admin: true }, { name: 'alice', key: ALICE }] }), { mode: 0o600 });
  resetApiKeyStoreCache();
  resetSecurityMetrics();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetApiKeyStoreCache();
  resetSecurityMetrics();
});

const app = new Hono().route('/', systemRoutes);
const call = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const strict = <T>(fn: () => Promise<T>) => withEnv({ SORA_ISOLATION: 'strict', SORA_AUTH_KEYS_FILE: keysFile }, fn);
/** 数字が出ていないことの確かめ（JSON の欄と、Prometheus 形式の行） */
const leaksNumbers = (text: string) =>
  text.includes('"counters"') || text.includes('sora_uptime_seconds') || text.includes('"uptimeSeconds"') || text.includes('isolation');

/** JSON・?format=prometheus・Accept: text/plain の 3 通り。どれも同じ数字を返す口 */
const FORMS: Array<[string, Record<string, string>]> = [
  ['/metrics', {}],
  ['/metrics?format=prometheus', {}],
  ['/metrics', { accept: 'text/plain' }],
];

describe('GET /metrics（strict）', () => {
  test('鍵なしは 401。JSON でも Prometheus 形式でも、数字を返さない', async () => {
    await strict(async () => {
      for (const [path, headers] of FORMS) {
        const res = await call(path, headers);
        expect(res.status, path).toBe(401);
        const text = await res.text();
        expect(leaksNumbers(text), `${path} ${JSON.stringify(headers)}`).toBe(false);
        expect(JSON.parse(text)).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
      }
      expect(getSecurityMetrics()).toMatchObject({ sora_auth_rejected_missing_total: 3 });
    });
  });

  test('知らない鍵は 401（鍵なしと数え分ける）。管理者でない鍵は 403 で、数字を返さない', async () => {
    await strict(async () => {
      for (const [path, headers] of FORMS) {
        const wrong = await call(path, { ...headers, 'x-api-key': 'not-a-key-0123456789' });
        expect(wrong.status, path).toBe(401);
        expect(leaksNumbers(await wrong.text()), path).toBe(false);
      }
      expect(getSecurityMetrics()).toMatchObject({ sora_auth_rejected_invalid_total: 3 });
      for (const headers of [{ authorization: `Bearer ${ALICE}` }, { 'x-api-key': ALICE }] as Array<Record<string, string>>) {
        const alice = await call('/metrics', headers);
        expect(alice.status).toBe(403);
        const text = await alice.text();
        expect(leaksNumbers(text)).toBe(false);
        expect(JSON.parse(text)).toMatchObject({ code: 'FORBIDDEN', status: 403, retryable: false });
      }
      expect(getSecurityMetrics()).toMatchObject({ sora_auth_rejected_not_admin_total: 2 });
    });
  });

  test('管理者の鍵（Authorization: Bearer でも X-API-Key でも）は、JSON を返す', async () => {
    await strict(async () => {
      for (const headers of [{ authorization: `Bearer ${ADMIN}` }, { 'x-api-key': ADMIN }] as Array<Record<string, string>>) {
        const res = await call('/metrics', headers);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; counters: Record<string, number>; cache: unknown; memory: unknown };
        expect(body.status).toBe('ok');
        expect(body.cache).toBeDefined();
        expect(body.memory).toBeDefined();
        expect(body.counters).toBeDefined();
      }
    });
  });

  test('管理者の鍵は、Prometheus 形式（?format=prometheus・Accept: text/plain）も返す', async () => {
    await strict(async () => {
      for (const [path, headers] of FORMS.slice(1)) {
        const res = await call(path, { ...headers, authorization: `Bearer ${ADMIN}` });
        expect(res.status, path).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/plain');
        const text = await res.text();
        expect(text).toContain('sora_uptime_seconds');
        expect(text).toContain('sora_memory_rss_bytes');
      }
    });
  });

  test('断った要求も、数えられる（sora_auth_rejected_*）。通した要求は数えない', async () => {
    await strict(async () => {
      await call('/metrics', { authorization: `Bearer ${ADMIN}` });
      expect(getSecurityMetrics()).toEqual({});
      await call('/metrics');
      expect(getSecurityMetrics()).toEqual({ sora_auth_rejected_missing_total: 1 });
    });
  });

  test('鍵の表を読めないときは 503（匿名にも、数字を返すことにもしない）', async () => {
    await withEnv({ SORA_ISOLATION: 'strict', SORA_AUTH_KEYS_FILE: join(dir, 'missing.json') }, async () => {
      for (const [path, headers] of FORMS) {
        const res = await call(path, { ...headers, authorization: `Bearer ${ADMIN}` });
        expect(res.status, path).toBe(503);
        expect(leaksNumbers(await res.text()), path).toBe(false);
      }
    });
  });

  test('鍵ファイルが無い組み立て（起動の検査を通らない経路）でも、開かない（閉じる側に倒す）', async () => {
    await withEnv({ SORA_ISOLATION: 'strict', SORA_AUTH_KEYS_FILE: undefined }, async () => {
      for (const [path, headers] of FORMS) {
        const res = await call(path, { ...headers, authorization: `Bearer ${ADMIN}` });
        expect(res.status, path).toBe(401);
        expect(leaksNumbers(await res.text()), path).toBe(false);
      }
    });
  });
});

describe('GET /metrics（standard。今までどおり）', () => {
  test('鍵が要らず、鍵ファイルがあっても、鍵なしで開く（JSON も Prometheus 形式も）', async () => {
    for (const vars of [{ SORA_ISOLATION: undefined, SORA_AUTH_KEYS_FILE: undefined }, { SORA_ISOLATION: 'standard', SORA_AUTH_KEYS_FILE: keysFile }]) {
      await withEnv(vars, async () => {
        for (const [path, headers] of FORMS) {
          const res = await call(path, headers);
          expect(res.status, `${path} ${JSON.stringify(vars)}`).toBe(200);
          expect(leaksNumbers(await res.text()), path).toBe(true);
        }
        expect(getSecurityMetrics()).toEqual({});
      });
    }
  });
});

/**
 * 実アプリ（index.ts の app。認証の中間層・公開の経路の一覧・Origin の検査を通る）で確かめる。素の systemRoutes だけでは、
 * 経路の書き方の違い（末尾のスラッシュ・大文字・二重のスラッシュ・パーセント符号化）が、公開の経路の判定をすり抜けるかを検出できない。
 */
describe('GET /metrics（strict。実アプリを通す）', () => {
  const realApp = async () => (await import('../index.js')).app;
  const callReal = async (path: string, init: RequestInit = {}) => (await realApp()).request(path, init);

  test('鍵なしは、経路の書き方を変えても、数字を返さない', async () => {
    await strict(async () => {
      const paths = [
        '/metrics',
        '/metrics/',
        '//metrics',
        '/Metrics',
        '/%6Detrics',
        '/metrics?format=prometheus',
        '/metrics/?format=prometheus',
        '//metrics?format=prometheus',
        '/%6detrics?format=prometheus',
        '/metrics?x=1',
        '/metrics?format=prometheus&format=json',
      ];
      for (const path of paths) {
        for (const headers of [{}, { accept: 'text/plain' }, { origin: 'http://evil.example' }] as Array<Record<string, string>>) {
          const res = await callReal(path, { headers });
          expect(leaksNumbers(await res.text()), `${path} ${JSON.stringify(headers)}`).toBe(false);
        }
      }
      expect((await callReal('/metrics')).status).toBe(401);
      expect((await callReal('/metrics', { method: 'HEAD' })).status).toBe(401);
      expect((await callReal('/metrics?format=prometheus')).status).toBe(401);
    });
  });

  test('管理者の鍵なら、実アプリでも数字を返す。管理者でない鍵は 403', async () => {
    await strict(async () => {
      const admin = await callReal('/metrics', { headers: { authorization: `Bearer ${ADMIN}` } });
      expect(admin.status).toBe(200);
      expect(await admin.json()).toHaveProperty('counters');
      const prom = await callReal('/metrics?format=prometheus', { headers: { 'x-api-key': ADMIN } });
      expect(prom.status).toBe(200);
      expect(await prom.text()).toContain('sora_uptime_seconds');
      const alice = await callReal('/metrics', { headers: { 'x-api-key': ALICE } });
      expect(alice.status).toBe(403);
    });
  });

  test('コンテナの死活確認の /health と、サービス情報の / は、strict でも鍵なしで開く', async () => {
    await strict(async () => {
      expect((await callReal('/health')).status).toBe(200);
      expect((await callReal('/')).status).toBe(200);
    });
  });
});

/**
 * 隔離の状態（設計 8）: strict の管理者にだけ、JSON の isolation と Prometheus の gauge を付ける。standard は、項目も行も増やさない（今までどおり）。
 */
describe('GET /metrics の隔離の状態', () => {
  type Isolation = {
    level: string;
    browser: { sandbox: string; connection: string; processes: { active: number; max: number } };
    egressGateway: { enabled: boolean; started: boolean };
    authKeys?: { keys: number; tenants: number; stale: boolean; staleSeconds: number };
  };
  const admin = { authorization: `Bearer ${ADMIN}` };
  const JSON_KEYS = ['activeSessions', 'botDetection', 'cache', 'chromium', 'counters', 'memory', 'service', 'status', 'timestamp', 'uptimeSeconds', 'version'];
  /** Prometheus の「名前 値」の行を、名前 → 値 にする */
  const samples = (text: string) => Object.fromEntries(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' ')));

  test('strict の管理者には、JSON に isolation（水準・ブラウザ・ゲートウェイ・鍵の表）が付く', async () => {
    await strict(async () => {
      const body = (await (await call('/metrics', admin)).json()) as { isolation?: Isolation };
      const iso = body.isolation;
      expect(iso?.level).toBe('strict');
      expect(['on', 'off', 'unknown']).toContain(iso?.browser.sandbox as string);
      expect(['pipe', 'port']).toContain(iso?.browser.connection as string);
      expect(iso?.browser.processes.max).toBeGreaterThan(0);
      expect(typeof iso?.egressGateway.enabled).toBe('boolean');
      expect(iso?.authKeys).toEqual({ keys: 2, tenants: 2, stale: false, staleSeconds: 0 });
    });
  });

  test('Prometheus 形式（?format=prometheus・Accept: text/plain）にも、gauge が付く', async () => {
    await strict(async () => {
      for (const [path, headers] of FORMS.slice(1)) {
        const text = await (await call(path, { ...headers, ...admin })).text();
        const values = samples(text);
        expect(values.sora_isolation_strict, path).toBe('1');
        expect(['0', '1']).toContain(values.sora_browser_sandbox_on);
        expect(['0', '1']).toContain(values.sora_browser_cdp_pipe);
        expect(Number(values.sora_browser_tenant_processes_max)).toBeGreaterThan(0);
        expect(['0', '1']).toContain(values.sora_egress_gateway_enabled);
        expect(['0', '1']).toContain(values.sora_egress_gateway_started);
        expect(values.sora_auth_keys_stale).toBe('0');
        expect(values.sora_auth_keys_stale_seconds).toBe('0');
        expect(text).toContain('# TYPE sora_isolation_strict gauge');
        expect(text).toContain('sora_uptime_seconds'); // 既存の行は、そのまま出る
      }
    });
  });

  test('前の鍵で動いている間は、JSON の authKeys.stale が true で、Prometheus の sora_auth_keys_stale が 1', async () => {
    await strict(async () => {
      expect((await call('/metrics', admin)).status).toBe(200);
      writeFileSync(keysFile, '{ broken', { mode: 0o600 });
      loadApiKeyStore(keysFile, Date.now() + 5000); // 1 秒に 1 回の確認を、進めた時刻で起こす（読み直しに失敗して、前の表で動き始める）
      const json = (await (await call('/metrics', admin)).json()) as { isolation?: Isolation };
      expect(json.isolation?.authKeys).toMatchObject({ keys: 2, tenants: 2, stale: true });
      const prom = samples(await (await call('/metrics?format=prometheus', admin)).text());
      expect(prom.sora_auth_keys_stale).toBe('1');
    });
  });

  test('鍵なし・知らない鍵・管理者でない鍵への応答には、隔離の状態を出さない', async () => {
    await strict(async () => {
      for (const [path, headers] of FORMS) {
        for (const extra of [{}, { 'x-api-key': 'not-a-key-0123456789' }, { authorization: `Bearer ${ALICE}` }] as Array<Record<string, string>>) {
          const res = await call(path, { ...headers, ...extra });
          expect([401, 403]).toContain(res.status);
          const text = await res.text();
          expect(text).not.toContain('isolation');
          expect(text).not.toContain('sora_browser_sandbox_on');
        }
      }
    });
  });

  test('standard では、JSON の項目も Prometheus の行も増えない（今までどおり。鍵ファイルがあっても）', async () => {
    for (const vars of [{ SORA_ISOLATION: undefined, SORA_AUTH_KEYS_FILE: undefined }, { SORA_ISOLATION: 'standard', SORA_AUTH_KEYS_FILE: keysFile }]) {
      await withEnv(vars, async () => {
        const json = (await (await call('/metrics')).json()) as Record<string, unknown>;
        expect(Object.keys(json).sort()).toEqual(JSON_KEYS);
        const prom = await (await call('/metrics?format=prometheus')).text();
        for (const name of ['sora_isolation_strict', 'sora_browser_sandbox_on', 'sora_browser_cdp_pipe', 'sora_browser_tenant_processes', 'sora_egress_gateway', 'sora_auth_keys_stale']) {
          expect(prom, name).not.toContain(name);
        }
      });
    }
  });
});
