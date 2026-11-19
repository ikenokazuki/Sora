import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getApiKeyStore, type KeyFileFs, loadApiKeyStore, resetApiKeyStoreCache } from './api_keys.js';
import { getSecurityMetrics, resetSecurityMetrics } from './metrics.js';

/**
 * 鍵ファイル（SORA_AUTH_KEYS_FILE）の再読み込み（再起動なしで、鍵を足す・消す）。
 * ファイルの変更は、1 秒に 1 回まで調べる。読み直しに失敗したら、前の表を使い続ける（匿名にしない）。
 * 時刻は引数で渡す（本物の待ちを避ける）。
 */

const KEY_A = 'alice-key-0123456789abcdef';
const KEY_B = 'bob-key-0123456789abcdefgh';
const KEY_C = 'carol-key-0123456789abcdefg';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const row = (name: string, key: string, extra: Record<string, unknown> = {}) => ({ name, keyHash: `sha256:${sha(key)}`, ...extra });
const file = (keys: unknown[]) => JSON.stringify({ keys });

const T0 = 1_000_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const realFs: KeyFileFs = { stat: (p) => statSync(p), read: (p) => readFileSync(p, 'utf8') };
const errno = (code: string) => Object.assign(new Error(code), { code });
let dir: string;
let path: string;
let logs: string[];
let restore: Array<() => void>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-keys-reload-'));
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

describe('鍵ファイルの再読み込み', () => {
  test('変えても、1 秒のうちは、読み直さない（調べるのは 1 秒に 1 回まで）', () => {
    const first = getApiKeyStore(env(), T0);
    expect(first?.lookup(KEY_A)).toBe('alice');
    replace([row('alice', KEY_A), row('bob', KEY_B)]);
    expect(getApiKeyStore(env(), T0 + 999)).toBe(first);
    expect(getApiKeyStore(env(), T0 + 999)?.lookup(KEY_B)).toBeUndefined();
  });

  test('1 秒たつと、変わったファイルを読み直す: 足した鍵が通り、消した鍵は断られる', () => {
    expect(getApiKeyStore(env(), T0)?.lookup(KEY_A)).toBe('alice');
    replace([row('bob', KEY_B), row('carol', KEY_C)]);
    const after = getApiKeyStore(env(), T0 + 1000);
    expect(after?.lookup(KEY_B)).toBe('bob');
    expect(after?.lookup(KEY_C)).toBe('carol');
    expect(after?.lookup(KEY_A)).toBeUndefined();
    expect(after?.size).toBe(2);
  });

  test('その場で書き換えた（置き換えでない）ときも、読み直す', () => {
    expect(getApiKeyStore(env(), T0)?.lookup(KEY_B)).toBeUndefined();
    writeFileSync(path, file([row('alice', KEY_A), row('bob', KEY_B)]), { mode: 0o600 });
    expect(getApiKeyStore(env(), T0 + 1000)?.lookup(KEY_B)).toBe('bob');
  });

  test('admin の付け外しも、読み直すと効く', () => {
    expect(getApiKeyStore(env(), T0)?.lookupEntry(KEY_A)).toEqual({ name: 'alice', admin: false });
    replace([row('alice', KEY_A, { admin: true })]);
    expect(getApiKeyStore(env(), T0 + 1000)?.lookupEntry(KEY_A)).toEqual({ name: 'alice', admin: true });
    replace([row('alice', KEY_A)]);
    expect(getApiKeyStore(env(), T0 + 2000)?.lookupEntry(KEY_A)).toEqual({ name: 'alice', admin: false });
  });

  test('変わっていなければ、何度確かめても、同じ表のまま（読み直さない）', () => {
    const first = getApiKeyStore(env(), T0);
    for (const at of [1000, 2000, 5000, 60_000]) expect(getApiKeyStore(env(), T0 + at)).toBe(first);
    expect(getSecurityMetrics().sora_auth_keys_reload_total).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test('読み直したことを、ログと数に残す（鍵の数と利用者の数。鍵の値は出さない）', () => {
    getApiKeyStore(env(), T0);
    replace([row('alice', KEY_A), row('bob', KEY_B), row('bob', KEY_C)]);
    getApiKeyStore(env(), T0 + 1000);
    expect(getSecurityMetrics().sora_auth_keys_reload_total).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('鍵ファイルを読み直しました');
    expect(logs[0]).toContain('鍵 3 件');
    expect(logs[0]).toContain('利用者 2 人');
    for (const secret of [KEY_A, KEY_B, KEY_C, sha(KEY_A), sha(KEY_B)]) expect(logs.join('\n')).not.toContain(secret);
  });

  test('読み直しに失敗したら（JSON の誤り・name の誤り・鍵が 0 件）、前の表を使い続ける。匿名にも、断りにもしない', () => {
    const first = getApiKeyStore(env(), T0);
    let at = T0;
    for (const bad of ['{ not json', file([{ name: 'Alice', keyHash: `sha256:${sha(KEY_B)}` }]), file([])]) {
      replace(bad);
      at += 1000;
      const kept = getApiKeyStore(env(), at);
      expect(kept).toBe(first);
      expect(kept?.lookup(KEY_A)).toBe('alice');
    }
    expect(getSecurityMetrics().sora_auth_keys_reload_failed_total).toBe(3);
  });

  test('失敗の理由は、1 回だけ出す。同じファイルを、何度も読み直さず、ログも繰り返さない', () => {
    getApiKeyStore(env(), T0);
    replace(file([{ name: 'Alice', keyHash: `sha256:${sha(KEY_B)}` }]));
    for (const at of [1000, 2000, 3000, 10_000]) getApiKeyStore(env(), T0 + at);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('読み直せませんでした');
    expect(logs[0]).toContain('前の鍵を使い続けます');
    expect(logs[0]).toContain('keys[0].name');
    expect(getSecurityMetrics().sora_auth_keys_reload_failed_total).toBe(1);
  });

  test('直せば、次の確認で戻る(再起動しない)', () => {
    getApiKeyStore(env(), T0);
    replace('{ broken');
    getApiKeyStore(env(), T0 + 1000);
    replace([row('bob', KEY_B)]);
    const fixed = getApiKeyStore(env(), T0 + 2000);
    expect(fixed?.lookup(KEY_B)).toBe('bob');
    expect(fixed?.lookup(KEY_A)).toBeUndefined();
    expect(getSecurityMetrics()).toMatchObject({ sora_auth_keys_reload_failed_total: 1, sora_auth_keys_reload_total: 1 });
  });

  test('ファイルが消えたら（置き換えの途中）、前の表を使い続け、1 回だけ警告する。戻ったら、読み直す', () => {
    const first = getApiKeyStore(env(), T0);
    unlinkSync(path);
    for (const at of [1000, 2000, 3000]) expect(getApiKeyStore(env(), T0 + at)).toBe(first);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('見つかりません');
    writeFileSync(path, file([row('bob', KEY_B)]), { mode: 0o600 });
    expect(getApiKeyStore(env(), T0 + 4000)?.lookup(KEY_B)).toBe('bob');
  });

  test('消える → 戻る → また消えるときは、2 度目の警告も出す(戻ったことを覚えて、知らせ直す)', () => {
    getApiKeyStore(env(), T0);
    unlinkSync(path);
    getApiKeyStore(env(), T0 + 1000);
    writeFileSync(path, file([row('alice', KEY_A)]), { mode: 0o600 });
    getApiKeyStore(env(), T0 + 2000);
    unlinkSync(path);
    getApiKeyStore(env(), T0 + 3000);
    expect(logs.filter((line) => line.includes('見つかりません'))).toHaveLength(2);
  });

  test('確認の間隔は、確認のたびに数え直す(確認した時刻から 1 秒のうちは、また変わっても、調べない)', () => {
    getApiKeyStore(env(), T0);
    replace([row('bob', KEY_B)]);
    expect(getApiKeyStore(env(), T0 + 1000)?.lookup(KEY_B)).toBe('bob');
    replace([row('carol', KEY_C)]);
    expect(getApiKeyStore(env(), T0 + 1500)?.lookup(KEY_C)).toBeUndefined();
    expect(getApiKeyStore(env(), T0 + 2000)?.lookup(KEY_C)).toBe('carol');
  });

  test('最初の読み込みが失敗していても（起動の検査を通さない経路）、直せば、再起動なしで使えるようになる', () => {
    writeFileSync(path, '{ broken', { mode: 0o600 });
    resetApiKeyStoreCache();
    expect(() => getApiKeyStore(env(), T0)).toThrow('JSON として読めません');
    // 同じ誤りのまま、1 秒たっても、例外のまま
    expect(() => getApiKeyStore(env(), T0 + 1000)).toThrow();
    replace([row('alice', KEY_A)]);
    expect(getApiKeyStore(env(), T0 + 2000)?.lookup(KEY_A)).toBe('alice');
  });

  test('時計が戻っても、調べる（戻った時刻のあとで、確認を止めたままにしない）', () => {
    getApiKeyStore(env(), T0 + 10_000);
    replace([row('bob', KEY_B)]);
    expect(getApiKeyStore(env(), T0)?.lookup(KEY_B)).toBe('bob');
  });

  test('読み直したとき、平文の鍵を所有者以外も読める警告を、ログに出す', () => {
    getApiKeyStore(env(), T0);
    const tmp = join(dir, 'p.tmp');
    writeFileSync(tmp, JSON.stringify({ keys: [{ name: 'alice', key: KEY_A }] }), { mode: 0o644 });
    renameSync(tmp, path);
    getApiKeyStore(env(), T0 + 1000);
    expect(logs.join('\n')).toContain('平文の鍵があり、所有者以外も読めます');
  });

  test('loadApiKeyStore（起動の検査が使う）も、同じ確認の間隔に従う。1 秒のうちは、同じ結果', () => {
    const first = loadApiKeyStore(path, T0);
    replace([row('bob', KEY_B)]);
    expect(loadApiKeyStore(path, T0 + 500)).toBe(first);
    expect(loadApiKeyStore(path, T0 + 1000).store?.lookup(KEY_B)).toBe('bob');
  });

  test('鍵ファイルを指定していなければ、undefined を返す', () => {
    expect(getApiKeyStore({}, T0)).toBeUndefined();
    expect(getApiKeyStore({ SORA_AUTH_KEYS_FILE: '  ' }, T0 + 5000)).toBeUndefined();
  });
});

describe('読む間の置き換え・一時的な失敗・古い表で動く間(独立したレビューの指摘)', () => {
  test('最初の読み込みの最中にファイルが置き換わっても、あとで追いつく(署名は、読む前に取る。古い内容に、新しい署名を付けて見逃さない)', () => {
    const racy: KeyFileFs = {
      stat: realFs.stat,
      read: (p) => {
        const text = realFs.read(p);
        replace([row('bob', KEY_B)]); // 読んだ直後に、置き換わる
        return text;
      },
    };
    const first = loadApiKeyStore(path, T0, racy);
    expect(first.store?.lookup(KEY_A)).toBe('alice'); // 古い内容を読んだ
    const later = loadApiKeyStore(path, T0 + 1000);
    expect(later.store?.lookup(KEY_B)).toBe('bob');
    expect(later.store?.lookup(KEY_A)).toBeUndefined();
  });

  test('読み直しの最中に置き換わっても、あとで追いつく', () => {
    loadApiKeyStore(path, T0);
    replace([row('bob', KEY_B)]);
    const racy: KeyFileFs = {
      stat: realFs.stat,
      read: (p) => {
        const text = realFs.read(p);
        replace([row('carol', KEY_C)]);
        return text;
      },
    };
    expect(loadApiKeyStore(path, T0 + 1000, racy).store?.lookup(KEY_B)).toBe('bob');
    expect(loadApiKeyStore(path, T0 + 2000).store?.lookup(KEY_C)).toBe('carol');
  });

  test('読み取りそのものの失敗(EMFILE など。一時的かもしれない)は、署名を覚えず、次の確認で再試行する。同じ理由は、繰り返し出さない', () => {
    loadApiKeyStore(path, T0);
    replace([row('bob', KEY_B)]);
    const flaky: KeyFileFs = { stat: realFs.stat, read: () => { throw errno('EMFILE'); } };
    expect(loadApiKeyStore(path, T0 + 1000, flaky).store?.lookup(KEY_A)).toBe('alice'); // 前の表のまま
    loadApiKeyStore(path, T0 + 2000, flaky);
    loadApiKeyStore(path, T0 + 3000, flaky);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('EMFILE');
    expect(logs[0]).toContain('前の鍵を使い続けます');
    expect(getSecurityMetrics().sora_auth_keys_reload_failed_total).toBe(1);
    // ファイルは正常。次に、読めるようになれば、追いつく(ファイルがもう一度変わるのを、待たない)
    expect(loadApiKeyStore(path, T0 + 4000).store?.lookup(KEY_B)).toBe('bob');
    expect(getSecurityMetrics().sora_auth_keys_reload_total).toBe(1);
  });

  test('調べるのに失敗した(EACCES など。親のディレクトリの権限)ときは、「見つかりません」と言わず、理由を示す。戻れば、追いつく', () => {
    loadApiKeyStore(path, T0);
    const denied: KeyFileFs = { stat: () => { throw errno('EACCES'); }, read: realFs.read };
    expect(loadApiKeyStore(path, T0 + 1000, denied).store?.lookup(KEY_A)).toBe('alice');
    loadApiKeyStore(path, T0 + 2000, denied);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('調べられません');
    expect(logs[0]).toContain('EACCES');
    expect(logs[0]).not.toContain('見つかりません');
    replace([row('bob', KEY_B)]);
    expect(loadApiKeyStore(path, T0 + 3000).store?.lookup(KEY_B)).toBe('bob');
  });

  test('ファイルが消えた回数を数える(消える → 戻る → また消える で、2 回)', () => {
    loadApiKeyStore(path, T0);
    unlinkSync(path);
    loadApiKeyStore(path, T0 + 1000);
    loadApiKeyStore(path, T0 + 2000);
    expect(getSecurityMetrics().sora_auth_keys_missing_total).toBe(1);
    writeFileSync(path, file([row('bob', KEY_B)]), { mode: 0o600 });
    loadApiKeyStore(path, T0 + 3000);
    unlinkSync(path);
    loadApiKeyStore(path, T0 + 4000);
    expect(getSecurityMetrics().sora_auth_keys_missing_total).toBe(2);
  });

  test('最初の読み込みが誤りで表が無いときは、確認の文で「前の鍵を使い続けます」と言わない(前の鍵が無い)。直れば、表ができる', () => {
    writeFileSync(path, '{ broken', { mode: 0o600 });
    resetApiKeyStoreCache();
    expect(() => getApiKeyStore(env(), T0)).toThrow();
    expect(() => getApiKeyStore(env(), T0 + 1000)).toThrow();
    unlinkSync(path);
    expect(() => getApiKeyStore(env(), T0 + 2000)).toThrow();
    expect(logs.filter((line) => line.includes('前の鍵を使い続けます'))).toEqual([]);
    writeFileSync(path, file([row('alice', KEY_A)]), { mode: 0o600 });
    expect(getApiKeyStore(env(), T0 + 3000)?.lookup(KEY_A)).toBe('alice');
  });

  test('now が数でなくても(NaN)、確認が止まらない(いまの時刻にする)', () => {
    loadApiKeyStore(path, Number.NaN);
    replace([row('bob', KEY_B)]);
    expect(loadApiKeyStore(path, T0).store?.lookup(KEY_B)).toBe('bob'); // いまの時刻より前の時刻でも、調べる
  });

  test('失敗の理由は、長くても、ログに出すのは先頭の一部だけ(巨大なファイルの誤りで、ログを埋めない)', () => {
    loadApiKeyStore(path, T0);
    replace(file(Array.from({ length: 5000 }, () => ({ name: 'Bad Name', keyHash: 'x' }))));
    loadApiKeyStore(path, T0 + 1000);
    expect(logs).toHaveLength(1);
    expect(logs[0].length).toBeLessThan(1700);
    expect(logs[0]).toContain('長いので');
  });

  test('古い表で動いている間は、1 分ごとに知らせる(消した鍵がまだ有効なことも)。直れば、止まる', () => {
    loadApiKeyStore(path, T0);
    replace('{ broken');
    loadApiKeyStore(path, T0 + 1000);
    expect(logs).toHaveLength(1);
    loadApiKeyStore(path, T0 + 30_000);
    expect(logs).toHaveLength(1);
    loadApiKeyStore(path, T0 + 61_000);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('1 分前から使えていません');
    expect(logs[1]).toContain('消した鍵');
    loadApiKeyStore(path, T0 + 62_000);
    expect(logs).toHaveLength(2);
    loadApiKeyStore(path, T0 + 121_000);
    expect(logs).toHaveLength(3);
    expect(logs[2]).toContain('2 分前から');
    replace([row('bob', KEY_B)]);
    loadApiKeyStore(path, T0 + 122_000);
    const afterFix = logs.length;
    loadApiKeyStore(path, T0 + 300_000);
    expect(logs).toHaveLength(afterFix);
  });

  test('ファイルが消えた間も、1 分ごとに知らせる。同じファイルが戻れば、止まる', () => {
    loadApiKeyStore(path, T0);
    const original = readFileSync(path, 'utf8');
    const before = statSync(path);
    unlinkSync(path);
    loadApiKeyStore(path, T0 + 1000);
    loadApiKeyStore(path, T0 + 61_000);
    expect(logs.filter((line) => line.includes('分前から使えていません'))).toHaveLength(1);
    writeFileSync(path, original, { mode: 0o600 });
    utimesSync(path, before.atime, before.mtime);
    loadApiKeyStore(path, T0 + 62_000);
    const count = logs.length;
    loadApiKeyStore(path, T0 + 200_000);
    expect(logs).toHaveLength(count);
  });

  test('同じ警告(平文の鍵を所有者以外も読める)は、読み直すたびに繰り返さない。消えて、また出るときは、もう一度出す', () => {
    loadApiKeyStore(path, T0);
    const plain = (keys: string) => {
      const tmp = join(dir, 'p.tmp');
      writeFileSync(tmp, keys, { mode: 0o644 });
      chmodSync(tmp, 0o644);
      renameSync(tmp, path);
    };
    const plainRows = (name: string, key: string) => JSON.stringify({ keys: [{ name, key }] });
    const warnings = () => logs.filter((line) => line.includes('平文の鍵があり')).length;
    plain(plainRows('alice', KEY_A));
    loadApiKeyStore(path, T0 + 1000);
    expect(warnings()).toBe(1);
    plain(plainRows('bob', KEY_B));
    loadApiKeyStore(path, T0 + 2000);
    expect(warnings()).toBe(1); // 同じ警告は、繰り返さない
    replace([row('carol', KEY_C)]); // ハッシュだけ(警告なし)
    loadApiKeyStore(path, T0 + 3000);
    plain(plainRows('bob', KEY_B));
    loadApiKeyStore(path, T0 + 4000);
    expect(warnings()).toBe(2); // 消えて、また出たので、もう一度
  });

  test('だれでも書ける鍵ファイルは、警告する(読み直しで、書ける人は、管理者の鍵を足せる)。起動の検査が出す警告にも入る', () => {
    chmodSync(path, 0o666);
    expect(loadApiKeyStore(path, T0).warnings.join('\n')).toContain('だれでも書けます');
    resetApiKeyStoreCache();
    chmodSync(path, 0o600);
    loadApiKeyStore(path, T0);
    const tmp = join(dir, 'w.tmp');
    writeFileSync(tmp, file([row('bob', KEY_B)]), { mode: 0o666 });
    chmodSync(tmp, 0o666);
    renameSync(tmp, path);
    loadApiKeyStore(path, T0 + 1000);
    expect(logs.join('\n')).toContain('だれでも書けます');
    // 自分だけが書けるなら、警告しない
    resetApiKeyStoreCache();
    chmodSync(path, 0o640);
    expect(loadApiKeyStore(path, T0).warnings).toEqual([]);
  });

  test('同じ大きさの鍵への交換(置き換え)も、読み直す(実際の鍵の更新の典型)', async () => {
    loadApiKeyStore(path, T0);
    await sleep(5);
    replace([row('alice', KEY_B)]); // 同じ name・同じ長さのハッシュ
    const after = loadApiKeyStore(path, T0 + 1000);
    expect(after.store?.lookup(KEY_B)).toBe('alice');
    expect(after.store?.lookup(KEY_A)).toBeUndefined();
  });

  test('その場で、同じ大きさに書き換え、更新時刻を元に戻しても、変更時刻が変わるので、読み直す', async () => {
    const before = statSync(path);
    loadApiKeyStore(path, T0);
    await sleep(5);
    writeFileSync(path, file([row('alice', KEY_B)]));
    expect(statSync(path).size).toBe(before.size);
    utimesSync(path, before.atime, before.mtime);
    expect(loadApiKeyStore(path, T0 + 1000).store?.lookup(KEY_B)).toBe('alice');
  });
});
