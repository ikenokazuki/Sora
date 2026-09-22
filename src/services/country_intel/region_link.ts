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
  textMentioned = false,
): RegionLinkResult {
  const code = region.countryCode;
  if (!code) return { link: 'unknown', reasons: ['region-unresolved'] };
  if (item.eventCountry === code) return { link: 'direct', reasons: ['event-country'] };
  if (item.mentionedCountries?.includes(code)) {
    return item.eventCountry
      ? { link: 'related', reasons: ['mentioned-alongside-foreign-event'] }
      : { link: 'related', reasons: ['mentioned'] };
  }
  if (textMentioned) {
    return item.eventCountry
      ? { link: 'related', reasons: ['text-mentioned-alongside-foreign-event'] }
      : { link: 'related', reasons: ['text-mentioned'] };
  }
  if (item.eventCountry) return { link: 'unrelated', reasons: ['foreign-event-country:' + item.eventCountry] };
  if (item.sourceType === 'structured_dataset') {
    return { link: 'unknown', reasons: ['structured-unattributed'] };
  }
  if (queryTargeted) return { link: 'candidate', reasons: ['region-query-unverified'] };
  return { link: 'unknown', reasons: ['no-attribution'] };
}


/** 言及針。ICUの地域表示名で多言語化する汎用機構で、個別国の表記ハードコードはしない。 */
export function regionMentionNeedles(region: RegionIdentity, extraLocales: readonly string[] = []): string[] {
  const locales = [...new Set([...(region.languages ?? []), ...extraLocales, 'en'])];
  const needles = new Set<string>();
  for (const value of [region.name, region.nativeName, ...(region.aliases ?? [])]) {
    if (value && value.trim().length > 1) needles.add(value.normalize('NFKC'));
  }
  if (region.countryCode) {
    for (const locale of locales) {
      try {
        const display = new Intl.DisplayNames([locale], { type: 'region' }).of(region.countryCode);
        if (display && display.trim().length > 1) needles.add(display.normalize('NFKC'));
      } catch { /* ICU欠落時は無視 */ }
    }
  }
  return [...needles];
}

/** 本文・見出しの地域言及。ラテン文字は大小無視、CJKは部分一致。 */
export function textMentionsRegion(text: string | undefined, region: RegionIdentity, extraLocales: readonly string[] = []): boolean {
  if (!text) return false;
  const normalized = text.normalize('NFKC');
  const lowered = normalized.toLocaleLowerCase('en-US');
  return regionMentionNeedles(region, extraLocales).some((needle) => {
    if (/[\p{Script=Latin}]/u.test(needle)) return lowered.includes(needle.toLocaleLowerCase('en-US'));
    return normalized.includes(needle);
  });
}

/** 候補の本文確認。本文に地域言及があればrelatedへ昇格する。候補以外・言及なしは触らない。 */
export function upgradeCandidateWithBody(link: RegionLink, bodyText: string | undefined, region: RegionIdentity, extraLocales: readonly string[] = []): RegionLinkResult | undefined {
  if (link !== 'candidate') return undefined;
  if (!textMentionsRegion(bodyText, region, extraLocales)) return undefined;
  return { link: 'related', reasons: ['body-mention'] };
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
