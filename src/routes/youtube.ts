import { Hono } from 'hono';
import type { Context } from 'hono';
import type { z } from 'zod';
import { errorMessage } from '../errors.js';
import { getYoutubeChannel, getYoutubeTranscript, YoutubeInputError } from '../services/youtube.js';
import { YoutubeChannelRequestSchema, YoutubeTranscriptRequestSchema } from '../types.js';
import { formatError } from './utils.js';

/** 本文を検証して run を呼ぶ。入力の誤りは 400、YouTube の側の失敗（同意の画面・ブロック・通信）は再試行できる 502。 */
const handle = <S extends z.ZodType>(schema: S, run: (input: z.infer<S>) => Promise<unknown>) => async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }
  try {
    return c.json(await run(parsed.data));
  } catch (err) {
    if (err instanceof YoutubeInputError) return formatError(c, err.message, 'INVALID_INPUT', 400, false);
    return formatError(c, errorMessage(err) || 'YouTube lookup failed', 'YOUTUBE_UPSTREAM_ERROR', 502, true);
  }
};

/**
 * YouTube の動画の字幕・説明文 (POST /youtube/transcript) と、チャンネルの最新動画 (POST /youtube/channel)。
 * 動画・チャンネルが見つからない場合と字幕なしも 200 で返す。
 */
export function createYoutubeRoutes(run: typeof getYoutubeTranscript = getYoutubeTranscript, runChannel: typeof getYoutubeChannel = getYoutubeChannel) {
  const routes = new Hono();
  routes.post('/youtube/transcript', handle(YoutubeTranscriptRequestSchema, (input) => run(input)));
  routes.post('/youtube/channel', handle(YoutubeChannelRequestSchema, (input) => runChannel(input)));
  return routes;
}

export const youtubeRoutes = createYoutubeRoutes();
