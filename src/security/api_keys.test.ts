import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeyStore, digestOf, getApiKeyStore, loadApiKeyStore, parseApiKeyFile, resetApiKeyStoreCache } from './api_keys.js';

const KEY_A = 'alice-key-0123456789abcdef';
const KEY_B = 'bob-key-0123456789abcdefgh';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const file = (keys: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ keys, ...extra });

describe('parseApiKeyFile: 正しい鍵ファイル', () => {
  test('平文の key と、ハッシュの keyHash を、1 行ごとに、どちらかで書ける', () => {
    const { entries, errors } = parseApiKeyFile(file([{ name: 'alice', key: KEY_A }, { name: 'bob', keyHash: `sha256:${sha(KEY_B)}` }]));
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { name: 'alice', digest: sha(KEY_A), plain: true },
      { name: 'bob', digest: sha(KEY_B), plain: false },
    ]);
  });

  test('keyHash の 16 進は、大文字でも書ける（小文字にそろえる）', () => {
    const { entries, errors } = parseApiKeyFile(file([{ name: 'bob', keyHash: `sha256:${sha(KEY_B).toUpperCase()}` }]));
    expect(errors).toEqual([]);
    expect(entries[0].digest).toBe(sha(KEY_B));
  });

  test('同じ name を複数の行に書ける（鍵の入れ替えの移行期。どちらの鍵も同じ tenant）', () => {
    const { entries, errors } = parseApiKeyFile(file([{ name: 'alice', key: KEY_A }, { name: 'alice', key: KEY_B }]));
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.name)).toEqual(['alice', 'alice']);
  });

  test('name は、英小文字・数字・-・_ の 1〜64 字（先頭は英小文字か数字）', () => {
    for (const name of ['a', '0', 'alice', 'team-1', 'team_2', 'a'.repeat(64), '1abc']) {
      expect(parseApiKeyFile(file([{ name, key: KEY_A }])).errors, name).toEqual([]);
    }
  });

  test('key は、16〜256 字の、空白を含まない ASCII の印字可能な文字', () => {
    for (const key of ['a'.repeat(16), 'a'.repeat(256), 'AbC-_.~+/=0123456789!#$%&()*,:;<>?@[]^`{|}']) {
      expect(parseApiKeyFile(file([{ name: 'alice', key: key.padEnd(16, 'x') }])).errors, key).toEqual([]);
    }
  });
});

describe('parseApiKeyFile: 誤り（すべてを一度に知らせ、1 つでもあれば、鍵を返さない）', () => {
  const errorsOf = (text: string) => parseApiKeyFile(text).errors;

  test('JSON として読めない', () => {
    expect(errorsOf('{')).toEqual(['JSON として読めません（カンマ・引用符・括弧を確かめてください）']);
    expect(errorsOf('')).toEqual(['JSON として読めません（カンマ・引用符・括弧を確かめてください）']);
  });

  test('最上位は {"keys": [...]} の形', () => {
    for (const text of ['[]', 'null', '"x"', '1', '[{"name":"a","key":"' + KEY_A + '"}]']) {
      expect(errorsOf(text), text).toEqual(['最上位は {"keys": [{"name": …, "key": …}, …]} の形にしてください']);
    }
    expect(errorsOf('{}')).toEqual(['最上位に keys（配列）がありません']);
    expect(errorsOf('{"keys": {}}')).toEqual(['keys は配列にしてください']);
  });

  test('鍵が 1 つも無いと、誰も使えないので、誤り', () => {
    expect(errorsOf(file([]))).toEqual(['鍵が 1 つもありません（鍵ファイルを設定したときは、1 つ以上の鍵が要ります。匿名にはしません）']);
  });

  test('未対応の項目は、誤り（あとの版が足す limits・admin を、古い版が黙って無視しない）', () => {
    expect(errorsOf(file([{ name: 'alice', key: KEY_A }], { limits: {} }))).toEqual(['最上位に、未対応の項目 limits があります（対応しているのは keys だけ）']);
    expect(errorsOf(file([{ name: 'alice', key: KEY_A, admin: true, limits: {} }]))).toEqual([
      'keys[0] に、未対応の項目 admin があります（対応しているのは name・key・keyHash）',
      'keys[0] に、未対応の項目 limits があります（対応しているのは name・key・keyHash）',
    ]);
  });

  test('行がオブジェクトでない', () => {
    for (const row of ['x', 1, null, [], true]) expect(errorsOf(file([row])), JSON.stringify(row)).toEqual(['keys[0] はオブジェクトにしてください']);
  });

  test('name がない・文字列でない・形が違う', () => {
    expect(errorsOf(file([{ key: KEY_A }]))).toEqual(['keys[0].name がありません']);
    for (const name of [1, null, true, ['a'], {}]) expect(errorsOf(file([{ name, key: KEY_A }])), JSON.stringify(name)).toEqual(['keys[0].name は文字列にしてください']);
    for (const name of ['', 'Alice', 'a b', 'a.b', '-a', '_a', 'é', 'a'.repeat(65), 'a/b', 'legacy name', ' alice']) {
      expect(errorsOf(file([{ name, key: KEY_A }])), name).toEqual(['keys[0].name は、英小文字・数字・-・_ の 1〜64 字にしてください（先頭は英小文字か数字）']);
    }
  });

  test('key か keyHash のどちらか 1 つだけを書く', () => {
    expect(errorsOf(file([{ name: 'alice' }]))).toEqual(['keys[0] に key か keyHash が要ります（どちらか 1 つ）']);
    expect(errorsOf(file([{ name: 'alice', key: KEY_A, keyHash: `sha256:${sha(KEY_A)}` }]))).toEqual(['keys[0] に key と keyHash の両方は書けません（どちらか 1 つ）']);
  });

  test('key の形: 16 字未満・257 字以上・空白・ASCII 以外・制御文字・文字列でない', () => {
    const message = 'keys[0].key は、16〜256 字の、空白を含まない ASCII の印字可能な文字にしてください';
    for (const key of ['a'.repeat(15), 'a'.repeat(257), 'aaaa aaaa aaaa aaaa', ' aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa ', 'aaaaaaaaaaaaaaaaé', 'aaaaaaaaaaaaaaaa\n', 'aaaaaaaaaaaaaaaa\t', 'aaaaaaaaaaaaaaaa\u0000']) {
      expect(errorsOf(file([{ name: 'alice', key }])), JSON.stringify(key)).toEqual([message]);
    }
    for (const key of [1, null, true, ['a'], {}]) expect(errorsOf(file([{ name: 'alice', key }])), JSON.stringify(key)).toEqual(['keys[0].key は文字列にしてください']);
  });

  test('keyHash の形: sha256: と 64 桁の 16 進', () => {
    const message = 'keys[0].keyHash は、sha256: と 64 桁の 16 進にしてください（printf %s "$KEY" | sha256sum の値）';
    const hex = sha(KEY_A);
    for (const keyHash of [hex, `sha256:${hex.slice(1)}`, `sha256:${hex}0`, `sha256:${hex.replace(/.$/, 'g')}`, `md5:${hex}`, `SHA256:${hex}`, `sha256: ${hex}`, '']) {
      expect(errorsOf(file([{ name: 'alice', keyHash }])), keyHash).toEqual([message]);
    }
    for (const keyHash of [1, null, true]) expect(errorsOf(file([{ name: 'alice', keyHash }])), JSON.stringify(keyHash)).toEqual(['keys[0].keyHash は文字列にしてください']);
  });

  test('同じ鍵が 2 回（同じ鍵が別の tenant になるのを防ぐ）。平文とそのハッシュも同じ鍵', () => {
    expect(errorsOf(file([{ name: 'alice', key: KEY_A }, { name: 'bob', key: KEY_A }]))).toEqual(['keys[1] の鍵は、keys[0] と同じです']);
    expect(errorsOf(file([{ name: 'alice', key: KEY_A }, { name: 'alice', keyHash: `sha256:${sha(KEY_A)}` }]))).toEqual(['keys[1] の鍵は、keys[0] と同じです']);
    expect(errorsOf(file([{ name: 'a', key: KEY_A }, { name: 'b', key: KEY_B }, { name: 'c', key: KEY_B }]))).toEqual(['keys[2] の鍵は、keys[1] と同じです']);
  });

  test('誤りは、すべてを一度に知らせ、鍵は 1 つも返さない', () => {
    const { entries, errors } = parseApiKeyFile(file([{ name: 'alice', key: KEY_A }, { name: 'Bob', key: 'short' }, { name: 'carol' }, 'x']));
    expect(entries).toEqual([]);
    expect(errors).toEqual([
      'keys[1].name は、英小文字・数字・-・_ の 1〜64 字にしてください（先頭は英小文字か数字）',
      'keys[1].key は、16〜256 字の、空白を含まない ASCII の印字可能な文字にしてください',
      'keys[2] に key か keyHash が要ります（どちらか 1 つ）',
      'keys[3] はオブジェクトにしてください',
    ]);
  });

  test('未対応の項目の名前が、名前の形でない（空白・記号・41 字以上）ときは、文に入れない。名前の形（40 字まで）は、そのまま出す', () => {
    const odd = 'SECRET value with space';
    expect(parseApiKeyFile(JSON.stringify({ keys: [{ name: 'alice', key: KEY_A, [odd]: 1 }] })).errors).toEqual(['keys[0] に、未対応の項目 （読めない名前） があります（対応しているのは name・key・keyHash）']);
    expect(parseApiKeyFile(JSON.stringify({ keys: [{ name: 'alice', key: KEY_A }], [odd]: 1 })).errors).toEqual(['最上位に、未対応の項目 （読めない名前） があります（対応しているのは keys だけ）']);
    expect(parseApiKeyFile(JSON.stringify({ keys: [{ name: 'alice', key: KEY_A }], ['x'.repeat(41)]: 1 })).errors).toEqual(['最上位に、未対応の項目 （読めない名前） があります（対応しているのは keys だけ）']);
    expect(parseApiKeyFile(JSON.stringify({ keys: [{ name: 'alice', key: KEY_A }], ['x'.repeat(40)]: 1 })).errors).toEqual([`最上位に、未対応の項目 ${'x'.repeat(40)} があります（対応しているのは keys だけ）`]);
    expect(parseApiKeyFile(JSON.stringify({ keys: [{ name: 'alice', key: KEY_A, 'a.b-c_9': 1 }] })).errors).toEqual(['keys[0] に、未対応の項目 a.b-c_9 があります（対応しているのは name・key・keyHash）']);
  });

  test('誤りの文に、鍵の値もハッシュも、入れない（標準エラーに残るので）', () => {
    const secret = 'SECRET-value with space-0123456789';
    const texts = [
      file([{ name: 'alice', key: secret }]),
      file([{ name: 'alice', key: KEY_A, keyHash: `sha256:${sha(KEY_A)}` }]),
      file([{ name: 'alice', keyHash: `sha256:${sha(KEY_A)}x` }]),
      file([{ name: 'alice', key: KEY_A }, { name: 'bob', key: KEY_A }]),
      `{"keys": [{"name": "alice", "key": "${secret}"` /* 閉じていない */,
      file([{ name: 'alice', key: KEY_A, admin: KEY_B }]),
      file([{ name: KEY_A, key: KEY_B }]),
    ];
    for (const text of texts) {
      const message = parseApiKeyFile(text).errors.join('\n');
      expect(message, text).not.toContain('SECRET');
      for (const leaked of [secret, KEY_A, KEY_B, sha(KEY_A), sha(KEY_B)]) expect(message, text).not.toContain(leaked);
    }
  });
});

describe('ApiKeyStore.lookup: 提示された鍵から、tenant の name を引く', () => {
  const storeOf = (keys: unknown[]) => {
    const { entries, errors } = parseApiKeyFile(file(keys));
    expect(errors).toEqual([]);
    return new ApiKeyStore(entries);
  };

  test('平文の鍵でもハッシュの鍵でも引ける。知らない鍵・空・近い鍵は引けない', () => {
    const s = storeOf([{ name: 'alice', key: KEY_A }, { name: 'bob', keyHash: `sha256:${sha(KEY_B)}` }]);
    expect(s.lookup(KEY_A)).toBe('alice');
    expect(s.lookup(KEY_B)).toBe('bob');
    for (const miss of ['', ' ', KEY_A.slice(0, -1), `${KEY_A}x`, KEY_A.toUpperCase(), ` ${KEY_A}`, `${KEY_A} `, sha(KEY_B), `sha256:${sha(KEY_B)}`, 'unknown-key-0123456789abcdef']) {
      expect(s.lookup(miss), JSON.stringify(miss)).toBeUndefined();
    }
  });

  test('digestOf は、鍵の UTF-8 の SHA-256（小文字の 16 進）', () => {
    expect(digestOf(KEY_A)).toBe(sha(KEY_A));
  });

  test('同じ name の 2 つの鍵（鍵の入れ替えの移行期）は、どちらも同じ name を返す', () => {
    const s = storeOf([{ name: 'alice', key: KEY_A }, { name: 'alice', key: KEY_B }]);
    expect(s.lookup(KEY_A)).toBe('alice');
    expect(s.lookup(KEY_B)).toBe('alice');
    expect(s.size).toBe(2);
  });

  test('鍵が数千あっても、正しく引ける（表を引く。鍵の数に比例して調べない）', () => {
    const s = storeOf(Array.from({ length: 3000 }, (_, i) => ({ name: `t${i % 50}`, key: `generated-key-${String(i).padStart(6, '0')}-xxxxxxxx` })));
    expect(s.size).toBe(3000);
    expect(s.lookup('generated-key-002999-xxxxxxxx')).toBe('t49');
    expect(s.lookup('generated-key-003000-xxxxxxxx')).toBeUndefined();
  });

  test('names は、重複を除いた tenant の名前（並べ替え済み）', () => {
    const s = storeOf([{ name: 'bob', key: KEY_B }, { name: 'alice', key: KEY_A }, { name: 'bob', key: 'bob-second-key-0123456789' }]);
    expect(s.names()).toEqual(['alice', 'bob']);
  });
});

describe('loadApiKeyStore・getApiKeyStore: ファイルから', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sora-keys-'));
    resetApiKeyStoreCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetApiKeyStoreCache();
  });
  const write = (name: string, content: string, mode = 0o600) => {
    const path = join(dir, name);
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  };

  test('正しいファイルは、鍵の表になる（警告もなし）', () => {
    const path = write('ok.json', file([{ name: 'alice', key: KEY_A }]));
    const loaded = loadApiKeyStore(path);
    expect(loaded.errors).toEqual([]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.store?.lookup(KEY_A)).toBe('alice');
  });

  test('ファイルが無い・ディレクトリ・読めない: 誤り（匿名にはしない）。理由の種類と、パスを示す', () => {
    const missing = loadApiKeyStore(join(dir, 'nope.json'));
    expect(missing.store).toBeUndefined();
    expect(missing.errors).toEqual([`鍵ファイル（"${join(dir, 'nope.json')}"）を読めません（ENOENT）。パスと権限を確かめてください`]);
    const asDir = loadApiKeyStore(dir);
    expect(asDir.store).toBeUndefined();
    expect(asDir.errors[0]).toContain('EISDIR');
  });

  test('中身の誤りは、そのまま誤りとして返す（鍵の表は作らない）', () => {
    const path = write('bad.json', file([{ name: 'Alice', key: KEY_A }]));
    const loaded = loadApiKeyStore(path);
    expect(loaded.store).toBeUndefined();
    expect(loaded.errors).toEqual(['keys[0].name は、英小文字・数字・-・_ の 1〜64 字にしてください（先頭は英小文字か数字）']);
  });

  test('平文の鍵があるファイルを、所有者以外も読めるときは、警告する。ハッシュだけなら、警告しない', () => {
    const plain = loadApiKeyStore(write('plain.json', file([{ name: 'alice', key: KEY_A }]), 0o644));
    expect(plain.store).toBeDefined();
    expect(plain.warnings).toEqual([`鍵ファイル（"${join(dir, 'plain.json')}"）に平文の鍵があり、所有者以外も読めます（権限 644）。chmod 600 にするか、keyHash で書いてください`]);
    const group = loadApiKeyStore(write('group.json', file([{ name: 'alice', key: KEY_A }]), 0o640));
    expect(group.warnings).toHaveLength(1);
    const hashed = loadApiKeyStore(write('hashed.json', file([{ name: 'alice', keyHash: `sha256:${sha(KEY_A)}` }]), 0o644));
    expect(hashed.store).toBeDefined();
    expect(hashed.warnings).toEqual([]);
    const owner = loadApiKeyStore(write('owner.json', file([{ name: 'alice', key: KEY_A }]), 0o400));
    expect(owner.warnings).toEqual([]);
  });

  test('同じパスは、1 回だけ読んで覚える（起動の検査が読んだ表を、要求のたびに引き直さない）', () => {
    const path = write('cached.json', file([{ name: 'alice', key: KEY_A }]));
    const first = loadApiKeyStore(path);
    writeFileSync(path, file([{ name: 'bob', key: KEY_B }]));
    expect(loadApiKeyStore(path)).toBe(first);
    expect(loadApiKeyStore(path).store?.lookup(KEY_A)).toBe('alice');
    resetApiKeyStoreCache();
    expect(loadApiKeyStore(path).store?.lookup(KEY_B)).toBe('bob');
  });

  test('getApiKeyStore: SORA_AUTH_KEYS_FILE が無い（空白だけを含む）なら undefined。あれば鍵の表。誤りなら例外（読めない鍵ファイルを、匿名にしない）', () => {
    const path = write('env.json', file([{ name: 'alice', key: KEY_A }]));
    expect(getApiKeyStore({})).toBeUndefined();
    expect(getApiKeyStore({ SORA_AUTH_KEYS_FILE: '   ' })).toBeUndefined();
    expect(getApiKeyStore({ SORA_AUTH_KEYS_FILE: path })?.lookup(KEY_A)).toBe('alice');
    expect(getApiKeyStore({ SORA_AUTH_KEYS_FILE: `  ${path}  ` })?.lookup(KEY_A)).toBe('alice');
    expect(() => getApiKeyStore({ SORA_AUTH_KEYS_FILE: join(dir, 'nope.json') })).toThrow('ENOENT');
    const bad = write('bad2.json', '{');
    expect(() => getApiKeyStore({ SORA_AUTH_KEYS_FILE: bad })).toThrow('JSON として読めません');
  });
});
