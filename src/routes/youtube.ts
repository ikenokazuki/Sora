import { Hono } from 'hono';
import { errorMessage } from '../errors.js';
import { getYoutubeTranscript, YoutubeInputError } from '../services/youtube.js';
import { YoutubeTranscriptRequestSchema } from '../types.js';
import { formatError } from './utils.js';

/** YouTube の動画の字幕・説明文 (POST /youtube/transcript)。動画が見つからない場合と字幕なしも 200 で返す。 */
export function createYoutubeRoutes(run: typeof getYoutubeTranscript = getYoutubeTranscript) {
  const routes = new Hono();
  routes.post('/youtube/transcript', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
    }
    const parsed = YoutubeTranscriptRequestSchema.safeParse(rawBody);
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
  });
  return routes;
}

export const youtubeRoutes = createYoutubeRoutes();
