import { z } from 'zod';
import { errorMessage } from '../errors.js';
import { classifyYoutubeUrl, getYoutubeChannel, getYoutubeTranscript } from '../services/youtube.js';
import { DEFAULT_MAX_CHARS, YoutubeChannelRequestSchema, YoutubeTranscriptRequestSchema } from '../types.js';
import { onlyForMode, usageError } from './args.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🎬 Category 13: YouTube (モジュール: 'youtube'。動画の字幕・説明文と、チャンネルの最新動画。要約は呼び出し側の AI が書く) */
export function registerYoutubeTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool: get_youtube (動画の字幕・説明文か、チャンネルの最新動画。url の形で判別) - DEFERRED
  const YOUTUBE_USAGE = '使い方: url に動画（watch・youtu.be・shorts・live・embed の URL か 11 文字の動画 ID）を渡すと字幕と説明文（lang・fromSec・maxChars）、チャンネル（/@ハンドル・/channel/UC…・/c/名前・/user/名前 の URL、@ハンドル、UC… の ID）を渡すと最新の動画（limit）。';
  // onlyForMode に渡す語句。エラーの文にそのまま出る。入力の形で言う
  const VIDEO = 'url が動画のとき';
  const CHANNEL = 'url がチャンネルのとき';
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_youtube',
    'youtube',
    '【YouTube 動画の字幕・チャンネルの最新動画】url の形で判別します。動画（URL か動画 ID）: 題名・投稿者・公開日・長さ・説明文・チャプターと、時刻つきの字幕（手動の字幕、無ければ YouTube の自動字幕）を取得します。動画の要約・内容の抽出・何分に何と言ったかの確認に使います。自動字幕は音声認識なので誤りを含みます。transcript.status が ok 以外（字幕なし・配信中・取得失敗）のときは、話の中身を推測せず題名と説明文だけで答えてください。長い動画は nextFromSec を fromSec に渡して続きを読みます。チャンネル（URL・@ハンドル・UC… の ID）: 最新の動画（題名・公開日・説明文の先頭・視聴回数）を新しい順に最大 15 件。Yahoo の検索は使いません。動画の中身は、返った videoId を url に渡して読みます。チャンネルが無いときは found が false。返却: mode（video / channel）と、video は { found, videoId, title, channel, publishedAt, durationSec, description, chapters, requestedStartSec, transcript: { status, reason, message, source, note, text, truncated, nextFromSec }, availableTracks }、channel は { found, channelId, title, url, videos: [{ videoId, url, title, publishedAt, updatedAt, description, views }] }',
    {
      url: z.string().min(1, 'url は必須です').describe('動画: URL (watch・youtu.be・shorts・live・embed) か 11 文字の動画 ID。URL の t= は requestedStartSec として返す。チャンネル: URL (/@ハンドル・/channel/UC…・/c/名前・/user/名前)、@ハンドル、UC で始まる 24 文字のチャンネル ID'),
      lang: YoutubeTranscriptRequestSchema.shape.lang.describe('字幕の言語 (デフォルト: "ja")。この言語の手動字幕、自動字幕の順に選び、無ければ他の言語。動画のときだけ'),
      fromSec: YoutubeTranscriptRequestSchema.shape.fromSec.describe('この秒から返す (デフォルト: 0。続きは nextFromSec を渡す)。動画のときだけ'),
      maxChars: YoutubeTranscriptRequestSchema.shape.maxChars.describe(`返す字幕の最大文字数 (デフォルト: ${DEFAULT_MAX_CHARS})。動画のときだけ`),
      limit: YoutubeChannelRequestSchema.shape.limit.describe('返す動画の最大数 (デフォルト: 10, 最大: 15)。チャンネルのときだけ'),
      noCache: YoutubeTranscriptRequestSchema.shape.noCache,
    },
    async (args) => {
      const { url, lang, fromSec, maxChars, limit, noCache } = args;
      const kind = classifyYoutubeUrl(url);
      if (!kind) return usageError(`url が YouTube の動画でもチャンネルでもありません。${YOUTUBE_USAGE}`);
      const mode = kind === 'video' ? VIDEO : CHANNEL;
      const invalid = onlyForMode(mode, [VIDEO], args, ['lang', 'fromSec', 'maxChars'], YOUTUBE_USAGE, { lang: 'ja', fromSec: 0, maxChars: DEFAULT_MAX_CHARS })
        ?? onlyForMode(mode, [CHANNEL], args, ['limit'], YOUTUBE_USAGE, { limit: 10 });
      if (invalid) return usageError(invalid);
      // 応答とエラーの文は、統合前の 2 ツールのまま（REST の 2 ルートと同じサービス）。mode を足す
      try {
        const result = kind === 'video'
          ? await getYoutubeTranscript({ url, lang, fromSec, maxChars, noCache })
          : await getYoutubeChannel({ url, limit, noCache });
        return { content: [{ type: 'text', text: toolJson({ mode: kind, ...result }) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `YouTube error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['YouTube', 'ユーチューブ', '動画', '字幕', '自動字幕', '文字起こし', '要約', 'transcript', 'captions', 'youtu.be', 'チャンネル', 'channel', '新着', '最新動画', '新着動画', '動画一覧', '投稿', 'ハンドル', 'RSS', 'get_youtube_transcript', 'get_youtube_channel'] },
  );
}
