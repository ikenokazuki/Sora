import { describe, expect, test } from 'bun:test';
import {
  checkTrackingNegative,
  checkTrackingNoCreds,
  checkProviderItems, checkTrackingResult, classifyProviderError, mustContain, mustHaveItems, secretOrUnverified,
} from './catalog.js';
import {
  collectKnownCaseIds, gateExit, isGatePass, nonPassLines, redact, registerSecrets, summarize, toJUnit, toMarkdown, validateCasesJson,
} from './report.js';
import { ProviderHttpError, ProviderNetworkError } from '../../src/services/country_intel/provider_registry.js';
import { LiveBlocked, LiveFail, LiveUnavailable, LiveUnverified } from './types.js';
import { parseArgs } from './run.js';

describe('runner arg contract', () => {
  test('parseArgs reads flags', () => {
    expect(parseArgs(['--live', '--image', 'img', '--out', 'dir'])).toMatchObject({ live: true, image: 'img', out: 'dir' });
    // --enable-hotel は廃止したホテルレーンの名残で無視される
    expect(parseArgs(['--live', '--image', 'img', '--out', 'dir', '--enable-hotel'])).toMatchObject({ live: true, image: 'img', out: 'dir' });
    expect(parseArgs([]).live).toBe(false);
  });
});

describe('classification', () => {
  test('broken HTML login page is blocked, missing anchors fail', () => {
    expect(() => mustContain({ a: 1 }, ['zzz'], 's')).toThrow(LiveFail);
    expect(() => mustContain({ body: 'Please log in to continue' }, ['zzz'], 's')).toThrow(LiveBlocked);
  });
  test('item arrays require non-empty records with fields', () => {
    expect(() => mustHaveItems({ items: [] }, 's')).toThrow(LiveFail);
    expect(() => mustHaveItems({ nope: 1 }, 's')).toThrow(LiveFail);
    expect(() => mustHaveItems({ items: [{}] }, 's', 'url')).toThrow(LiveFail);
    // 一部の要素だけ項目が欠けても拾う（全体の8割未満なら fail）
    expect(() => mustHaveItems({ items: [{ url: 'a', title: 't' }, { url: 'b', title: '' }, { url: 'c' }] }, 's', ['url', 'title'])).toThrow(LiveFail);
    expect(mustHaveItems({ items: [1, 2, 3, 4, 5].map((i) => ({ url: `u${i}`, title: i === 5 ? '' : 't' })) }, 's', ['url', 'title']).items).toHaveLength(5);
    expect(() => mustHaveItems({ suggestions: ['東京', '', ''] }, 's')).toThrow(LiveFail);
    expect(mustHaveItems({ suggestions: ['東京駅', '東京都'] }, 's').items).toHaveLength(2);
    const { items } = mustHaveItems({ items: [{ url: 'https://e/1' }] }, 's', 'url');
    expect(items).toHaveLength(1);
  });
  test('tracking maps states to fail/unverified correctly', () => {
    const ok = checkTrackingResult({ trackingNumber: 'N1', status: 'in_transit', events: [{ s: 'a' }] }, 'N1', 'yamato');
    expect(ok.sources[0].source).toBe('yamato');
    expect(() => checkTrackingResult({ trackingNumber: 'N1', status: 'not_found', events: [] }, 'N1', 'yamato')).toThrow(LiveUnverified);
    expect(() => checkTrackingResult({ trackingNumber: 'N1', status: 'unknown', events: [] }, 'N1', 'ups')).toThrow(LiveUnverified);
    expect(() => checkTrackingResult({ other: 1 }, 'N1', 'yamato')).toThrow(LiveFail);
    const neg = checkTrackingNegative({ trackingNumber: 'B1', status: 'not_found' }, 'B1', 'ups', true);
    expect(neg.detail).toContain('bogus');
    // 存在しない番号を判定できないのはページ変更の疑い（fail）。理由に応答の要約を入れる
    expect(() => checkTrackingNegative({ trackingNumber: 'B1', status: 'unknown', statusText: 'page layout changed' }, 'B1', 'ups', true)).toThrow(LiveFail);
    expect(() => checkTrackingNegative({ trackingNumber: 'B1', status: 'unknown', statusText: 'page layout changed' }, 'B1', 'ups', true)).toThrow(/unknown \| page layout changed/);
    expect(() => checkTrackingNegative({ trackingNumber: 'B1', status: 'unknown', statusText: 'blocked by carrier bot check' }, 'B1', 'ups', true)).toThrow(LiveBlocked);
    const any = checkTrackingNegative({ trackingNumber: 'B1', status: 'delivered' }, 'B1', 'dhl', false);
    expect(any.detail).toContain('delivered');
    const soft = checkTrackingNoCreds({ trackingNumber: 'N1', status: 'unknown', trackingUrl: 'https://www.ups.com/track?x=N1' }, 'N1', 'ups');
    expect(soft.sources[0].source).toBe('ups');
    expect(() => checkTrackingNoCreds({ trackingNumber: 'N1', status: 'in_transit', events: [{}] }, 'N1', 'ups')).toThrow(LiveFail);
  });
  test('provider HTTP statuses classify without guessing 200', () => {
    expect(() => classifyProviderError(new ProviderHttpError(429), 's')).toThrow(LiveUnavailable);
    expect(() => classifyProviderError(new ProviderHttpError(503), 's')).toThrow(LiveUnavailable);
    expect(() => classifyProviderError(new ProviderHttpError(403), 's')).toThrow(LiveBlocked);
    expect(() => classifyProviderError(new ProviderHttpError(400), 's')).toThrow(LiveFail);
    expect(() => classifyProviderError(new ProviderNetworkError('x'), 's')).toThrow(LiveUnavailable);
    expect(() => classifyProviderError(new TypeError('fetch failed'), 's')).toThrow(LiveUnavailable);
  });
  test('missing test data is unverified, never pass', () => {
    const secrets = { getCase: () => undefined, hasCase: () => false };
    expect(() => secretOrUnverified({ secrets } as never, 'tracking.yamato.positive', ['trackingNumber'])).toThrow(LiveUnverified);
  });
});

describe('cases config', () => {
  const known = collectKnownCaseIds(['track.yamato', 'social.fetch', 'fetch.xpost']);
  test('accepts versioned known ids and rejects unknown ids/keys', () => {
    const good = validateCasesJson(JSON.stringify({ version: 1, cases: { 'tracking.yamato.positive': { trackingNumber: 'N1' } } }), known);
    expect(good.cases['tracking.yamato.positive'].trackingNumber).toBe('N1');
    expect(() => validateCasesJson(JSON.stringify({ version: 1, cases: { nope: {} } }), known)).toThrow(/unknown case id/);
    expect(() => validateCasesJson(JSON.stringify({ version: 1, cases: { 'tracking.yamato.positive': { evil: 'x' } } }), known)).toThrow(/unknown key/);
    expect(() => validateCasesJson('not json', known)).toThrow();
    expect(() => validateCasesJson(JSON.stringify({ version: 2, cases: {} }), known)).toThrow();
  });
  test('redaction hides registered secret values', () => {
    registerSecrets(['SECRET-ABC-123']);
    expect(redact('number SECRET-ABC-123 here')).not.toContain('SECRET-ABC-123');
    expect(redact('nothing here')).toBe('nothing here');
  });
});

describe('report writers', () => {
  const results = [
    { caseId: 'a', toolNames: ['scrape'], dependencyIds: [], status: 'pass', reason: 'ok', startedAt: 't', durationMs: 1, attempts: 1, recovered: false, observedSources: [] },
    { caseId: 'b', toolNames: [], dependencyIds: ['gdacs'], status: 'unverified', reason: 'zero items', startedAt: 't', durationMs: 1, attempts: 1, recovered: false, observedSources: [] },
  ] as never;
  test('non-pass lines list only failing cases, with secrets redacted', () => {
    registerSecrets(['TOPSECRET-999']);
    const lines = nonPassLines([
      ...(results as unknown as never[]),
      { caseId: 'c', toolNames: [], dependencyIds: [], status: 'unavailable', reason: 'HTTP 503 key=TOPSECRET-999\nretry', startedAt: 't', durationMs: 1, attempts: 2, recovered: false, observedSources: [] },
    ] as never);
    expect(lines).toEqual(['  b unverified: zero items', '  c unavailable: HTTP 503 key=[redacted] retry']);
  });
  test('counts and gate', () => {
    const counts = summarize(results);
    expect(counts.pass).toBe(1);
    expect(counts.unverified).toBe(1);
    expect(isGatePass(counts, [])).toBe(false);
    expect(isGatePass(summarize([results[0]]), [])).toBe(true);
    expect(isGatePass(summarize([results[0]]), ['missing-tool'])).toBe(false);
    expect(gateExit({ pass: 1, pass_empty: 0, fail: 0, unavailable: 0, blocked: 0, unverified: 0, not_applicable: 0 } as never, [])).toBe(0);
    expect(gateExit({ pass: 1, pass_empty: 0, fail: 0, unavailable: 0, blocked: 1, unverified: 2, not_applicable: 0 } as never, [])).toBe(3);
    expect(gateExit({ pass: 1, pass_empty: 0, fail: 1, unavailable: 0, blocked: 0, unverified: 0, not_applicable: 0 } as never, [])).toBe(1);
    // 外部の一時的な不調だけなら公開は止めない。ただし unavailable が 25% を超えたらこちら側の故障とみなす
    expect(gateExit({ pass: 9, pass_empty: 0, fail: 0, unavailable: 1, blocked: 0, unverified: 0, not_applicable: 0 } as never, [])).toBe(3);
    expect(gateExit({ pass: 2, pass_empty: 0, fail: 0, unavailable: 1, blocked: 0, unverified: 0, not_applicable: 0 } as never, [])).toBe(1);
    expect(gateExit({ pass: 1, pass_empty: 0, fail: 0, unavailable: 0, blocked: 0, unverified: 0, not_applicable: 0 } as never, ['missing-tool'])).toBe(1);
  });
  test('junit and markdown render', () => {
    const report = { meta: { startedAt: 't', commit: 'c', image: 'i', imageId: 'id', lane: 'standard', runner: 'r', overall: 'fail' }, results, counts: summarize(results), missing: [] } as never;
    const junit = toJUnit(report);
    expect(junit).toContain('testcase');
    expect(junit).toContain('failure');
    const md = toMarkdown(report);
    expect(md).toContain('| b |');
  });
});

describe('always-populated providers', () => {
  const item = { evidence: { url: 'https://example.com/a' } } as never;
  test('zero items fail for an always-populated source, stay unverified otherwise', () => {
    expect(() => checkProviderItems([], 'weibo_hot', undefined, { alwaysPopulated: true })).toThrow(LiveFail);
    expect(() => checkProviderItems([], 'gdacs')).toThrow(LiveUnverified);
    expect(checkProviderItems([item], 'weibo_hot', undefined, { alwaysPopulated: true }).sources[0].count).toBe(1);
  });
});
