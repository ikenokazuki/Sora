import { z } from 'zod';
import { getLyrics, searchArtist, searchMusic, searchSong } from '../scraper.js';
import { errorMessage } from '../errors.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🎵 Category 7: Music Metadata (モジュール: 'music') */
export function registerMusicTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 22: search_song (iTunes 曲名指定 楽曲メタデータ検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_song',
    'music',
    '【iTunes公式直結】楽曲タイトル（曲名）を指定して、iTunes公式メタデータ（正確な曲名、高解像度ジャケット画像、30秒試聴音源URL、アーティスト名、リリース日、Apple Musicリンク）をピンポイント検索します。返却: { query, country, count, items: [{ title, artist, previewUrl, artwork }], source }',
    {
      query: z.string().min(1).describe('検索曲名・楽曲タイトル (例: "アイドル", "夜に駆ける", "Subtitle")'),
      country: z.string().optional().describe('国コード (デフォルト: "jp")').meta({ default: 'jp' }),
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)').meta({ default: 20 }),
    },
    async (opts) => {
      try {
        const result = await searchSong(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Artist search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['楽曲検索', '楽曲', '曲名', '曲の検索', '曲', '歌', 'ソング', 'iTunes', '音楽', 'Apple Music', 'ミュージック'] },
  );

  // Tool 23: search_artist (iTunes アーティスト名指定 音楽・アルバム・アーティスト検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_artist',
    'music',
    '【iTunes公式直結】アーティスト名を指定して、公式メタデータから指定アーティストの代表曲一覧、アルバム一覧、アーティスト基本情報（Apple Musicリンク等）を正確に取得します。※歌手・アーティスト公式カタログメタデータを検索します。ライブ・公演日程や最新の出演スケジュール・最新活動情報は search_deep または search_realtime を使用してください。返却: { query, country, count, items, source }',
    {
      query: z.string().min(1).describe('アーティスト名 (例: "YOASOBI", "Official髭男dism", "Ado")'),
      country: z.string().optional().describe('国コード (デフォルト: "jp")').meta({ default: 'jp' }),
      entity: z.enum(['song', 'album', 'musicArtist']).optional().describe('検索エンティティ: "song" (楽曲一覧), "album" (アルバム一覧), "musicArtist" (アーティスト情報) (デフォルト: "song")').meta({ default: 'song' }),
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)').meta({ default: 20 }),
    },
    async (opts) => {
      try {
        const result = await searchArtist(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Artist search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['アーティスト検索', 'アーティスト', 'ディスコグラフィ', '歌手', 'バンド', 'ミュージシャン', 'iTunes', 'アルバム'] },
  );

  // Tool 24: search_music (iTunes 音楽・アルバム・アーティスト汎用検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_music',
    'music',
    '【iTunes公式直結】楽曲・アルバム・アーティストの複合キーワード全文検索をiTunes公式メタデータに対して行います（曲名・アーティスト名が明確な場合は search_song / search_artist を推奨）。返却: { query, country, entity, count, items, source }',
    {
      query: z.string().min(1).describe('検索キーワード (曲名、アーティスト名、アルバム名の自由入力)'),
      country: z.string().optional().describe('国コード (デフォルト: "jp")').meta({ default: 'jp' }),
      entity: z.enum(['song', 'album', 'musicArtist']).optional().describe('検索エンティティ: "song", "album", "musicArtist" (デフォルト: "song")').meta({ default: 'song' }),
      attribute: z.enum(['songTerm', 'artistTerm', 'albumTerm']).or(z.string()).optional().describe('属性絞り込み: "songTerm" (曲名), "artistTerm" (アーティスト名), "albumTerm" (アルバム名)'),
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
    { defaultEnabled: deferredDefault, keywords: ['汎用音楽検索', '音楽検索', '音楽', '楽曲', '曲', 'アルバム', 'iTunes', 'ミュージック'] },
  );

  // Tool 25: get_lyrics (Uta-Net 曲名指定 歌詞全文取得) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_lyrics',
    'music',
    '【Uta-Net直結】曲名（任意でアーティスト名）を指定して歌詞全文・作詞者・作曲者を取得します。歌詞は著作物のため、取得結果の利用は利用者の責任で行ってください。同名曲が複数ある場合は artist で絞るか candidates から pick を指定します。返却: { query, title, artist, lyricist, composer, lyrics, url, source, candidates }',
    {
      query: z.string().min(1).describe('曲名 (例: "夜に駆ける")'),
      artist: z.string().optional().describe('アーティスト名 (同名曲の絞り込み)'),
      pick: z.number().int().min(0).max(9).optional().describe('候補の何番目を取得するか (0始まり, デフォルト: 0)').meta({ default: 0 }),
    },
    async (opts) => {
      try {
        const result = await getLyrics(opts);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Lyrics error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['歌詞', '歌詞検索', 'リリック', 'lyrics', '作詞', '作曲'] },
  );
}
