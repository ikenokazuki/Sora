import { describe, expect, test } from 'bun:test';
// Explicit live gate. Never runs in normal CI.
const tLive = test.skipIf(!process.env.SORA_LIVE_TESTS);
import { hotelService } from './index.js';

/** 21 days ahead in JST. Prices and counts are never asserted. */
function futureStay(): { checkIn: string; checkOut: string } {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const base = Date.parse(today + 'T00:00:00Z') + 21 * 86400000;
  return {
    checkIn: new Date(base).toISOString().slice(0, 10),
    checkOut: new Date(base + 86400000).toISOString().slice(0, 10),
  };
}

describe('rakuten travel live acceptance', () => {
  tLive(
    'returns dated structures for the three observed locations',
    async () => {
      const { checkIn, checkOut } = futureStay();
      const heapBefore = process.memoryUsage().heapUsed;
      for (const location of ['東京駅', '京都駅', '草津温泉']) {
        const started = Date.now();
        const result = await hotelService.searchHotelAvailability(
          { location, checkIn, checkOut, adults: 2 },
          { signal: AbortSignal.timeout(20000), deadlineAt: Date.now() + 20000 },
        );
        const elapsed = Date.now() - started;
        console.log(
          'live ' + location + ': status=' + result.status +
            ' hotels=' + result.hotels.length +
            ' failures=' + result.failures.map((f) => f.code).join(',') +
            ' elapsedMs=' + elapsed,
        );
        expect(['ok', 'empty']).toContain(result.status);
        expect(result.query).toMatchObject({ location, checkIn, checkOut, adults: 2 });
        expect(Number.isNaN(Date.parse(result.retrievedAt))).toBe(false);
        expect(elapsed).toBeLessThan(20000);
        if (result.status === 'ok') {
          expect(result.hotels.length).toBeGreaterThan(0);
          for (const hotel of result.hotels.slice(0, 3)) {
            expect(hotel.id).toMatch(/^\d+$/);
            expect(hotel.sourceUrl).toContain('search.travel.rakuten.co.jp');
            for (const plan of hotel.plans.slice(0, 2)) {
              for (const room of plan.rooms.slice(0, 2)) {
                expect(room.amount).toBeGreaterThanOrEqual(0);
                expect(room.currency).toBe('JPY');
              }
            }
          }
        }
      }
      const heapAfter = process.memoryUsage().heapUsed;
      console.log('live heap delta bytes=' + (heapAfter - heapBefore));
    },
    55000,
  );
});
