import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { app } from '../../index.js';
import { getCarrierAdapter } from './registry.js';
import { isValidTrackingPage, renderTrackingPage, trackingPageUrl } from './page.js';
import type { TrackingResult } from './types.js';

const KEYS = ['SORA_TRACKING_PAGE_SECRET', 'SORA_PUBLIC_URL', 'WEB_FETCHER_API_KEY', 'API_KEY'] as const;
const enable = () => {
  process.env.SORA_TRACKING_PAGE_SECRET = 'test-secret';
  process.env.SORA_PUBLIC_URL = 'https://sora.example/';
};

const delivered = (num: string): TrackingResult => ({
  carrier: 'sagawa',
  carrierName: '佐川急便',
  trackingNumber: num,
  status: 'delivered',
  statusText: '配達完了（宅配BOX）',
  events: [
    { status: '集荷', date: '10/20 16:37', location: '渋谷営業所' },
    { status: '配達完了（宅配BOX）', date: '10/23 18:00', location: '那覇営業所' },
  ],
  trackingUrl: 'https://e-customer.sagawa-exp.co.jp/k2k',
  details: { origin: '渋谷営業所', destination: '那覇営業所', deliveryDate: '10月23日 18時00分', serviceType: '飛脚宅配便' },
  fetchedAt: '2026-10-23T09:30:00.000Z',
});

describe('tracking page', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('issues a signed URL only when both the secret and the public URL are set', () => {
    expect(trackingPageUrl('sagawa', '123456789012')).toBeUndefined();
    process.env.SORA_TRACKING_PAGE_SECRET = 'test-secret';
    expect(trackingPageUrl('sagawa', '123456789012')).toBeUndefined();

    enable();
    const url = new URL(trackingPageUrl('sagawa', '123456789012')!);
    expect(`${url.origin}${url.pathname}`).toBe('https://sora.example/t/sagawa/123456789012');
    const sig = url.searchParams.get('sig')!;
    expect(isValidTrackingPage('sagawa', '123456789012', sig)).toBe(true);
    expect(isValidTrackingPage('sagawa', '123456789013', sig)).toBe(false);
    expect(isValidTrackingPage('yamato', '123456789012', sig)).toBe(false);
    expect(isValidTrackingPage('sagawa', '123456789012', `${sig.slice(0, -1)}A`)).toBe(false);
    expect(isValidTrackingPage('sagawa', '123456789012', undefined)).toBe(false);
  });

  test('renders the result with a not-official notice and escapes carrier text', () => {
    const html = renderTrackingPage({
      ...delivered('123456789012'),
      statusText: '<script>alert(1)</script>',
      events: [{ status: '配達中', date: '10/23 08:47', location: '"><img src=x onerror=alert(1)>' }],
    });
    expect(html).toContain('このページは佐川急便の公式ページではありません。');
    expect(html).toContain('<th>お問い合せ送り状No.</th><td><strong>123456789012</strong>');
    expect(html).toContain('<tr><th>集荷営業所</th><td>渋谷営業所</td></tr><tr><th>配達営業所</th><td>那覇営業所</td></tr>');
    expect(html).toContain('配達完了日：10月23日 18時00分');
    expect(html).toContain('<th>荷物状況</th><th>日時</th><th>担当営業所</th>');
    expect(html).toContain('href="https://e-customer.sagawa-exp.co.jp/k2k"');
    expect(html).toContain('（送り状番号: 123456789012）');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('says why there is nothing to show, and links only to http(s) pages', () => {
    const notFound = renderTrackingPage({ ...delivered('123456789012'), status: 'not_found', statusText: '該当なし', events: [], details: undefined });
    expect(notFound).toContain('該当するお荷物が見つかりません。');
    expect(notFound).not.toContain('荷物状況');
    const failed = renderTrackingPage({ ...delivered('123456789012'), status: 'error', trackingUrl: 'javascript:alert(1)' });
    expect(failed).toContain('現在、配達状況を取得できません。');
    expect(failed).not.toContain('javascript:');
  });

  test('opens from another site without an API key, and only with the signature Sora issued', async () => {
    enable();
    process.env.WEB_FETCHER_API_KEY = 'secret-key';
    const num = '987654321098';
    const track = spyOn(getCarrierAdapter('sagawa')!, 'track').mockImplementation(async () => delivered(num));
    try {
      const url = new URL(trackingPageUrl('sagawa', num)!);
      const fromOtherSite = { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } };

      const res = await app.request(`${url.pathname}${url.search}`, fromOtherSite);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      expect(await res.text()).toContain('配達完了（宅配BOX）');

      expect((await app.request(`${url.pathname}?sig=wrong`, fromOtherSite)).status).toBe(404);
      expect((await app.request(url.pathname, fromOtherSite)).status).toBe(404);
      expect((await app.request(`/t/auto/${num}${url.search}`, fromOtherSite)).status).toBe(404);

      // 照会の API は今までどおりキーが要り、結果に pageUrl が付く
      expect((await app.request(`/tracking/sagawa/${num}`)).status).toBe(401);
      const api = await app.request(`/tracking/sagawa/${num}`, { headers: { Authorization: 'Bearer secret-key' } });
      expect(((await api.json()) as TrackingResult).pageUrl).toBe(url.toString());

      // 無効にすると、発行済みの URL も開けない
      delete process.env.SORA_TRACKING_PAGE_SECRET;
      expect((await app.request(`${url.pathname}${url.search}`, fromOtherSite)).status).toBe(404);
    } finally {
      track.mockRestore();
    }
  });
});
