import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResourceBusyError } from '../../errors.js';
import { runAsCaller } from '../../security/caller.js';
import { getSecurityMetrics, resetSecurityMetrics } from '../../security/metrics.js';
import { providerHttpGate, resetProviderHttpState } from './provider_http.js';
import { type CountryIntelProvider, type ProviderCache, type ProviderResult, runProviderPass } from './provider_registry.js';
import { createBingNewsProvider } from './providers/bing_news.js';
import { createFediverseProvider } from './providers/fediverse.js';
import { createGdacsProvider } from './providers/gdacs.js';
import { createGdeltExportProvider } from './providers/gdelt_files.js';
import { createGoogleNewsProvider } from './providers/google_news.js';
import { createGlobalFeedsProvider } from './providers/feeds.js';
import { createOfficialWebProvider } from './providers/official_web.js';
import { planCountryResearch } from './query_planner.js';
import { resolveRegion } from './region.js';
import { createDefaultCountryIntelDependencies, researchCountryWithDefaults } from './runtime.js';

/**
 * 国の情報の提供元への取得が、順番・予算で断られたとき（ResourceBusyError。設計 6。穴 25）。
 * 断りは、提供元の失敗として握らない・包まない: 再試行されず、部分的な結果にならず、共有のキャッシュに入らない
 * （入ると、予算を使い切った利用者の欠けた結果が、予算に余裕のある別の利用者にも返る）。
 * 報告は、その提供元だけ rate_limited / PROVIDER_BUSY として、ほかの提供元の結果は返す。
 */

process.env.SORA_INTEL_SCRAPE = 'off';
process.env.SORA_INTEL_WEB_SEARCH = 'off';

/** fetchProviderResponse を通る提供元の全部 */
const GATED = ['baidu_hot', 'bing_news', 'bluesky', 'eonet', 'fediverse', 'gdacs', 'gdelt_export', 'global_feeds', 'google_news', 'thepaper_hot', 'toutiao_hot', 'usgs', 'wallstreet_live', 'wiki_current', 'zhihu_hot'];

const SAVED_ISOLATION = process.env.SORA_ISOLATION;
const realFetch = globalThis.fetch;
const spies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  delete process.env.SORA_ISOLATION;
  resetProviderHttpState();
  resetSecurityMetrics();
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  globalThis.fetch = realFetch;
  if (SAVED_ISOLATION === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = SAVED_ISOLATION;
  resetProviderHttpState();
});

const busy = () => new ResourceBusyError('国の情報の取得の、この利用者の予算（1 分に 120 回）を使い切りました。42 秒たってから、もう一度試してください', 'tenant_budget', 42, 'country_intel');
const noFetch = () => { globalThis.fetch = (async () => { throw new Error('提供元に出してはいけない'); }) as unknown as typeof fetch; };

/** 取得の入口（admit）を、最初の n 回は通し、それ以降は断りにする。数えた回数を返す */
function admitAfter(passes: number, error = busy()) {
  const counter = { calls: 0 };
  spies.push(spyOn(providerHttpGate, 'admit').mockImplementation(async () => {
    counter.calls++;
    if (counter.calls > passes) throw error;
    return () => undefined;
  }));
  return counter;
}

const recordingCache = (): ProviderCache & { sets: string[] } => {
  const sets: string[] = [];
  return { sets, get: () => undefined, set: (key: string, _value: ProviderResult) => { sets.push(key); } };
};

const planFor = (request: Record<string, unknown>, providers: readonly CountryIntelProvider[]) => {
  const region = resolveRegion(String(request.region));
  const capabilities = providers.map((provider) => ({ id: provider.id, areas: [...provider.areas], ...(provider.regions ? { regions: [...provider.regions] } : {}) }));
  return { region, plan: planCountryResearch(request as never, region, capabilities, []) };
};

describe('全部の提供元: 断りは PROVIDER_BUSY（rate_limited）。再試行せず、提供元に出さず、キャッシュに入れない', () => {
  test('取得の入口が全部断るとき、取得を出す 15 の提供元の全部が rate_limited / PROVIDER_BUSY', async () => {
    noFetch();
    const counter = admitAfter(0);
    const providers = createDefaultCountryIntelDependencies({}, { disabledProviders: [] }).providers!.filter((provider) => GATED.includes(provider.id));
    expect(providers.map((provider) => provider.id).toSorted()).toEqual(GATED);
    const { plan } = planFor({ region: 'China', query: 'chip export', includeSocial: true, noCache: true }, providers);
    const cache = recordingCache();
    const result = await runProviderPass(plan, 1, providers, { cache });
    expect(result.runs.map((run) => run.provider).toSorted()).toEqual(GATED);
    for (const run of result.runs) {
      expect(run, run.provider).toMatchObject({ status: 'rate_limited', errorCode: 'PROVIDER_BUSY', itemCount: 0 });
    }
    expect(cache.sets).toEqual([]);
    expect(counter.calls).toBeGreaterThanOrEqual(GATED.length);
  });

  test('断りは再試行しない: 順に取得する提供元（global_feeds）は、1 回の取得で断られたら、そこで終わる（入口を呼ぶのは 1 回）', async () => {
    noFetch();
    const counter = admitAfter(0);
    const providers = [createGlobalFeedsProvider()];
    const { plan } = planFor({ region: 'China', noCache: true }, providers);
    const result = await runProviderPass(plan, 1, providers, { cache: null });
    expect(result.runs[0]).toMatchObject({ status: 'rate_limited', errorCode: 'PROVIDER_BUSY' });
    expect(counter.calls).toBe(1);
  });

  test('キャッシュにある提供元は、入口を通らない（順番も予算も使わない）。断られている最中でも、その結果を返す', async () => {
    noFetch();
    const counter = admitAfter(0);
    const providers = [createGlobalFeedsProvider()];
    const { plan } = planFor({ region: 'China' }, providers);
    const cache: ProviderCache = { get: () => ({ value: { items: [], coverage: ['media_activity'] }, expiresAt: Date.now() + 60_000 }), set: () => undefined };
    const result = await runProviderPass(plan, 1, providers, { cache });
    expect(result.runs[0]).toMatchObject({ status: 'success' });
    expect(counter.calls).toBe(0);
  });
});

describe('一部の取得だけが断られても、部分的な結果にしない（共有キャッシュに入るため）', () => {
  const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${'<item><title>a</title><link>https://news.example/1</link><pubDate>' + new Date().toUTCString() + '</pubDate></item>'}</channel></rss>`;
  const okFeed = (async () => new Response(feedXml, { status: 200, headers: { 'content-type': 'application/rss+xml' } })) as (url: string, init?: RequestInit) => Promise<Response>;
  const signal = () => new AbortController().signal;

  test('google_news: 検索語の 1 つの取得が断られたら、ほかが成功していても、提供元ごと断る（gaps つきの成功にしない）', async () => {
    const error = busy();
    const counter = admitAfter(1, error);
    const provider = createGoogleNewsProvider(okFeed);
    const { region, plan } = planFor({ region: 'Japan', topics: ['economy', 'politics'], noCache: true }, [provider]);
    const queries = plan.pass1.filter((query) => query.providerId === 'google_news');
    await expect(provider.run({ request: plan.request, region, queries }, signal())).rejects.toBe(error);
    // 検索語は提供元の中で複数に増える。最初の 1 件は通り（成功）、残りが断られても、結果は部分的にならない
    expect(counter.calls).toBeGreaterThan(1);
  });

  test('bing_news: 検索語の 1 つが断られたら、提供元ごと断る', async () => {
    const provider = createBingNewsProvider(okFeed);
    const { region, plan } = planFor({ region: 'Japan', topics: ['economy', 'politics'], noCache: true }, [provider]);
    const queries = plan.pass1.filter((query) => query.providerId === 'bing_news');
    const error = busy();
    const counter = admitAfter(1, error);
    await expect(provider.run({ request: plan.request, region, queries }, signal())).rejects.toBe(error);
    expect(counter.calls).toBeGreaterThan(1);
  });

  test('fediverse: 1 つの取得が断られたら、gaps に書いて続けず、提供元ごと断る', async () => {
    const provider = createFediverseProvider(async () => Response.json([]));
    const { region, plan } = planFor({ region: 'Japan', query: 'スタバ 新作', includeSocial: true, noCache: true }, [provider]);
    const queries = plan.pass1.filter((query) => query.providerId === 'fediverse');
    const error = busy();
    const counter = admitAfter(1, error);
    await expect(provider.run({ request: plan.request, region, queries }, signal())).rejects.toBe(error);
    expect(counter.calls).toBe(2);
  });

  test('fediverse: Misskey への POST も入口を通る。断られたら提供元に出さず、提供元ごと断る', async () => {
    const error = busy();
    let posts = 0;
    const provider = createFediverseProvider((async () => { posts++; return Response.json([]); }) as never, [{ kind: 'misskey', host: 'https://misskey.example' }]);
    const { region, plan } = planFor({ region: 'Japan', query: 'スタバ 新作', includeSocial: true, noCache: true }, [provider]);
    const queries = plan.pass1.filter((query) => query.providerId === 'fediverse');
    const counter = admitAfter(0, error);
    await expect(provider.run({ request: plan.request, region, queries }, signal())).rejects.toBe(error);
    expect(counter.calls).toBe(1);
    expect(posts).toBe(0);
  });

  test('fediverse: Misskey への POST は、終わったら（失敗しても）順番の枠を手放す', async () => {
    let fail = false;
    const provider = createFediverseProvider((async () => (fail ? new Response('x', { status: 500 }) : Response.json([]))) as never, [{ kind: 'misskey', host: 'https://misskey.example' }]);
    const { region, plan } = planFor({ region: 'Japan', query: 'スタバ 新作 コーヒー', includeSocial: true, noCache: true }, [provider]);
    const queries = plan.pass1.filter((query) => query.providerId === 'fediverse');
    for (let i = 0; i < 3; i++) await provider.run({ request: plan.request, region, queries }, signal());
    expect(providerHttpGate.queue.activeCount).toBe(0);
    fail = true;
    await provider.run({ request: plan.request, region, queries }, signal());
    expect(providerHttpGate.queue.activeCount).toBe(0);
  });

  test('gdacs: API の取得が断られたら、RSS に切り替えない（RSS の部分的な結果を共有キャッシュに入れない）', async () => {
    const provider = createGdacsProvider(okFeed);
    const { region, plan } = planFor({ region: 'Japan', noCache: true }, [provider]);
    const queries = plan.pass1.filter((query) => query.providerId === 'gdacs');
    const error = busy();
    const counter = admitAfter(0, error);
    await expect(provider.run({ request: plan.request, region, queries }, signal())).rejects.toBe(error);
    expect(counter.calls).toBe(1);
  });

  test('gdacs: API が通常の失敗（HTTP 500）で、RSS の取得が断られたときも、包まずそのまま投げる', async () => {
    const error = busy();
    const urls: string[] = [];
    const provider = createGdacsProvider((async (url: string) => { urls.push(url); return new Response('x', { status: 500 }); }) as never);
    const { region, plan } = planFor({ region: 'Japan', noCache: true }, [provider]);
    const queries = plan.pass1.filter((query) => query.providerId === 'gdacs');
    const counter = admitAfter(1, error);
    await expect(provider.run({ request: plan.request, region, queries }, signal())).rejects.toBe(error);
    expect(counter.calls).toBe(2);
    expect(urls).toHaveLength(1);
  });

  test('gdelt_export: ファイル一覧は取れ、zip の取得が断られたら、包まずそのまま投げる（古いファイルへ戻らない）', async () => {
    const error = busy();
    const urls: string[] = [];
    const list = '1 a http://data.gdeltproject.org/gdeltv2/20260921181500.export.CSV.zip\n';
    const provider = createGdeltExportProvider({ fetchFn: (async (url: string) => { urls.push(url); return new Response(list, { status: 200, headers: { 'content-type': 'text/plain' } }); }) as never });
    const { region, plan } = planFor({ region: 'Japan', noCache: true }, [provider]);
    const queries = plan.pass1.filter((query) => query.providerId === 'gdelt_export');
    const counter = admitAfter(1, error);
    await expect(provider.run({ request: plan.request, region, queries }, signal())).rejects.toBe(error);
    expect(counter.calls).toBe(2);
    expect(urls).toHaveLength(1);
  });

  test('baidu_hot: 最初の段の取得が断られたら、次の段（HTML・ミラー）へ進まない', async () => {
    const providers = createDefaultCountryIntelDependencies({}, { disabledProviders: [] }).providers!.filter((provider) => provider.id === 'baidu_hot');
    const { region, plan } = planFor({ region: 'China', noCache: true }, providers);
    const queries = plan.pass1.filter((query) => query.providerId === 'baidu_hot');
    const error = busy();
    const counter = admitAfter(0, error);
    noFetch();
    await expect(providers[0].run({ request: plan.request, region, queries }, signal())).rejects.toBe(error);
    expect(counter.calls).toBe(1);
  });
});

describe('Yahoo の断りも、国の情報の提供元の失敗に包まない（official_web）', () => {
  test('Web 検索（Yahoo）の順番・予算の断りは、そのまま投げる。PROVIDER_BUSY で、再試行しない（検索は 1 回）', async () => {
    const error = new ResourceBusyError('Yahoo への問い合わせの、この利用者の予算を使い切りました', 'tenant_budget', 9, 'yahoo');
    let searches = 0;
    const provider = createOfficialWebProvider({ searchWeb: async () => { searches++; throw error; }, verifiedDomains: [] });
    const { plan } = planFor({ region: 'Japan', noCache: true }, [provider]);
    const result = await runProviderPass(plan, 1, [provider], { cache: null });
    expect(result.runs[0]).toMatchObject({ status: 'rate_limited', errorCode: 'PROVIDER_BUSY' });
    expect(searches).toBe(1);
  });
});

describe('提供元の追加で断りを握らないための検査', () => {
  test('fetchProviderResponse を使う提供元のファイルは、全部 rethrowIfBusy を使っている', () => {
    const dir = join(import.meta.dir, 'providers');
    const users = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => readFileSync(join(dir, name), 'utf8').includes('fetchProviderResponse('));
    expect(users.length).toBe(15);
    // 取得の場所（fetchProviderResponse( の出現）の数だけ、rethrowIfBusy( がある（import の行だけで通らない。2 つ目の catch への付け忘れも落とす）
    const count = (text: string, needle: string) => text.split(needle).length - 1;
    for (const name of users) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(count(text, 'rethrowIfBusy('), name).toBeGreaterThanOrEqual(count(text, 'fetchProviderResponse('));
    }
  });
});

describe('報告全体: 断られた提供元だけが欠ける。ほかの利用者は影響されない', () => {
  function stubFetch(requested: string[]) {
    globalThis.fetch = (async (input: unknown) => {
      requested.push(new URL(String(input)).hostname);
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  }

  test('予算を使い切った利用者の報告は、200 のまま。取得を出す提供元は PROVIDER_BUSY、ほかの利用者の報告は取得に出る', async () => {
    process.env.SORA_ISOLATION = 'strict';
    for (let i = 0; i < 120; i++) providerHttpGate.budget.spend('name:A');
    const requested: string[] = [];
    stubFetch(requested);
    const a = await runAsCaller('name:A', () => researchCountryWithDefaults({ region: 'Japan', noCache: true }, { cache: null }));
    const busyRuns = a.providerCoverage.filter((run) => run.errorCode === 'PROVIDER_BUSY');
    expect(busyRuns.map((run) => run.provider)).toEqual(expect.arrayContaining(['usgs', 'eonet', 'gdacs', 'google_news', 'bing_news', 'global_feeds']));
    for (const run of busyRuns) expect(run.status).toBe('rate_limited');
    expect(requested).not.toContain('earthquake.usgs.gov');
    expect(a.limitations?.some((limitation) => limitation.code === 'rate_limited' && limitation.providerId === 'usgs')).toBe(true);
    expect(getSecurityMetrics()['sora_country_intel_busy_tenant_budget_total']).toBeGreaterThan(0);

    const b = await runAsCaller('name:B', () => researchCountryWithDefaults({ region: 'Japan', noCache: true }, { cache: null }));
    expect(requested).toContain('earthquake.usgs.gov');
    expect(b.providerCoverage.some((run) => run.errorCode === 'PROVIDER_BUSY')).toBe(false);
  });

  test('strict: 1 回の報告（SNS あり）は、自分の報告だけで断られない。同じ利用者が 2 つ同時に出すと、待ちの上限（30 件）を超えて、一部の提供元が断られる', async () => {
    process.env.SORA_ISOLATION = 'strict';
    globalThis.fetch = (async () => { await Bun.sleep(30); return new Response('not found', { status: 404 }); }) as unknown as typeof fetch;
    const report = (tenant: string) => runAsCaller(tenant, () => researchCountryWithDefaults({ region: 'Japan', includeSocial: true, noCache: true }, { cache: null }, { disabledProviders: ['social_posts', 'yahoo_realtime'] }));
    const busyRuns = (r: Awaited<ReturnType<typeof report>>) => r.providerCoverage.filter((run) => run.errorCode === 'PROVIDER_BUSY');
    expect(busyRuns(await report('name:B'))).toEqual([]);
    const [x, y] = await Promise.all([report('name:C'), report('name:C')]);
    expect(busyRuns(x).length + busyRuns(y).length).toBeGreaterThan(0);
    // 別の利用者の報告は、同じときでも、自分の分だけで通る
    const [c1, c2, d] = await Promise.all([report('name:E'), report('name:E'), report('name:D')]);
    expect(busyRuns(d)).toEqual([]);
    void c1; void c2;
  });
});
