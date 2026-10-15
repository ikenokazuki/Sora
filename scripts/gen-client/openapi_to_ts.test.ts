import { describe, expect, test } from 'bun:test';
import { schemaToTs } from './openapi_to_ts.js';

describe('schemaToTs', () => {
  test('primitives, enums and unknown', () => {
    expect(schemaToTs({ type: 'string' })).toBe('string');
    expect(schemaToTs({ type: 'integer' })).toBe('number');
    expect(schemaToTs({ type: 'boolean' })).toBe('boolean');
    expect(schemaToTs({ type: 'string', enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(schemaToTs(undefined)).toBe('unknown');
    expect(schemaToTs({})).toBe('unknown');
  });

  test('objects mark optional keys and keep descriptions as comments', () => {
    const ts = schemaToTs({
      type: 'object',
      properties: { query: { type: 'string', description: '検索語' }, limit: { type: 'integer' } },
      required: ['query'],
    });
    expect(ts).toContain('/** 検索語 */');
    expect(ts).toContain('query: string;');
    expect(ts).toContain('limit?: number;');
  });

  test('arrays, nullable and unions', () => {
    expect(schemaToTs({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(schemaToTs({ type: 'array', items: { type: 'string', enum: ['a', 'b'] } })).toBe('("a" | "b")[]');
    expect(schemaToTs({ type: 'string', nullable: true })).toBe('string | null');
    expect(schemaToTs({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string | number');
  });

  test('keys that are not identifiers are quoted; free-form objects become records', () => {
    expect(schemaToTs({ type: 'object', properties: { 'a-b': { type: 'string' } } })).toContain('"a-b"?: string;');
    expect(schemaToTs({ type: 'object' })).toBe('Record<string, unknown>');
    expect(schemaToTs({ type: 'object', additionalProperties: { type: 'number' } })).toBe('Record<string, number>');
  });
});
