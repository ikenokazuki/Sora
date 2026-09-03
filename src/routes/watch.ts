import { Hono } from 'hono';
import {
  registerWatchTarget,
  checkWatchTarget,
  checkAllWatchTargets,
  listWatchTargets,
  deleteWatchTarget,
} from '../scraper.js';
import {
  WatchRegisterRequestSchema,
  WatchCheckRequestSchema,
} from '../types.js';
import { formatError } from './utils.js';

export const watchRoutes = new Hono();

// 監視ターゲット登録 (POST /watch/register)
watchRoutes.post('/watch/register', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = WatchRegisterRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid watch register parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await registerWatchTarget(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Watch target registration failed', 'WATCH_ERROR', 500);
  }
});

// 差分スキャン実行 (POST /watch/check)
watchRoutes.post('/watch/check', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = WatchCheckRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid watch check parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = parsed.data.id
      ? await checkWatchTarget(parsed.data.id)
      : await checkAllWatchTargets();
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Watch check failed', 'WATCH_ERROR', 500);
  }
});

// 監視ターゲット一覧 (GET /watch/list)
watchRoutes.get('/watch/list', (c) => {
  try {
    const targets = listWatchTargets();
    return c.json({ count: targets.length, targets });
  } catch (err: any) {
    return formatError(c, err.message || 'Watch list failed', 'WATCH_ERROR', 500);
  }
});

// 監視ターゲット削除 (DELETE /watch/:id)
watchRoutes.delete('/watch/:id', (c) => {
  const id = c.req.param('id');
  if (!id) {
    return formatError(c, 'Target id is required', 'INVALID_INPUT', 400);
  }
  const deleted = deleteWatchTarget(id);
  return c.json({ success: deleted, id });
});
