import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMainContentWithRs } from './rs_trafilatura.js';

// 本物の rs-trafilatura の代わりに、決まった JSON を返すコマンドを作る
const dir = mkdtempSync(join(tmpdir(), 'sora-rs-'));
const fake = (name: string, json: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${json}'\n`);
  chmodSync(path, 0o755);
  return path;
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('extractMainContentWithRs', () => {
  test('returns the main content HTML and the page type from the command', async () => {
    const bin = fake('ok', '{"page_type":"listing","classification_confidence":0.9,"confidence":0.7,"content_html":"<ul><li>予定</li></ul>","main_content":"予定"}');
    expect(await extractMainContentWithRs('<html><body><ul><li>予定</li></ul></body></html>', 'https://example.com/', bin)).toEqual({
      pageType: 'listing',
      contentHtml: '<ul><li>予定</li></ul>',
    });
  });

  test('does not hand the operator secrets to the command (PATH and the like are kept)', async () => {
    const dump = join(dir, 'env.dump');
    const path = join(dir, 'envdump');
    writeFileSync(path, `#!/bin/sh\ncat > /dev/null\nenv > "${dump}"\nprintf '%s' '{"content_html":"<p>x</p>"}'\n`);
    chmodSync(path, 0o755);
    const saved = { sora: process.env.SORA_API_KEY, ups: process.env.SORA_TRACKING_UPS_CLIENT_SECRET };
    process.env.SORA_API_KEY = 'sk-test-secret';
    process.env.SORA_TRACKING_UPS_CLIENT_SECRET = 'ups-test-secret';
    try {
      await extractMainContentWithRs('<html></html>', 'https://example.com/', path);
    } finally {
      if (saved.sora === undefined) delete process.env.SORA_API_KEY;
      else process.env.SORA_API_KEY = saved.sora;
      if (saved.ups === undefined) delete process.env.SORA_TRACKING_UPS_CLIENT_SECRET;
      else process.env.SORA_TRACKING_UPS_CLIENT_SECRET = saved.ups;
    }
    const dumped = readFileSync(dump, 'utf8');
    expect(dumped).not.toContain('sk-test-secret');
    expect(dumped).not.toContain('ups-test-secret');
    expect(dumped).toContain('PATH=');
  });

  test('asks the command to keep links in the content HTML', async () => {
    // 偽のコマンドは、受け取った引数を本文として返す
    const path = join(dir, 'args');
    writeFileSync(path, `#!/bin/sh\ncat > /dev/null\nprintf '{"page_type":"listing","content_html":"%s"}' "$*"\n`);
    chmodSync(path, 0o755);
    expect((await extractMainContentWithRs('<html></html>', 'https://example.com/', path))?.contentHtml).toContain('--markdown');
  });

  test('returns undefined when the command is not configured or missing, or the content is empty', async () => {
    expect(await extractMainContentWithRs('<html></html>', 'https://example.com/', undefined)).toBeUndefined();
    expect(await extractMainContentWithRs('<html></html>', 'https://example.com/', join(dir, 'missing'))).toBeUndefined();
    expect(await extractMainContentWithRs('<html></html>', 'https://example.com/', fake('empty', '{"page_type":"article","content_html":""}'))).toBeUndefined();
    expect(await extractMainContentWithRs('<html></html>', 'https://example.com/', fake('broken', 'not json'))).toBeUndefined();
  });
});

// 呼ばれた引数を <bin>.calls に 1 行ずつ書き、受け取った HTML を <bin>.stdin.<引数の数> に保存して、
// --page-type 付き（2 回目）なら second、なければ first を返すコマンド
const twoRuns = (name: string, first: string, second: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ncat > "${path}.stdin.$#"\necho "$*" >> "${path}.calls"\ncase "$*" in\n  *--page-type*) printf '%s' '${second}' ;;\n  *) printf '%s' '${first}' ;;\nesac\n`);
  chmodSync(path, 0o755);
  return path;
};
const calls = (bin: string) => readFileSync(`${bin}.calls`, 'utf8').trim().split('\n');

describe('extractMainContentWithRs の画像', () => {
  const page = '<html><body><p>本文<img src="/a.jpg" alt="写真"></p></body></html>';
  const first = '{"page_type":"listing","content_html":"<p>本文</p>"}';
  const second = '{"page_type":"listing","content_html":"<p>本文\uE000</p>"}';

  test('記事以外で画像があれば、目印を入れた HTML を種類付きで渡し、画像を戻す', async () => {
    const bin = twoRuns('images', first, second);
    expect(await extractMainContentWithRs(page, 'https://example.com/p', bin)).toEqual({
      pageType: 'listing',
      contentHtml: '<p>本文<img src="https://example.com/a.jpg" alt="写真"></p>',
    });
    expect(calls(bin)).toHaveLength(2);
    expect(calls(bin)[1]).toContain('--page-type listing');
    expect(readFileSync(`${bin}.stdin.6`, 'utf8')).toContain('\uE000');
  });

  test('2 回目の本文がずれたら 1 回目を返す', async () => {
    const bin = twoRuns('shifted', first, '{"page_type":"listing","content_html":"<p>別の本文\uE000</p>"}');
    expect(await extractMainContentWithRs(page, 'https://example.com/p', bin)).toEqual({ pageType: 'listing', contentHtml: '<p>本文</p>' });
  });

  test('2 回目が壊れた出力なら 1 回目を返す', async () => {
    const bin = twoRuns('second-broken', first, 'not json');
    expect((await extractMainContentWithRs(page, 'https://example.com/p', bin))?.contentHtml).toBe('<p>本文</p>');
  });

  test('記事・includeMedia: false・画像の無いページでは 2 回目を走らせない', async () => {
    const article = twoRuns('article', '{"page_type":"article","content_html":"<p>本文</p>"}', second);
    expect((await extractMainContentWithRs(page, 'https://example.com/p', article))?.contentHtml).toBe('<p>本文</p>');
    const noMedia = twoRuns('no-media', first, second);
    expect((await extractMainContentWithRs(page, 'https://example.com/p', noMedia, { includeMedia: false }))?.contentHtml).toBe('<p>本文</p>');
    const noImage = twoRuns('no-image', first, second);
    await extractMainContentWithRs('<html><body><p>本文</p></body></html>', 'https://example.com/p', noImage);
    for (const bin of [article, noMedia, noImage]) expect(calls(bin)).toHaveLength(1);
  });

  test('removeSelectors の要素を消してから渡す', async () => {
    const bin = twoRuns('remove', first, second);
    await extractMainContentWithRs('<html><body><div class="ad">広告</div><p>本文</p></body></html>', 'https://example.com/p', bin, { removeSelectors: ['.ad'] });
    const sent = readFileSync(`${bin}.stdin.4`, 'utf8');
    expect(sent).not.toContain('広告');
    expect(sent).toContain('本文');
  });

  test('正しくない removeSelectors は、今までどおりエラーにする', async () => {
    const bin = twoRuns('bad-selector', first, second);
    await expect(extractMainContentWithRs(page, 'https://example.com/p', bin, { removeSelectors: ['['] })).rejects.toThrow();
  });
});
