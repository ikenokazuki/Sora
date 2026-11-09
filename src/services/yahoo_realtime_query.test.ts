import { afterEach, expect, setSystemTime, test } from 'bun:test';
import {
  buildYahooRealtimeQuery,
  extractRealtimeFallbackQueries,
  requiresExactRealtimeQuery,
  searchYahooRealtime,
} from './yahoo.js';

const OPT = { detailEnrichment: false } as const;

afterEach(() => setSystemTime());

test('rewrites 一昨日 to the date two days back in JST (not yesterday), and leaves no stray character', () => {
  setSystemTime(new Date('2026-11-09T03:00:00Z')); // 日本時間 11 月 9 日 12 時
  const two = extractRealtimeFallbackQueries('君と見るそら 一昨日 ライブ');
  expect(two).toContain('君と見るそら 11/7');
  expect(two).toContain('君と見るそら 11月7日');
  expect(two).not.toContain('君と見るそら 11/8');
  expect(two.some((q) => q.includes('一'))).toBe(true); // 元の問い (先頭の候補) だけが「一昨日」を残す
  expect(two.slice(1).some((q) => q.includes('一'))).toBe(false);
  const one = extractRealtimeFallbackQueries('君と見るそら 昨日 ライブ');
  expect(one).toContain('君と見るそら 11/8');
});

test('does not broaden or rewrite an OR query after an empty result', async () => {
  const seen: string[] = [];
  const query = '(SPARK ライブ) id:kimisora_JPN';
  const result: any = await searchYahooRealtime({ query, ...OPT, _callMcp: (async (_tool: string, args: Record<string, any>) => {
    seen.push(args.query);
    return { content: [{ text: JSON.stringify({ items: [] }) }] };
  }) as any } as any);
  expect(seen).toEqual([query]);
  expect(result.isFallback).toBe(false);
});

test('uses the URL operator for the structured domain option', () => {
  expect(buildYahooRealtimeQuery({ query: '告知', url: 'x.com' }))
    .toBe('告知 URL:x.com');
});

test('flags complex expressions for exact-only retrieval', () => {
  expect(requiresExactRealtimeQuery('(SPARK ライブ) id:kimisora_JPN')).toBe(true);
  expect(requiresExactRealtimeQuery('SPARK URL:yahoo.co.jp id:kimisora_JPN')).toBe(true);
  expect(requiresExactRealtimeQuery('https://www.yahoo.co.jp/ SPARK')).toBe(true);
  expect(requiresExactRealtimeQuery('君と見るそら ライブ 出演 id:kimisora_JPN')).toBe(false);
  expect(requiresExactRealtimeQuery('SPARK -出演辞退 id:kimisora_JPN')).toBe(false);
});

test('sends the full multi-term query first without shortening', async () => {
  const seen: string[] = [];
  await searchYahooRealtime({ query: '君と見るそら ライブ 出演 id:kimisora_JPN', ...OPT, _callMcp: (async (_tool: string, args: Record<string, any>) => {
    seen.push(args.query);
    return { content: [{ text: JSON.stringify({ items: [] }) }] };
  }) as any } as any);
  expect(seen[0]).toBe('君と見るそら ライブ 出演 id:kimisora_JPN');
});
