import { describe, expect, test } from 'bun:test';
import { resolveChromiumPath } from '../../../browser_engine.js';
import {
  extractDatedEvents, findStatusHeadline, looksLikeChallenge, scopedBodyText, statusFromText,
} from './browser_track.js';
import { parseUpsTrackPage } from './ups.js';
import { parseFedexTrackPage } from './fedex.js';
import { parseDhlTrackPage } from './dhl.js';

const UPS_INVALID_HTML = `<!DOCTYPE html><html><head><title>Tracking | UPS</title></head><body>
<header><nav>UPS tracking nav</nav></header>
<main><div role="alert">warning トラッキングナンバーが無効です このトラッキングナンバーは無効であるか、まだ有効になっていない可能性があります。</div></main>
<footer>Copyright UPS</footer></body></html>`;

const UPS_DELIVERED_HTML = `<!DOCTYPE html><html><head><title>Tracking | UPS</title></head><body>
<main><h1>Delivered</h1><p>Your package was delivered on January 5, 2026 at 10:30 AM.</p>
<table><tr><td>January 5, 2026, 10:30 AM</td><td>Delivered</td><td>Tokyo, JP</td></tr>
<tr><td>January 4, 2026, 8:00 PM</td><td>Departed Facility</td><td>Osaka, JP</td></tr></table></main></body></html>`;

const FEDEX_POSITIVE_HTML = `<!DOCTYPE html><html><head><title>Detailed Tracking</title></head><body>
<main><h1>Delivered</h1><p>January 5, 2026 at 10:30 AM - Delivered, Front door</p>
<p>January 4, 2026 at 8:00 PM - On FedEx vehicle for delivery</p></main></body></html>`;

const DHL_DELIVERED_HTML = `<!DOCTYPE html><html><head><title>Tracking - DHL</title></head><body>
<main><div class="c-tracking-result"><p>1234567890</p><p>DELIVERED</p><p>Origin: SALT LAKE CITY - United States of America</p><p>January 5, 2026 Shipment delivered</p></div></main></body></html>`;

const DHL_EMPTY_FORM_HTML = `<!DOCTYPE html><html><head><title>Tracking - DHL</title></head><body>
<main><h1>Track &amp; Trace</h1><p>Enter your tracking number(s)</p><p>Frequently Asked Questions</p></main></body></html>`;

describe('intl tracking page parsing (fixtures)', () => {
  test('ups invalid number is not_found', () => {
    expect(parseUpsTrackPage(UPS_INVALID_HTML, 'Tracking | UPS')).toEqual({ notFound: true });
  });
  test('ups delivered page keeps status and dated events', () => {
    const r = parseUpsTrackPage(UPS_DELIVERED_HTML, 'Tracking | UPS');
    expect(r).toMatchObject({ status: 'delivered' });
    if (r && !('notFound' in r) && !('challenge' in r)) {
      expect(r.events.length).toBeGreaterThan(0);
    }
  });
  test('fedex no-results url is not_found', () => {
    const r = parseFedexTrackPage('<html><body>Your tracking number can\'t be found.</body></html>', 'https://www.fedex.com/fedextrack/no-results-found?trknbr=1', 'x');
    expect(r).toEqual({ notFound: true });
  });
  test('fedex delivered page keeps status', () => {
    const r = parseFedexTrackPage(FEDEX_POSITIVE_HTML, 'https://www.fedex.com/fedextrack/', 'Detailed Tracking');
    expect(r).toMatchObject({ status: 'delivered' });
  });
  test('dhl delivered card is delivered', () => {
    const r = parseDhlTrackPage(DHL_DELIVERED_HTML, 'Tracking - DHL');
    expect(r).toMatchObject({ status: 'delivered' });
  });
  test('dhl empty form is unknown, never not_found', () => {
    expect(parseDhlTrackPage(DHL_EMPTY_FORM_HTML, 'Tracking - DHL')).toBeUndefined();
  });
  test('challenge pages are detected, not parsed', () => {
    const html = '<html><head><title>Access Denied</title></head><body>Access Denied reference id 123</body></html>';
    expect(looksLikeChallenge('Access Denied', 'Access Denied')).toBe(true);
    expect(parseUpsTrackPage(html, 'Access Denied')).toEqual({ challenge: true });
  });
  test('scoped text drops header/footer noise', () => {
    const scoped = scopedBodyText(UPS_INVALID_HTML);
    expect(scoped).not.toContain('Copyright');
    expect(scoped).toContain('トラッキングナンバーが無効');
  });
  test('status mapping covers EN/JA', () => {
    expect(statusFromText('Out for delivery')).toBe('in_transit');
    expect(statusFromText('配達完了しました')).toBe('delivered');
    expect(statusFromText('Shipment information received')).toBe('registered');
    expect(statusFromText('nothing here')).toBe('unknown');
  });
  test('dated extractor skips undated lines', () => {
    expect(extractDatedEvents('no dates\nJanuary 5, 2026 ok')).toHaveLength(1);
  });
  test('headline picks the status line', () => {
    expect(findStatusHeadline('foo\nDelivered today\nbar')).toContain('Delivered');
  });
});

describe('intl tracking live (bogus numbers, keyless)', () => {
  test('ups bogus number is not_found via browser', async () => {
    if (!resolveChromiumPath()) {
      console.log('Skipping intl tracking live test (Chromium not found on host)');
      return;
    }
    const { upsAdapter } = await import('./ups.js');
    const u = await upsAdapter.track('1Z9999999999999999');
    expect(u.trackingNumber).toBe('1Z9999999999999999');
    expect(['not_found', 'unknown']).toContain(u.status);
  }, 110000);
  test('fedex bogus number is not_found via browser', async () => {
    if (!resolveChromiumPath()) {
      console.log('Skipping intl tracking live test (Chromium not found on host)');
      return;
    }
    const { fedexAdapter } = await import('./fedex.js');
    const f = await fedexAdapter.track('999999999999');
    expect(f.trackingNumber).toBe('999999999999');
    expect(['not_found', 'unknown']).toContain(f.status);
  }, 110000);
  test('dhl bogus number returns a parsed result via browser', async () => {
    if (!resolveChromiumPath()) {
      console.log('Skipping intl tracking live test (Chromium not found on host)');
      return;
    }
    const { dhlAdapter } = await import('./dhl.js');
    const d = await dhlAdapter.track('1234567890');
    expect(d.trackingNumber).toBe('1234567890');
    expect(['delivered', 'in_transit', 'registered', 'returned', 'not_found', 'unknown']).toContain(d.status);
  }, 110000);
});
