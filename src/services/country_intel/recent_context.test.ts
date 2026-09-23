import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { saveHotObservations } from './db.js';
import { researchCountryContext } from './report.js';
import { createWallstreetLiveProvider } from './providers/wallstreet_live.js';
import { createWeiboHotProvider } from './providers/weibo_hot.js';
import { createZhihuHotProvider } from './providers/zhihu_hot.js';
import type { CountryIntelProvider } from './provider_registry.js';
import type { RegionIdentity } from './types.js';
let directory: string;
let previousPath: string | undefined;
const NOW = new Date('2026-09-23T12:00:00Z');
const china: RegionIdentity = { id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [], confidence: 'high' };
const inputFor = (id: string) => ({ request: { region: 'China' } as never, region: china, queries: [{ pass: 1 as const, providerId: id, query: 'China', topics: [], maxItems: 10 }] });
beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-recent-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});
const weiboShape = JSON.stringify({ ok: 1, data: { hotgovs: [], realtime: [{ word: 'topic-a', num: 100, realpos: 2 }, { word: 'topic-b', num: 50, realpos: 1 }] } });
const wallstreetShape = (displayTime: number) => JSON.stringify({ data: { items: [{ id: 7, title: 'flash-headline', content_text: 'body text here', display_time: displayTime, uri: 'https://wallstreetcn.com/livenews/7' }] } });
const stubFetch = (routes: Record<string, string>): never => ((async (url: string) => {
  const body = routes[url];
  if (body === undefined) throw new Error('unexpected fetch ' + url);
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}) as unknown as never);
const WEIBO_URL = 'https://weibo.com/ajax/side/hotSearch';
const WALLSTREET_URL = 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30';
describe('recent context', () => {
  test('summarizes hot topics and fresh articles without recommendations', async () => {
    const fetchFn = stubFetch({ [WEIBO_URL]: weiboShape, [WALLSTREET_URL]: wallstreetShape(Date.parse('2026-09-23T11:55:00Z') / 1000) });
    const providers: CountryIntelProvider[] = [createWeiboHotProvider(fetchFn), createWallstreetLiveProvider(fetchFn)];
    const report = await researchCountryContext({ region: 'China', noCache: true }, { providers, cache: null, now: () => NOW, scrapeArticle: undefined });
    const recent = report.recentContext;
    expect(recent).toBeDefined();
    expect(recent?.topics.map((topic) => topic.topicId)).toEqual(['topic-b', 'topic-a']);
    expect(recent?.topics[0]).toMatchObject({ rank: 1 });
    expect('previousRank' in (recent?.topics[0] ?? {})).toBe(false);
    expect(recent?.topics[0].evidenceIds.length).toBeGreaterThan(0);
    expect(recent?.reports).toHaveLength(1);
    expect(recent?.reports[0]).toMatchObject({ title: 'flash-headline', ageClass: 'flash' });
    expect(recent?.sources.map((source) => source.provider).sort()).toEqual(['wallstreet_live', 'weibo_hot']);
    expect(recent?.sources.every((source) => source.stale === false)).toBe(true);
    expect(JSON.stringify(recent)).not.toMatch(/should|recommend|投稿/);
  });
  test('attaches previous ranks from scheduled history', async () => {
    saveHotObservations([{ sourceId: 'weibo_hot', topicId: 'topic-a', regionId: 'country:CN', observedAt: Date.parse('2026-09-23T11:00:00Z'), rank: 5, title: 'topic-a', url: 'https://s.weibo.com/x' }]);
    const fetchFn = stubFetch({ [WEIBO_URL]: weiboShape, [WALLSTREET_URL]: wallstreetShape(Date.parse('2026-09-23T11:55:00Z') / 1000) });
    const providers: CountryIntelProvider[] = [createWeiboHotProvider(fetchFn), createWallstreetLiveProvider(fetchFn)];
    const report = await researchCountryContext({ region: 'China', noCache: true }, { providers, cache: null, now: () => NOW, scrapeArticle: undefined });
    const topic = report.recentContext?.topics.find((entry) => entry.topicId === 'topic-a');
    expect(topic).toMatchObject({ rank: 2, previousRank: 5, rankChange: 'up' });
  });
  test('marks stale sources and passes through their limitations', async () => {
    const fetchFn = stubFetch({ [WEIBO_URL]: weiboShape, [WALLSTREET_URL]: wallstreetShape(Date.parse('2026-09-23T11:55:00Z') / 1000) });
    const failing = createZhihuHotProvider(async () => { throw new Error('zhihu down'); });
    const providers: CountryIntelProvider[] = [createWeiboHotProvider(fetchFn), createWallstreetLiveProvider(fetchFn), failing];
    const report = await researchCountryContext({ region: 'China', noCache: true }, { providers, cache: null, now: () => NOW, scrapeArticle: undefined });
    const source = report.recentContext?.sources.find((entry) => entry.provider === 'zhihu_hot');
    expect(source?.stale).toBe(true);
    expect(report.recentContext?.limitations.some((limitation) => limitation.providerId === 'zhihu_hot')).toBe(true);
  });
});
