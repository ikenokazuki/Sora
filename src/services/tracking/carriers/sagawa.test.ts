import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { trackByCarrier } from '../index.js';

const PAGE = 'https://e-customer.sagawa-exp.co.jp/k2k';

// 佐川の新サイト（Next.js のサーバーアクション）の応答は React Flight 形式。1 行目はアクション結果（`1:`）への参照、
// 2 行目が戻り値の JSON。
const flight = (result: unknown) =>
  new Response(`0:{"a":"$@1","q":"","i":false,"b":"build"}\n1:${JSON.stringify(result)}\n`, {
    headers: { 'content-type': 'text/x-component' },
  });

const shipment = (
  status: string,
  history: Array<{ status: string; date: string; office: string }>,
  extra: Record<string, unknown> = {},
) => ({
  ok: true,
  results: [{
    trackingNumber: '123456789012',
    status,
    messageLines: [],
    dateLines: [],
    shippedDate: '2026年10月20日',
    pickupOffice: null,
    deliveryOffice: null,
    packageCount: '1個',
    history,
    ...extra,
  }],
});

describe('Sagawa tracking response handling', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
  beforeEach(() => { fetchSpy = spyOn(globalThis, 'fetch'); });
  afterEach(() => fetchSpy.mockRestore());

  test('posts the number to the server action and maps the history', async () => {
    fetchSpy.mockResolvedValue(flight(shipment('配達完了（宅配BOX）', [
      { status: '↓集荷', date: '10/20 16:37', office: '渋谷営業所' },
      { status: '↓輸送中', date: '10/20 22:34', office: '関東中継センター' },
      { status: '⇒配達完了（宅配BOX）', date: '10/23 18:00', office: '那覇営業所' },
    ], {
      dateLines: [{ label: '配達完了日　　：', value: '10月23日　18時00分' }],
      pickupOffice: { name: '渋谷営業所', tel: '0570-00-0000', fax: '03-0000-0000' },
      deliveryOffice: { name: '那覇営業所', tel: '0570-00-0000', fax: '098-000-0000' },
    })));

    const result = await trackByCarrier('sagawa', '1234-5678-9012');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PAGE);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Next-Action']).toMatch(/^[0-9a-f]{40,}$/);
    const form = init.body as FormData;
    expect(form.get('_1_tracking_number')).toBe('123456789012');
    expect(form.get('0')).toBe('[null,"$K1"]');

    expect(result.status).toBe('delivered');
    expect(result.statusText).toBe('配達完了（宅配BOX）');
    expect(result.events).toEqual([
      { status: '集荷', date: '10/20 16:37', location: '渋谷営業所' },
      { status: '輸送中', date: '10/20 22:34', location: '関東中継センター' },
      { status: '配達完了（宅配BOX）', date: '10/23 18:00', location: '那覇営業所' },
    ]);
    expect(result.details).toEqual({
      origin: '渋谷営業所',
      destination: '那覇営業所',
      deliveryDate: '10月23日 18時00分',
      serviceType: '飛脚宅配便',
    });
    expect(result.verification?.level).toBe('strong');
    expect(result.trackingUrl).toBe(PAGE);
  });

  test('a successful no-match response returns not_found', async () => {
    fetchSpy.mockResolvedValue(flight(shipment('該当なし', [])));

    const result = await trackByCarrier('sagawa', '1234-5678-9012');
    expect(result.status).toBe('not_found');
    expect(result.trackingNumber).toBe('123456789012');
    expect(result.events).toEqual([]);
    expect(result.verification?.level).toBe('none');
    expect(result.error).toBeUndefined();
  });

  test('a rejected search (ok: false) stays an error, not a missing shipment', async () => {
    fetchSpy.mockResolvedValue(flight({ ok: false, message: 'エラーが発生しました。しばらく時間をおいて再度お試しください。' }));

    const result = await trackByCarrier('sagawa', '123456789012');
    expect(result.status).toBe('error');
    expect(result.error).toBe('エラーが発生しました。しばらく時間をおいて再度お試しください。');
    expect(result.events).toEqual([]);
    expect(result.verification?.level).toBe('none');
  });

  test.each([
    ['an HTML page such as the shutdown notice the old site now serves', new Response('<html>システム停止中のお知らせ</html>')],
    ['a Flight body without the action result row', new Response('0:{"a":"$@1"}\n')],
    ['an action result that is not JSON', new Response('0:{"a":"$@1"}\n1:E{"digest":"x"}\n')],
    ['a successful search without any shipment', flight({ ok: true, results: [] })],
  ])('%s is an error, never not_found', async (_, response) => {
    fetchSpy.mockResolvedValue(response);

    const result = await trackByCarrier('sagawa', '123456789012');
    expect(result.status).toBe('error');
    expect(result.error).toBeTruthy();
    expect(result.events).toEqual([]);
    expect(result.verification?.level).toBe('none');
  });

  test.each([403, 429, 503])('HTTP %i stays an error, not a missing shipment', async (status) => {
    fetchSpy.mockResolvedValue(new Response('Service unavailable', { status }));

    const result = await trackByCarrier('sagawa', '123456789012');
    expect(result.status).toBe('error');
    expect(result.error).toContain(`HTTP ${status}`);
    expect(result.events).toEqual([]);
    expect(result.verification?.level).toBe('none');
    expect(result.trackingUrl).toBe(PAGE);
  });

  test('transport failures retain the cause and never report not_found', async () => {
    fetchSpy.mockRejectedValue(new Error('Connection refused'));

    const result = await trackByCarrier('sagawa', '123456789012');
    expect(result.status).toBe('error');
    expect(result.error).toBe('Connection refused');
    expect(result.events).toEqual([]);
    expect(result.verification?.level).toBe('none');
  });

  // 取り直した ID はモジュールに残るので、ID に触れるこのテストは最後に置く。
  test('takes the action id from the page JS when the server rejects the old one', async () => {
    const newId = `60${'a'.repeat(40)}`;
    fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        return (init.headers as Record<string, string>)['Next-Action'] === newId
          ? flight(shipment('配達中', [{ status: '⇒配達中', date: '10/23 08:47', office: '那覇営業所' }]))
          : new Response('Server Action unavailable.', { status: 409 });
      }
      if (url === PAGE) return new Response('<script src="/k2k/_next/static/chunks/abc.js"></script>');
      if (url === `${PAGE}/_next/static/chunks/abc.js`) {
        return new Response(`(0,n.createServerReference)("${newId}",n.callServer,void 0,n.findSourceMapURL,"searchPackages")`);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);

    const result = await trackByCarrier('sagawa', '123456789012');
    expect(result.status).toBe('in_transit');
    expect(result.events).toEqual([{ status: '配達中', date: '10/23 08:47', location: '那覇営業所' }]);
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);

    // 取り直した ID が残り、次の照会はそのまま通る（取り直しは起きない）
    fetchSpy.mockClear();
    const again = await trackByCarrier('sagawa', '123456789012');
    expect(again.status).toBe('in_transit');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
