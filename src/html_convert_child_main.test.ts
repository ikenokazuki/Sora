import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConvertChild } from './html_convert_child_main.js';
import { type ConvertRequest, ConvertDoneSchema, ConvertErrorSchema, encodeConvertRequest } from './html_convert_protocol.js';
import { convertHtmlToMarkdown, conversionHooks } from './html_parser.js';
import { incrementSecurityCounter } from './security/metrics.js';

/**
 * HTML の変換の別プロセスの中身（html_convert_child_main.ts の runConvertChild）。ここでは、同じプロセスの中で呼んで、
 * 頼み方の読み方・結果の行・本文の抽出の扱いを確かめる。本物の子プロセスとの通しは html_convert.test.ts にある。
 */

const dir = mkdtempSync(join(tmpdir(), 'sora-convert-child-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 本物の rs-trafilatura の代わりに、決まった JSON を返すコマンド */
const fakeRs = (name: string, json: string): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${json}'\n`);
  chmodSync(path, 0o755);
  return path;
};

const PAGE = `<html><head><title>題名</title><meta name="description" content="説明の文です。"></head><body><main>${'<p>これは本文の段落です。<a href="/next">次の記事</a>への案内と、ふつうの長さの文章が続きます。</p>'.repeat(10)}<img src="/a.jpg" alt="写真の説明です"><table><tr><th>項目</th><th>値</th></tr><tr><td>A</td><td>1</td></tr></table></main><script type="application/ld+json">{"@type":"Article","headline":"題名"}</script></body></html>`;
const ALL: ConvertRequest['want'] = { links: true, images: true, jsonLd: true, tables: true, html: true };
const request = (over: Partial<ConvertRequest> = {}): ConvertRequest => ({ v: 1, url: 'https://example.com/a', maxChars: 10_000, isRendered: false, onlyMainContent: true, want: ALL, ...over });

async function run(bytes: Uint8Array, options?: Parameters<typeof runConvertChild>[2]): Promise<string[]> {
  const lines: string[] = [];
  await runConvertChild(bytes, (line) => void lines.push(line), options);
  return lines;
}
const bytesOf = async (req: ConvertRequest, html = PAGE): Promise<Uint8Array> => new Uint8Array(await encodeConvertRequest(req, html).arrayBuffer());
const doneOf = (lines: string[]) => {
  expect(lines).toHaveLength(1);
  expect(lines[0]!.endsWith('\n')).toBe(true);
  return ConvertDoneSchema.parse(JSON.parse(lines[0]!));
};

describe('runConvertChild（頼み方を読み、変換して、結果を 1 行で返す）', () => {
  test('本体の中の変換と同じ結果を、親が検査する形（ConvertDoneSchema）の 1 行で返す', async () => {
    const done = doneOf(await run(await bytesOf(request())));
    const inline = convertHtmlToMarkdown(PAGE, 'https://example.com/a', 10_000, false, true);
    expect(done.result.markdown).toBe(inline.markdown);
    expect(done.result.title).toBe('題名');
    expect(done.result.links).toEqual(inline.links);
    expect(done.result.tables).toEqual(inline.tables);
    expect(done.rsUnavailable).toEqual([]);
  });

  test('頼まれていない大きな欄（links・images・jsonLd・tables・html）は返さない（links は空の配列）', async () => {
    const done = doneOf(await run(await bytesOf(request({ want: { links: false, images: false, jsonLd: false, tables: false, html: false } }))));
    expect(done.result.links).toEqual([]);
    expect(done.result.images).toBeUndefined();
    expect(done.result.jsonLd).toBeUndefined();
    expect(done.result.tables).toBeUndefined();
    expect(done.result.html).toBeUndefined();
    expect(done.result.markdown).toContain('これは本文の段落です');
  });

  test('頼み方の引数（maxChars・onlyMainContent・stripLinks）を、変換にそのまま渡す', async () => {
    const done = doneOf(await run(await bytesOf(request({ maxChars: 30, onlyMainContent: false, stripLinks: true }))));
    const inline = convertHtmlToMarkdown(PAGE, 'https://example.com/a', 30, false, false, undefined, undefined, true);
    expect(done.result.markdown).toBe(inline.markdown);
    expect(done.result.isTruncated).toBe(true);
  });

  test('変換の重い段階の前に、渡した gc を呼び、終わったら合図を外す', async () => {
    let calls = 0;
    doneOf(await run(await bytesOf(request()), { gc: () => void calls++ }));
    expect(calls).toBe(2);
    expect(conversionHooks.beforeHeavyStage).toBeUndefined();
  });

  test('本文の抽出（rs-trafilatura）を頼まれたら、子の中で動かし、その本文で変換する', async () => {
    const bin = fakeRs('listing', '{"page_type":"listing","content_html":"<ul><li>抽出した予定の一覧です。今月の公演の予定をまとめました。</li></ul>"}');
    const done = doneOf(await run(await bytesOf(request({ mainContent: { bin } }))));
    expect(done.result.markdown).toContain('抽出した予定の一覧です');
  });

  test('本文の抽出が空を返したら、数えたカウンター（sora_main_content_rs_*）を親に渡す。それ以外の名前は渡さない', async () => {
    const bin = fakeRs('empty', '{"page_type":"article","content_html":""}');
    const done = doneOf(await run(await bytesOf(request({ mainContent: { bin } }))));
    expect(done.counters).toEqual({ sora_main_content_rs_empty_total: 1 });
  });

  test('頼み方が読めないときは、error の 1 行を返す（変換しない）', async () => {
    const lines = await run(new TextEncoder().encode('{"v":2}\n<p>x</p>'));
    expect(lines).toHaveLength(1);
    expect(ConvertErrorSchema.parse(JSON.parse(lines[0]!)).t).toBe('error');
    expect((await run(new TextEncoder().encode('改行の無い入力'))).map((line) => JSON.parse(line).t)).toEqual(['error']);
  });

  test('書き込みに失敗しても（親が先に死んだ）、投げない', async () => {
    await runConvertChild(await bytesOf(request()), () => {
      throw new Error('EPIPE');
    });
  });
});

describe('runConvertChild のカウンター（親の /metrics に足すもの）', () => {
  test('この変換の間に増えた分だけを渡す（前から数えてあった分は渡さない）。本文の抽出の名前の形だけ・1 つ 10 までに切る', async () => {
    incrementSecurityCounter('sora_main_content_rs_empty_total', 5);
    const bin = fakeRs('empty-again', '{"page_type":"article","content_html":""}');
    const done = doneOf(
      await run(await bytesOf(request({ mainContent: { bin } })), {
        gc: () => {
          incrementSecurityCounter('sora_unrelated_counter_total');
          incrementSecurityCounter('sora_main_content_rs_probe_total', 20);
        },
      }),
    );
    expect(done.counters).toEqual({ sora_main_content_rs_empty_total: 1, sora_main_content_rs_probe_total: 10 });
  });
});
