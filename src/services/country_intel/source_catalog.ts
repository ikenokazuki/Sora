export type FeedSourceType = 'official' | 'international_media';

export interface SourceCatalogEntry {
  id: string;
  url: string;
  publisher: string;
  languages: string[];
  areas: string[];
  sourceType: FeedSourceType;
  verificationBasis: string;
  pollIntervalMs: number;
  contentPolicy: 'excerpt_only';
  /** 対象国コード（ISO alpha2）。空・省略時は全地域共通。 */
  countryCodes?: readonly string[];
}

export const GLOBAL_FEED_CATALOG: readonly SourceCatalogEntry[] = [
  { id: 'bbc-world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', publisher: 'BBC News', languages: ['en'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only' },
  { id: 'un-news', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', publisher: 'UN News', languages: ['en'], areas: ['humanitarian', 'current_events'], sourceType: 'official', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only' },
  { id: 'ecb-press', url: 'https://www.ecb.europa.eu/rss/press.html', publisher: 'European Central Bank', languages: ['en'], areas: ['economy', 'business'], sourceType: 'official', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only' },
  { id: 'aljazeera-all', url: 'https://www.aljazeera.com/xml/rss/all.xml', publisher: 'Al Jazeera', languages: ['en'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['QA', 'SA', 'AE', 'EG', 'TR', 'IR', 'IL', 'PS'] },
  { id: 'dw-top', url: 'https://rss.dw.com/rdf/rss-en-top', publisher: 'Deutsche Welle', languages: ['en'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['DE', 'FR', 'GB', 'IT', 'ES', 'PL', 'UA'] },
  { id: 'france24-en', url: 'https://www.france24.com/en/rss', publisher: 'France 24', languages: ['en'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['FR', 'BE', 'CH', 'CA', 'SN', 'CI'] },
  { id: 'cbc-top', url: 'https://www.cbc.ca/webfeed/rss/rss-topstories', publisher: 'CBC News', languages: ['en'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['CA', 'US'] },
  { id: 'abc-au-top', url: 'https://www.abc.net.au/news/feed/51120/rss.xml', publisher: 'ABC News (AU)', languages: ['en'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['AU', 'NZ', 'PG', 'FJ'] },
  { id: 'ndtv-latest', url: 'https://feeds.feedburner.com/NDTV-LatestNews', publisher: 'NDTV', languages: ['en'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['IN', 'PK', 'BD', 'LK', 'NP'] },
  { id: 'yonhap-en', url: 'https://en.yna.co.kr/RSS/news.xml', publisher: 'Yonhap News Agency', languages: ['en', 'ko'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['KR', 'KP', 'JP', 'CN'] },
  { id: 'scmp-hk', url: 'https://www.scmp.com/rss/91/feed', publisher: 'South China Morning Post', languages: ['en'], areas: ['media_activity', 'current_events', 'economy'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['CN', 'HK', 'TW', 'MO'] },
  { id: 'st-asia', url: 'https://www.straitstimes.com/news/asia/rss.xml', publisher: 'The Straits Times', languages: ['en'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['SG', 'MY', 'TH', 'VN', 'ID', 'PH'] },
  { id: 'nikkei-asia', url: 'https://asia.nikkei.com/rss/feed/nar', publisher: 'Nikkei Asia', languages: ['en'], areas: ['economy', 'business', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only', countryCodes: ['JP', 'CN', 'KR', 'TW'] },
];
