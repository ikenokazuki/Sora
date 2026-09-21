import { Hono } from 'hono';
import { CountryContextRequestSchema } from '../services/country_intel/types.js';
import { getPersistedCountryContext, normalizeCountryRequest, type researchCountryContext } from '../services/country_intel/report.js';
import { researchCountryWithDefaults } from '../services/country_intel/runtime.js';
import { formatError } from './utils.js';

export interface IntelligenceRouteDeps {
  research?: typeof researchCountryContext;
  retrieve?: typeof getPersistedCountryContext;
}

export function createIntelligenceRoutes(deps: IntelligenceRouteDeps = {}) {
  const research = deps.research ?? researchCountryWithDefaults;
  const retrieve = deps.retrieve ?? getPersistedCountryContext;
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

  return routes;
}

export const intelligenceRoutes = createIntelligenceRoutes();
