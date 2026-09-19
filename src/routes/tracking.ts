import { Hono } from 'hono';
import { trackPackage, cleanTrackingNumber } from '../services/tracking.js';
import { TrackingRequestSchema, CARRIER_CODES } from '../types.js';

export const trackingRoutes = new Hono();

// POST /tracking
trackingRoutes.post('/tracking', async (c) => {
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    const parseResult = TrackingRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return c.json(
        {
          error: 'リクエストパラメータが不正です',
          details: parseResult.error.flatten().fieldErrors,
        },
        400,
      );
    }

    const result = await trackPackage(parseResult.data);
    return c.json(result);
  } catch (err: any) {
    return c.json(
      {
        error: err.message || '荷物追跡に失敗しました',
      },
      500,
    );
  }
});

// GET /tracking/:carrier/:number (運送会社 & 伝票番号指定)
trackingRoutes.get('/tracking/:carrier/:number', async (c) => {
  try {
    const carrierParam = c.req.param('carrier').toLowerCase();
    const numberParam = c.req.param('number');
    const noCache = c.req.query('noCache') === 'true';

    const validCarriers: string[] = [...CARRIER_CODES, 'auto'];
    if (!validCarriers.includes(carrierParam)) {
      return c.json(
        {
          error: `不正な運送会社コードです: ${carrierParam}。有効な値: ${validCarriers.join(', ')}`,
        },
        400,
      );
    }

    const num = cleanTrackingNumber(numberParam);
    if (!num) {
      return c.json({ error: '伝票番号を指定してください' }, 400);
    }

    const result = await trackPackage({
      trackingNumber: num,
      carrier: carrierParam as any,
      noCache,
    });

    return c.json(result);
  } catch (err: any) {
    return c.json(
      {
        error: err.message || '荷物追跡に失敗しました',
      },
      500,
    );
  }
});

// GET /tracking/:number (伝票番号から自動判別)
trackingRoutes.get('/tracking/:number', async (c) => {
  try {
    const numberParam = c.req.param('number');
    const noCache = c.req.query('noCache') === 'true';

    const num = cleanTrackingNumber(numberParam);
    if (!num) {
      return c.json({ error: '伝票番号を指定してください' }, 400);
    }

    const result = await trackPackage({
      trackingNumber: num,
      carrier: 'auto',
      noCache,
    });

    return c.json(result);
  } catch (err: any) {
    return c.json(
      {
        error: err.message || '荷物追跡に失敗しました',
      },
      500,
    );
  }
});
