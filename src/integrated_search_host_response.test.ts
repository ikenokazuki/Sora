import { describe, expect, test } from 'bun:test';
import {
  formatIntegratedSearchHostResponse,
  projectIntegratedSearchEvidenceItem,
  serializeIntegratedSearchMcpResponse,
} from './integrated_search_host_response.js';

function baseItem() {
  return {
    title: 'Fixture',
    url: 'https://example.com/article',
    source: 'web',
    snippet: 'search snippet',
    description: 'page description',
    markdown: '# Full source\n\n## Target\nAnswer evidence\n\n## Other\nNon-query detail',
    highlights: ['## Target\n\nAnswer evidence'],
    publishedTime: '2026-09-16T12:00:00Z',
    siteName: 'Fixture Site',
    pageType: 'article',
    cached: false,
  };
}

function response() {
  return {
    query: 'Target answer',
    source: 'integrated',
    count: 1,
    cached: false,
    results: [baseItem()],
    realtime: {
      source: 'x',
      sort: 'recent',
      count: 0,
      effectiveQuery: 'Target answer',
      isFallback: false,
      items: [],
    },
  };
}

describe('integrated search Host response', () => {
  test('full is exact legacy object by identity', () => {
    const input = response();
    expect(formatIntegratedSearchHostResponse(input)).toBe(input);
    expect(
      formatIntegratedSearchHostResponse(input, { responseMode: 'full' }),
    ).toBe(input);
  });

  test('verbose forces exact full object even if evidence is requested', () => {
    const input = response();
    expect(
      formatIntegratedSearchHostResponse(input, {
        responseMode: 'evidence',
        verbose: true,
      }),
    ).toBe(input);
  });

  test('evidence preserves JSON properties and highlights, removing only markdown', () => {
    const input = response();
    const before = structuredClone(input);
    const output = formatIntegratedSearchHostResponse(input, {
      responseMode: 'evidence',
    });

    expect(output.responseMode).toBe('evidence');
    expect(output.query).toBe(input.query);
    expect(output.source).toBe(input.source);
    expect(output.count).toBe(input.count);
    expect(output.cached).toBe(input.cached);
    expect(output.realtime).toEqual(input.realtime);

    const item = output.results[0];
    const source = input.results[0];
    expect(item.markdown).toBeUndefined();
    expect(item.highlights).toEqual(source.highlights);
    expect(item.title).toBe(source.title);
    expect(item.url).toBe(source.url);
    expect(item.snippet).toBe(source.snippet);
    expect(item.description).toBe(source.description);
    expect(item.publishedTime).toBe(source.publishedTime);
    expect(item.siteName).toBe(source.siteName);
    expect(item.pageType).toBe(source.pageType);
    expect(item.cached).toBe(source.cached);

    // Source object must never be mutated.
    expect(input).toEqual(before);
    expect(typeof input.results[0].markdown).toBe('string');
  });

  test('explicit formats:["markdown"] preserves markdown', () => {
    const item = baseItem();
    const output = projectIntegratedSearchEvidenceItem(item, {
      responseMode: 'evidence',
      explicitFormats: ['markdown'],
    });
    expect(output.markdown).toBe(item.markdown);
    expect(output.highlights).toEqual(item.highlights);
  });

  test('extractHighlights:false preserves markdown', () => {
    const item = baseItem();
    const output = projectIntegratedSearchEvidenceItem(item, {
      responseMode: 'evidence',
      extractHighlights: false,
    });
    expect(output.markdown).toBe(item.markdown);
  });

  test('no highlights preserves markdown', () => {
    const item = { ...baseItem(), highlights: [] };
    const output = projectIntegratedSearchEvidenceItem(item, {
      responseMode: 'evidence',
    });
    expect(output.markdown).toBe(item.markdown);
  });

  test('scrape error and snippet fallback preserve markdown', () => {
    const errorItem = { ...baseItem(), scrapeError: 'blocked' };
    const fallbackItem = { ...baseItem(), isSnippetFallback: true };

    expect(
      projectIntegratedSearchEvidenceItem(errorItem, {
        responseMode: 'evidence',
      }).markdown,
    ).toBe(errorItem.markdown);

    expect(
      projectIntegratedSearchEvidenceItem(fallbackItem, {
        responseMode: 'evidence',
      }).markdown,
    ).toBe(fallbackItem.markdown);
  });

  test('X items preserve markdown', () => {
    for (const item of [
      { ...baseItem(), source: 'x' },
      {
        ...baseItem(),
        source: 'web',
        url: 'https://x.com/example/status/123',
      },
      {
        ...baseItem(),
        source: 'web',
        url: 'https://twitter.com/example/status/123',
      },
    ]) {
      expect(
        projectIntegratedSearchEvidenceItem(item, {
          responseMode: 'evidence',
        }).markdown,
      ).toBe(item.markdown);
    }
  });

  test('markdown is never overwritten with highlight text', () => {
    const item = baseItem();
    const output = projectIntegratedSearchEvidenceItem(item, {
      responseMode: 'evidence',
      explicitFormats: ['markdown'],
    });
    expect(output.markdown).toBe(item.markdown);
    expect(output.markdown).not.toBe(item.highlights[0]);
  });

  test('MCP full serialization stays pretty; evidence serialization is compact', () => {
    const input = response();
    const full = serializeIntegratedSearchMcpResponse(input, {
      responseMode: 'full',
    });
    const evidence = serializeIntegratedSearchMcpResponse(input, {
      responseMode: 'evidence',
    });

    expect(full).toContain('\n  "query"');
    expect(evidence).not.toContain('\n  "query"');
    expect(JSON.parse(full).results[0].markdown).toBeDefined();
    expect(JSON.parse(evidence).results[0].markdown).toBeUndefined();
    expect(JSON.parse(evidence).results[0].highlights).toEqual(
      input.results[0].highlights,
    );
  });

  test('known lossiness remains visible: evidence is not full-source equivalent', () => {
    const input = response();
    const output = formatIntegratedSearchHostResponse(input, {
      responseMode: 'evidence',
    });

    expect(input.results[0].markdown).toContain('Non-query detail');
    expect(JSON.stringify(output.results[0].highlights)).not.toContain(
      'Non-query detail',
    );
  });
});
