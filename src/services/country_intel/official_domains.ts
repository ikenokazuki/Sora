export interface OfficialDomainSeed {
  countryCode: string;
  domain: string;
  kind: string;
}

export const OFFICIAL_DOMAIN_SEEDS: readonly OfficialDomainSeed[] = [
  { countryCode: 'US', domain: 'whitehouse.gov', kind: 'government' },
  { countryCode: 'US', domain: 'state.gov', kind: 'foreign_ministry' },
  { countryCode: 'JP', domain: 'mofa.go.jp', kind: 'foreign_ministry' },
  { countryCode: 'JP', domain: 'stat.go.jp', kind: 'statistics' },
  { countryCode: 'CN', domain: 'fmprc.gov.cn', kind: 'foreign_ministry' },
  { countryCode: 'CN', domain: 'stats.gov.cn', kind: 'statistics' },
  { countryCode: 'KR', domain: 'mofa.go.kr', kind: 'foreign_ministry' },
  { countryCode: 'KR', domain: 'kostat.go.kr', kind: 'statistics' },
  { countryCode: 'GB', domain: 'gov.uk', kind: 'government' },
  { countryCode: 'GB', domain: 'bankofengland.co.uk', kind: 'central_bank' },
  { countryCode: 'FR', domain: 'elysee.fr', kind: 'government' },
  { countryCode: 'FR', domain: 'insee.fr', kind: 'statistics' },
  { countryCode: 'DE', domain: 'bundesregierung.de', kind: 'government' },
  { countryCode: 'DE', domain: 'destatis.de', kind: 'statistics' },
  { countryCode: 'TW', domain: 'mofa.gov.tw', kind: 'foreign_ministry' },
];

export function seedDomainsForCountry(countryCode: string | undefined): string[] {
  if (!countryCode) return [];
  return OFFICIAL_DOMAIN_SEEDS.filter(function (seed) { return seed.countryCode === countryCode; }).map(function (seed) { return seed.domain; });
}
