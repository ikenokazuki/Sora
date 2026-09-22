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
  { countryCode: 'IT', domain: 'governo.it', kind: 'government' },
  { countryCode: 'IT', domain: 'istat.it', kind: 'statistics' },
  { countryCode: 'ES', domain: 'lamoncloa.gob.es', kind: 'government' },
  { countryCode: 'ES', domain: 'ine.es', kind: 'statistics' },
  { countryCode: 'CA', domain: 'canada.ca', kind: 'government' },
  { countryCode: 'CA', domain: 'statcan.gc.ca', kind: 'statistics' },
  { countryCode: 'AU', domain: 'australia.gov.au', kind: 'government' },
  { countryCode: 'AU', domain: 'abs.gov.au', kind: 'statistics' },
  { countryCode: 'IN', domain: 'pib.gov.in', kind: 'government' },
  { countryCode: 'IN', domain: 'mospi.gov.in', kind: 'statistics' },
  { countryCode: 'BR', domain: 'gov.br', kind: 'government' },
  { countryCode: 'BR', domain: 'ibge.gov.br', kind: 'statistics' },
  { countryCode: 'MX', domain: 'gob.mx', kind: 'government' },
  { countryCode: 'MX', domain: 'inegi.org.mx', kind: 'statistics' },
  { countryCode: 'TH', domain: 'thaigov.go.th', kind: 'government' },
  { countryCode: 'VN', domain: 'chinhphu.vn', kind: 'government' },
  { countryCode: 'ID', domain: 'indonesia.go.id', kind: 'government' },
  { countryCode: 'ID', domain: 'bps.go.id', kind: 'statistics' },
  { countryCode: 'PH', domain: 'officialgazette.gov.ph', kind: 'government' },
  { countryCode: 'PH', domain: 'psa.gov.ph', kind: 'statistics' },
  { countryCode: 'SG', domain: 'gov.sg', kind: 'government' },
  { countryCode: 'SG', domain: 'singstat.gov.sg', kind: 'statistics' },
];

export function seedDomainsForCountry(countryCode: string | undefined): string[] {
  if (!countryCode) return [];
  return OFFICIAL_DOMAIN_SEEDS.filter(function (seed) { return seed.countryCode === countryCode; }).map(function (seed) { return seed.domain; });
}
