import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearCache } from '../cache.js';
import { lookupCrossRulings, parseCrossTariffs, resetCrossBreakerForTest } from './cbp_cross.js';

type Raw = { rulingNumber: string; subject?: string; categories?: string; rulingDate?: string; tariffs?: string; operationallyRevoked?: boolean; revokedBy?: unknown[] };
const ruling = (n: string, tariffs: string, extra: Partial<Raw> = {}): Raw => ({
  rulingNumber: n,
  subject: `The tariff classification of item ${n}`,
  categories: 'Classification',
  rulingDate: '2020-01-02T00:00:00',
  tariffs,
  operationallyRevoked: false,
  revokedBy: [],
  ...extra,
});

describe('CBP CROSS ruling lookup', () => {
  const originalFetch = globalThis.fetch;
  let terms: string[] = [];
  // term ごとの応答。未登録の語は 0 件
  let responses: Record<string, { totalHits?: number; rulings: Raw[] } | 'fail'> = {};

  beforeEach(() => {
    clearCache();
    resetCrossBreakerForTest();
    terms = [];
    responses = {};
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      expect(url.hostname).toBe('rulings.cbp.gov');
      const term = url.searchParams.get('term') ?? '';
      terms.push(term);
      const r = responses[term];
      if (r === 'fail') return new Response('upstream error', { status: 503 });
      return new Response(JSON.stringify({ totalHits: r?.totalHits ?? r?.rulings.length ?? 0, rulings: r?.rulings ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses tariff numbers in old and new notations into digits', () => {
    expect(parseCrossTariffs('6912.00.4400, 6912.00.4810')).toEqual(['6912004400', '6912004810']);
    expect(parseCrossTariffs('6506.10.60')).toEqual(['65061060']);
    expect(parseCrossTariffs('9903.88.15; 6109.10.00.04 and 6109.10')).toEqual(['990388 15'.replace(' ', ''), '6109100004', '610910']);
    expect(parseCrossTariffs(undefined)).toEqual([]);
    expect(parseCrossTariffs('no code here')).toEqual([]);
  });

  it('keeps classification rulings only, and drops revoked ones and rulings without a tariff number', async () => {
    responses.mug = {
      rulings: [
        ruling('N1', '6912.00.4400'),
        ruling('N2', '6912.00.4500', { operationallyRevoked: true }),
        ruling('N3', '7323.93.0080', { revokedBy: [{ rulingNumber: 'H9' }] }),
        ruling('N4', '3924.10.4000', { categories: 'Marking' }),
        ruling('N5', ''),
        ruling('N6', '6911.10.5800', { categories: 'Classification, Marking' }),
      ],
    };
    const res = await lookupCrossRulings(['mug'], 1);
    expect(res.status).toBe('ok');
    expect(res.rulings.map((r) => r.rulingNumber)).toEqual(['N1', 'N6']);
    expect(res.rulings[0]).toMatchObject({ date: '2020-01-02', tariffs: ['6912004400'], url: 'https://rulings.cbp.gov/ruling/N1' });
  });

  it('tries the queries in order and stops at the first one with enough rulings (the search is AND, so long titles get 0 hits)', async () => {
    responses['wooden building blocks'] = { rulings: [ruling('A', '9503.00.00'), ruling('B', '9503.00.00'), ruling('C', '9503.00.00')] };
    responses.blocks = { rulings: [ruling('Z', '3926.90.99')] };
    const res = await lookupCrossRulings(['wooden building blocks toddlers', 'wooden building blocks', 'blocks'], 3);
    expect(terms).toEqual(['wooden building blocks toddlers', 'wooden building blocks']);
    expect(res.query).toBe('wooden building blocks');
    expect(res.rulings).toHaveLength(3);
  });

  it('falls back to the query that returned the most rulings when none reaches the minimum', async () => {
    responses['a b'] = { rulings: [ruling('A', '6912.00.44')] };
    responses.b = { rulings: [ruling('X', '6912.00.44'), ruling('Y', '6912.00.45')] };
    const res = await lookupCrossRulings(['a b', 'b'], 3);
    expect(res.query).toBe('b');
    expect(res.rulings).toHaveLength(2);
  });

  it('reports no_rulings when nothing matches', async () => {
    const res = await lookupCrossRulings(['quantum widget'], 3);
    expect(res).toEqual({ status: 'no_rulings', rulings: [] });
  });

  it('ignores words that match thousands of rulings (their top hits are unrelated to the product)', async () => {
    responses.model = { totalHits: 9599, rulings: [ruling('A', '9503.00.00'), ruling('B', '9503.00.00'), ruling('C', '9503.00.00')] };
    const res = await lookupCrossRulings(['model'], 1);
    expect(res.status).toBe('no_rulings');
  });

  it('caches a term, so a repeated lookup does not call CROSS again', async () => {
    responses.mug = { rulings: [ruling('N1', '6912.00.4400')] };
    await lookupCrossRulings(['mug'], 1);
    await lookupCrossRulings(['mug'], 1);
    expect(terms).toEqual(['mug']);
  });

  it('reports unavailable on an upstream error and stays quiet for a while instead of retrying every request', async () => {
    responses.mug = 'fail';
    const first = await lookupCrossRulings(['mug'], 1);
    expect(first.status).toBe('unavailable');
    expect(first.error).toContain('503');
    const second = await lookupCrossRulings(['cup'], 1);
    expect(second.status).toBe('unavailable');
    expect(terms).toEqual(['mug']); // 2回目は通信していない
    resetCrossBreakerForTest();
    responses.cup = { rulings: [ruling('N1', '6912.00.4400')] };
    expect((await lookupCrossRulings(['cup'], 1)).status).toBe('ok');
  });

  it('keeps the rulings already found when a later query fails', async () => {
    responses.a = { rulings: [ruling('N1', '6912.00.4400')] };
    responses.b = 'fail';
    const res = await lookupCrossRulings(['a', 'b'], 3);
    expect(res.status).toBe('ok');
    expect(res.rulings).toHaveLength(1);
  });
});
