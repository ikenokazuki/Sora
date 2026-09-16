import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  canonicalHighlightTexts,
  stripHighlightInternals,
} from './highlight_surface.js';
import { formatCompactScrapeResult } from './response_cleaner.js';

describe('Phase 0 canonical Host-facing highlight surface', () => {
  test('canonical highlights take precedence over internal items', () => {
    expect(
      canonicalHighlightTexts(
        ['primary evidence'],
        [{ text: 'fallback evidence' }],
      ),
    ).toEqual(['primary evidence']);
  });

  test('highlightItems text is used only when highlights are absent', () => {
    expect(
      canonicalHighlightTexts(
        undefined,
        [{ text: 'one' }, { text: 'two' }],
      ),
    ).toEqual(['one', 'two']);
  });

  test('default compact output exposes highlights only', () => {
    const result: any = {
      url: 'https://example.com',
      title: 'Example',
      content: 'Body',
      highlights: ['evidence'],
      highlightItems: [{ text: 'evidence', score: 0.99, cost: 12 }],
    };
    const output = formatCompactScrapeResult(result);
    expect(output.highlights).toEqual(['evidence']);
    expect('highlightItems' in output).toBe(false);
  });

  test('default compact output can canonicalize highlightItems fallback', () => {
    const result: any = {
      url: 'https://example.com',
      title: 'Example',
      content: 'Body',
      highlightItems: [
        { text: 'one', score: 0.9 },
        { text: 'two', score: 0.8 },
      ],
    };
    const output = formatCompactScrapeResult(result);
    expect(output.highlights).toEqual(['one', 'two']);
    expect('highlightItems' in output).toBe(false);
  });

  test('verbose compact output preserves diagnostic internals', () => {
    const result: any = {
      url: 'https://example.com',
      title: 'Example',
      content: 'Body',
      highlights: ['evidence'],
      highlightItems: [{ text: 'evidence', score: 0.99 }],
      highlightDiagnostics: { engine: 'rho-select-v2' },
    };
    const output = formatCompactScrapeResult(result, { verbose: true });
    expect(output).toBe(result);
    expect(output.highlightItems).toEqual(result.highlightItems);
  });

  test('integrated output cleanup removes internals without touching payload', () => {
    const input = {
      title: 'A',
      markdown: 'source-faithful body',
      highlights: ['evidence'],
      highlightItems: [{ text: 'evidence', score: 1 }],
      highlightDiagnostics: { a: 1 },
    };
    expect(stripHighlightInternals(input)).toEqual({
      title: 'A',
      markdown: 'source-faithful body',
      highlights: ['evidence'],
    });
  });

  test('integratedSearch canonicalization occurs after deep evidence reranking', () => {
    const source = readFileSync(new URL('./scraper.ts', import.meta.url), 'utf8');
    const rerank = source.indexOf('rerankByDeepEvidence(enrichedResults, query)');
    const strip = source.indexOf(
      'enrichedResults = enrichedResults.map((item: any) => stripHighlightInternals(item));',
    );
    expect(rerank).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(rerank);
  });
});
