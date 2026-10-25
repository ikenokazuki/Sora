import { errorMessage } from '../errors.js';
import { getYoutubeTranscript } from '../services/youtube.js';
import { YoutubeTranscriptRequestSchema } from '../types.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🎬 Category 13: YouTube (モジュール: 'youtube'。動画の字幕・説明文。要約は呼び出し側の AI が書く) */
export function registerYoutubeTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 52: get_youtube_transcript (YouTube の字幕・説明文) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'get_youtube_transcript',
    'youtube',
    '【YouTube 動画の字幕・説明文】YouTube の URL か動画 ID から、題名・投稿者・公開日・長さ・説明文・チャプターと、時刻つきの字幕（手動の字幕、無ければ YouTube の自動字幕）を取得します。動画の要約・内容の抽出・何分に何と言ったかの確認に使います。自動字幕は音声認識なので誤りを含みます。transcript.status が ok 以外（字幕なし・配信中・取得失敗）のときは、話の中身を推測せず題名と説明文だけで答えてください。長い動画は nextFromSec を fromSec に渡して続きを読みます。返却: { found, videoId, title, channel, publishedAt, durationSec, description, chapters, requestedStartSec, transcript: { status, reason, message, source, note, text, truncated, nextFromSec }, availableTracks }',
    YoutubeTranscriptRequestSchema.shape,
    async (opts) => {
      try {
        return { content: [{ type: 'text', text: toolJson(await getYoutubeTranscript(opts)) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `YouTube error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['YouTube', 'ユーチューブ', '動画', '字幕', '自動字幕', '文字起こし', '要約', 'transcript', 'captions', 'youtu.be'] },
  );
}
