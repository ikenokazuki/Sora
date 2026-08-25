import { getFromCache, setToCache, CACHE_TTL_DEFAULT } from '../cache.js';

export interface MusicItem {
  id: string;
  type: 'song' | 'album' | 'artist';
  title: string;
  artist: string;
  album?: string;
  artwork?: {
    thumbnail?: string; // 100x100
    highRes?: string;   // 600x600
  };
  previewUrl?: string;  // 30秒試聴音源 URL
  releaseDate?: string; // ISO 8601
  genre?: string;
  trackNumber?: number;
  trackTimeMillis?: number;
  url?: string;         // Apple Music / iTunes Web リンク
}

export interface MusicSearchResult {
  query: string;
  country: string;
  entity: string;
  attribute?: string;
  count: number;
  items: MusicItem[];
  source: 'itunes';
}

/** iTunes Search API による音楽・アルバム・アーティストメタデータ検索 (汎用) */
export async function searchMusic(options: {
  query: string;
  country?: string;
  entity?: 'song' | 'album' | 'musicArtist';
  attribute?: 'songTerm' | 'artistTerm' | 'albumTerm' | string;
  limit?: number;
  noCache?: boolean;
}): Promise<MusicSearchResult> {
  const query = options.query?.trim();
  if (!query) {
    throw new Error('query is required for music search');
  }

  const country = options.country || 'jp';
  const entity = options.entity || 'song';
  const attribute = options.attribute?.trim();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);

  const cacheKey = `music:${query}:${country}:${entity}:${attribute || 'all'}:${limit}`;
  if (!options.noCache) {
    const cached = getFromCache<MusicSearchResult>(cacheKey);
    if (cached) return cached;
  }

  let itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=${encodeURIComponent(country)}&entity=${encodeURIComponent(entity)}&limit=${limit}`;
  if (attribute) {
    itunesUrl += `&attribute=${encodeURIComponent(attribute)}`;
  }

  const res = await fetch(itunesUrl, {
    headers: { 'User-Agent': 'Sora-Music-Metadata-Fetcher/1.0' },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`iTunes Search API failed (HTTP ${res.status}): ${itunesUrl}`);
  }

  const data = await res.json() as any;
  const rawResults = Array.isArray(data?.results) ? data.results : [];

  const items: MusicItem[] = rawResults.map((r: any) => {
    const isSong = r.wrapperType === 'track' || r.kind === 'song';
    const isAlbum = r.wrapperType === 'collection' || entity === 'album';

    const thumb = r.artworkUrl100 || r.artworkUrl60;
    const highRes = thumb ? thumb.replace(/\/\d+x\d+bb\./, '/600x600bb.') : undefined;

    return {
      id: String(r.trackId || r.collectionId || r.artistId || ''),
      type: isSong ? 'song' : isAlbum ? 'album' : 'artist',
      title: r.trackName || r.collectionName || r.artistName || 'Unknown Title',
      artist: r.artistName || 'Unknown Artist',
      album: r.collectionName || undefined,
      artwork: thumb ? { thumbnail: thumb, highRes } : undefined,
      previewUrl: r.previewUrl || undefined,
      releaseDate: r.releaseDate || undefined,
      genre: r.primaryGenreName || undefined,
      trackNumber: typeof r.trackNumber === 'number' ? r.trackNumber : undefined,
      trackTimeMillis: typeof r.trackTimeMillis === 'number' ? r.trackTimeMillis : undefined,
      url: r.trackViewUrl || r.collectionViewUrl || r.artistViewUrl || undefined,
    };
  });

  const result: MusicSearchResult = {
    query,
    country,
    entity,
    ...(attribute ? { attribute } : {}),
    count: items.length,
    items,
    source: 'itunes',
  };

  if (!options.noCache) {
    setToCache(cacheKey, result, CACHE_TTL_DEFAULT);
  }

  return result;
}

/** 曲名指定での楽曲メタデータ検索 (iTunes attribute=songTerm) */
export async function searchSong(options: {
  query: string;
  country?: string;
  limit?: number;
  noCache?: boolean;
}): Promise<MusicSearchResult> {
  return searchMusic({
    ...options,
    entity: 'song',
    attribute: 'songTerm',
  });
}

/** アーティスト名指定での音楽メタデータ検索 (iTunes attribute=artistTerm または entity=musicArtist) */
export async function searchArtist(options: {
  query: string;
  country?: string;
  entity?: 'song' | 'album' | 'musicArtist';
  limit?: number;
  noCache?: boolean;
}): Promise<MusicSearchResult> {
  const entity = options.entity || 'song';
  return searchMusic({
    ...options,
    entity,
    ...(entity !== 'musicArtist' ? { attribute: 'artistTerm' } : {}),
  });
}

