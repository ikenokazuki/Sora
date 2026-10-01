import { Hono } from 'hono';
import { HotelSearchInputSchema, isRakutenTravelEnabled } from '../services/hotels/types.js';
import { hotelService, type HotelService } from '../services/hotels/index.js';

const CALL_BUDGET_MS = 20000;

export function createHotelRoutes(options: { service?: HotelService } = {}) {
  const routes = new Hono();
  const service = options.service ?? hotelService;

  routes.post('/hotels/availability', async (c) => {
    if (!isRakutenTravelEnabled()) {
      return c.json({ error: 'ホテル検索は無効です (SORA_RAKUTEN_TRAVEL_ENABLED=true で有効化)' }, 404);
    }
    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = HotelSearchInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: 'リクエストパラメータが不正です',
          details: parsed.error.flatten().fieldErrors,
        },
        400,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_BUDGET_MS);
    try {
      const result = await service.searchHotelAvailability(parsed.data, {
        signal: controller.signal,
        deadlineAt: Date.now() + CALL_BUDGET_MS,
      });
      return c.json(result);
    } finally {
      clearTimeout(timer);
    }
  });

  return routes;
}

export const hotelRoutes = createHotelRoutes();
