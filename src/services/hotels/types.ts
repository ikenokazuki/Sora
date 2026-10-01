import { z } from 'zod';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Real calendar date in YYYY-MM-DD form. No year auto-completion. */
export function isRealCalendarDate(value: string): boolean {
  return (
    DATE_RE.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
  );
}

export const HotelSearchInputSchema = z
  .object({
    location: z.string().trim().min(1).max(200),
    checkIn: z.string().regex(DATE_RE, 'checkIn must be YYYY-MM-DD'),
    checkOut: z.string().regex(DATE_RE, 'checkOut must be YYYY-MM-DD'),
    adults: z.number().int().min(1),
    rooms: z.number().int().min(1).max(1).default(1),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isRealCalendarDate(value.checkIn)) {
      ctx.addIssue({ code: 'custom', path: ['checkIn'], message: 'checkIn is not a real date' });
    }
    if (!isRealCalendarDate(value.checkOut)) {
      ctx.addIssue({ code: 'custom', path: ['checkOut'], message: 'checkOut is not a real date' });
    }
    if (
      isRealCalendarDate(value.checkIn) &&
      isRealCalendarDate(value.checkOut) &&
      value.checkOut <= value.checkIn
    ) {
      ctx.addIssue({ code: 'custom', path: ['checkOut'], message: 'checkOut must be after checkIn' });
    }
  });

export type HotelSearchInput = z.infer<typeof HotelSearchInputSchema>;

/** Loose query accepted at service boundaries. Defaults apply during validation. */
export type HotelSearchQuery = z.input<typeof HotelSearchInputSchema>;

export const HotelPriceBasisSchema = z.enum(['stay_total', 'room_night', 'person_night', 'unknown']);
export type HotelPriceBasis = z.infer<typeof HotelPriceBasisSchema>;

export const HotelTaxStatusSchema = z.enum(['included', 'excluded', 'unknown']);
export type HotelTaxStatus = z.infer<typeof HotelTaxStatusSchema>;

export const HotelFailureCodeSchema = z.enum([
  'AMBIGUOUS_LOCATION',
  'UNSUPPORTED_CONDITION',
  'CONDITION_MISMATCH',
  'SCHEMA_CHANGED',
  'SESSION_REQUIRED',
  'RATE_LIMITED',
  'ACCESS_DENIED',
  'TIMEOUT',
  'UPSTREAM_ERROR',
]);
export type HotelFailureCode = z.infer<typeof HotelFailureCodeSchema>;

export const HotelFailureSchema = z
  .object({
    code: HotelFailureCodeSchema,
    message: z.string().min(1),
  })
  .strict();
export type HotelFailure = z.infer<typeof HotelFailureSchema>;

export const HotelRoomPriceSchema = z
  .object({
    roomId: z.string().min(1),
    amount: z.number().int().min(0),
    currency: z.string().min(1),
    basis: HotelPriceBasisSchema,
    taxStatus: HotelTaxStatusSchema,
  })
  .strict();
export type HotelRoomPrice = z.infer<typeof HotelRoomPriceSchema>;

export const HotelPlanSchema = z
  .object({
    planId: z.string().min(1),
    rooms: z.array(HotelRoomPriceSchema),
  })
  .strict();
export type HotelPlan = z.infer<typeof HotelPlanSchema>;

export const HotelSchema = z
  .object({
    id: z.string().min(1),
    /** Null while no structured facility metadata route is established. Never fabricated. */
    name: z.string().nullable(),
    /** Null while no structured facility metadata route is established. Never fabricated. */
    address: z.string().nullable(),
    sourceUrl: z.string().min(1),
    plans: z.array(HotelPlanSchema),
  })
  .strict();
export type Hotel = z.infer<typeof HotelSchema>;

export const HotelSearchResultSchema = z
  .object({
    source: z.literal('rakuten_travel'),
    status: z.enum(['ok', 'partial', 'empty', 'unavailable']),
    query: z
      .object({
        location: z.string(),
        checkIn: z.string(),
        checkOut: z.string(),
        adults: z.number().int(),
        rooms: z.number().int(),
        limit: z.number().int(),
      })
      .strict(),
    retrievedAt: z.string().min(1),
    hotels: z.array(HotelSchema),
    warnings: z.array(z.string()),
    failures: z.array(HotelFailureSchema),
  })
  .strict();
export type HotelSearchResult = z.infer<typeof HotelSearchResultSchema>;

/** Experimental gate. Default off; REST/MCP/service stay hidden until explicitly enabled. */
export function isRakutenTravelEnabled(): boolean {
  return process.env.SORA_RAKUTEN_TRAVEL_ENABLED === 'true';
}
