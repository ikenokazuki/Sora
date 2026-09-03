import { Hono } from 'hono';
import { executeBrowserActions } from '../scraper.js';
import { BrowserActionRequestSchema } from '../types.js';
import { extractAuthToken } from '../auth.js';
import { formatError } from './utils.js';

export const browserRoutes = new Hono();

// 対話型ブラウザ自動操作 (POST /browser/action & POST /action)
export const handleBrowserAction = async (c: any) => {
  let rawBody: any;
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
    const result = await executeBrowserActions({
      url: body.url,
      sessionId: body.sessionId,
      ownerToken: extractAuthToken(c),
      createSession: body.createSession,
      closeSession: body.closeSession,
      actions: body.actions,
      extract: body.extract,
      timeout: body.timeout,
    });

    return c.json(result);
  } catch (err: any) {
    const msg = err.message || 'Browser action failed';
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
