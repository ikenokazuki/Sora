import { describe, expect, test } from 'bun:test';
import { ChiebukuroSearchRequestSchema, EarthquakeRequestSchema, generateOpenApiDocument } from './types.js';

describe('enumerated inputs', () => {
  test('minIntensity accepts JMA scale codes only', () => {
    for (const code of [10, 20, 30, 40, 45, 50, 55, 60, 70]) expect(EarthquakeRequestSchema.safeParse({ minIntensity: code }).success).toBe(true);
    expect(EarthquakeRequestSchema.safeParse({ minIntensity: 35 }).success).toBe(false);
  });

  test('chiebukuro status is documented', () => {
    expect(ChiebukuroSearchRequestSchema.parse({ query: 'x', status: 'solved' }).status).toBe('solved');
    expect(ChiebukuroSearchRequestSchema.safeParse({ query: 'x', status: 'closed' }).success).toBe(false);
  });

  test('GET /tracking/{carrier}/{number} lists every carrier', () => {
    const doc: any = generateOpenApiDocument();
    const carrier = doc.paths['/tracking/{carrier}/{number}'].get.parameters.find((p: any) => p.name === 'carrier');
    expect([...carrier.schema.enum].sort()).toEqual(['dhl', 'fedex', 'fukutsu', 'japanpost', 'sagawa', 'seino', 'ups', 'yamato']);
  });
});
