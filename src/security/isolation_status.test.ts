import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserProcessUsage, browserSandboxStatus } from '../browser_engine.js';
import { isEgressGatewayStarted, stopEgressGateway } from '../net/egress.js';
import { getApiKeyStore, resetApiKeyStoreCache } from './api_keys.js';
import { withEnv } from '../test_fixtures/env.js';
import { type IsolationStatus, isolationGaugeLines, isolationStatus, type StatusSources, statusSources } from './isolation_status.js';

/**
 * 隔離の状態（設計 8）。水準が strict のときだけ返す（standard は何も返さない = 応答は今までどおり）。
 * 取り出し口を差し替えて、値の写し間違い（取り違え・向きの逆）を、互いに違う値で確かめる。
 */

const sources = (over: Partial<StatusSources> = {}): StatusSources => ({
  sandbox: () => 'on',
  connection: () => 'pipe',
  processes: () => ({ active: 2, max: 4 }),
  gatewayEnabled: () => true,
  gatewayStarted: () => true,
  authKeys: () => ({ keys: 3, tenants: 2, stale: false, staleSeconds: 0 }),
  ...over,
});
/** 呼ばれたら失敗する取り出し口（standard では、何も調べないことの確かめ） */
const forbidden = (): StatusSources => {
  const boom = () => {
    throw new Error('呼ばれてはいけない');
  };
  return { sandbox: boom, connection: boom, processes: boom, gatewayEnabled: boom, gatewayStarted: boom, authKeys: boom };
};
const strict = <T>(fn: () => T | Promise<T>) => withEnv({ SORA_ISOLATION: 'strict' }, fn);

describe('isolationStatus', () => {
  test('standard（未設定・standard）は undefined。何も調べない', async () => {
    for (const level of [undefined, 'standard']) {
      await withEnv({ SORA_ISOLATION: level }, () => {
        expect(isolationStatus(forbidden())).toBeUndefined();
      });
    }
  });

  test('strict は、水準・ブラウザ・ゲートウェイ・鍵の表を返す（取り出し口の値を、そのまま写す）', async () => {
    await strict(() => {
      expect(isolationStatus(sources())).toEqual({
        level: 'strict',
        browser: { sandbox: 'on', connection: 'pipe', processes: { active: 2, max: 4 } },
        egressGateway: { enabled: true, started: true },
        authKeys: { keys: 3, tenants: 2, stale: false, staleSeconds: 0 },
      });
    });
  });

  test('サンドボックスは off・unknown も、接続は port も、そのまま返す', async () => {
    await strict(() => {
      for (const sandbox of ['off', 'unknown'] as const) {
        expect(isolationStatus(sources({ sandbox: () => sandbox }))?.browser.sandbox).toBe(sandbox);
      }
      expect(isolationStatus(sources({ connection: () => 'port' }))?.browser.connection).toBe('port');
    });
  });

  test('ゲートウェイの「使う設定か」と「始めているか」は別々に写す', async () => {
    await strict(() => {
      expect(isolationStatus(sources({ gatewayEnabled: () => true, gatewayStarted: () => false }))?.egressGateway).toEqual({ enabled: true, started: false });
      expect(isolationStatus(sources({ gatewayEnabled: () => false, gatewayStarted: () => true }))?.egressGateway).toEqual({ enabled: false, started: true });
    });
  });

  test('ゲートウェイの設定が読めなくても（環境変数の書き方の誤りで、読む関数が例外を投げる）、状態の取得は失敗せず、使わない扱いにする', async () => {
    await strict(() => {
      const status = isolationStatus(
        sources({
          gatewayEnabled: () => {
            throw new Error('SORA_EGRESS_GATEWAY の書き方が誤り');
          },
        }),
      );
      expect(status?.egressGateway).toEqual({ enabled: false, started: true });
    });
  });

  test('鍵の表が無いとき（鍵ファイルを使わない・読めていない）は、authKeys の欄ごと出さない', async () => {
    await strict(() => {
      const status = isolationStatus(sources({ authKeys: () => undefined }));
      expect(status).toBeDefined();
      expect('authKeys' in (status as IsolationStatus)).toBe(false);
    });
  });

  test('前の鍵で動いているとき（stale）は、その秒数まで写す', async () => {
    await strict(() => {
      const authKeys = { keys: 1, tenants: 1, stale: true, staleSeconds: 90 };
      expect(isolationStatus(sources({ authKeys: () => authKeys }))?.authKeys).toEqual(authKeys);
    });
  });

  test('実際の取り出し口でも動く（strict。ブラウザは起動しておらず、ゲートウェイは始めていない）', async () => {
    await stopEgressGateway();
    await withEnv({ SORA_ISOLATION: 'strict', SORA_EGRESS_GATEWAY: 'on', SORA_FETCH_ALLOW_PRIVATE_NETWORK: undefined, SORA_AUTH_KEYS_FILE: undefined }, () => {
      const status = isolationStatus();
      expect(status?.level).toBe('strict');
      expect(['on', 'off', 'unknown']).toContain(status?.browser.sandbox as string);
      expect(['pipe', 'port']).toContain(status?.browser.connection as string);
      expect(status?.browser.processes.active).toBeGreaterThanOrEqual(0);
      expect(status?.browser.processes.max).toBeGreaterThan(0); // strict は、tenant ごとにブラウザのプロセスを分ける
      expect(status?.egressGateway).toEqual({ enabled: true, started: false });
      expect(status && 'authKeys' in status).toBe(false);
    });
  });

  test('実際の取り出し口の配線: 取り出し元の関数をそのまま使い、設定を読む口は、設定に従う', async () => {
    expect(statusSources.sandbox).toBe(browserSandboxStatus);
    expect(statusSources.processes).toBe(browserProcessUsage);
    expect(statusSources.gatewayStarted).toBe(isEgressGatewayStarted);
    await withEnv({ SORA_BROWSER_PIPE: 'false' }, () => expect(statusSources.connection()).toBe('port'));
    await withEnv({ SORA_BROWSER_PIPE: 'true' }, () => expect(statusSources.connection()).toBe('pipe'));
    await withEnv({ SORA_EGRESS_GATEWAY: 'on', SORA_FETCH_ALLOW_PRIVATE_NETWORK: undefined }, () => expect(statusSources.gatewayEnabled()).toBe(true));
    await withEnv({ SORA_EGRESS_GATEWAY: undefined }, () => expect(statusSources.gatewayEnabled()).toBe(false));
  });

  test('実際の取り出し口: 鍵ファイルを読んでいれば、鍵の表の状態が付く', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sora-isolation-status-'));
    const keys = join(dir, 'keys.json');
    writeFileSync(keys, JSON.stringify({ keys: [{ name: 'ops', key: 'ops-key-0123456789abcdef', admin: true }, { name: 'alice', key: 'alice-key-0123456789abcdef' }] }), { mode: 0o600 });
    resetApiKeyStoreCache();
    try {
      await withEnv({ SORA_ISOLATION: 'strict', SORA_AUTH_KEYS_FILE: keys }, () => {
        getApiKeyStore(); // 認証が読むのと同じ口。読んだあとの状態が、見える
        expect(isolationStatus()?.authKeys).toEqual({ keys: 2, tenants: 2, stale: false, staleSeconds: 0 });
      });
    } finally {
      resetApiKeyStoreCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('実際の取り出し口でも、standard は undefined', async () => {
    await withEnv({ SORA_ISOLATION: 'standard' }, () => {
      expect(isolationStatus()).toBeUndefined();
    });
  });
});

describe('isolationGaugeLines（Prometheus 形式）', () => {
  const lines = (over: Partial<StatusSources> = {}) => {
    const status = isolationStatus(sources(over));
    if (!status) throw new Error('strict のはず');
    return isolationGaugeLines(status);
  };
  const value = (all: string[], name: string) => {
    const line = all.find((l) => l.startsWith(`${name} `));
    return line === undefined ? undefined : Number(line.slice(name.length + 1));
  };

  let restore: () => void;
  beforeEach(() => {
    const previous = process.env.SORA_ISOLATION;
    process.env.SORA_ISOLATION = 'strict';
    restore = () => {
      if (previous === undefined) delete process.env.SORA_ISOLATION;
      else process.env.SORA_ISOLATION = previous;
    };
  });
  afterEach(() => restore());

  test('すべて整ったときの値（互いに違う値で、取り違えを見分ける）', () => {
    const all = lines();
    expect(value(all, 'sora_isolation_strict')).toBe(1);
    expect(value(all, 'sora_browser_sandbox_on')).toBe(1);
    expect(value(all, 'sora_browser_cdp_pipe')).toBe(1);
    expect(value(all, 'sora_browser_tenant_processes')).toBe(2);
    expect(value(all, 'sora_browser_tenant_processes_max')).toBe(4);
    expect(value(all, 'sora_egress_gateway_enabled')).toBe(1);
    expect(value(all, 'sora_egress_gateway_started')).toBe(1);
    expect(value(all, 'sora_auth_keys_stale')).toBe(0);
    expect(value(all, 'sora_auth_keys_stale_seconds')).toBe(0);
  });

  test('サンドボックスが on でないとき（off・unknown）と、接続が port のときは 0', () => {
    for (const sandbox of ['off', 'unknown'] as const) expect(value(lines({ sandbox: () => sandbox }), 'sora_browser_sandbox_on')).toBe(0);
    expect(value(lines({ connection: () => 'port' }), 'sora_browser_cdp_pipe')).toBe(0);
  });

  test('ゲートウェイの「使う設定か」と「始めているか」は、別の gauge', () => {
    const all = lines({ gatewayEnabled: () => true, gatewayStarted: () => false });
    expect(value(all, 'sora_egress_gateway_enabled')).toBe(1);
    expect(value(all, 'sora_egress_gateway_started')).toBe(0);
    const other = lines({ gatewayEnabled: () => false, gatewayStarted: () => true });
    expect(value(other, 'sora_egress_gateway_enabled')).toBe(0);
    expect(value(other, 'sora_egress_gateway_started')).toBe(1);
  });

  test('前の鍵で動いている間は、stale が 1 で、経過の秒数が出る', () => {
    const all = lines({ authKeys: () => ({ keys: 3, tenants: 2, stale: true, staleSeconds: 90 }) });
    expect(value(all, 'sora_auth_keys_stale')).toBe(1);
    expect(value(all, 'sora_auth_keys_stale_seconds')).toBe(90);
  });

  test('鍵の表が無いときは、鍵の gauge を出さない（0 を返すと、正常と見分けがつかない）', () => {
    const all = lines({ authKeys: () => undefined });
    expect(all.some((l) => l.includes('sora_auth_keys_'))).toBe(false);
    expect(value(all, 'sora_isolation_strict')).toBe(1);
  });

  test('どの gauge も、HELP・TYPE gauge・値 の 3 行で、値は整数', () => {
    const all = lines();
    expect(all.length % 3).toBe(0);
    for (let i = 0; i < all.length; i += 3) {
      const name = all[i + 2].split(' ')[0];
      expect(all[i]).toMatch(new RegExp(`^# HELP ${name} .+`));
      expect(all[i + 1]).toBe(`# TYPE ${name} gauge`);
      expect(all[i + 2]).toMatch(/^[a-z_][a-z0-9_]* -?\d+$/);
    }
  });
});
