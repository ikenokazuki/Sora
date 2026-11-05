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

const jaNames = new Intl.DisplayNames(['ja'], { type: 'region' });
const normalizeKey = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
/** ISO alpha-2 → 日本語の国名 (ICU の地域名から作る。表は持たない)。データが無い地域は含めない。 */
const JA_NAME_BY_ALPHA2: ReadonlyMap<string, string> = new Map(ISO_COUNTRIES.flatMap(([alpha2]) => {
  const name = jaNames.of(alpha2);
  return name && name !== alpha2 ? [[alpha2, normalizeKey(name)] as const] : [];
}));
/** 先頭だけの入力 (例: アメリカ → アメリカ合衆国) は短すぎる語を除く。 */
const JA_PREFIX_MIN_LENGTH = 3;

function matchKeys(region: RegionRecord, alpha3: string | undefined): string[] {
  return [
    region.id,
    region.name,
    region.nativeName,
    region.subdivisionCode || !region.countryCode ? undefined : JA_NAME_BY_ALPHA2.get(region.countryCode),
    // Subdivision は親国コード単体で解決しない (US が US-GA にも一致するのを防ぐ)。
    ...(region.subdivisionCode ? [region.subdivisionCode] : [region.countryCode]),
    alpha3,
    ...region.aliases,
  ].filter((value): value is string => Boolean(value));
}

export function resolveRegion(input: string): RegionIdentity {
  const normalized = normalizeKey(input);
  const alpha3ByAlpha2 = new Map(ISO_COUNTRIES.map(([alpha2, alpha3]) => [alpha2, alpha3]));
  const matches = REGION_IDENTITIES.filter((region) =>
    matchKeys(region, region.countryCode ? alpha3ByAlpha2.get(region.countryCode) : undefined)
      .some((value) => value.toLocaleLowerCase('en-US') === normalized));

  const found = (region: RegionRecord, confidence: RegionIdentity['confidence']): RegionIdentity => ({
    ...region,
    languages: [...region.languages],
    aliases: [...region.aliases],
    confidence,
  });
  if (matches.length === 1) return found(matches[0], 'high');

  // 完全一致が無いときだけ、日本語名の先頭一致を見る。候補が1か国に決まるときだけ採る。
  if (matches.length === 0 && normalized.length >= JA_PREFIX_MIN_LENGTH) {
    const prefixed = REGION_IDENTITIES.filter((region) =>
      !region.subdivisionCode && region.countryCode && JA_NAME_BY_ALPHA2.get(region.countryCode)?.startsWith(normalized));
    if (prefixed.length === 1) return found(prefixed[0], 'medium');
  }

  return {
    id: `unresolved:${normalized}`,
    name: input.trim(),
    languages: [],
    aliases: [],
    confidence: 'low',
  };
}
