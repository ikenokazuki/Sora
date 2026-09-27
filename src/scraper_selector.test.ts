import { describe, expect, test } from 'bun:test';
import { selectScrapeTargets } from './scraper.js';
import { computeAnswerability, rerankByDeepEvidence } from './enrichment.js';

describe('P1-4 selectScrapeTargets', () => {
  test('top3 guaranteed and diversity slots filled', () => {
    const pool = [
      { title: 'k1', snippet: 'kimisora', url: 'https://official.example/1', lexicalScore: 5 },
      { title: 'k2', snippet: 'kimisora', url: 'https://official.example/2', lexicalScore: 5 },
      { title: 'k3', snippet: 'kimisora', url: 'https://official.example/3', lexicalScore: 5 },
      { title: 'k4', snippet: 'kimisora', url: 'https://official.example/4', lexicalScore: 5 },
      { title: 'Reuters SPARK', snippet: 'kimisora SPARK', url: 'https://reuters.example/spark', lexicalScore: 1 },
      { title: 'Tech SPARK', snippet: 'SPARK syutuen', url: 'https://tech.example/spark', lexicalScore: 1 },
    ];
    const { targets, spares } = selectScrapeTargets(pool as any, 5, 'kimisora SPARK');
    expect(targets).toHaveLength(5);
    expect(targets[0].url).toBe('https://official.example/1');
    expect(targets[1].url).toBe('https://official.example/2');
    expect(targets[2].url).toBe('https://official.example/3');
    const picked = targets.slice(3).map((t: any) => t.url).sort();
    expect(picked).toEqual(['https://reuters.example/spark', 'https://tech.example/spark'].sort());
    expect(spares.map((s: any) => s.url)).toContain('https://official.example/4');
  });
  test('saturated hosts are penalized in remaining slots', () => {
    const pool = [
      { title: 'a1', snippet: 'x', url: 'https://same.example/1', lexicalScore: 1 },
      { title: 'a2', snippet: 'x', url: 'https://same.example/2', lexicalScore: 1 },
      { title: 'a3', snippet: 'x', url: 'https://same.example/3', lexicalScore: 1 },
      { title: 'a4', snippet: 'x', url: 'https://same.example/4', lexicalScore: 1 },
      { title: 'b1', snippet: 'x', url: 'https://other.example/1', lexicalScore: 1 },
      { title: 'c1', snippet: 'x', url: 'https://third.example/1', lexicalScore: 0 },
    ];
    const { targets } = selectScrapeTargets(pool as any, 5, 'zzzqq');
    const picked = targets.slice(3).map((t: any) => t.url);
    expect(picked).toContain('https://other.example/1');
    expect(picked).toContain('https://third.example/1');
    expect(picked).not.toContain('https://same.example/4');
  });
  test('small pool falls back to slice', () => {
    const pool = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
    const { targets, spares } = selectScrapeTargets(pool as any, 5, 'test');
    expect(targets).toHaveLength(2);
    expect(spares).toHaveLength(0);
  });

  test('assessEvidenceSufficiency detects missing terms', async () => {
    const { assessEvidenceSufficiency } = await import('./scraper.js');
    const good = assessEvidenceSufficiency(
      [
        { title: 'kimisora SPARK', markdown: 'kimisora SPARK 18:20', highlights: ['kimisora SPARK'] },
        { title: 'timetable', markdown: 'SPARK timetable', highlights: ['timetable'] },
        { title: 'event', markdown: 'event info', highlights: ['info'] },
      ] as any,
      'kimisora SPARK',
    );
    expect(good.sufficient).toBe(true);
    const weak = assessEvidenceSufficiency(
      [{ title: 'kimisora', markdown: 'kimisora only', highlights: [] }] as any,
      'kimisora SPARK timetable',
    );
    expect(weak.sufficient).toBe(false);
  });


  test('answerability detects price and cancel signals', async () => {
    const { computeAnswerability } = await import('./enrichment.js');
    const price = computeAnswerability({ title: 't', snippet: '価格 3500円' } as any, 'チケット 価格');
    expect(price.signals).toContain('price');
    const noprice = computeAnswerability({ title: 't', snippet: 'live report' } as any, 'チケット 価格');
    expect(noprice.signals).not.toContain('price');
    const cancel = computeAnswerability({ title: 't', snippet: '出演辞退のお知らせ' } as any, '出演辞退');
    expect(cancel.signals).toContain('cancel');
  });
  test('answerability detects time signal', () => {
    const r = computeAnswerability({ title: 'live', snippet: 'live 14:10-14:30' } as any, 'live time');
    expect(r.signals).toContain('concrete');
  });

  test('weighted evidence prefers entity coverage', () => {
    const items = [
      { title: 'A', markdown: 'generic bigram text', highlights: [] },
      { title: 'kimisora SPARK time', markdown: 'kimisora SPARK 18:20', highlights: ['kimisora SPARK'] },
    ];
    const ranked = rerankByDeepEvidence(items as any, 'kimisora SPARK');
    expect(ranked[0].title).toContain('kimisora');
  });

  test('targets carry selection reasons', () => {
    const pool = [
      { title: 'k1', snippet: 'kimisora', url: 'https://official.example/1' },
      { title: 'k2', snippet: 'kimisora', url: 'https://official.example/2' },
      { title: 'k3', snippet: 'kimisora', url: 'https://official.example/3' },
      { title: 'k4', snippet: 'kimisora', url: 'https://official.example/4' },
      { title: 'SPARK report', snippet: 'kimisora SPARK', url: 'https://news.example/s' },
      { title: 'extra', snippet: 'other', url: 'https://other.example/e' },
    ];
    const { targets } = selectScrapeTargets(pool as any, 5, 'kimisora SPARK', 'rrf_top_rank');
    expect(targets.slice(0, 3).every((t: any) => t.selectionReason === 'rrf_top_rank')).toBe(true);
    expect(['missing_requirement', 'source_diversity']).toContain(targets[3].selectionReason);
  });
});