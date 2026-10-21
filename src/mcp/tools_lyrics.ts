import { z } from 'zod';
import { errorMessage } from '../errors.js';
import { getLyrics } from '../services/lyrics.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🎤 Category 12: Lyrics (モジュール: 'lyrics'。ENABLED_MODULES に名前を挙げたときだけ有効な、自己責任の機能) */
export function registerLyricsTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 51: get_lyrics (歌手・曲名から歌詞全文) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_lyrics',
    'lyrics',
    '【歌詞全文・自己責任】歌手／グループ名と曲名から歌詞全文を取得します（API キー不要）。まず LRCLIB（利用者投稿の歌詞データベース）、無ければ TuneCore Japan の LinkCore（地下アイドル・インディーズ）を引きます。歌詞は著作物です。個人利用の範囲で使い、再配布・公開しないでください。LRCLIB に無い曲を TuneCore で探すには artist が必須です。found が false のときは reason（no-match / no-lyrics-registered / search-unavailable）と candidates を見て、表記を直して再実行してください。返却: { found, track, lyrics, source, sourceUrl, reason, candidates, notice }',
    {
      title: z.string().min(1).describe('曲名 (例: "夜に駆ける")'),
      artist: z.string().optional().describe('歌手・グループ名。省略できるが、LRCLIB に無い曲（地下アイドル・インディーズ）を TuneCore で探すときは必須'),
      noCache: z.boolean().optional().describe('キャッシュをバイパスするか').meta({ default: false }),
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
    { defaultEnabled: deferredDefault, keywords: ['歌詞', '歌詞全文', 'リリック', 'lyrics', 'lyric'] },
  );
}
