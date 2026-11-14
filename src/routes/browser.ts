import { Hono, type Context } from 'hono';
import { executeBrowserActions } from '../scraper.js';
import { BrowserActionRequestSchema } from '../types.js';
import { extractAuthToken } from '../auth.js';
import { busyResponse, formatError } from './utils.js';
import { errorMessage, ScrapeInputError } from '../errors.js';

export const browserRoutes = new Hono();

// 対話型ブラウザ自動操作 (POST /browser/action & POST /action)
export const handleBrowserAction = async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = BrowserActionRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid browser action parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  const body = parsed.data;
  if (!body.url && !body.sessionId) {
    return formatError(c, 'url or sessionId is required', 'INVALID_INPUT', 400, false);
  }

  try {
    const tenant = c.get('tenant');
    const tenantId = tenant?.tenantId ?? 'legacy';
    const result = await executeBrowserActions({
      url: body.url,
      sessionId: body.sessionId,
      // 名前つきの鍵（鍵ファイル）の tenant は、鍵の値でなく tenant で持ち主を確かめる（セッションは tenant に結び付く）。
      // 鍵の値を持ち主にすると、同じ tenant の別の鍵（鍵の入れ替えの移行期）で、自分のセッションを続けられなくなる
      ownerToken: tenant?.name ? undefined : extractAuthToken(c),
      tenantId,
      createSession: body.createSession,
      closeSession: body.closeSession,
      actions: body.actions,
      extract: body.extract,
      timeout: body.timeout,
    });

    return c.json(result);
  } catch (err) {
    const busy = busyResponse(c, err);
    if (busy) return busy;
    const msg = errorMessage(err) || 'Browser action failed';
    if (err instanceof ScrapeInputError) return formatError(c, msg, 'INVALID_INPUT', 400, false);
    const isForbidden = msg.includes('Forbidden') || msg.includes('permission');
    const isSecurity = isForbidden || msg.includes('private or blocked') || msg.includes('遮断');
    const isTimeout = msg.includes('timeout') || msg.includes('タイムアウト');
    const code = isForbidden ? 'FORBIDDEN' : isSecurity ? 'SSRF_BLOCKED' : isTimeout ? 'TIMEOUT' : 'BROWSER_ERROR';
    const status = isSecurity ? 403 : isTimeout ? 408 : 500;
    return formatError(c, msg, code, status, !isSecurity);
  }
};

browserRoutes.post('/browser/action', handleBrowserAction);
browserRoutes.post('/action', handleBrowserAction);
