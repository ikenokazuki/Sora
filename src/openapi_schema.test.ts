import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { zodToOpenApiSchema, ScrapeResponseSchema, IntegratedSearchResponseSchema } from './types.js';
import { formatCompactScrapeResult } from './response_cleaner.js';

describe('OpenAPI schema conversion', () => {
  test('describes literals, nullable required values and unconstrained JSON accurately', () => {
    const schema = zodToOpenApiSchema(z.object({ source: z.literal('web'), elevation: z.number().nullable(), result: z.any() }));
    expect(schema.properties.source).toMatchObject({ type: 'string', enum: ['web'] });
    expect(schema.properties.elevation).toMatchObject({ type: 'number', nullable: true });
    expect(schema.required).toContain('elevation');
    expect(schema.properties.result.type).toBeUndefined();
  });

  test('retains string formats, lengths, patterns, array bounds and record value types', () => {
    const schema = zodToOpenApiSchema(z.object({
      urls: z.array(z.string().url()).min(1).max(20),
      code: z.string().min(2).max(8).regex(/^[A-Z]+$/),
      headers: z.record(z.string(), z.string()),
    }));
    expect(schema.properties.urls).toMatchObject({ minItems: 1, maxItems: 20, items: { type: 'string', format: 'uri' } });
    expect(schema.properties.code).toMatchObject({ minLength: 2, maxLength: 8, pattern: '^[A-Z]+$' });
    expect(schema.properties.headers.additionalProperties).toMatchObject({ type: 'string' });
  });

  test('documentation defaults do not change omission semantics', () => {
    const formats = z.array(z.string()).optional().meta({ default: ['markdown'] });
    expect(formats.parse(undefined)).toBeUndefined();
    expect(zodToOpenApiSchema(formats).default).toEqual(['markdown']);
  });
});

describe('public response schemas', () => {
  test('the compact scrape response satisfies its documented schema', () => {
    const compact = formatCompactScrapeResult({ url: 'https://example.com', title: 'Fixture', content: '# Fixture\n\nPage content', isTruncated: false, contentType: 'text/html', source: 'web', contentStatus: 'body' });
    expect(ScrapeResponseSchema.safeParse(compact).success).toBe(true);
  });

  test('integrated search documents markdown results, realtime envelope and PRF metadata', () => {
    const response = { query: 'Festival', source: 'integrated', count: 1, cached: false, responseMode: 'evidence',
      results: [{ title: 'Event', url: 'https://example.com/event', source: 'web', highlights: ['Live 15:20'], contentStatus: 'structured_data', events: [{ name: 'Festival' }] }],
      realtime: { source: 'x', sort: 'recent', count: 1, effectiveQuery: 'Festival', isFallback: false, items: [{ source: 'x', id: '123', text: 'Live 15:20', url: 'https://x.com/a/status/123', retrievalSources: ['web', 'realtime'] }] },
      prf: { originalQuery: 'Festival', expandedQuery: 'Festival timetable', expansionTerms: ['timetable'] },
    };
    const parsed = IntegratedSearchResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject(response);
  });
});
