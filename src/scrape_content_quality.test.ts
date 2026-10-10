import { describe, expect, test } from 'bun:test';
import { isRenderStillBlockedOrBlank, isUsableScrape } from './scraper.js';
import { projectRequestedScrapeFormats } from './search_format_projection.js';
import { formatCompactScrapeResult } from './response_cleaner.js';

describe('usable scrape content', () => {
  test('calendar chrome does not count as a successful scrape', () => {
    const markdown = '---\nsiteName: "Calendar"\n---\n\n> 📅 **イベント情報**: Festival (日時: 2026-04-19T06:20:00Z | 会場: RED SUN)\n\nMon\n\nTue\n\nWed\n\nThu\n\nFri\n\nSat\n\nSun\n\n28\n\n29\n\n30\n\n1\n\n2\n\n3';
    expect(isUsableScrape({ markdown })).toBe(false);
    expect(isRenderStillBlockedOrBlank({ html: '', bodyOnlyMarkdown: markdown })).toBe(true);
  });

  test('a JavaScript placeholder is unusable even when metadata makes it longer than 50 characters', () => {
    const markdown = '# Festival\n\nJavaScript is disabled. Please enable your JavaScript settings in order to use the service.';
    expect(isUsableScrape({ markdown })).toBe(false);
    expect(isRenderStillBlockedOrBlank({ html: '', bodyOnlyMarkdown: markdown })).toBe(true);
  });

  test('short real schedules remain usable', () => {
    expect(isUsableScrape({ markdown: '# Live schedule\n\nFestival 2026: ライブ 15:20〜15:40。特典会 16:10〜17:10。会場 RED SUN。' })).toBe(true);
  });

  test('metadata-only extraction stays explicit at the search and scrape boundaries', () => {
    const scrape = { url: 'https://example.com', title: 'Event', content: '# Event\n\nInformation unavailable.', description: 'Event metadata', contentStatus: 'metadata_only', events: [{ name: 'Event', startDate: '2026-04-19T06:20:00Z' }] };
    const result = projectRequestedScrapeFormats(scrape, ['markdown'], { minMarkdownChars: 50, markdownFallback: '# Event\n\nSearch snippet' });
    expect(result.contentStatus).toBe('metadata_only');
    expect(result.events).toEqual(scrape.events);
    expect(result.isSnippetFallback).toBe(true);
    expect(isUsableScrape(result)).toBe(false);
    expect(formatCompactScrapeResult(scrape as any).contentStatus).toBe('metadata_only');
  });
});

describe('calendar chrome with several events', () => {
  test('callout lines for several events do not count as page content', () => {
    const callouts = ['A', 'B', 'C'].map((n) => `> 📅 **イベント情報**: Festival ${n} (日時: 2026-04-19T06:20:00Z | 会場: RED SUN)`).join('\n');
    const markdown = `---\nsiteName: "Calendar"\n---\n\n${callouts}\n> 📅 **イベント情報**: ほか 2 件\n\nMon\n\nTue\n\nWed\n\nThu\n\nFri\n\nSat\n\nSun\n\n28\n\n29\n\n30\n\n1\n\n2\n\n3`;
    expect(isUsableScrape({ markdown })).toBe(false);
  });
});
