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
}

export const GLOBAL_FEED_CATALOG: readonly SourceCatalogEntry[] = [
  { id: 'bbc-world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', publisher: 'BBC News', languages: ['en'], areas: ['media_activity', 'current_events'], sourceType: 'international_media', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only' },
  { id: 'un-news', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', publisher: 'UN News', languages: ['en'], areas: ['humanitarian', 'current_events'], sourceType: 'official', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only' },
  { id: 'ecb-press', url: 'https://www.ecb.europa.eu/rss/press.html', publisher: 'European Central Bank', languages: ['en'], areas: ['economy', 'business'], sourceType: 'official', verificationBasis: 'live_probe_2026_09_22', pollIntervalMs: 300_000, contentPolicy: 'excerpt_only' },
];
