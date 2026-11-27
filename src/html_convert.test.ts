import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConvertLimitError, convertChildConcurrency, convertChildLimits, convertChildMemoryMb, convertPage, convertSlots, convertsInChild, countTagsUpTo, rememberLast, resetConvertWarnings, RS_UNAVAILABLE_WARNINGS, STANDARD_CHILD_MIN_TAGS } from './html_convert.js';
import { convertHtmlToMarkdown } from './html_parser.js';
import { detectMemoryLimitBytes } from './memory_limit.js';
import { getSecurityMetrics } from './security/metrics.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('機械のメモリから決める値（cgroup の上限と搭載メモリの小さい方）', () => {
  test('同時に動かす変換の子は、4GB 以上なら 2、それ未満と分からないときは 1（今のやり方〔本体で 1 件ずつ〕よりメモリの最大を増やさない）', () => {
    expect(convertChildConcurrency(undefined)).toBe(1);
    expect(convertChildConcurrency(1 * GB)).toBe(1);
    expect(convertChildConcurrency(4 * GB - 1)).toBe(1);
    expect(convertChildConcurrency(4 * GB)).toBe(2);
    expect(convertChildConcurrency(64 * GB)).toBe(2);
  });

  test('1 件の子のメモリの上限は、機械のメモリの 25%（256〜1,024 MB に丸める）。分からないときは 1,024 MB', () => {
    expect(convertChildMemoryMb(undefined)).toBe(1024);
    expect(convertChildMemoryMb(512 * MB)).toBe(256);
    expect(convertChildMemoryMb(1 * GB)).toBe(256);
    expect(convertChildMemoryMb(1.5 * GB)).toBe(384);
    expect(convertChildMemoryMb(2 * GB)).toBe(512);
    expect(convertChildMemoryMb(4 * GB)).toBe(1024);
    expect(convertChildMemoryMb(16 * GB)).toBe(1024);
  });
});

describe('要素（開きタグ）の数え方', () => {
  test('`<` の直後が英字のものだけを数える（閉じタグ・`<!--`・`<!doctype`・数字・空白は数えない。コメントやスクリプトの中の `<x>` は数える〔多めに数える側にだけずれる〕）', () => {
    expect(countTagsUpTo('<!doctype html><html><body><p>a < b</p><!-- <x> --></body></html>', 100)).toBe(4);
    expect(countTagsUpTo('<a><B><1><-></a>', 100)).toBe(2);
    expect(countTagsUpTo('', 100)).toBe(0);
  });

  test('上限を超えたら数えるのをやめ、上限 + 1 を返す（大きいページの全体を数えない）', () => {
    expect(countTagsUpTo('<p>'.repeat(50), 10)).toBe(11);
    expect(countTagsUpTo('<p>'.repeat(10), 10)).toBe(10);
  });
});

describe('変換をどこでするか', () => {
  test('strict は、小さなページでも子で変換する（全員の要求を処理するメインスレッドを止めない）', () => {
    expect(convertsInChild('<p>x</p>', 'strict')).toBe(true);
  });

  test('standard は、要素が 1 万を超えるページだけ子で変換する（境界: 1 万ちょうどは本体の中）', () => {
    expect(STANDARD_CHILD_MIN_TAGS).toBe(10_000);
    expect(convertsInChild('<p>'.repeat(10_000), 'standard')).toBe(false);
    expect(convertsInChild('<p>'.repeat(10_001), 'standard')).toBe(true);
    expect(convertsInChild('<p>x</p>', 'standard')).toBe(false);
  });
});

// ==========================================
// convertPage（本体の中か、別プロセスかを決めて変換する）
// ==========================================

const PARAGRAPH = '<p>これは本文の段落です。<a href="/next">次の記事</a>への案内と、ふつうの長さの文章が続きます。</p>';
const ARTICLE = `<html><head><title>題名</title></head><body><main>${PARAGRAPH.repeat(10)}</main></body></html>`;
/** 要素が 1 万を超えるページ（p と b で 1 段落 2 つ × 5,001） */
const BIG = `<html><head><title>大きい</title></head><body><main>${'<p>段落の <b>太字</b> の文です。</p>'.repeat(5001)}</main></body></html>`;
const URL_A = 'https://example.com/a';
const inline = (html: string) => convertHtmlToMarkdown(html, URL_A, 10_000, false, true);

/** 偽の子（bun -e の台本）。標準入力は読まない */
const fakeChild = (body: string): string[] => [process.execPath, '--no-env-file', '-e', body];
const MIN_RESULT = { title: 't', markdown: 'm', fullMarkdown: 'm', contentStatus: 'body', isTruncated: false, links: [], estimatedTokens: 1 };
const printLine = (line: object): string => `console.log(${JSON.stringify(JSON.stringify(line))});`;

const spawned: number[] = [];
const onSpawn = (pid: number) => void spawned.push(pid);
afterEach(() => {
  spawned.length = 0;
  resetConvertWarnings();
});

describe('convertPage: どこで変換するか', () => {
  test('standard の小さなページは、今までどおり本体の中で変換する（子を起こさない）', async () => {
    const { parsed, warnings } = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'standard', onSpawn } });
    expect(spawned).toHaveLength(0);
    expect(parsed.markdown).toBe(inline(ARTICLE).markdown);
    expect(warnings).toEqual([]);
  });

  test('standard でも、要素が 1 万を超えるページは子で変換し、本体の中と同じ結果を返す。終わったら順番の枠を返す', async () => {
    expect(countTagsUpTo(BIG, 20_000)).toBeGreaterThan(STANDARD_CHILD_MIN_TAGS);
    const { parsed } = await convertPage({ html: BIG, url: URL_A, maxChars: 10_000 }, { child: { level: 'standard', onSpawn } });
    expect(spawned).toHaveLength(1);
    expect(parsed.markdown).toBe(inline(BIG).markdown);
    expect(parsed.title).toBe('大きい');
    expect(convertSlots.activeCount).toBe(0);
  });

  test('strict は、小さなページも子で変換する', async () => {
    const { parsed } = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', onSpawn } });
    expect(spawned).toHaveLength(1);
    expect(parsed.markdown).toBe(inline(ARTICLE).markdown);
    expect(parsed.links).toEqual(inline(ARTICLE).links);
  });

  test('子で変換するとき、頼まれていない大きな欄は受け取らない（links は空・tables は無し）', async () => {
    const { parsed } = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { want: { links: false, tables: false }, child: { level: 'strict' } });
    expect(parsed.links).toEqual([]);
    expect(parsed.tables).toBeUndefined();
    expect(parsed.markdown).toBe(inline(ARTICLE).markdown);
  });

  test('入口が見つからないとき、standard は本体の中で変換し、そのことを 1 回だけ知らせる。strict は失敗する（本体の中で変換しない）', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sora-no-entry-'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await convertPage({ html: BIG, url: URL_A, maxChars: 10_000 }, { child: { level: 'standard', entryDir: empty, onSpawn } });
      await convertPage({ html: BIG, url: URL_A, maxChars: 10_000 }, { child: { level: 'standard', entryDir: empty, onSpawn } });
      expect(first.parsed.markdown).toBe(inline(BIG).markdown);
      expect(spawned).toHaveLength(0);
      expect(warn.mock.calls.filter(([text]) => String(text).includes('html-convert.js'))).toHaveLength(1);
      await expect(convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', entryDir: empty } })).rejects.toThrow('html-convert.js');
    } finally {
      warn.mockRestore();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('convertPage: 子の上限と約束', () => {
  const metric = (name: string) => getSecurityMetrics()[name] ?? 0;

  test('メモリの上限を超えた子は止め、上限を書いた失敗にする（それまでの結果は返さない）。止めたことを数える', async () => {
    const before = metric('sora_convert_child_killed_memory_total');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const error = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', limits: { memoryMb: 1 } } }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConvertLimitError);
      expect((error as ConvertLimitError).reason).toBe('memory');
      expect((error as Error).message).toContain('メモリの上限（1 MB）');
    } finally {
      warn.mockRestore();
    }
    expect(metric('sora_convert_child_killed_memory_total')).toBe(before + 1);
    expect(convertSlots.activeCount).toBe(0);
  });

  test('時間の上限を過ぎた子は止め、「タイムアウト」の失敗にする（REST は 408）', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const error = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', command: fakeChild('setInterval(() => {}, 1000);'), limits: { hardMs: 200 } } }).catch((e: unknown) => e);
      expect((error as ConvertLimitError).reason).toBe('time');
      expect((error as Error).message).toContain('タイムアウト');
    } finally {
      warn.mockRestore();
    }
  });

  test('形の合わない結果（乗っ取られた子など）は、約束違反として捨てて失敗にする', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const line of [{ t: 'done', result: { ...MIN_RESULT, markdown: 1 }, rsUnavailable: [], counters: {} }, { t: 'done', result: MIN_RESULT, rsUnavailable: [], counters: { sora_api_key_total: 1 } }, { t: 'other' }]) {
        const error = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', command: fakeChild(printLine(line)) } }).catch((e: unknown) => e);
        expect((error as ConvertLimitError).reason).toBe('protocol');
      }
    } finally {
      warn.mockRestore();
    }
  });

  test('子が返した変換の例外は、同じ名前・同じ文で投げ直す（上限の失敗にしない）', async () => {
    const error = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', command: fakeChild(printLine({ t: 'error', name: 'SyntaxError', message: 'セレクタが正しくありません' })) } }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ConvertLimitError);
    expect((error as Error).name).toBe('SyntaxError');
    expect((error as Error).message).toBe('セレクタが正しくありません');
  });

  test('子が数えた本文の抽出のカウンターは、本体の /metrics に足す。本文の抽出が使えなかったことは、利用者向けの警告の文にする', async () => {
    const before = metric('sora_main_content_rs_failed_total');
    const line = { t: 'done', result: MIN_RESULT, rsUnavailable: ['content'], counters: { sora_main_content_rs_failed_total: 2 } };
    const { parsed, warnings } = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', command: fakeChild(printLine(line)) } });
    expect(parsed.markdown).toBe('m');
    expect(warnings).toEqual([RS_UNAVAILABLE_WARNINGS.content]);
    expect(metric('sora_main_content_rs_failed_total')).toBe(before + 2);
  });

  test('子には、運用者の秘密を渡さない（PATH など bun を動かすのに要るものだけ）', async () => {
    process.env.SORA_API_KEY_FOR_TEST = 'sk-convert-secret';
    try {
      const script = `const leaked = process.env.SORA_API_KEY_FOR_TEST ?? ''; const path = process.env.PATH ? 'PATH' : ''; console.log(JSON.stringify({ t: 'done', result: { ...${JSON.stringify(MIN_RESULT)}, title: leaked + '|' + path }, rsUnavailable: [], counters: {} }));`;
      const { parsed } = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', command: fakeChild(script) } });
      expect(parsed.title).toBe('|PATH');
    } finally {
      delete process.env.SORA_API_KEY_FOR_TEST;
    }
  });
});

describe('convertPage: 本文の抽出（rs-trafilatura）', () => {
  const rsDir = mkdtempSync(join(tmpdir(), 'sora-convert-rs-'));
  const listing = join(rsDir, 'listing');
  writeFileSync(listing, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"page_type":"listing","content_html":"<ul><li>抽出した予定の一覧です。今月の公演の予定をまとめました。</li></ul>"}'\n`);
  chmodSync(listing, 0o755);
  const saved = process.env.SORA_RS_TRAFILATURA_PATH;
  beforeAll(() => {
    process.env.SORA_RS_TRAFILATURA_PATH = listing;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SORA_RS_TRAFILATURA_PATH;
    else process.env.SORA_RS_TRAFILATURA_PATH = saved;
    rmSync(rsDir, { recursive: true, force: true });
  });

  test('子で変換するとき、本文の抽出も子の中でし、その本文で変換する（コマンドの場所は本体が渡す）', async () => {
    const { parsed, warnings } = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { mainContent: {}, child: { level: 'strict', onSpawn } });
    expect(spawned).toHaveLength(1);
    expect(parsed.markdown).toContain('抽出した予定の一覧です');
    expect(warnings).toEqual([]);
  });

  test('本体の中で変換するときも、今までどおり本文の抽出をして、その本文で変換する', async () => {
    const { parsed } = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { mainContent: {}, child: { level: 'standard', onSpawn } });
    expect(spawned).toHaveLength(0);
    expect(parsed.markdown).toContain('抽出した予定の一覧です');
  });

  test('本文の抽出を頼まなければ、抽出しない（ブラウザの描画を待つ間の確認など）', async () => {
    for (const level of ['strict', 'standard'] as const) {
      const { parsed } = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level } });
      expect(parsed.markdown).not.toContain('抽出した予定の一覧です');
      expect(parsed.markdown).toBe(inline(ARTICLE).markdown);
    }
  });
});

describe('convertPage: 子の行の検査（つづき）', () => {
  test('JSON として読めない行・数えすぎたカウンターは、約束違反', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const script of ["console.log('not json');", printLine({ t: 'done', result: MIN_RESULT, rsUnavailable: [], counters: { sora_main_content_rs_failed_total: 11 } })]) {
        const error = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', command: fakeChild(script) } }).catch((e: unknown) => e);
        expect((error as ConvertLimitError).reason).toBe('protocol');
      }
    } finally {
      warn.mockRestore();
    }
  });

  test('子が返した例外の名前と文は、長さを切る（利用者に見える文になりうる）', async () => {
    const error = await convertPage({ html: ARTICLE, url: URL_A, maxChars: 10_000 }, { child: { level: 'strict', command: fakeChild(printLine({ t: 'error', name: 'N'.repeat(500), message: 'M'.repeat(5000) })) } }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('N'.repeat(100));
    expect((error as Error).message).toBe('M'.repeat(300));
  });
});

describe('rememberLast（ブラウザの描画を待つ間の確認が、同じ HTML を続けて確かめるとき、変換を 1 回で済ませる）', () => {
  test('直前と同じ HTML と URL なら、覚えた答えを返す。違えば確かめ直す（覚えるのは直前の 1 件だけ）', async () => {
    const calls: string[] = [];
    const check = rememberLast(async (html: string, url: string) => {
      calls.push(`${url}|${html}`);
      return html.length > 3;
    });
    expect(await check('<p>a</p>', 'u1')).toBe(true);
    expect(await check('<p>a</p>', 'u1')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await check('<p>a</p>', 'u2')).toBe(true);
    expect(await check('ab', 'u2')).toBe(false);
    expect(await check('<p>a</p>', 'u1')).toBe(true);
    expect(calls).toEqual(['u1|<p>a</p>', 'u2|<p>a</p>', 'u2|ab', 'u1|<p>a</p>']);
  });

  test('確かめる関数が失敗したら、覚えない（次は確かめ直す）', async () => {
    let n = 0;
    const check = rememberLast(async () => {
      n++;
      if (n === 1) throw new Error('混み合っています');
      return true;
    });
    await expect(check('<p>a</p>', 'u')).rejects.toThrow('混み合っています');
    expect(await check('<p>a</p>', 'u')).toBe(true);
    expect(n).toBe(2);
  });
});

describe('convertPage: 止めたときの運用者向けのログ', () => {
  test('ページはホスト名だけを書く（URL のパス・問い合わせの署名や鍵を、ログに出さない）', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await convertPage({ html: ARTICLE, url: 'https://example.com/private/path?token=sk-secret-token', maxChars: 10_000 }, { child: { level: 'strict', command: fakeChild("console.log('not json');") } }).catch(() => {});
      const logged = warn.mock.calls.map(([text]) => String(text)).join('\n');
      expect(logged).toContain('example.com');
      expect(logged).not.toContain('sk-secret-token');
      expect(logged).not.toContain('/private/path');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('convertPage: 子に渡す変換の引数', () => {
  // どの引数も、結果を変えるページ（消す要素・取り出す要素・リンク・data: の画像）
  const PAGE = `<html><head><title>引数</title></head><body><main>${PARAGRAPH.repeat(5)}<div class="ad">広告の文は消えるはずです</div><p id="price">価格は 1,200 円です</p><p><img src="data:image/png;base64,iVBORw0KGgo=" alt="小さな画像"></p></main></body></html>`;
  const args = { removeSelectors: ['.ad'], selectors: { price: '#price' }, stripLinks: true, keepDataImages: true };
  const inlineWith = (extra: Partial<typeof args>) => convertHtmlToMarkdown(PAGE, URL_A, 10_000, false, true, extra.selectors, extra.removeSelectors, extra.stripLinks, extra.keepDataImages ?? false);

  test('removeSelectors・selectors・stripLinks・keepDataImages を、本体の中の変換と同じに渡す（どれも、渡さないと結果が変わるページで）', async () => {
    const plain = inlineWith({});
    const expected = inlineWith(args);
    expect(expected.markdown).not.toBe(plain.markdown);
    expect(expected.markdown).not.toContain('広告の文');
    expect(plain.markdown).toContain('[次の記事](');
    expect(expected.markdown).not.toContain('[次の記事](');
    expect(expected.markdown).toContain('data:image/png');
    expect(expected.extracted).toEqual({ price: '価格は 1,200 円です' });
    const { parsed } = await convertPage({ html: PAGE, url: URL_A, maxChars: 10_000, ...args }, { child: { level: 'strict' } });
    expect(parsed.markdown).toBe(expected.markdown);
    expect(parsed.extracted).toEqual(expected.extracted);
  });
});

describe('convertChildLimits（子の上限）', () => {
  test('時間は水準の表（strict 30 秒・standard 60 秒）、メモリは機械のメモリから（convertChildMemoryMb）、出力量は 64MB', () => {
    const saved = process.env.SORA_ISOLATION;
    try {
      process.env.SORA_ISOLATION = 'strict';
      expect(convertChildLimits().hardMs).toBe(30_000);
      process.env.SORA_ISOLATION = 'standard';
      expect(convertChildLimits().hardMs).toBe(60_000);
    } finally {
      if (saved === undefined) delete process.env.SORA_ISOLATION;
      else process.env.SORA_ISOLATION = saved;
    }
    expect(convertChildLimits().memoryMb).toBe(convertChildMemoryMb(detectMemoryLimitBytes()));
    expect(convertChildLimits().maxOutputBytes).toBe(64 * MB);
    expect(convertChildLimits({ hardMs: 5 }).hardMs).toBe(5);
  });
});
