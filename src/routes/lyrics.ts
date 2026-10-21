import { Hono } from 'hono';
import { errorMessage } from '../errors.js';
import { isModuleActive } from '../mcp/registry.js';
import { getLyrics } from '../services/lyrics.js';
import { LyricsRequestSchema } from '../types.js';
import { formatError } from './utils.js';

/** 歌詞全文の取得 (POST /lyrics)。モジュール 'lyrics' を ENABLED_MODULES に名前で挙げたときだけ応答する。 */
export function createLyricsRoutes(run: typeof getLyrics = getLyrics) {
  const routes = new Hono();
  routes.post('/lyrics', async (c) => {
    if (!isModuleActive('lyrics')) {
      return formatError(c, 'lyrics module is not enabled. Add it to ENABLED_MODULES by name (e.g. ENABLED_MODULES=all,lyrics); "all" alone does not include it.', 'MODULE_DISABLED', 404, false);
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
    }
    const parsed = LyricsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return formatError(c, 'title is required for lyrics', 'INVALID_INPUT', 400, false, parsed.error.format());
    }
    try {
      return c.json(await run(parsed.data));
    } catch (err) {
      return formatError(c, errorMessage(err) || 'Lyrics lookup failed', 'LYRICS_UPSTREAM_ERROR', 502, true);
    }
  });
  return routes;
}

export const lyricsRoutes = createLyricsRoutes();
