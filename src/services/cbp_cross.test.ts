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
    const res = await lookupCrossRulings(['mug']);
    expect(res.status).toBe('ok');
    expect(res.rulings.map((r) => r.rulingNumber)).toEqual(['N1', 'N6']);
    expect(res.rulings[0]).toMatchObject({ date: '2020-01-02', tariffs: ['6912004400'], url: 'https://rulings.cbp.gov/ruling/N1' });
  });

  it('keeps the few rulings of a specific query first and fills up from the general one (leather coaster: 2 rulings, coaster: 132)', async () => {
    responses['pu leather coaster'] = { rulings: [] };
    responses['leather coaster'] = { rulings: [ruling('D85840', '4205.00.8000'), ruling('d84016', '4205.00.8000')] };
    responses.coaster = { totalHits: 132, rulings: [ruling('N022273', '6304.93.0000'), ruling('D85840', '4205.00.8000'), ruling('N030229', '6304.92.0000')] };
    const res = await lookupCrossRulings(['pu leather coaster', 'leather coaster', 'coaster']);
    expect(terms).toEqual(['pu leather coaster', 'leather coaster', 'coaster']);
    expect(res.rulings.map((r) => r.rulingNumber)).toEqual(['D85840', 'd84016', 'N022273', 'N030229']); // 重複は除き、具体的な照会語の判例が先頭
    expect(res.query).toBe('leather coaster / coaster');
  });

  it('stops asking once it has enough rulings, and caps the list at the target', async () => {
    responses.a = { rulings: Array.from({ length: 12 }, (_, i) => ruling(`A${i}`, '6912.00.4400')) };
    responses.b = { rulings: [ruling('B1', '6912.00.4500')] };
    const res = await lookupCrossRulings(['a', 'b'], 10);
    expect(terms).toEqual(['a']);
    expect(res.rulings).toHaveLength(10);
  });

  it('reports no_rulings when nothing matches', async () => {
    const res = await lookupCrossRulings(['quantum widget']);
    expect(res).toEqual({ status: 'no_rulings', rulings: [] });
  });

  it('ignores words that match thousands of rulings (their top hits are unrelated to the product)', async () => {
    responses.model = { totalHits: 9599, rulings: [ruling('A', '9503.00.00'), ruling('B', '9503.00.00'), ruling('C', '9503.00.00')] };
    const res = await lookupCrossRulings(['model']);
    expect(res.status).toBe('no_rulings');
  });

  it('caches a term, so a repeated lookup does not call CROSS again', async () => {
    responses.mug = { rulings: [ruling('N1', '6912.00.4400')] };
    await lookupCrossRulings(['mug']);
    await lookupCrossRulings(['mug']);
    expect(terms).toEqual(['mug']);
  });

  it('reports unavailable on an upstream error and stays quiet for a while instead of retrying every request', async () => {
    responses.mug = 'fail';
    const first = await lookupCrossRulings(['mug']);
    expect(first.status).toBe('unavailable');
    expect(first.error).toContain('503');
    const second = await lookupCrossRulings(['cup']);
    expect(second.status).toBe('unavailable');
    expect(terms).toEqual(['mug']); // 2回目は通信していない
    resetCrossBreakerForTest();
    responses.cup = { rulings: [ruling('N1', '6912.00.4400')] };
    expect((await lookupCrossRulings(['cup'])).status).toBe('ok');
  });

  it('keeps the rulings already found when a later query fails', async () => {
    responses.a = { rulings: [ruling('N1', '6912.00.4400')] };
    responses.b = 'fail';
    const res = await lookupCrossRulings(['a', 'b']);
    expect(res.status).toBe('ok');
    expect(res.rulings).toHaveLength(1);
  });
});
