import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { trackByCarrier } from '../index.js';

describe('Sagawa tracking response handling', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
  beforeEach(() => { fetchSpy = spyOn(globalThis, 'fetch'); });
  afterEach(() => fetchSpy.mockRestore());

  test('a successful no-match response returns not_found', async () => {
    fetchSpy.mockResolvedValue(new Response(
      '<table class="table_okurijo_index"><tr><td class="state">該当なし</td></tr></table>',
    ));

    const result = await trackByCarrier('sagawa', '1234-5678-9012');
    expect(result.status).toBe('not_found');
    expect(result.trackingNumber).toBe('123456789012');
    expect(result.events).toEqual([]);
    expect(result.verification?.level).toBe('none');
    expect(result.error).toBeUndefined();
  });

  test.each([403, 429, 503])('HTTP %i stays an error, not a missing shipment', async (status) => {
    fetchSpy.mockResolvedValue(new Response('Service unavailable', { status }));

    const result = await trackByCarrier('sagawa', '123456789012');
    expect(result.status).toBe('error');
    expect(result.error).toContain(`HTTP ${status}`);
    expect(result.events).toEqual([]);
    expect(result.verification?.level).toBe('none');
    expect(result.trackingUrl).toBe('https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=123456789012');
  });

  test('transport failures retain the cause and never report not_found', async () => {
    fetchSpy.mockRejectedValue(new Error('Connection refused'));

    const result = await trackByCarrier('sagawa', '123456789012');
    expect(result.status).toBe('error');
    expect(result.error).toBe('Connection refused');
    expect(result.events).toEqual([]);
    expect(result.verification?.level).toBe('none');
  });
});
