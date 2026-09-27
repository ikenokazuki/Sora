import { Hono } from 'hono';
import { CountryContextRequestSchema } from '../services/country_intel/types.js';
import { getEvidencePage, getContextUpdates } from '../services/country_intel/db.js';
import { getPersistedCountryContext, normalizeCountryRequest, type researchCountryContext } from '../services/country_intel/report.js';
import { researchCountryWithDefaults } from '../services/country_intel/runtime.js';
import { formatError } from './utils.js';

export interface IntelligenceRouteDeps {
  research?: typeof researchCountryContext;
  retrieve?: typeof getPersistedCountryContext;
  page?: typeof getEvidencePage;
  updates?: typeof getContextUpdates;
}

export function createIntelligenceRoutes(deps: IntelligenceRouteDeps = {}) {
  const research = deps.research ?? researchCountryWithDefaults;
  const retrieve = deps.retrieve ?? getPersistedCountryContext;
  const page = deps.page ?? getEvidencePage;
  const updates = deps.updates ?? getContextUpdates;
  const routes = new Hono();

  routes.post('/intelligence/country', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
    }
    const parsed = CountryContextRequestSchema.safeParse(
      normalizeCountryRequest((rawBody ?? {}) as never),
    );
    if (!parsed.success) {
      return formatError(c, 'Invalid country context parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
    }
    try {
      return c.json(await research(parsed.data));
    } catch (error) {
      return formatError(c, error instanceof Error ? error.message : 'Country context failed', 'INTEL_ERROR', 500);
    }
  });

  routes.get('/intelligence/context/:contextId', async (c) => {
    try {
      const report = retrieve(c.req.param('contextId'));
      if (!report) return formatError(c, 'Country context not found', 'NOT_FOUND', 404, false);
      return c.json(report);
    } catch (error) {
      return formatError(c, error instanceof Error ? error.message : 'Country context retrieval failed', 'INTEL_ERROR', 500);
    }
  });

  routes.get('/intelligence/context/:contextId/evidence', async (c) => {
    try {
      const ids = c.req.query('ids')?.split(',').map((id) => id.trim()).filter(Boolean);
      const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        return formatError(c, 'Invalid limit (1-100)', 'INVALID_INPUT', 400, false);
      }
      return c.json(page(c.req.param('contextId'), { ids, cursor: c.req.query('cursor'), limit }));
    } catch (error) {
      return formatError(c, error instanceof Error ? error.message : 'Evidence page failed', 'INTEL_ERROR', 500);
    }
  });

  routes.get('/intelligence/context/:contextId/updates', async (c) => {
    try {
      return c.json(updates(c.req.param('contextId'), c.req.query('cursor')));
    } catch (error) {
      return formatError(c, error instanceof Error ? error.message : 'Context updates failed', 'INTEL_ERROR', 500);
    }
  });

  return routes;
}

export const intelligenceRoutes = createIntelligenceRoutes();
