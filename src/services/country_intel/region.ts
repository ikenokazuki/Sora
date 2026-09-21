import { ISO_COUNTRIES } from './geo_codes.js';
import type { RegionIdentity } from './types.js';

type RegionRecord = Omit<RegionIdentity, 'confidence' | 'languages' | 'aliases'> & {
  readonly languages: readonly string[];
  readonly aliases: readonly string[];
};

function identity(region: Omit<RegionIdentity, 'confidence'>): RegionRecord {
  return Object.freeze({
    ...region,
    languages: Object.freeze([...region.languages]),
    aliases: Object.freeze([...region.aliases]),
  });
}

/** ISO catalogue由来の国レコード。nativeName/aliases は既存の監査済み分のみ保持する。 */
const CATALOGUE_EXTRA: Readonly<Record<string, { nativeName?: string; aliases?: readonly string[]; languages?: readonly string[]; timezone?: string }>> = Object.freeze({
  KR: { nativeName: '대한민국', aliases: ['Korea, Republic of', 'Republic of Korea', 'Korea (South)'], languages: ['ko'], timezone: 'Asia/Seoul' },
  GE: { nativeName: 'საქართველო', languages: ['ka'], timezone: 'Asia/Tbilisi' },
  US: { aliases: ['United States of America', 'USA'], languages: ['en'], timezone: 'America/New_York' },
});

const REGION_IDENTITIES: readonly RegionRecord[] = Object.freeze([
  ...ISO_COUNTRIES.map(([alpha2, , name]) => {
    const extra = CATALOGUE_EXTRA[alpha2] ?? {};
    return identity({
      id: `country:${alpha2}`,
      name,
      ...(extra.nativeName ? { nativeName: extra.nativeName } : {}),
      countryCode: alpha2,
      languages: [...(extra.languages ?? [])],
      aliases: [...(extra.aliases ?? [])],
      ...(extra.timezone ? { timezone: extra.timezone } : {}),
    });
  }),
  identity({
    id: 'subdivision:US-GA',
    name: 'Georgia',
    countryCode: 'US',
    subdivisionCode: 'US-GA',
    parentCountryCode: 'US',
    languages: ['en'],
    aliases: ['State of Georgia'],
    timezone: 'America/New_York',
  }),
]);

function matchKeys(region: RegionRecord, alpha3: string | undefined): string[] {
  return [
    region.id,
    region.name,
    region.nativeName,
    // Subdivision は親国コード単体で解決しない (US が US-GA にも一致するのを防ぐ)。
    ...(region.subdivisionCode ? [region.subdivisionCode] : [region.countryCode]),
    alpha3,
    ...region.aliases,
  ].filter((value): value is string => Boolean(value));
}

export function resolveRegion(input: string): RegionIdentity {
  const normalized = input.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const alpha3ByAlpha2 = new Map(ISO_COUNTRIES.map(([alpha2, alpha3]) => [alpha2, alpha3]));
  const matches = REGION_IDENTITIES.filter((region) =>
    matchKeys(region, region.countryCode ? alpha3ByAlpha2.get(region.countryCode) : undefined)
      .some((value) => value.toLocaleLowerCase('en-US') === normalized));

  if (matches.length === 1) {
    return {
      ...matches[0],
      languages: [...matches[0].languages],
      aliases: [...matches[0].aliases],
      confidence: 'high',
    };
  }

  return {
    id: `unresolved:${normalized}`,
    name: input.trim(),
    languages: [],
    aliases: [],
    confidence: 'low',
  };
}
