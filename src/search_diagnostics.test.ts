import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildSearchDiagnostics } from './search_diagnostics.js';

describe('Phase 1 verbose-only search diagnostics', () => {
  test('records observed query lineage without changing or deduplicating meaning', () => {
    const diagnostics = buildSearchDiagnostics({
      originalQuery: '君と見るそら 山中湖 spark 出演時間',
      effectiveQuery: '君と見るそら 山中湖 spark 出演時間',
      webEffectiveQuery: '君と見るそら 山中湖 spark',
      webIsFallback: true,
      webResultCount: 5,
      includeRealtime: true,
      realtimeOriginalQuery: '君と見るそら 山中湖 spark 出演時間',
      realtimeEffectiveQuery: '君と見るそら 山中湖 spark',
      realtimeIsFallback: true,
      realtimeCount: 3,
      results: [],
    });

    expect(diagnostics.originalQuery).toBe('君と見るそら 山中湖 spark 出演時間');
    expect(diagnostics.web.isFallback).toBe(true);
    expect(diagnostics.retrievalQueries).toEqual([
      '君と見るそら 山中湖 spark 出演時間',
      '君と見るそら 山中湖 spark',
    ]);
  });

  test('records source identity and selected highlight text observationally', () => {
    const diagnostics = buildSearchDiagnostics({
      originalQuery: 'q',
      effectiveQuery: 'q',
      webResultCount: 1,
      includeRealtime: false,
      results: [{
        source: 'web',
        url: 'https://example.com/a',
        siteName: 'Example',
        pageType: 'article',
        highlights: ['evidence'],
        isSnippetFallback: false,
      }],
    });

    expect(diagnostics.sourceIdentity).toEqual([{
      rank: 1,
      source: 'web',
      url: 'https://example.com/a',
      siteName: 'Example',
      pageType: 'article',
      isSnippetFallback: false,
      hasScrapeError: false,
    }]);
    expect(diagnostics.selectedHighlights).toEqual([{
      rank: 1,
      url: 'https://example.com/a',
      highlights: ['evidence'],
    }]);
  });

  test('Phase 1 diagnostics are guarded by verbose and added after output ordering', () => {
    const source = readFileSync(new URL('./scraper.ts', import.meta.url), 'utf8');
    const reorder = source.indexOf('reorderLostInTheMiddle(enrichedResults)');
    const diagnostics = source.indexOf('finalResponse.searchDiagnostics = buildSearchDiagnostics');
    expect(reorder).toBeGreaterThan(-1);
    expect(diagnostics).toBeGreaterThan(reorder);

    const guarded = source.indexOf('if (options.verbose) {', source.indexOf('const finalResponse'));
    expect(guarded).toBeGreaterThan(-1);
    expect(diagnostics).toBeGreaterThan(guarded);
  });

  test('integratedSearch cache key distinguishes verbose from default output shape', () => {
    const source = readFileSync(new URL('./scraper.ts', import.meta.url), 'utf8');
    expect(source).toContain("${options.verbose === true ? 'verbose' : 'compact'}");
  });
});
