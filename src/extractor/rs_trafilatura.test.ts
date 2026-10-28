import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
