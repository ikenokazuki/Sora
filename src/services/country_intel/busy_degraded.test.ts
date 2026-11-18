import { describe, expect, test } from 'bun:test';
import { ResourceBusyError } from '../../errors.js';
import { type ProviderCache, type ProviderResult, runProviderPass } from './provider_registry.js';
import { createOfficialWebProvider, type WebSearchItem } from './providers/official_web.js';
import { createSocialPostsProvider } from './providers/social_posts.js';
import { planCountryResearch } from './query_planner.js';
import { resolveRegion } from './region.js';
import { createSocialService, type SocialDeps } from '../social/index.js';

/**
 * 順番・予算で断られた取得を、握って「欠けた結果」にしない（設計 6。穴 25。5f-3 のレビューの同型の穴）。
 * 提供元の結果は、利用者を区別しないキーで共有のキャッシュに入る。断られた利用者の欠けた結果が入ると、
 * 余裕のある別の利用者にも、その結果が（social_posts は 60 秒・official_web は 1 時間）返る。
 * 欠けた結果は返してよい（呼んだ利用者には役に立つ）が、キャッシュには入れない。
 */

const busy = () => new ResourceBusyError('ブラウザの枠が混み合っています。9 秒たってから、もう一度試してください', 'queue_full', 9, 'browser');

const recordingCache = (): ProviderCache & { sets: string[] } => {
  const sets: string[] = [];
  return { sets, get: () => undefined, set: (key: string, _value: ProviderResult) => { sets.push(key); } };
};

const planFor = (request: Record<string, unknown>, providers: Parameters<typeof runProviderPass>[2]) => {
  const region = resolveRegion(String(request.region));
  const capabilities = providers.map((provider) => ({ id: provider.id, areas: [...provider.areas], ...(provider.regions ? { regions: [...provider.regions] } : {}) }));
  return planCountryResearch(request as never, region, capabilities, []);
};

describe('social_posts: ブラウザの枠・Yahoo の断りを握って、欠けた結果をキャッシュに入れない', () => {
  const threads = (id: string) => `https://www.threads.com/@a/post/${id}`;
  const goodHtml = `<html><head><meta property="og:description" content="hello threads post">`
    + `<meta property="og:title" content="A (@a) on Threads"><meta property="og:url" content="${threads('ABC')}">`
    + `</head><body><a href="/@a/post/ABC"><time datetime="${new Date().toISOString()}">today</time></a></body></html>`;

  /** threads の投稿 2 件（ABC は静的な取得で読める。DEF は本文が無く、ブラウザで描画する） */
  function deps(overrides: Partial<SocialDeps> = {}): SocialDeps {
    return {
      weiboHttp: { getJson: async () => ({ status: 200, data: { ok: 1, data: { cards: [] } } }) },
      sessionOpener: { openWeiboSession: async () => [{ name: 'SUB', value: 's', domain: 'm.weibo.cn' }] },
      metaHttp: {
        getPage: async (url: string) => ({ status: 200, finalUrl: url, html: url.endsWith('ABC') ? goodHtml : '<html></html>' }),
        getJson: async () => ({ status: 200, data: {} }),
      },
      metaBrowser: { readPage: async () => { throw new Error('browser crashed'); } },
      webSearch: { search: async () => [{ url: threads('ABC') }, { url: threads('DEF') }] },
      ...overrides,
    };
  }

  async function run(socialDeps: SocialDeps, platforms: string[] = ['threads']) {
    const provider = createSocialPostsProvider({ service: createSocialService(socialDeps) });
    const plan = planFor({ region: 'Japan', query: 'starbucks', includeSocial: true, social: { platforms } }, [provider]);
    const cache = recordingCache();
    const result = await runProviderPass(plan, 1, [provider], { cache });
    return { run: result.runs[0], items: result.items, cache };
  }

  test('通常の失敗（ブラウザが落ちた）で一部だけ取れた結果は、これまでどおり partial で、キャッシュに入る', async () => {
    const { run: r, items, cache } = await run(deps());
    expect(r).toMatchObject({ status: 'partial', itemCount: 1 });
    expect(r.errorCode).toBe('PROVIDER_PARTIAL');
    expect(items).toHaveLength(1);
    expect(cache.sets).toHaveLength(1);
  });

  test('ブラウザの枠の断りで、一部だけ取れた結果は、partial / PROVIDER_BUSY で返し、キャッシュに入れない', async () => {
    const { run: r, items, cache } = await run(deps({ metaBrowser: { readPage: async () => { throw busy(); } } }));
    expect(r).toMatchObject({ status: 'partial', errorCode: 'PROVIDER_BUSY', itemCount: 1 });
    expect(items).toHaveLength(1);
    expect(r.gaps?.some((gap) => gap.reason.includes('順番・予算'))).toBe(true);
    expect(cache.sets).toEqual([]);
  });

  test('Weibo の匿名セッションを開く枠の断りで、何も取れなかったときは、rate_limited / PROVIDER_BUSY（unavailable にしない）', async () => {
    const { run: r, cache } = await run(deps({ sessionOpener: { openWeiboSession: async () => { throw busy(); } } }), ['weibo']);
    expect(r).toMatchObject({ status: 'rate_limited', errorCode: 'PROVIDER_BUSY', itemCount: 0 });
    expect(cache.sets).toEqual([]);
  });

  test('Yahoo の検索の断りで、投稿の候補を探せなかったときも、rate_limited / PROVIDER_BUSY', async () => {
    const { run: r, cache } = await run(deps({ webSearch: { search: async () => { throw busy(); } } }));
    expect(r).toMatchObject({ status: 'rate_limited', errorCode: 'PROVIDER_BUSY', itemCount: 0 });
    expect(cache.sets).toEqual([]);
  });

  test('ある SNS が取れ、別の SNS が断られたとき、取れた分は返し、キャッシュには入れない', async () => {
    const weiboOk = { ok: 1, data: { cards: [{ card_type: 9, mblog: { id: '1', bid: 'B1', text: 'post 1', created_at: new Date().toUTCString(), user: { screen_name: 'a' }, comments_count: 0 } }] } };
    const { run: r, items, cache } = await run(deps({
      weiboHttp: { getJson: async () => ({ status: 200, data: weiboOk }) },
      webSearch: { search: async () => { throw busy(); } },
    }), ['weibo', 'threads']);
    expect(items.length).toBeGreaterThan(0);
    expect(r).toMatchObject({ status: 'partial', errorCode: 'PROVIDER_BUSY' });
    expect(cache.sets).toEqual([]);
  });

  test('Weibo のセッションが期限切れで、更新（開き直し）が断られたときも、rate_limited / PROVIDER_BUSY', async () => {
    let opens = 0;
    const { run: r, cache } = await run(deps({
      sessionOpener: { openWeiboSession: async () => { opens++; if (opens > 1) throw busy(); return [{ name: 'SUB', value: 's', domain: 'm.weibo.cn' }]; } },
      weiboHttp: { getJson: async () => ({ status: 200, data: { ok: -100 } }) },
    }), ['weibo']);
    expect(opens).toBe(2);
    expect(r).toMatchObject({ status: 'rate_limited', errorCode: 'PROVIDER_BUSY', itemCount: 0 });
    expect(cache.sets).toEqual([]);
  });

  /** サービスそのものが断りを直接投げる（テスト用の偽のサービス）。検索と URL の取得は、別々に確かめる */
  async function runWithService(service: { search: () => Promise<unknown>; fetch: () => Promise<unknown> }, social: Record<string, unknown>) {
    const provider = createSocialPostsProvider({ service: { ...service, enrichWeiboTop: async (items: never[]) => items } as never });
    const plan = planFor({ region: 'Japan', query: 'starbucks', includeSocial: true, social }, [provider]);
    const cache = recordingCache();
    const result = await runProviderPass(plan, 1, [provider], { cache });
    return { run: result.runs[0], cache };
  }
  const nothing = async () => ({ status: 'empty', platform: 'threads', query: 'q', searchMode: 'test', items: [], matchedInWindow: 0, unknownTime: 0, excluded: 0, failures: [], warnings: [] });
  const noPost = async () => ({ status: 'unavailable', failures: ['no post'], warnings: [] });

  test('サービスが、検索で断りを直接投げたとき（URL の取得は断られない）も、PROVIDER_BUSY で、キャッシュに入れない', async () => {
    const { run: r, cache } = await runWithService({ search: async () => { throw busy(); }, fetch: noPost }, { platforms: ['threads'], urls: [threads('XYZ')] });
    expect(r).toMatchObject({ status: 'rate_limited', errorCode: 'PROVIDER_BUSY', itemCount: 0 });
    expect(cache.sets).toEqual([]);
  });

  test('サービスが、URL の取得で断りを直接投げたとき（検索は断られない）も、PROVIDER_BUSY で、キャッシュに入れない', async () => {
    const { run: r, cache } = await runWithService({ search: nothing, fetch: async () => { throw busy(); } }, { platforms: ['threads'], urls: [threads('XYZ')] });
    expect(r).toMatchObject({ status: 'rate_limited', errorCode: 'PROVIDER_BUSY', itemCount: 0 });
    expect(cache.sets).toEqual([]);
  });

  test('断りでない失敗（URL の取得）は、これまでどおり、PROVIDER_BUSY にしない', async () => {
    const { run: r } = await runWithService({ search: nothing, fetch: noPost }, { platforms: ['threads'], urls: [threads('XYZ')] });
    expect(r.errorCode).not.toBe('PROVIDER_BUSY');
  });
});

describe('official_web: 記事本文の取得の断りを握って、見出しと概要だけの結果をキャッシュに入れない', () => {
  const found: WebSearchItem[] = [
    { url: 'https://news.example/a', title: 'A', snippet: 'snippet a', domain: 'news.example' },
    { url: 'https://news.example/b', title: 'B', snippet: 'snippet b', domain: 'news.example' },
  ];
  const article = { markdown: 'First paragraph of the article.\n\nSecond paragraph of the article.' };

  async function run(scrapeArticle: (url: string, signal: AbortSignal) => Promise<unknown>) {
    const provider = createOfficialWebProvider({ searchWeb: async () => found, scrapeArticle: scrapeArticle as never, verifiedDomains: [] });
    const plan = planFor({ region: 'Japan', noCache: true }, [provider]);
    const cache = recordingCache();
    const result = await runProviderPass(plan, 1, [provider], { cache });
    return { run: result.runs[0], items: result.items, cache };
  }

  test('本文が取れたときは、これまでどおり success で、キャッシュに入る', async () => {
    const { run: r, items, cache } = await run(async () => article);
    expect(r).toMatchObject({ status: 'success' });
    expect(items.every((entry) => entry.item.detail?.contentKind === 'extracted_text')).toBe(true);
    expect(cache.sets).toHaveLength(1);
  });

  test('通常の失敗（取得できないページ）は、概要だけを残して success で、キャッシュに入る（これまでどおり）', async () => {
    const { run: r, cache } = await run(async () => { throw new Error('HTTP 404'); });
    expect(r).toMatchObject({ status: 'success' });
    expect(cache.sets).toHaveLength(1);
  });

  test('本文の取得が順番・予算で断られたら、概要だけの結果は返すが、partial / PROVIDER_BUSY で、キャッシュに入れない', async () => {
    const { run: r, items, cache } = await run(async () => { throw busy(); });
    expect(r).toMatchObject({ status: 'partial', errorCode: 'PROVIDER_BUSY', itemCount: 2 });
    expect(items.every((entry) => entry.item.detail?.contentKind === 'excerpt')).toBe(true);
    expect(r.gaps?.some((gap) => gap.reason.includes('順番・予算'))).toBe(true);
    expect(cache.sets).toEqual([]);
  });

  test('1 件だけ断られ、ほかは本文が取れたときも、キャッシュに入れない（本文が取れた記事は、本文つきで返す）', async () => {
    let calls = 0;
    const { run: r, items, cache } = await run(async () => { calls++; if (calls === 1) throw busy(); return article; });
    expect(r).toMatchObject({ status: 'partial', errorCode: 'PROVIDER_BUSY' });
    expect(items.some((entry) => entry.item.detail?.contentKind === 'extracted_text')).toBe(true);
    expect(cache.sets).toEqual([]);
  });
});
