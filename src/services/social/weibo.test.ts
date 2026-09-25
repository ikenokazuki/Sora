import { describe, expect, test } from 'bun:test';
import { extractMblogs, fetchWeiboHotComments, fetchWeiboStatus, parseWeiboTime, searchWeibo, stripWeiboHtml, WeiboAuthError, type WeiboHttp } from './weibo.js';

const mblog = (id: string, text: string, created_at = 'Fri Sep 25 22:29:20 +0800 2026') => ({
  id, bid: 'B' + id, text, created_at, user: { screen_name: 'author' + id }, comments_count: 3,
});
const pageData = (posts: any[]) => ({ ok: 1, data: { cards: posts.map((mblog) => ({ card_type: 9, mblog })) } });

describe('weibo search', () => {
  test('dedups across pages and stops at limit', async () => {
    const calls: string[] = [];
    const http: WeiboHttp = {
      getJson: async (url) => {
        calls.push(url);
        if (url.includes('page=1')) return { status: 200, data: pageData([mblog('1', 'a'), mblog('2', 'b')]) };
        return { status: 200, data: pageData([mblog('2', 'b'), mblog('3', 'c')]) };
      },
    };
    const { posts, failures } = await searchWeibo(http, [], 'q', 3, AbortSignal.timeout(5000));
    expect(posts.map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(failures).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(3);
  });
  test('auth failure surfaces for session renewal', async () => {
    const http: WeiboHttp = { getJson: async () => ({ status: 200, data: { ok: -100, url: '/sso/signin' } }) };
    await expect(searchWeibo(http, [], 'q', 5, AbortSignal.timeout(5000))).rejects.toBeInstanceOf(WeiboAuthError);
  });
  test('nested card_group posts are found', () => {
    const data = { ok: 1, data: { cards: [{ card_type: 11, card_group: [{ card_type: 9, mblog: mblog('9', 'nested') }] }] } };
    expect(extractMblogs(data).map((p) => p.id)).toEqual(['9']);
  });
});

describe('weibo status and comments', () => {
  test('status envelope error throws', async () => {
    const http: WeiboHttp = { getJson: async () => ({ status: 200, data: { ok: 0, msg: 'gone' } }) };
    await expect(fetchWeiboStatus(http, 'X', AbortSignal.timeout(5000))).rejects.toThrow();
  });
  test('hot comments parse author, time, and text', async () => {
    const http: WeiboHttp = {
      getJson: async () => ({
        status: 200,
        data: { ok: 1, data: { data: [{ id: 11, created_at: 'Sat Aug 29 10:08:26 +0800 2026', text: 'good <span>.赞</span>', user: { screen_name: 'fan' } }] } },
      }),
    };
    const r = await fetchWeiboHotComments(http, '123', 10, AbortSignal.timeout(5000));
    expect(r.state).toBe('fetched');
    expect(r.comments[0].author).toBe('fan');
    expect(r.comments[0].publishedAt).toContain('2026-08-29');
    expect(r.comments[0].text).toContain('good');
  });
});

describe('weibo text and time', () => {
  test('keeps emoji alt text and line breaks', () => {
    const out = stripWeiboHtml('a<br>b<img alt="[\u559c]" src="x">c');
    expect(out).toContain('[\u559c]');
    expect(out.split('\n')).toHaveLength(2);
  });
  test('parses weibo timestamps to ISO', () => {
    expect(parseWeiboTime('Fri Sep 25 22:29:20 +0800 2026')).toBe('2026-09-25T14:29:20.000Z');
    expect(parseWeiboTime('not a date')).toBeNull();
    expect(parseWeiboTime(undefined)).toBeNull();
  });
});
