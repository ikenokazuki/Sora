import { errorMessage } from '../errors.js';
import { recognizeSong } from '../services/song_recognition.js';
import { SongRecognitionRequestSchema } from '../types.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🎧 Category 14: Song Recognition (モジュール: 'shazam'。ENABLED_MODULES に名前を挙げたときだけ有効。Shazam の iPhone アプリと同じ窓口を使う) */
export function registerShazamTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // recognize_song (音から曲を特定し、iTunes の曲とつなぐ) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'recognize_song',
    'shazam',
    '【楽曲認識・Shazam】音声・動画ファイルの URL から、流れている曲を Shazam で特定し、iTunes の曲（search_song と同じ形。id は trackId、ジャケット・30 秒試聴 URL・Apple Music のリンク）とつないで返します。mp3・m4a・wav・ogg・webm・flac・mp4 など 20 MB まで。YouTube などの動画のページの URL は読めません。offsetSec を省略すると、長い音は真ん中、続けて先頭から 12 秒ずつ、最大 3 回試します。found が false のときは reason（no-match / not-audio / too-short / too-large / download-failed）と message に従い、曲名を推測で答えないでください。match.uncertain が true の当たりは別の曲のことがあるので、確かではないと伝えてください。返却: { found, reason, message, itunes, itunesMatch, shazam, match, attempts, audio }',
    SongRecognitionRequestSchema.shape,
    async (opts) => {
      try {
        return { content: [{ type: 'text', text: toolJson(await recognizeSong(opts)) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Song recognition error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['楽曲認識', '曲の特定', '曲名を当てる', '何の曲', 'この曲', '音楽認識', 'Shazam', 'シャザム'] },
  );
}
