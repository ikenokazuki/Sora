import { describe, expect, test } from 'bun:test';
import { SCRAPE_FORMATS, ScrapeFormatSchema } from './types.js';
import { projectRequestedScrapeFormats } from './search_format_projection.js';
describe('shared search format contract', () => {
  test('canonical list/schema align', () => {
    expect(SCRAPE_FORMATS).toEqual(['markdown','html','rawHtml','links','screenshot','jsonLd','images','tables']);
    for (const f of SCRAPE_FORMATS) expect(ScrapeFormatSchema.parse(f)).toBe(f);
    expect(ScrapeFormatSchema.safeParse('bogus').success).toBe(false);
  });
  test('projection returns requested fields only', () => {
    const x={content:'# Hello\n\nBody',html:'<main>Body</main>',rawHtml:'<html/>',links:['https://e/a'],screenshot:'b64',jsonLd:[{}],images:[{url:'x'}],tables:[{headers:['A'],rows:[{A:'1'}]}]};
    const p=projectRequestedScrapeFormats(x,['markdown','tables']);
    expect(p.markdown).toContain('Body'); expect(p.tables).toEqual(x.tables); expect(p.html).toBeUndefined(); expect(p.images).toBeUndefined();
  });
  test('snippet fallback semantics remain explicit', () => {
    const p=projectRequestedScrapeFormats({content:'tiny'},['markdown'],{minMarkdownChars:50,markdownFallback:'# Result\n\nfallback'});
    expect(p.markdown).toContain('fallback'); expect(p.isSnippetFallback).toBe(true);
  });
});
