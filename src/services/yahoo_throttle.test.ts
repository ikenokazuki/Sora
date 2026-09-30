import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  isYahooRateLimitText,
  yahooResultHasData,
  isYahooRateLimitedError,
  isYahooBreakerOpen,
  tripYahooBreaker,
  resetYahooBreaker,
  resetYahooCallGate,
  resetYahooWebPressure,
  yahooWebPressure,
  YahooProviderError,
  parseRetryAfterMs,
  searchYahooWeb,
  searchYahooRealtime,
} from './yahoo.js';
const SAVED_ENV: Record<string, string | undefined> = {
  YAHOO_MCP_PATH: process.env.YAHOO_MCP_PATH,
  SORA_YAHOO_THROTTLE: process.env.SORA_YAHOO_THROTTLE,
  SORA_YAHOO_MIN_INTERVAL_MS: process.env.SORA_YAHOO_MIN_INTERVAL_MS,
  SORA_YAHOO_BREAKER_COOLDOWN_MS: process.env.SORA_YAHOO_BREAKER_COOLDOWN_MS,
};
afterEach(() => {
  for (const k of Object.keys(SAVED_ENV)) {
    const v = SAVED_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetYahooBreaker();
  resetYahooCallGate();
});
beforeEach(() => {
  resetYahooBreaker();
  resetYahooCallGate();
  resetYahooWebPressure();
  delete process.env.SORA_YAHOO_THROTTLE;
  delete process.env.SORA_YAHOO_BREAKER_COOLDOWN_MS;
  process.env.SORA_YAHOO_MIN_INTERVAL_MS = '0';
});
describe('yahoo throttle discipline (hermetic)', () => {
  test('detects rate-limit text', () => {
    expect(isYahooRateLimitText('HTTP 429 Too Many Requests')).toBe(true);
    expect(isYahooRateLimitText('rate limit exceeded')).toBe(true);
    expect(isYahooRateLimitText('request throttled by upstream')).toBe(true);
    expect(isYahooRateLimitText('[]')).toBe(false);
    expect(isYahooRateLimitText('')).toBe(false);
    expect(isYahooRateLimitText('HTTP 429 Too Many Requests')).toBe(true);
    expect(isYahooRateLimitText('error 429')).toBe(true);
    expect(isYahooRateLimitText('価格は1,429円です')).toBe(false);
    expect(isYahooRateLimitText('住所は東京都港区1-4-29です')).toBe(false);
    expect(isYahooRateLimitText('cursorWf66Dt429gJBJhVN3r')).toBe(false);
    expect(isYahooRateLimitText('status code 429')).toBe(true);
  });
  test('data payloads win over incidental matches', () => {
    expect(yahooResultHasData(JSON.stringify({ items: [{ title: 'a' }] }))).toBe(true);
    expect(yahooResultHasData(JSON.stringify([{ id: '1' }]))).toBe(true);
    expect(yahooResultHasData(JSON.stringify({ items: [] }))).toBe(false);
    expect(yahooResultHasData('not json')).toBe(false);
  });
  test('recognizes rate-limited errors', () => {
    const e: any = new Error('limited');
    e.code = 'YAHOO_RATE_LIMITED';
    expect(isYahooRateLimitedError(e)).toBe(true);
    expect(isYahooRateLimitedError(new Error('other'))).toBe(false);
    expect(isYahooRateLimitedError(null)).toBe(false);
  });
  test('breaker opens on trip and closes after cooldown', () => {
    expect(isYahooBreakerOpen()).toBe(false);
    tripYahooBreaker();
    expect(isYahooBreakerOpen()).toBe(true);
    process.env.SORA_YAHOO_BREAKER_COOLDOWN_MS = '0';
    expect(isYahooBreakerOpen()).toBe(false);
  });
  test('open breaker fails fast with throttled marker and no spawn', async () => {
    process.env.YAHOO_MCP_PATH = '/nonexistent/yahoo-search-mcp-for-throttle-test';
    tripYahooBreaker();
    const res = await searchYahooWeb({ query: 'throttle probe', disableFallback: true });
    expect(res.items).toEqual([]);
    expect(res.throttled).toBe(true);
  });
  test('realtime waves abort with throttled stop on injected 429', async () => {
    const rateErr: any = new Error('Yahoo provider rate limited');
    rateErr.code = 'YAHOO_RATE_LIMITED';
    const res = await searchYahooRealtime({
      query: 'throttle probe realtime',
      detailEnrichment: false,
      _callMcp: async () => { throw rateErr; },
    } as any);
    expect(res.stopReason).toBe('throttled');
    expect((res as any).throttled).toBe(true);
  });
  test('parseRetryAfterMs reads seconds and HTTP dates', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('garbage')).toBeUndefined();
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future)!;
    expect(ms).toBeGreaterThan(4000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  test('structured direct 429 carries Retry-After into the controller cooldown', async () => {
    const rateErr: any = new Error('Yahoo provider rate limited');
    rateErr.code = 'YAHOO_RATE_LIMITED';
    const res = await searchYahooWeb(
      { query: 'throttle probe structured', disableFallback: true },
      {
        callYahooMcp: async () => { throw rateErr; },
        fetchYahooWebDirect: async () => { throw new YahooProviderError('Yahoo direct fetch failed: 429', 429, 60000); },
      } as any,
    );
    expect(res.items).toEqual([]);
    expect(res.throttled).toBe(true);
    expect(yahooWebPressure.canRequest()).toBe(false);
  });
  test('partial wave failure keeps sibling results and stops further waves', async () => {
    const rateErr: any = new Error('Yahoo provider rate limited');
    rateErr.code = 'YAHOO_RATE_LIMITED';
    let calls = 0;
    const item = { id: '7', author_handle: 'kimisora_JPN', author_name: 'test', text: 'SPARK 出演のお知らせ', url: 'https://x.com/kimisora_JPN/status/7', created_at: 1758000000 };
    const res = await searchYahooRealtime({
      query: 'SPARK 出演 辞退 id:kimisora_JPN',
      detailEnrichment: false,
      _callMcp: async () => {
        calls += 1;
        if (calls === 1) throw rateErr;
        return { content: [{ text: JSON.stringify({ items: [item] }) }] };
      },
    } as any);
    expect(res.stopReason).toBe('throttled');
    expect((res as any).throttled).toBe(true);
    expect(res.items.length).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(2);
  });
});
