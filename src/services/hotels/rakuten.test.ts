import { describe, expect, test } from 'bun:test';
import { HotelSearchInputSchema } from './types.js';
import { encodeRakutenSearch, parseRakutenResponse, resolveRakutenLocation } from './rakuten.js';
import { EMPTY_DS, MISMATCH_DS, TOKYO_DS } from './fixtures/ds.js';
import type { HotelSearchInput } from './types.js';

const htmlWith = (ds: unknown) =>
  '<html><head><script>var ds = ' + JSON.stringify(ds) + ';</script></head><body></body></html>';

const tokyoInput = (overrides: Partial<HotelSearchInput> = {}): HotelSearchInput => ({
  location: '東京駅',
  checkIn: '2026-10-20',
  checkOut: '2026-10-21',
  adults: 2,
  rooms: 1,
  limit: 5,
  ...overrides,
});

describe('HotelSearchInputSchema', () => {
  test('accepts a minimal dated query with defaults', () => {
    const parsed = HotelSearchInputSchema.parse({
      location: '東京駅',
      checkIn: '2026-10-20',
      checkOut: '2026-10-21',
      adults: 2,
    });
    expect(parsed.rooms).toBe(1);
    expect(parsed.limit).toBe(5);
  });

  test('rejects nonexistent dates, reversed stays, and unsupported occupancy', () => {
    const base = { location: '東京駅', checkIn: '2026-10-20', checkOut: '2026-10-21', adults: 2 };
    expect(() => HotelSearchInputSchema.parse({ ...base, checkIn: '2026-02-30' })).toThrow();
    expect(() => HotelSearchInputSchema.parse({ ...base, checkOut: '2026-10-20' })).toThrow();
    expect(() => HotelSearchInputSchema.parse({ ...base, adults: 0 })).toThrow();
    expect(() => HotelSearchInputSchema.parse({ ...base, rooms: 2 })).toThrow();
    expect(() => HotelSearchInputSchema.parse({ ...base, location: '  ' })).toThrow();
  });

  test('rejects unknown fields instead of ignoring them', () => {
    expect(() =>
      HotelSearchInputSchema.parse({
        location: '東京駅',
        checkIn: '2026-10-20',
        checkOut: '2026-10-21',
        adults: 2,
        children: 1,
      }),
    ).toThrow();
    expect(() =>
      HotelSearchInputSchema.parse({
        location: '東京駅',
        checkIn: '2026-10-20',
        checkOut: '2026-10-21',
        adults: 2,
        limit: 11,
      }),
    ).toThrow();
  });
});

describe('resolveRakutenLocation', () => {
  test('resolves the observed labels and ids exactly', () => {
    expect(resolveRakutenLocation('東京駅').id).toBe('tokyo');
    expect(resolveRakutenLocation('tokyo').id).toBe('tokyo');
    expect(resolveRakutenLocation('  京都駅 ').id).toBe('kyoto');
    expect(resolveRakutenLocation('草津温泉').id).toBe('kusatsu');
  });

  test('refuses to guess unobserved or broader locations', () => {
    expect(() => resolveRakutenLocation('東京')).toThrow();
    expect(() => resolveRakutenLocation('大阪')).toThrow();
    expect(() => resolveRakutenLocation('Kyoto Station')).toThrow();
  });
});

describe('encodeRakutenSearch', () => {
  test('encodes dates and occupancy into the observed route', () => {
    const url = encodeRakutenSearch(tokyoInput(), resolveRakutenLocation('東京駅'));
    expect(url.origin).toBe('https://search.travel.rakuten.co.jp');
    expect(url.pathname).toBe('/ds/hotellist/Japan-Tokyo-Tokyo-Tokyo_Station_Area');
    expect(url.searchParams.get('f_nen1')).toBe('2026');
    expect(url.searchParams.get('f_tuki1')).toBe('10');
    expect(url.searchParams.get('f_hi1')).toBe('20');
    expect(url.searchParams.get('f_nen2')).toBe('2026');
    expect(url.searchParams.get('f_tuki2')).toBe('10');
    expect(url.searchParams.get('f_hi2')).toBe('21');
    expect(url.searchParams.get('f_otona_su')).toBe('2');
    expect(url.searchParams.get('f_heya_su')).toBe('1');
  });

  test('reflects changed conditions and year boundaries', () => {
    const changed = encodeRakutenSearch(
      tokyoInput({ checkIn: '2026-12-31', checkOut: '2027-01-01', adults: 1 }),
      resolveRakutenLocation('東京駅'),
    );
    expect(changed.searchParams.get('f_nen1')).toBe('2026');
    expect(changed.searchParams.get('f_hi1')).toBe('31');
    expect(changed.searchParams.get('f_nen2')).toBe('2027');
    expect(changed.searchParams.get('f_tuki2')).toBe('1');
    expect(changed.searchParams.get('f_hi2')).toBe('1');
    expect(changed.searchParams.get('f_otona_su')).toBe('1');
  });
});

describe('parseRakutenResponse', () => {
  test('keeps every plan of the same facility with tax-inclusive amounts', () => {
    const requestedUrl = encodeRakutenSearch(tokyoInput(), resolveRakutenLocation('東京駅')).toString();
    const result = parseRakutenResponse(
      { status: 200, html: htmlWith(TOKYO_DS), url: requestedUrl },
      tokyoInput(),
      '2026-10-01T00:00:00.000Z',
    );
    expect(result.status).toBe('ok');
    expect(result.source).toBe('rakuten_travel');
    expect(result.hotels).toHaveLength(2);
    const first = result.hotels[0];
    expect(first.id).toBe('141356');
    expect(first.name).toBeNull();
    expect(first.address).toBeNull();
    expect(first.sourceUrl).toBe(requestedUrl);
    expect(first.plans).toHaveLength(1);
    expect(first.plans[0].rooms[0]).toMatchObject({
      roomId: 'sma',
      amount: 38000,
      currency: 'JPY',
      basis: 'stay_total',
      taxStatus: 'included',
    });
    const second = result.hotels[1];
    expect(second.plans.map((plan) => plan.planId).sort()).toEqual(['4625093', '6162116']);
  });

  test('marks multi-night charges as unknown basis instead of multiplying', () => {
    const requestedUrl = encodeRakutenSearch(
      tokyoInput({ checkIn: '2026-10-20', checkOut: '2026-10-22' }),
      resolveRakutenLocation('東京駅'),
    ).toString();
    const multiNight = JSON.parse(JSON.stringify(TOKYO_DS));
    multiNight.conditions.f_hi2 = ['22'];
    const result = parseRakutenResponse(
      { status: 200, html: htmlWith(multiNight), url: requestedUrl },
      tokyoInput({ checkIn: '2026-10-20', checkOut: '2026-10-22' }),
      '2026-10-01T00:00:00.000Z',
    );
    expect(result.status).toBe('ok');
    for (const hotel of result.hotels) {
      for (const plan of hotel.plans) {
        for (const room of plan.rooms) {
          expect(room.basis).toBe('unknown');
        }
      }
    }
  });

  test('keeps unknown tax status instead of assuming it', () => {
    const requestedUrl = encodeRakutenSearch(tokyoInput(), resolveRakutenLocation('東京駅')).toString();
    const noTaxType = JSON.parse(JSON.stringify(TOKYO_DS));
    delete noTaxType.hotels['141356'].plans['5109708'].rooms.sma.taxType;
    const result = parseRakutenResponse(
      { status: 200, html: htmlWith(noTaxType), url: requestedUrl },
      tokyoInput(),
      '2026-10-01T00:00:00.000Z',
    );
    expect(result.status).toBe('ok');
    expect(result.hotels[0].plans[0].rooms[0]).toMatchObject({ amount: 38000, taxStatus: 'unknown' });
  });

  test('respects the caller limit and says so', () => {
    const requestedUrl = encodeRakutenSearch(tokyoInput({ limit: 1 }), resolveRakutenLocation('東京駅')).toString();
    const result = parseRakutenResponse(
      { status: 200, html: htmlWith(TOKYO_DS), url: requestedUrl },
      tokyoInput({ limit: 1 }),
      '2026-10-01T00:00:00.000Z',
    );
    expect(result.hotels).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('1');
  });

  test('reports condition mismatch instead of empty', () => {
    const requestedUrl = encodeRakutenSearch(tokyoInput(), resolveRakutenLocation('東京駅')).toString();
    const result = parseRakutenResponse(
      { status: 200, html: htmlWith(MISMATCH_DS), url: requestedUrl },
      tokyoInput(),
      '2026-10-01T00:00:00.000Z',
    );
    expect(result.status).toBe('unavailable');
    expect(result.status).not.toBe('empty');
    expect(result.hotels).toEqual([]);
    expect(result.failures[0].code).toBe('CONDITION_MISMATCH');
  });

  test('reports schema changes instead of empty', () => {
    const requestedUrl = encodeRakutenSearch(tokyoInput(), resolveRakutenLocation('東京駅')).toString();
    const missing = parseRakutenResponse(
      { status: 200, html: '<html><body>no state here</body></html>', url: requestedUrl },
      tokyoInput(),
      '2026-10-01T00:00:00.000Z',
    );
    expect(missing.status).toBe('unavailable');
    expect(missing.failures[0].code).toBe('SCHEMA_CHANGED');
  });

  test('returns empty only for an explicit zero-result state', () => {
    const requestedUrl = encodeRakutenSearch(tokyoInput(), resolveRakutenLocation('東京駅')).toString();
    const emptyDs = JSON.parse(JSON.stringify(EMPTY_DS));
    const result = parseRakutenResponse(
      { status: 200, html: htmlWith(emptyDs), url: requestedUrl },
      tokyoInput(),
      '2026-10-01T00:00:00.000Z',
    );
    expect(result.status).toBe('empty');
    expect(result.hotels).toEqual([]);
  });

  test('survives key reordering and unrelated additions, fails on missing essentials', () => {
    const requestedUrl = encodeRakutenSearch(tokyoInput(), resolveRakutenLocation('東京駅')).toString();
    const reordered = JSON.parse(JSON.stringify(TOKYO_DS));
    const hotels = reordered.hotels;
    delete reordered.hotels;
    reordered.hotels = Object.fromEntries(Object.entries(hotels).reverse());
    reordered.unrelated = { ads: [1, 2, 3] };
    const ok = parseRakutenResponse(
      { status: 200, html: htmlWith(reordered), url: requestedUrl },
      tokyoInput(),
      '2026-10-01T00:00:00.000Z',
    );
    expect(ok.status).toBe('ok');
    const broken = JSON.parse(JSON.stringify(TOKYO_DS));
    delete broken.hotels;
    const failed = parseRakutenResponse(
      { status: 200, html: htmlWith(broken), url: requestedUrl },
      tokyoInput(),
      '2026-10-01T00:00:00.000Z',
    );
    expect(failed.status).toBe('unavailable');
    expect(failed.failures[0].code).toBe('SCHEMA_CHANGED');
  });

});
