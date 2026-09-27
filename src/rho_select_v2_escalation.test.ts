import { describe, expect, test } from 'bun:test';
import { extractWithEscalation } from './rho_select_v2_adapter.js';

const priced = [
  '## Astra Phone X \u4fa1\u683c',
  '',
  'Astra Phone X\u306e\u4fa1\u683c\u306f159,800\u5186\u3067\u3059\u3002',
  '',
  '## \u30b9\u30da\u30c3\u30af',
  '',
  'Astra Phone X\u306f\u8efd\u91cf199g\u306e\u30b9\u30de\u30fc\u30c8\u30d5\u30a9\u30f3\u3067\u3059\u3002',
].join('\n');

const mentionOnly = [
  '## Astra Phone X \u4fa1\u683c\u306b\u3064\u3044\u3066',
  '',
  'Astra Phone X\u306e\u4fa1\u683c\u306b\u3064\u3044\u3066\u89e3\u8aac\u3057\u307e\u3059\u3002\u8a73\u7d30\u306f\u5e97\u982d\u3067\u3054\u78ba\u8a8d\u304f\u3060\u3055\u3044\u3002',
].join('\n');

describe('extraction escalation (spec sections 51-53)', () => {
  test('sufficient precision stays on the precision path', () => {
    const r = extractWithEscalation(priced, 'Astra Phone X \u4fa1\u683c');
    expect(r.highlights.length).toBeGreaterThan(0);
    expect(r.diagnostics.escalation?.path).toBe('precision');
    expect(typeof r.diagnostics.extractionMs).toBe('number');
  });

  test('weak answers attempt recall and keep precision on ties', () => {
    const r = extractWithEscalation(mentionOnly, 'Astra Phone X \u4fa1\u683c');
    expect(r.diagnostics.escalation?.reason).toContain('precision-answer:0.00');
    expect(r.diagnostics.escalation?.reason).toContain('recall-answer:');
    expect(r.diagnostics.escalation?.path).toBe('precision');
  });

  test('empty input never recalls', () => {
    const r = extractWithEscalation('', 'Astra Phone X \u4fa1\u683c');
    expect(r.highlights).toEqual([]);
    expect(r.diagnostics.escalation?.path).toBe('precision');
  });

  test('maxBlocks truncates candidates and records it', () => {
    const r = extractWithEscalation(priced, 'Astra Phone X \u4fa1\u683c', { limits: { maxBlocks: 1 } });
    expect(r.diagnostics.candidateCount).toBeLessThanOrEqual(1);
    expect(r.diagnostics.limitsApplied).toContain('blocks-truncated:1');
  });

  test('zero time budget skips recall as time-boxed', () => {
    const r = extractWithEscalation(mentionOnly, 'Astra Phone X \u4fa1\u683c', { limits: { maxExtractionMs: 0 } });
    expect(r.diagnostics.escalation?.path).toBe('precision');
    expect(r.diagnostics.escalation?.reason).toBe('time-boxed');
  });
});
