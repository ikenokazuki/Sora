import { Hono } from 'hono';
import { errorMessage } from '../errors.js';
import { isModuleActive } from '../mcp/registry.js';
import { recognizeSong, SongRecognitionInputError, type SongRecognitionOptions } from '../services/song_recognition.js';
import { SongRecognitionFormSchema, SongRecognitionRequestSchema } from '../types.js';
import { formatError } from './utils.js';

/**
 * 音から曲を特定する (POST /music/recognize)。JSON の url か、multipart/form-data の file を受け取る。
 * モジュール 'shazam' を ENABLED_MODULES に名前で挙げたときだけ応答する。特定できない場合も 200 で found: false。
 */
export function createSongRecognitionRoutes(run: (input: SongRecognitionOptions) => Promise<unknown> = recognizeSong) {
  const routes = new Hono();
  routes.post('/music/recognize', async (c) => {
    if (!isModuleActive('shazam')) {
      return formatError(c, 'shazam module is not enabled. Add it to ENABLED_MODULES by name (e.g. ENABLED_MODULES=all,shazam); "all" alone does not include it.', 'MODULE_DISABLED', 404, false);
    }
    let input: SongRecognitionOptions;
    if ((c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
      let form: Record<string, string | File>;
      try {
        form = (await c.req.parseBody()) as Record<string, string | File>;
      } catch {
        return formatError(c, 'Invalid multipart body', 'INVALID_INPUT', 400, false);
      }
      const file = form.file;
      if (!(file instanceof File) || file.size === 0) return formatError(c, 'file: 音声・動画ファイルを付けてください', 'INVALID_INPUT', 400, false);
      const fields = SongRecognitionFormSchema.safeParse({ offsetSec: form.offsetSec, country: form.country, noCache: form.noCache });
      if (!fields.success) {
        const issue = fields.error.issues[0];
        return formatError(c, issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid form fields', 'INVALID_INPUT', 400, false, fields.error.format());
      }
      input = { ...fields.data, audio: { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type } };
    } else {
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
      }
      const parsed = SongRecognitionRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return formatError(c, issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required', 'INVALID_INPUT', 400, false, parsed.error.format());
      }
      input = parsed.data;
    }
    try {
      return c.json(await run(input));
    } catch (err) {
      if (err instanceof SongRecognitionInputError) return formatError(c, err.message, 'INVALID_INPUT', 400, false);
      return formatError(c, errorMessage(err) || 'Song recognition failed', 'SONG_RECOGNITION_UPSTREAM_ERROR', 502, true);
    }
  });
  return routes;
}

export const songRecognitionRoutes = createSongRecognitionRoutes();
