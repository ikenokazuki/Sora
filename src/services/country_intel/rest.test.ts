import { describe, expect, test } from 'bun:test';
import { createIntelligenceRoutes } from '../../routes/intelligence.js';

const report = {
  contextId: 'ctx-1', region: { id: 'KOR', name: 'South Korea', countryCode: 'KR', languages: ['ko'], aliases: [], confidence: 'high' as const },
  asOf: '2026-09-19T00:00:00Z',
  situation: { politics: { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] }, economy: { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] }, security: { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] }, disasters: { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] }, health: { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] }, humanitarian: { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] }, social: { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] } },
  elections: [], calendar: [], foreignRelations: [], polls: [], keyEvents: [], temporalMetrics: [], providerCoverage: [],
  coverage: { overall: 'good' as const, byArea: { politics: 'good' as const, economy: 'good' as const, security: 'good' as const, disaster: 'good' as const, health: 'good' as const, polls: 'good' as const, media: 'good' as const, social: 'good' as const, calendar: 'good' as const, foreignRelations: 'good' as const }, missingEvidence: [], unavailableProviders: [] },
  evidence: [],
};

describe('intelligence REST', () => {
  test('POST generates and GET retrieves the same report', async () => {
    const app = createIntelligenceRoutes({ research: (async () => report) as never, retrieve: (() => report) as never });
    const created = await app.request('/intelligence/country', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ region: 'South Korea' }) });
    expect(created.status).toBe(200);
    expect((await created.json() as { contextId: string }).contextId).toBe('ctx-1');
    const fetched = await app.request('/intelligence/context/ctx-1');
    expect(fetched.status).toBe(200);
    expect((await fetched.json() as { contextId: string }).contextId).toBe('ctx-1');
  });
  test('POST rejects invalid input and GET 404s unknown ids', async () => {
    const app = createIntelligenceRoutes({ research: (async () => report) as never, retrieve: (() => undefined) as never });
    const bad = await app.request('/intelligence/country', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ region: '' }) });
    expect(bad.status).toBe(400);
    const missing = await app.request('/intelligence/context/nope');
    expect(missing.status).toBe(404);
  });
});
