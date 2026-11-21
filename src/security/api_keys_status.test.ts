import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyTableStatus, getApiKeyStore, type KeyFileFs, loadApiKeyStore, resetApiKeyStoreCache } from './api_keys.js';
import { getSecurityMetrics, resetSecurityMetrics } from './metrics.js';

/**
 * 鍵の表の状態（apiKeyTableStatus）。鍵ファイルを読み直せず、前の表で動いている間は、消した鍵・管理者から外した鍵が、まだ有効のまま。
 * その状態を、運用者が /health?detailed と /metrics で見られるようにする（設計 8）。ファイルは読み直さず、最後の確認の結果を返す。
 * 時刻は引数で渡す（本物の待ちを避ける）。
 */

const KEY_A = 'alice-key-0123456789abcdef';
const KEY_A2 = 'alice-key-second-0123456789abcdef';
const KEY_B = 'bob-key-0123456789abcdefgh';
const KEY_C = 'carol-key-0123456789abcdefg';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const row = (name: string, key: string) => ({ name, keyHash: `sha256:${sha(key)}` });
const file = (keys: unknown[]) => JSON.stringify({ keys });

const T0 = 1_000_000;
const realFs: KeyFileFs = { stat: (p) => statSync(p), read: (p) => readFileSync(p, 'utf8') };
const errno = (code: string) => Object.assign(new Error(code), { code });
let dir: string;
let path: string;
let logs: string[];
let restore: Array<() => void>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-keys-status-'));
  path = join(dir, 'keys.json');
  writeFileSync(path, file([row('alice', KEY_A)]), { mode: 0o600 });
  resetApiKeyStoreCache();
  resetSecurityMetrics();
  logs = [];
  restore = [];
  for (const method of ['warn', 'error'] as const) {
    const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    restore.push(() => spy.mockRestore());
  }
});
afterEach(() => {
  for (const undo of restore) undo();
  rmSync(dir, { recursive: true, force: true });
  resetApiKeyStoreCache();
  resetSecurityMetrics();
});

/** 一時ファイルに書いてから置き換える（原子的な書き換え。新しい inode になる） */
const replace = (keys: unknown[] | string) => {
  const tmp = join(dir, 'keys.json.tmp');
  writeFileSync(tmp, typeof keys === 'string' ? keys : file(keys), { mode: 0o600 });
  renameSync(tmp, path);
};
const env = () => ({ SORA_AUTH_KEYS_FILE: path });

describe('apiKeyTableStatus（鍵の表の状態）', () => {
  test('鍵ファイルを指定していなければ、undefined（見せるものがない）', () => {
    getApiKeyStore(env(), T0);
    expect(apiKeyTableStatus({}, T0)).toBeUndefined();
  });

  test('まだ読んでいなければ、undefined。聞いても読み込みは起きない', () => {
    expect(apiKeyTableStatus(env(), T0)).toBeUndefined();
    // 聞いたときに読んでいたら、あとで壊れても「前の表」が残る。読んでいなければ、最初の読み込みが誤りで、例外になる
    replace('{ broken');
    expect(() => getApiKeyStore(env(), T0)).toThrow();
  });

  test('読めているとき: 鍵の数と利用者の数を返し、stale ではない', () => {
    getApiKeyStore(env(), T0);
    expect(apiKeyTableStatus(env(), T0)).toEqual({ keys: 1, tenants: 1, stale: false, staleSeconds: 0 });
  });

  test('1 人が鍵を 2 つ持つときは、鍵の数と利用者の数を数え分ける', () => {
    replace([row('alice', KEY_A), row('alice', KEY_A2), row('bob', KEY_B)]);
    getApiKeyStore(env(), T0);
    expect(apiKeyTableStatus(env(), T0)).toEqual({ keys: 3, tenants: 2, stale: false, staleSeconds: 0 });
  });

  test('読み直しに失敗すると、前の表の数のまま stale になり、前の表で動き始めてからの秒数（切り捨て）を返す', () => {
    getApiKeyStore(env(), T0);
    replace('{ broken');
    getApiKeyStore(env(), T0 + 1000); // 古い表で動き始める。この時刻から数える
    expect(apiKeyTableStatus(env(), T0 + 1000)).toEqual({ keys: 1, tenants: 1, stale: true, staleSeconds: 0 });
    expect(apiKeyTableStatus(env(), T0 + 91_000)).toEqual({ keys: 1, tenants: 1, stale: true, staleSeconds: 90 });
    expect(apiKeyTableStatus(env(), T0 + 91_999)).toMatchObject({ stale: true, staleSeconds: 90 });
  });

  test('失敗が続いても、数え始めは動かない（最初に前の表で動き始めた時刻のまま）', () => {
    getApiKeyStore(env(), T0);
    replace('{ broken');
    getApiKeyStore(env(), T0 + 1000);
    replace('{ still broken');
    getApiKeyStore(env(), T0 + 20_000);
    expect(apiKeyTableStatus(env(), T0 + 61_000)).toMatchObject({ stale: true, staleSeconds: 60 });
  });

  test('直れば stale ではなくなり、新しい表の数になる', () => {
    getApiKeyStore(env(), T0);
    replace('{ broken');
    getApiKeyStore(env(), T0 + 1000);
    expect(apiKeyTableStatus(env(), T0 + 5000)).toMatchObject({ stale: true });
    replace([row('bob', KEY_B), row('carol', KEY_C)]);
    getApiKeyStore(env(), T0 + 100_000);
    expect(apiKeyTableStatus(env(), T0 + 100_000)).toEqual({ keys: 2, tenants: 2, stale: false, staleSeconds: 0 });
  });

  test('ファイルが消えた間も stale。同じファイルが戻れば（置き換えの途中だけ消えていた）、stale ではない', () => {
    loadApiKeyStore(path, T0);
    const gone: KeyFileFs = { stat: () => { throw errno('ENOENT'); }, read: realFs.read };
    loadApiKeyStore(path, T0 + 1000, gone);
    expect(apiKeyTableStatus(env(), T0 + 31_000)).toEqual({ keys: 1, tenants: 1, stale: true, staleSeconds: 30 });
    loadApiKeyStore(path, T0 + 32_000); // 同じファイルが戻った（署名が同じ）
    expect(apiKeyTableStatus(env(), T0 + 32_000)).toEqual({ keys: 1, tenants: 1, stale: false, staleSeconds: 0 });
  });

  test('最初の読み込みが誤りで表が無いときは、undefined（前の表が無いので、前の鍵で動いているとは言わない）', () => {
    replace('{ broken');
    expect(() => getApiKeyStore(env(), T0)).toThrow();
    expect(() => getApiKeyStore(env(), T0 + 2000)).toThrow();
    expect(apiKeyTableStatus(env(), T0 + 5000)).toBeUndefined();
  });

  test('時計が戻っても、経過の秒数は負にならない。数でない時刻は、いまの時刻として扱う', () => {
    getApiKeyStore(env(), T0);
    replace('{ broken');
    getApiKeyStore(env(), T0 + 10_000);
    expect(apiKeyTableStatus(env(), T0)).toMatchObject({ stale: true, staleSeconds: 0 });
    const status = apiKeyTableStatus(env(), Number.NaN);
    expect(status?.stale).toBe(true);
    expect(Number.isInteger(status?.staleSeconds)).toBe(true);
  });

  test('聞いても、ファイルを読み直さず、数えず、ログも出さない（最後の確認の結果を返すだけ）', () => {
    getApiKeyStore(env(), T0);
    logs.length = 0;
    resetSecurityMetrics();
    replace('{ broken'); // 壊すが、確認はまだ起きていない
    expect(apiKeyTableStatus(env(), T0 + 60_000)).toMatchObject({ stale: false });
    expect(logs).toEqual([]);
    expect(getSecurityMetrics()).toEqual({});
  });
});
