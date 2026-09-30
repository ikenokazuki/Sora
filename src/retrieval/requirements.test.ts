import { describe, expect, test } from 'bun:test';
import { extractQueryRequirements } from './requirements.js';

describe('retrieval/requirements (P1-DEEP-02)', () => {
  test('splits entity, intent and temporal', () => {
    const r = extractQueryRequirements('君と見るそら SPARK 出演時間');
    expect(r.entityTerms[0]).toBe('君と見るそら');
    expect(r.intentTerms).toContain('出演時間');
    expect(r.hasDateReference).toBe(false);
  });
  test('digit-anchored query sets temporal intent', () => {
    const r = extractQueryRequirements('9/19 14:10 live');
    expect(r.hasDateReference).toBe(true);
  });
  test('辞退 query keeps intent term', () => {
    const r = extractQueryRequirements('君と見るそら SPARK 出演辞退');
    expect(r.intentTerms).toContain('出演辞退');
  });
  test('empty input is safe', () => {
    expect(extractQueryRequirements('')).toEqual({ entityTerms: [], intentTerms: [], supportTerms: [], hasDateReference: false });
  });
});
