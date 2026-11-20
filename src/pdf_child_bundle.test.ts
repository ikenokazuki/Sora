import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePdfToMarkdown } from './pdf.js';
import { makePdf } from './test_fixtures/pdf.js';

/**
 * 本番は、Containerfile の `bun build ./src/pdf_child_main.ts --target=bun --outfile=pdf-parse.js` でまとめた 1 つのファイルを、別プロセスで動かす。
 * まとめたあとも動くこと（import.meta.main の守り・unpdf の同梱・標準入出力の約束）を、同じ方法でまとめて確かめる。
 */
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sora-pdf-bundle-'));
  const built = await Bun.build({ entrypoints: [new URL('./pdf_child_main.ts', import.meta.url).pathname], target: 'bun', outdir: dir, naming: 'pdf-parse.js' });
  expect(built.success, built.logs.join('\n')).toBe(true);
  // 入口が無いと、standard はこのプロセスの中で解析する代わりの経路に入り、試験が意味を失う。実在を確かめる
  expect(existsSync(join(dir, 'pdf-parse.js'))).toBe(true);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('まとめた pdf-parse.js（本番と同じ形）', () => {
  test('まとめたファイルを入口にして、PDF を読める（結果は、TypeScript の入口と同じ）', async () => {
    const make = () => makePdf([['Hello bundled child'], ['second page']], { title: 'Bundle Title', author: 'Bundle Author' });
    const bundled = await parsePdfToMarkdown(make(), 'https://x.example/a.pdf', 30_000, { child: { entryDir: dir } });
    const source = await parsePdfToMarkdown(make(), 'https://x.example/a.pdf', 30_000);
    expect(bundled.content).toContain('Hello bundled child');
    expect(bundled).toEqual(source);
  });

  test('まとめたファイルでも、壊れた PDF は pdf.js の例外のまま失敗する', async () => {
    const error = await parsePdfToMarkdown(new TextEncoder().encode('not a pdf'), 'https://x.example/a.pdf', 30_000, { child: { entryDir: dir } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe('PdfParseLimitError');
    expect((error as Error).message.length).toBeGreaterThan(0);
  });
});
