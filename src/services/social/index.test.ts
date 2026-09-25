import { describe, expect, test } from 'bun:test';
import { createSocialService, type SocialDeps } from './index.js';
import { WeiboAuthError } from './weibo.js';

const mblog = (id: string, created_at = 'Fri Sep 25 22:29:20 +0800 2026') => ({
  id, bid: 'B' + id, text: 'post ' + id, created_at, user: { screen_name: 'a' }, comments_count: Number(id),
});
const searchPayload = (posts: any[]) => ({ ok: 1, data: { cards: posts.map((m) => ({ card_type: 9, mblog: m })) } });
const NOW = new Date('2026-09-25T15:00:00.000Z').getTime();
const ctx = () => ({ signal: AbortSignal.timeout(10000), deadlineAt: NOW + 55000 });

function baseDeps(overrides: Partial<SocialDeps> = {}): SocialDeps {
  return {
    weiboHttp: { getJson: async () => ({ status: 200, data: searchPayload([]) }) },
    sessionOpener: { openWeiboSession: async () => [{ name: 'SUB', value: 's', domain: 'm.weibo.cn' }] },
    metaHttp: {
      getPage: async () => ({ status: 200, finalUrl: 'https://x.invalid/', html: '<html></html>' }),
      getJson: async () => ({ status: 200, data: {} }),
    },
    webSearch: { search: async () => [] },
    now: () => NOW,
    ...overrides,
  };
}

describe('social search weibo', () => {
  test('fresh posts are ok with window counts', async () => {
    const svc = createSocialService(baseDeps({
      weiboHttp: { getJson: async (url) => url.includes('statuses')
        ? { status: 200, data: { ok: 1, data: mblog('7') } }
        : { status: 200, data: searchPayload([mblog('7'), mblog('8')]) } },
    }));
    const r = await svc.search({ platform: 'weibo', query: 'q', limit: 10, lookbackHours: 24 }, ctx());
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(2);
    expect(r.matchedInWindow).toBe(2);
    expect(r.items[0].method).toContain('weibo_public_mobile_json');
  });
  test('stale posts are excluded, not counted as matches', async () => {
    const svc = createSocialService(baseDeps({
      weiboHttp: { getJson: async () => ({ status: 200, data: searchPayload([mblog('1', 'Mon Aug 03 10:00:00 +0800 2026')]) }) },
    }));
    const r = await svc.search({ platform: 'weibo', query: 'q', limit: 10, lookbackHours: 24 }, ctx());
    expect(r.status).toBe('empty');
    expect(r.excluded).toBe(1);
    expect(r.items).toHaveLength(0);
  });
  test('auth failure renews the session once', async () => {
    let calls = 0;
    let opens = 0;
    const svc = createSocialService(baseDeps({
      sessionOpener: { openWeiboSession: async () => { opens++; return [{ name: 'SUB', value: 's' + opens, domain: 'm.weibo.cn' }]; } },
      weiboHttp: { getJson: async () => { calls++; return calls === 1 ? { status: 200, data: { ok: -100 } } : { status: 200, data: searchPayload([mblog('5')]) }; } },
    }));
    const r = await svc.search({ platform: 'weibo', query: 'q', limit: 10, lookbackHours: 24 }, ctx());
    expect(opens).toBe(2);
    expect(r.items).toHaveLength(1);
    expect(r.status).toBe('partial');
    expect(r.failures.join(' ')).toContain('renewing');
  });
  test('rate limit is unavailable, never empty', async () => {
    const svc = createSocialService(baseDeps({
      weiboHttp: { getJson: async () => ({ status: 429, data: {} }) },
    }));
    const r = await svc.search({ platform: 'weibo', query: 'q', limit: 10, lookbackHours: 24 }, ctx());
    expect(r.status).toBe('unavailable');
    expect(r.items).toHaveLength(0);
  });
});

describe('social search meta', () => {
  const threadsHtml = '<html><head><meta property="og:description" content="hello threads post">'
    + '<meta property="og:title" content="Starbucks (@starbucks) on Threads">'
    + '<meta property="og:url" content="https://www.threads.com/@starbucks/post/ABC/">'
    + '</head><body><a href="/@starbucks/post/ABC"><time datetime="2026-09-25T10:00:00.000Z">today</time></a></body></html>';
  test('discovers post urls and reads bodies', async () => {
    const svc = createSocialService(baseDeps({
      webSearch: { search: async () => [{ url: 'https://www.threads.com/@starbucks/post/ABC' }, { url: 'https://www.threads.com/@starbucks/' }] },
      metaHttp: {
        getPage: async () => ({ status: 200, finalUrl: 'https://www.threads.com/@starbucks/post/ABC', html: threadsHtml }),
        getJson: async () => ({ status: 200, data: {} }),
      },
    }));
    const r = await svc.search({ platform: 'threads', query: 'starbucks', limit: 10, lookbackHours: 24 }, ctx());
    expect(r.items).toHaveLength(1);
    expect(r.items[0].text).toBe('hello threads post');
    expect(r.items[0].author).toBe('starbucks');
    expect(r.items[0].searchMode).toBe('web_index');
    expect(r.matchedInWindow).toBe(1);
  });
});

describe('social fetch', () => {
  test('weibo fetch enriches full text and comments', async () => {
    const svc = createSocialService(baseDeps({
      weiboHttp: { getJson: async (url) => {
        if (url.includes('statuses/show')) return { status: 200, data: { ok: 1, data: { ...mblog('99'), isLongText: false } } };
        return { status: 200, data: { ok: 1, data: { data: [{ id: 1, created_at: 'Sat Aug 29 10:08:26 +0800 2026', text: 'nice', user: { screen_name: 'fan' } }] } } };
      } },
    }));
    const r = await svc.fetch({ url: 'https://m.weibo.cn/detail/99', commentLimit: 5 }, ctx());
    expect(r.status).toBe('ok');
    expect(r.post?.text).toContain('post 99');
    expect(r.post?.comments?.state).toBe('fetched');
    expect(r.post?.comments?.items[0].author).toBe('fan');
  });
  test('meta fetch marks comments unsupported without failing', async () => {
    const svc = createSocialService(baseDeps({
      metaHttp: {
        getPage: async () => ({ status: 200, finalUrl: 'https://www.threads.com/@threads/post/DWjTI0cgH5O/', html: '<html><head><meta property="og:description" content="crayons post"></head><body><a href="/@threads/post/DWjTI0cgH5O"><time datetime="2026-03-31T14:06:01.000Z">day</time></a></body></html>' }),
        getJson: async () => ({ status: 200, data: {} }),
      },
    }));
    const r = await svc.fetch({ url: 'https://www.threads.com/@threads/post/DWjTI0cgH5O/', commentLimit: 5 }, ctx());
    expect(r.post?.text).toBe('crayons post');
    expect(r.post?.comments?.state).toBe('unsupported');
    expect(r.status).toBe('ok');
  });
  test('unsupported urls are unavailable, not empty', async () => {
    const svc = createSocialService(baseDeps());
    const r = await svc.fetch({ url: 'https://example.org/article', commentLimit: 0 }, ctx());
    expect(r.status).toBe('unavailable');
    expect(r.post).toBeUndefined();
  });
  test('invalid input is rejected', async () => {
    const svc = createSocialService(baseDeps());
    await expect(svc.search({ platform: 'weibo', query: '  ', limit: 10, lookbackHours: 24 }, ctx())).rejects.toThrow();
  });
});
