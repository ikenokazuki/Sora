import { describe, expect, test, beforeEach } from 'bun:test';
import {
  isYahooRateLimitText,
  yahooResultHasData,
  isYahooRateLimitedError,
  isYahooBreakerOpen,
  tripYahooBreaker,
  resetYahooBreaker,
  resetYahooCallGate,
  searchYahooWeb,
  searchYahooRealtime,
} from './yahoo.js';
beforeEach(() => {
  resetYahooBreaker();
  resetYahooCallGate();
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
