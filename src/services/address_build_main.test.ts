import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHIYODA_LG, SMALL_MINIMUM, abrUrl, sampleUpstream } from '../test_fixtures/address/harness.js';
import { parseChildArgs, runChild } from './address_build_main.js';
import { AddressStore } from './address_store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-child-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseChildArgs', () => {
  test('--dir と --job からジョブを読む', () => {
    expect(parseChildArgs(['--dir', '/x', '--job', '{"kind":"master"}'])).toEqual({ dir: '/x', job: { kind: 'master' } });
    expect(parseChildArgs(['--job', '{"kind":"postal"}', '--dir', '/x'])).toEqual({ dir: '/x', job: { kind: 'postal' } });
    expect(parseChildArgs(['--dir', '/x', '--job', `{"kind":"city","lgCode":"${CHIYODA_LG}"}`]).job).toEqual({ kind: 'city', lgCode: CHIYODA_LG });
    expect(parseChildArgs(['--dir', '/x', '--job', `{"kind":"num","lgCode":"${CHIYODA_LG}"}`]).job).toEqual({ kind: 'num', lgCode: CHIYODA_LG });
  });

  test.each([
    [['--dir', '/x']],
    [['--job', '{"kind":"master"}']],
    [['--dir', '/x', '--job', '{not json']],
    [['--dir', '/x', '--job', '{"kind":"nothing"}']],
    [['--dir', '/x', '--job', '{"kind":"city","lgCode":"13101"}']],
    [['--dir', '/x', '--job', '{"kind":"city"}']],
    [['--dir', '/x', '--job', '{"kind":"num","lgCode":"abc"}']],
  ])('足りない引数・不正な JSON・不明なジョブ・不正な市区町村コードを拒否する %j', (argv) => {
    expect(() => parseChildArgs(argv)).toThrow();
  });
});

describe('runChild', () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
  });
  const deps = (up = sampleUpstream()) => ({
    http: { fetchFn: up.fetchFn, sleep: async () => undefined },
    minimum: SMALL_MINIMUM,
    nowSeconds: () => 1_700_000_000,
    err: (line: string) => lines.push(line),
  });

  test('ジョブを実行して成果物を公開し、0 を返す', async () => {
    const code = await runChild(['--dir', dir, '--job', '{"kind":"master"}'], deps());
    expect(code).toBe(0);
    expect(new AddressStore(dir).current('master')).not.toBeNull();
    expect(lines).toEqual([]);
  });

  test('国外 IP の拒否（403）は 3 を返して、メッセージを出す', async () => {
    const up = sampleUpstream();
    up.set(abrUrl(`mt_town/city/mt_town_city${CHIYODA_LG}`), { body: '', status: 403 });
    const code = await runChild(['--dir', dir, '--job', `{"kind":"city","lgCode":"${CHIYODA_LG}"}`], deps(up));
    expect(code).toBe(3);
    expect(lines.join('\n')).toContain('HTTP 403');
  });

  test('それ以外の失敗は 1 を返す', async () => {
    const code = await runChild(['--dir', dir, '--job', '{"kind":"city","lgCode":"999999"}'], deps());
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('999999');
  });

  test('引数が不正なら 2 を返す', async () => {
    expect(await runChild(['--dir', dir], deps())).toBe(2);
    expect(lines.join('\n')).toContain('usage');
  });
});

describe('子プロセスとして起動する', () => {
  test('入口は単体で起動でき、引数が不正なら 2 で終わる', async () => {
    const entry = new URL('./address_build_main.ts', import.meta.url).pathname;
    const proc = Bun.spawn([process.execPath, entry, '--dir', dir], { stdout: 'ignore', stderr: 'pipe' });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(stderr).toContain('usage');
  });
});
