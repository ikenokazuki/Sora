import { Hono } from 'hono';
import { SocialFetchInputSchema, SocialSearchInputSchema } from '../services/social/types.js';
import type { SocialService } from '../services/social/index.js';
import { formatError } from './utils.js';

export interface SocialRouteDeps {
  service?: SocialService;
}

async function loadProdService(): Promise<SocialService> {
  const { createSocialService } = await import('../services/social/index.js');
  const { createProdWeiboHttp, createProdMetaHttp, createProdMetaBrowser, createProdSessionOpener, createProdWebSearch } = await import('../services/social/transport.js');
  return createSocialService({
    weiboHttp: createProdWeiboHttp(),
    sessionOpener: createProdSessionOpener(),
    metaHttp: createProdMetaHttp(),
    metaBrowser: createProdMetaBrowser(),
    webSearch: createProdWebSearch(),
  });
}

export function createSocialRoutes(deps: SocialRouteDeps = {}) {
  const routes = new Hono();

  routes.post('/social/search', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
    }
    const parsed = SocialSearchInputSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      return formatError(c, 'Invalid social search parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
    }
    try {
      const service = deps.service ?? await loadProdService();
      const signal = AbortSignal.timeout(55000);
      return c.json(await service.search(parsed.data, { signal, deadlineAt: Date.now() + 55000 }));
    } catch (error) {
      return formatError(c, error instanceof Error ? error.message : 'Social search failed', 'SOCIAL_ERROR', 500);
    }
  });

  routes.post('/social/fetch', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
    }
    const parsed = SocialFetchInputSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      return formatError(c, 'Invalid social fetch parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
    }
    try {
      const service = deps.service ?? await loadProdService();
      const signal = AbortSignal.timeout(30000);
      return c.json(await service.fetch(parsed.data, { signal, deadlineAt: Date.now() + 30000 }));
    } catch (error) {
      return formatError(c, error instanceof Error ? error.message : 'Social fetch failed', 'SOCIAL_ERROR', 500);
    }
  });

  return routes;
}

export const socialRoutes = createSocialRoutes();
