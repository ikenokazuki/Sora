import { z } from 'zod';
import { searchMusic } from '../scraper.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🎵 Category 7: Music Metadata (モジュール: 'music') */
export function registerMusicTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 24: search_music (iTunes の楽曲・アルバム・アーティスト検索。曲名・アーティスト名は attribute で) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_music',
    'music',
    '【iTunes公式直結】楽曲・アルバム・アーティストをiTunes公式メタデータから検索し、正確な曲名、高解像度ジャケット画像、30秒試聴音源URL、アーティスト名、リリース日、Apple Musicリンクを返します。曲名で探すときは attribute: "songTerm"。アーティストの代表曲・アルバムは attribute: "artistTerm" と entity: "song" / "album"、アーティスト基本情報は entity: "musicArtist"（attribute なし）。※公式カタログのメタデータです。ライブ・公演日程や最新の出演スケジュール・最新活動情報は search_deep または search_realtime を使用してください。返却: { query, country, entity, attribute?, count, items: [{ title, artist, previewUrl, artwork }], source }',
    {
      query: z.string().min(1).describe('検索キーワード (曲名、アーティスト名、アルバム名の自由入力)'),
      country: z.string().optional().describe('国コード (デフォルト: "jp")').meta({ default: 'jp' }),
      entity: z.enum(['song', 'album', 'musicArtist']).optional().describe('検索エンティティ: "song", "album", "musicArtist" (デフォルト: "song")').meta({ default: 'song' }),
      attribute: z.enum(['songTerm', 'artistTerm', 'albumTerm']).optional().describe('属性絞り込み: "songTerm" (曲名), "artistTerm" (アーティスト名), "albumTerm" (アルバム名)'),
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)').meta({ default: 20 }),
    },
    async (opts) => {
      try {
        const result = await searchMusic(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Music search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['汎用音楽検索', '音楽検索', '音楽', '楽曲', '曲', 'アルバム', 'iTunes', 'ミュージック', '楽曲検索', '曲名', '曲の検索', '歌', 'ソング', 'Apple Music', 'アーティスト検索', 'アーティスト', 'ディスコグラフィ', '歌手', 'バンド', 'ミュージシャン', 'search_song', 'search_artist'] },
  );
}
