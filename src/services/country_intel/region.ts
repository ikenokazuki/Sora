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

const REGION_IDENTITIES: readonly RegionRecord[] = Object.freeze([
  identity({
    id: 'country:KR',
    name: 'South Korea',
    nativeName: '대한민국',
    countryCode: 'KR',
    languages: ['ko'],
    aliases: ['Korea, Republic of', 'Republic of Korea', 'Korea (South)'],
    timezone: 'Asia/Seoul',
  }),
  identity({
    id: 'country:GE',
    name: 'Georgia',
    nativeName: 'საქართველო',
    countryCode: 'GE',
    languages: ['ka'],
    aliases: [],
    timezone: 'Asia/Tbilisi',
  }),
  identity({
    id: 'country:US',
    name: 'United States',
    countryCode: 'US',
    languages: ['en'],
    aliases: ['United States of America', 'USA'],
    timezone: 'America/New_York',
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

export function resolveRegion(input: string): RegionIdentity {
  const normalized = input.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const matches = REGION_IDENTITIES.filter((region) =>
    [
      region.id,
      region.name,
      region.nativeName,
      region.subdivisionCode ?? region.countryCode,
      ...region.aliases,
    ]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase('en-US') === normalized));

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
