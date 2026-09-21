import { expect, test } from 'bun:test';
import {
  buildYahooRealtimeQuery,
  requiresExactRealtimeQuery,
  searchYahooRealtime,
} from './yahoo.js';

const OPT = { detailEnrichment: false } as const;

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
