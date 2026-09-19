import type { RegionIdentity } from './types.js';

export const REGION_IDENTITIES: readonly Omit<RegionIdentity, 'confidence'>[] = [
  {
    id: 'country:KR',
    name: 'South Korea',
    nativeName: '대한민국',
    countryCode: 'KR',
    languages: ['ko'],
    aliases: ['Korea, Republic of', 'Republic of Korea', 'Korea (South)'],
    timezone: 'Asia/Seoul',
  },
  {
    id: 'country:GE',
    name: 'Georgia',
    nativeName: 'საქართველო',
    countryCode: 'GE',
    languages: ['ka'],
    aliases: [],
    timezone: 'Asia/Tbilisi',
  },
  {
    id: 'subdivision:US-GA',
    name: 'Georgia',
    countryCode: 'US',
    subdivisionCode: 'US-GA',
    parentCountryCode: 'US',
    languages: ['en'],
    aliases: ['State of Georgia'],
    timezone: 'America/New_York',
  },
] as const;

export function resolveRegion(input: string): RegionIdentity {
  const normalized = input.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const matches = REGION_IDENTITIES.filter((region) =>
    [region.id, region.name, region.nativeName, region.countryCode, ...region.aliases]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase('en-US') === normalized));

  if (matches.length === 1) return { ...matches[0], confidence: 'high' };

  return {
    id: `unresolved:${normalized}`,
    name: input.trim(),
    languages: [],
    aliases: [],
    confidence: 'low',
  };
}
