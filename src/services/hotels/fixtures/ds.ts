/**
 * Minimal `ds` samples trimmed from the 2026-10-01 observed Tokyo response.
 * Kept to the fields the product parser reads. No credentials were ever present.
 * Prices move with inventory; these literals only exercise parsing, never live pricing.
 */
export const TOKYO_DS = {
  isDated: true,
  conditions: {
    f_dai: ['japan'],
    f_chu: ['tokyo'],
    f_shou: ['tokyo'],
    f_sai: ['A'],
    f_nen1: ['2026'],
    f_tuki1: ['10'],
    f_hi1: ['20'],
    f_nen2: ['2026'],
    f_tuki2: ['10'],
    f_hi2: ['21'],
    f_otona_su: ['2'],
    f_heya_su: ['1'],
  },
  totalResults: [22],
  displayedHotels: [141356, 178610],
  hotels: {
    '141356': {
      plans: {
        '5109708': {
          rooms: {
            sma: {
              sumTotalChargeTaxExclusive: 34546,
              sumTotalChargeTaxInclusive: 38000,
              taxType: 'inclusive',
            },
          },
        },
      },
      rooms: {},
    },
    '178610': {
      plans: {
        '4625093': {
          rooms: {
            sdn2: {
              sumTotalChargeTaxExclusive: 57273,
              sumTotalChargeTaxInclusive: 63000,
              taxType: 'inclusive',
            },
          },
        },
        '6162116': {
          rooms: {
            sdn2: {
              sumTotalChargeTaxExclusive: 58182,
              sumTotalChargeTaxInclusive: 64000,
              taxType: 'inclusive',
            },
          },
        },
      },
      rooms: {},
    },
  },
};

/** Same shape with one adult, so a 2-adult query must report CONDITION_MISMATCH. */
export const MISMATCH_DS = {
  ...TOKYO_DS,
  conditions: { ...TOKYO_DS.conditions, f_otona_su: ['1'] },
};

/** Explicit zero-result state. Only this shape may become `empty`. */
export const EMPTY_DS = {
  ...TOKYO_DS,
  totalResults: [0],
  displayedHotels: [],
  hotels: {},
};
