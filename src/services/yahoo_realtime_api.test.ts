import { describe, expect, test } from 'bun:test';
import account from '../../test/fixtures/yahoo-realtime/account.json';
import {
  buildYahooRealtimeApiUrl,
  parseYahooRealtimePayload,
  searchYahooRealtimePage,
} from './yahoo_realtime_api';

test('retains the official withdrawal as the first provider item', () => {
  const items = parseYahooRealtimePayload(account);
  expect(items[0].id).toBe('2101660418129494169');
  expect(items[0].author_handle).toBe('kimisora_JPN');
  expect(items[0].text).toContain('出演辞退');
  expect(items).toHaveLength(7);
});

test('uses zero-based Yahoo offset with a fixed 40-item page width', () => {
  const first = buildYahooRealtimeApiUrl({ query: 'SPARK id:kimisora_JPN', limit: 1 });
  const second = buildYahooRealtimeApiUrl({ query: 'SPARK id:kimisora_JPN', limit: 5, page: 2 });
  expect(first.searchParams.get('start')).toBe('0');
  expect(first.searchParams.get('results')).toBe('1');
  expect(first.searchParams.has('mtype')).toBe(false);
  expect(second.searchParams.get('start')).toBe('40');
});

describe('provider url contract', () => {
  test('recent omits md, popular sets md=h, mtype never sent', () => {
    const recent = buildYahooRealtimeApiUrl({ query: 'SPARK' });
    expect(recent.searchParams.has('md')).toBe(false);
    expect(recent.searchParams.has('mtype')).toBe(false);
    const popular = buildYahooRealtimeApiUrl({ query: 'SPARK', sort: 'popular' });
    expect(popular.searchParams.get('md')).toBe('h');
    expect(popular.searchParams.has('mtype')).toBe(false);
  });

  test('keeps the complete multi-term query encoded in p', () => {
    const query = '君と見るそら ライブ 出演 id:kimisora_JPN';
    const url = buildYahooRealtimeApiUrl({ query });
    expect(url.searchParams.get('p')).toBe(query);
  });

  test('rejects invalid limit and page', () => {
    expect(() => buildYahooRealtimeApiUrl({ query: 'SPARK', limit: 0 })).toThrow();
    expect(() => buildYahooRealtimeApiUrl({ query: 'SPARK', limit: 41 })).toThrow();
    expect(() => buildYahooRealtimeApiUrl({ query: 'SPARK', limit: 2.5 })).toThrow();
    expect(() => buildYahooRealtimeApiUrl({ query: 'SPARK', page: 0 })).toThrow();
    expect(() => buildYahooRealtimeApiUrl({ query: 'SPARK', page: 1.5 })).toThrow();
    expect(() => buildYahooRealtimeApiUrl({ query: '' })).toThrow();
  });
});

describe('payload conversion', () => {
  test('strips highlight markers but keeps the word START', () => {
    const items = parseYahooRealtimePayload({
      timeline: {
        entry: [{
          id: '1',
          url: 'https://x.com/u/status/1',
          displayTextBody: 'START \tSTART\tSPARK\tEND\t end',
          name: 'n',
          screenName: 'u',
        }],
      },
    });
    expect(items[0].text).toBe('START SPARK end');
  });

  test('falls back to displayText and generated url', () => {
    const items = parseYahooRealtimePayload({
      timeline: {
        entry: [{
          id: '42',
          displayText: 'hello',
          name: 'n',
          screenName: 'someone',
        }],
      },
    });
    expect(items[0].text).toBe('hello');
    expect(items[0].url).toBe('https://x.com/someone/status/42');
  });

  test('dedups same id, keeps empty text posts, skips numeric ids', () => {
    const items = parseYahooRealtimePayload({
      timeline: {
        entry: [
          { id: '7', url: 'https://x.com/u/status/7', displayTextBody: '', name: 'n', screenName: 'u' },
          { id: '7', url: 'https://x.com/u/status/7', displayTextBody: 'dup', name: 'n', screenName: 'u' },
          { id: 8, url: 'https://x.com/u/status/8', displayTextBody: 'numeric', name: 'n', screenName: 'u' },
        ],
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('');
  });

  test('keeps valid siblings when one entry is broken', () => {
    const items = parseYahooRealtimePayload({
      timeline: {
        entry: [
          { url: 'https://x.com/u/status/9', displayTextBody: 'no id', name: 'n', screenName: 'u' },
          { id: '10', url: 'https://x.com/u/status/10', displayTextBody: 'ok', name: 'n', screenName: 'u' },
        ],
      },
    });
    expect(items.map((i) => i.id)).toEqual(['10']);
  });

  test('rejects structural breakage, accepts empty results', () => {
    expect(() => parseYahooRealtimePayload({})).toThrow();
    expect(() => parseYahooRealtimePayload({ timeline: {} })).toThrow();
    expect(() => parseYahooRealtimePayload({ timeline: { entry: [{ id: 1 }] } })).toThrow();
    expect(parseYahooRealtimePayload({ timeline: { entry: [] } })).toEqual([]);
  });
});

describe('page fetch', () => {
  test('sends the complete multi-term query in one HTTP request', async () => {
    const requests: URL[] = [];
    const query = '君と見るそら ライブ 出演 id:kimisora_JPN';
    const result = await searchYahooRealtimePage({ query }, {
      fetchImpl: async (input) => {
        requests.push(new URL(String(input)));
        return Response.json(account);
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('p')).toBe(query);
    expect(result.items[0].id).toBe('2101660418129494169');
  });

  test('does not report provider failure as successful zero hits', async () => {
    await expect(searchYahooRealtimePage({ query: 'SPARK' }, {
      fetchImpl: async () => new Response('unavailable', { status: 503 }),
    })).rejects.toThrow();
    await expect(searchYahooRealtimePage({ query: 'SPARK' }, {
      fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }),
    })).rejects.toThrow();
    await expect(searchYahooRealtimePage({ query: 'SPARK' }, {
      fetchImpl: async () => { throw new Error('boom'); },
    })).rejects.toThrow();
  });
});
