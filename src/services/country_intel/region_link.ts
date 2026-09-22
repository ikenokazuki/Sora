import type { CountryEvidence, RegionIdentity } from './types.js';

export type RegionLink = 'direct' | 'related' | 'candidate' | 'unrelated' | 'unknown';

export interface RegionLinkResult {
  link: RegionLink;
  reasons: string[];
}

/**
 * 1件の証拠と対象地域の関係を判定する。媒体の所在国・言語・regionId
 * だけでは発生国を確定しない。国名の文字列一致は言及の根拠に留める。
 * queryTargeted: 実際に投げた検索条件に地域名・コード・別名が含まれる場合 true。
 */
export function classifyRegionLink(
  item: CountryEvidence,
  region: RegionIdentity,
  queryTargeted: boolean,
): RegionLinkResult {
  const code = region.countryCode;
  if (!code) return { link: 'unknown', reasons: ['region-unresolved'] };
  if (item.eventCountry === code) return { link: 'direct', reasons: ['event-country'] };
  if (item.mentionedCountries?.includes(code)) {
    return item.eventCountry
      ? { link: 'related', reasons: ['mentioned-alongside-foreign-event'] }
      : { link: 'related', reasons: ['mentioned'] };
  }
  if (item.eventCountry) return { link: 'unrelated', reasons: ['foreign-event-country:' + item.eventCountry] };
  if (item.sourceType === 'structured_dataset') {
    return { link: 'unknown', reasons: ['structured-unattributed'] };
  }
  if (queryTargeted) return { link: 'candidate', reasons: ['region-query-unverified'] };
  return { link: 'unknown', reasons: ['no-attribution'] };
}

/**
 * 実際に投げた検索条件に地域名・コード・別名が含まれるか。
 * query が空の provider は対象地域を絞っていないため false ではなく true 扱い
 * （情報不足による降格を避ける）。呼び出し側で明示的に判定する。
 */
export function isQueryTargeted(queries: readonly { query: string }[], region: RegionIdentity): boolean {
  if (queries.length === 0) return true;
  const haystack = queries.map((q) => q.query).join(' \n').toLocaleLowerCase('en-US');
  const needles = [region.name, region.countryCode, ...(region.aliases ?? [])]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.toLocaleLowerCase('en-US'));
  return needles.some((needle) => needle.length > 1 && haystack.includes(needle));
}
