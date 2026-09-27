import type { ProviderInput } from '../provider_registry.js';

type Facet = 'economy' | 'politics' | 'tourism' | 'health' | 'disasters';
export interface NewsQuery { query: string; language: string; area: string; facet: string; }

// 国ごとの条件分岐を避け、ICU で得た検索言語に分野語を対応させる。
const FACET_WORDS: Record<string, Record<Facet, string>> = {
  en: { economy: 'economy', politics: 'politics', tourism: 'tourism', health: 'outbreak', disasters: 'disaster' },
  ja: { economy: '経済', politics: '政治', tourism: '観光', health: '感染症', disasters: '災害' },
  zh: { economy: '经济', politics: '政治', tourism: '旅游', health: '传染病', disasters: '灾害' },
  fr: { economy: 'économie', politics: 'politique', tourism: 'tourisme', health: 'épidémie', disasters: 'catastrophe' },
  de: { economy: 'Wirtschaft', politics: 'Politik', tourism: 'Tourismus', health: 'Infektionskrankheit', disasters: 'Katastrophe' },
  es: { economy: 'economía', politics: 'política', tourism: 'turismo', health: 'brote', disasters: 'desastre' },
  pt: { economy: 'economia', politics: 'política', tourism: 'turismo', health: 'surto', disasters: 'desastre' },
  hi: { economy: 'अर्थव्यवस्था', politics: 'राजनीति', tourism: 'पर्यटन', health: 'संक्रामक रोग', disasters: 'आपदा' },
  id: { economy: 'ekonomi', politics: 'politik', tourism: 'pariwisata', health: 'wabah', disasters: 'bencana' },
  ko: { economy: '경제', politics: '정치', tourism: '관광', health: '감염병', disasters: '재난' },
  ar: { economy: 'اقتصاد', politics: 'سياسة', tourism: 'سياحة', health: 'تفشي', disasters: 'كارثة' },
  ru: { economy: 'экономика', politics: 'политика', tourism: 'туризм', health: 'вспышка заболевания', disasters: 'катастрофа' },
};

export function newsLanguage(region: ProviderInput['region']): string {
  if (region.languages?.[0]) return region.languages[0].split('-')[0].toLowerCase();
  if (!region.countryCode) return 'en';
  try { return new Intl.Locale('und-' + region.countryCode).maximize().language; }
  catch { return 'en'; }
}

function localRegionName(region: ProviderInput['region'], language: string): string {
  if (region.subdivisionCode || !region.countryCode) return region.name;
  try { return new Intl.DisplayNames([language], { type: 'region' }).of(region.countryCode) || region.name; }
  catch { return region.name; }
}

export function isRecentPublication(publishedAt: string | undefined, now: Date): boolean {
  if (!publishedAt) return true;
  const date = Date.parse(publishedAt);
  return !Number.isFinite(date) || (date >= now.getTime() - 7 * 86_400_000 && date <= now.getTime() + 86_400_000);
}

/** 明示クエリは現地語・英語の2経路。無指定なら分野横断で初回検索する。 */
export function planNewsQueries(input: ProviderInput, providerId: string): NewsQuery[] {
  const language = newsLanguage(input.region);
  const localName = localRegionName(input.region, language);
  const requested = input.request.query?.trim();
  const custom = input.queries.find((item) => item.providerId === providerId && item.query !== input.region.name)?.query;
  if (requested) {
    return [...new Set([localName, input.region.name])].map((name) => ({
      query: [name, requested, 'when:7d'].filter(Boolean).join(' '), language,
      area: 'media_activity', facet: 'request',
    }));
  }
  if (custom) return [{ query: `${custom} when:7d`, language, area: 'media_activity', facet: 'request' }];
  const topics = new Set(input.request.topics ?? []);
  const selected: Facet[] = topics.size === 0
    ? ['economy', 'politics', 'tourism', 'health', 'disasters']
    : ([
      ['economy', ['economy', 'trade', 'business']],
      ['politics', ['politics', 'elections', 'diplomacy', 'security', 'military', 'protests', 'political_violence', 'foreign_relations']],
      ['tourism', ['tourism', 'travel', 'calendar', 'holidays', 'commemorations']],
      ['health', ['health', 'humanitarian', 'social_issues']],
      ['disasters', ['disasters']],
    ] as const).filter(([, matches]) => matches.some((topic) => topics.has(topic))).map(([facet]) => facet);
  const words = FACET_WORDS[language] ?? FACET_WORDS.en;
  const facetName = FACET_WORDS[language] ? localName : input.region.name;
  const facets = selected.map((facet) => ({
    query: `${facetName} ${words[facet]} when:7d`, language,
    area: facet, facet,
  }));
  return [...facets, { query: `${localName} when:7d`, language, area: 'media_activity', facet: 'general' }];
}
