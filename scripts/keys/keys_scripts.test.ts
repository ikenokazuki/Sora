import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeyStore, parseApiKeyFile } from '../../src/security/api_keys.js';

/**
 * deploy/issue-key.sh と deploy/revoke-key.sh(docs/operations/vps.md の「鍵の発行と失効」)。
 * 作ったファイルを、Sora 自身の読み込み(parseApiKeyFile)で読んで確かめる。書き方が変わって Sora が読めなくなったら、ここで落ちる。
 * jq と flock が要る(無い機械では飛ばす。CI の ubuntu-latest には、どちらもある)。
 */

const ISSUE = new URL('../../deploy/issue-key.sh', import.meta.url).pathname;
const REVOKE = new URL('../../deploy/revoke-key.sh', import.meta.url).pathname;
const available = Boolean(Bun.which('jq') && Bun.which('flock'));

const run = async (script: string, dir: string, ...args: string[]) => {
  const proc = Bun.spawn(['bash', script, ...args], { env: { ...process.env, KEYS_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout: stdout.trim(), stderr, code };
};
const fileOf = (dir: string) => join(dir, 'keys.json');
const load = (dir: string) => {
  const parsed = parseApiKeyFile(readFileSync(fileOf(dir), 'utf8'));
  return { ...parsed, store: new ApiKeyStore(parsed.entries) };
};
const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'sora-keys-scripts-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe.skipIf(!available)('deploy/issue-key.sh', () => {
  test('鍵を 1 回だけ出し、ファイルにはハッシュだけを残す(権限 600)。Sora が読んで、その鍵を認める', async () => {
    await withDir(async (dir) => {
      const { stdout: key, code } = await run(ISSUE, dir, 'alice');
      expect(code).toBe(0);
      expect(key).toMatch(/^[0-9a-f]{48}$/);
      expect(readFileSync(fileOf(dir), 'utf8')).not.toContain(key);
      expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600);
      const { errors, store } = load(dir);
      expect(errors).toEqual([]);
      expect(store.lookupEntry(key)).toEqual({ name: 'alice', admin: false });
    });
  });

  test('admin を付けられる。同じ名前でもう 1 つ発行すると、どちらの鍵も使える(鍵の入れ替え)。発行のたびに、別の鍵', async () => {
    await withDir(async (dir) => {
      const ops = (await run(ISSUE, dir, 'ops', 'admin')).stdout;
      const first = (await run(ISSUE, dir, 'alice')).stdout;
      const second = (await run(ISSUE, dir, 'alice')).stdout;
      expect(new Set([ops, first, second]).size).toBe(3);
      const { errors, store } = load(dir);
      expect(errors).toEqual([]);
      expect(store.lookupEntry(ops)).toEqual({ name: 'ops', admin: true });
      expect(store.lookup(first)).toBe('alice');
      expect(store.lookup(second)).toBe('alice');
      expect(store.names()).toEqual(['alice', 'ops']);
    });
  });

  test('不正な名前や引数は断り、ファイルを変えない', async () => {
    await withDir(async (dir) => {
      await run(ISSUE, dir, 'alice');
      const before = readFileSync(fileOf(dir), 'utf8');
      for (const args of [['Bad Name'], ['-x'], ['a'.repeat(65)], ['alice', 'root'], ['UPPER']]) {
        const result = await run(ISSUE, dir, ...args);
        expect(result.code, JSON.stringify(args)).not.toBe(0);
        expect(result.stdout, JSON.stringify(args)).toBe('');
      }
      expect(readFileSync(fileOf(dir), 'utf8')).toBe(before);
    });
  });

  test('同時に 8 つ呼んでも、足した行が消えない(flock)。一時ファイルも残らない', async () => {
    await withDir(async (dir) => {
      await run(ISSUE, dir, 'ops', 'admin');
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => run(ISSUE, dir, `user${i}`)));
      expect(results.every((r) => r.code === 0)).toBe(true);
      const { errors, store } = load(dir);
      expect(errors).toEqual([]);
      expect(store.size).toBe(9);
      for (const [i, r] of results.entries()) expect(store.lookup(r.stdout), `user${i}`).toBe(`user${i}`);
      expect(readdirSync(dir).sort()).toEqual(['.lock', 'keys.json']);
    });
  });
});

describe.skipIf(!available)('deploy/revoke-key.sh', () => {
  test('その名前の鍵を全部消す。ほかの鍵は残る', async () => {
    await withDir(async (dir) => {
      const ops = (await run(ISSUE, dir, 'ops', 'admin')).stdout;
      const a1 = (await run(ISSUE, dir, 'alice')).stdout;
      const a2 = (await run(ISSUE, dir, 'alice')).stdout;
      const bob = (await run(ISSUE, dir, 'bob')).stdout;
      expect((await run(REVOKE, dir, 'alice')).code).toBe(0);
      const { errors, store } = load(dir);
      expect(errors).toEqual([]);
      expect(store.lookup(a1)).toBeUndefined();
      expect(store.lookup(a2)).toBeUndefined();
      expect(store.lookup(bob)).toBe('bob');
      expect(store.lookupEntry(ops)?.admin).toBe(true);
      expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600);
    });
  });

  test('最後の 1 件は消さない(Sora は鍵が 0 件のファイルを断るため)。ファイルは変わらない', async () => {
    await withDir(async (dir) => {
      const only = (await run(ISSUE, dir, 'only')).stdout;
      const before = readFileSync(fileOf(dir), 'utf8');
      const result = await run(REVOKE, dir, 'only');
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('0 件');
      expect(readFileSync(fileOf(dir), 'utf8')).toBe(before);
      expect(load(dir).store.lookup(only)).toBe('only');
      expect(readdirSync(dir).sort()).toEqual(['.lock', 'keys.json']);
    });
  });

  test('いない名前を消しても、ファイルの中身は変わらない', async () => {
    await withDir(async (dir) => {
      await run(ISSUE, dir, 'alice');
      const before = JSON.parse(readFileSync(fileOf(dir), 'utf8'));
      expect((await run(REVOKE, dir, 'nobody')).code).toBe(0);
      expect(JSON.parse(readFileSync(fileOf(dir), 'utf8'))).toEqual(before);
    });
  });
});
