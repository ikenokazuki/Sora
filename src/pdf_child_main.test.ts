import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lowerOomPriority, parseChildParams, runChild } from './pdf_child_main.js';
import { makePdf } from './test_fixtures/pdf.js';

/** PDF の解析の子プロセスの入口（標準入力の PDF を読み、1 行ずつ JSON を返す）。親の側の検査は pdf_child.test.ts */

const ENTRY = new URL('./pdf_child_main.ts', import.meta.url).pathname;
const PARAMS = { pageLimit: 200, needed: 451_000, budgetMs: 15_000 };

const lines = async (bytes: Uint8Array, params = PARAMS): Promise<Array<Record<string, unknown>>> => {
  const out: string[] = [];
  await runChild(bytes, params, (line) => void out.push(line));
  return out.map((line) => {
    expect(line.endsWith('\n'), line).toBe(true);
    return JSON.parse(line) as Record<string, unknown>;
  });
};

describe('parseChildParams（--params の JSON を検査して読む）', () => {
  test('正しい JSON を読む', () => {
    expect(parseChildParams(['--no-env-file', 'x', '--params', JSON.stringify(PARAMS)])).toEqual(PARAMS);
  });

  test('無い・JSON でない・数でない・負の数は、断る', () => {
    expect(() => parseChildParams([])).toThrow('--params');
    expect(() => parseChildParams(['--params'])).toThrow('--params');
    expect(() => parseChildParams(['--params', '{not json'])).toThrow('JSON');
    expect(() => parseChildParams(['--params', JSON.stringify({ ...PARAMS, pageLimit: 'many' })])).toThrow('pageLimit');
    expect(() => parseChildParams(['--params', JSON.stringify({ ...PARAMS, needed: -1 })])).toThrow('needed');
    expect(() => parseChildParams(['--params', JSON.stringify({ pageLimit: 1, needed: 1 })])).toThrow('budgetMs');
    expect(() => parseChildParams(['--params', JSON.stringify([1, 2, 3])])).toThrow('オブジェクト');
    expect(() => parseChildParams(['--params', 'null'])).toThrow('オブジェクト');
  });

  test('JSON でも書ける巨大な数（1e999 は Infinity になる）は、断る', () => {
    expect(() => parseChildParams(['--params', '{"pageLimit":1,"needed":1,"budgetMs":1e999}'])).toThrow('budgetMs');
  });

  test('0 は受け入れる（時間の上限 0 は、1 ページも読まない）', () => {
    expect(parseChildParams(['--params', JSON.stringify({ pageLimit: 0, needed: 0, budgetMs: 0 })])).toEqual({ pageLimit: 0, needed: 0, budgetMs: 0 });
  });
});

describe('runChild（標準入力の PDF → open・page … → done。壊れた PDF は error）', () => {
  test('open・page・done を、この順に返す', async () => {
    const got = await lines(makePdf([['first line', 'second line'], ['next page']], { title: 'The Title', author: 'The Author' }));
    expect(got.map((g) => g.t)).toEqual(['open', 'page', 'page', 'done']);
    expect(got[0]).toMatchObject({ t: 'open', numPages: 2, info: { Title: 'The Title', Author: 'The Author' } });
    expect(got[1]).toMatchObject({ t: 'page', n: 1 });
    expect(String(got[1]?.text)).toContain('first line');
    expect(got[2]).toMatchObject({ t: 'page', n: 2 });
    expect(String(got[2]?.text)).toContain('next page');
    expect(got[3]).toEqual({ t: 'done', timeBudgetHit: false });
  });

  test('頼んだページ数（pageLimit）までで止める。必要な文字数（needed）に達したら残りは読まない', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => [`page ${i + 1} body `.padEnd(50, 'x')]);
    // pdf.js は渡されたバッファを使い切る（空にする）ので、実行ごとに作り直す
    const limited = await lines(makePdf(pages), { ...PARAMS, pageLimit: 2 });
    expect(limited.filter((g) => g.t === 'page')).toHaveLength(2);
    expect(limited[0]).toMatchObject({ numPages: 5 });
    const enough = await lines(makePdf(pages), { ...PARAMS, needed: 10 });
    expect(enough.filter((g) => g.t === 'page')).toHaveLength(1);
  });

  test('時間の上限 0 なら、1 ページも読まずに done（timeBudgetHit: true）', async () => {
    const got = await lines(makePdf([['body']]), { ...PARAMS, budgetMs: 0 });
    expect(got.map((g) => g.t)).toEqual(['open', 'done']);
    expect(got[1]).toEqual({ t: 'done', timeBudgetHit: true });
  });

  test('壊れた PDF は、例外にせず、error の行 1 つにする（pdf.js の名前と文のまま）', async () => {
    const got = await lines(new TextEncoder().encode('これは PDF ではありません'));
    expect(got).toHaveLength(1);
    // pdf.js の例外の名前を、そのまま返す（親が、このプロセスの中で解析したときと同じ名前で投げ直す）
    expect(got[0]).toMatchObject({ t: 'error', name: 'InvalidPDFException' });
    expect(String(got[0]?.message).length).toBeGreaterThan(0);
  });

  test('書き込みが失敗しても、例外を外に出さない（親が先に死んだとき）', async () => {
    const write = (): never => {
      throw new Error('EPIPE');
    };
    await expect(runChild(makePdf([['body']]), PARAMS, write)).resolves.toBeUndefined();
  });
});

describe('lowerOomPriority（メモリ不足で何かを殺すとき、本体より先に子を選ばせる）', () => {
  test('oom_score_adj に 1000 を書く。書けなければ false（例外にしない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sora-oom-'));
    try {
      const path = join(dir, 'oom_score_adj');
      writeFileSync(path, '0');
      expect(lowerOomPriority(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('1000');
      expect(lowerOomPriority(join(dir, 'no-such-dir', 'x'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('入口を実際に起動する（標準出力は結果の行だけ）', () => {
  const spawnChild = async (stdin: Uint8Array) => {
    const proc = Bun.spawn([process.execPath, '--no-env-file', ENTRY, '--params', JSON.stringify(PARAMS)], { stdin, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
  };

  test('pdf.js が警告を出す PDF でも、標準出力は JSON の行だけ（警告は標準エラーへ）。終了コードは 0', async () => {
    // 文書情報に Custom の辞書があると、pdf.js が「Warning: Bad value, for custom key…」を console.log で出す
    const pdf = makePdf([['body']], { title: 'T', custom: { Foo: 'bar' } });
    const { stdout, code } = await spawnChild(pdf);
    expect(code).toBe(0);
    const rows = stdout.trim().split('\n');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect(() => JSON.parse(row), row).not.toThrow();
    expect(rows.map((r) => (JSON.parse(r) as { t: string }).t)).toEqual(['open', 'page', 'done']);
  });

  test('console.log・info・debug・warn で書かれたものは、標準エラーへ。標準出力は結果の行だけ（pdf.js の版が上がって、警告の出し方が変わっても）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sora-pdf-noise-'));
    try {
      // 入口が console を付け替えたあと（標準入力を待っている間）に、別の部品が console に書く、を再現する
      const noise = join(dir, 'noise.ts');
      writeFileSync(noise, "setTimeout(() => { console.log('NOISE-LOG'); console.info('NOISE-INFO'); console.debug('NOISE-DEBUG'); console.warn('NOISE-WARN'); }, 50);");
      const proc = Bun.spawn([process.execPath, '--no-env-file', '--preload', noise, ENTRY, '--params', JSON.stringify(PARAMS)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      await Bun.sleep(400);
      proc.stdin.write(makePdf([['body']]));
      await proc.stdin.end();
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(0);
      for (const row of stdout.trim().split('\n')) expect(() => JSON.parse(row), row).not.toThrow();
      expect(stdout).not.toContain('NOISE');
      for (const word of ['NOISE-LOG', 'NOISE-INFO', 'NOISE-DEBUG', 'NOISE-WARN']) expect(stderr, word).toContain(word);
      expect(stdout.trim().split('\n').map((r) => (JSON.parse(r) as { t: string }).t)).toEqual(['open', 'page', 'done']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('モジュールとして読み込んだだけでは、何も始めない（標準入力を読まず、何も出さず、終わらない）。入口として起動したときだけ動く', async () => {
    const proc = Bun.spawn([process.execPath, '--no-env-file', '-e', `await import(${JSON.stringify(ENTRY)}); console.log('IMPORTED-OK');`], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(stdout).toBe('IMPORTED-OK\n');
    expect(code).toBe(0);
  });

  test('壊れた PDF は、error の行を 1 つ返して、終了コード 0', async () => {
    const { stdout, code } = await spawnChild(new TextEncoder().encode('not a pdf'));
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({ t: 'error', name: 'InvalidPDFException' });
  });

  test('--params が無ければ、error の行を返して終わる（頼み方が分からないまま、PDF を読まない）', async () => {
    const proc = Bun.spawn([process.execPath, '--no-env-file', ENTRY], { stdin: makePdf([['body']]), stdout: 'pipe', stderr: 'pipe' });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(JSON.parse(stdout.trim())).toMatchObject({ t: 'error' });
  });
});
