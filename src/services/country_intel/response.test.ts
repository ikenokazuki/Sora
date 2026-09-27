import { expect, test } from 'bun:test';
import { compactCountryReport } from './response.js';
import type { CountryContextReport, Fact } from './types.js';

test('initial response samples every subject while preserving references to saved full context', () => {
  const facts: Fact[] = Array.from({ length: 50 }, (_, index) => ({
    id: `fact-${index}`, topic: index < 25 ? 'economy' : 'disasters', text: `Fact ${index}`,
    basis: 'source_excerpt', evidenceIds: [`id-${index}`],
  }));
  const report = {
    contextId: 'context-1',
    evidence: [...facts.map((fact, index) => ({
      id: fact.evidenceIds[0], publishedAt: new Date(1_800_000_000_000 + index * 1000).toISOString(),
      primarySource: false,
    })), { id: 'social-1', sourceType: 'social', regionLink: 'related', acquisition: { providerId: 'yahoo_realtime' }, publishedAt: new Date(1_800_000_100_000).toISOString() }],
    evidenceDetails: facts.map((fact) => ({ evidenceId: fact.evidenceIds[0], contentKind: 'title_only' })),
    keyEvents: [{ evidenceIds: ['id-0'] }],
    recentContext: { reports: [{ evidenceId: 'id-49' }], topics: [] },
    domainContext: { general: { domain: 'general', factors: facts, candidateFactors: [], missingInformation: [] }, finance: { domain: 'finance', factors: facts, missingInformation: [] } },
    enrichment: { attempted: 0, upgraded: 0, failed: 0, skippedBudget: 0, unavailable: true, truncatedDetails: 0, omittedDetails: 0 },
    limitations: [],
  } as unknown as CountryContextReport;
  const compact = compactCountryReport(report);
  expect(compact.domainContext?.general?.factors.length).toBe(24);
  expect(compact.domainContext?.general?.factors.some((fact) => fact.topic === 'economy')).toBe(true);
  expect(compact.domainContext?.general?.factors.some((fact) => fact.topic === 'disasters')).toBe(true);
  expect(compact.domainContext?.finance?.factors.every((fact) => fact.topic === 'economy')).toBe(true);
  expect(compact.evidence.some((item) => item.id === 'id-0')).toBe(true);
  expect(compact.evidence.some((item) => item.id === 'id-49')).toBe(true);
  expect(compact.evidence.some((item) => item.id === 'social-1')).toBe(true);
  const ids = new Set(compact.evidence.map((item) => item.id));
  for (const domain of Object.values(compact.domainContext ?? {})) {
    for (const fact of domain?.factors ?? []) expect(fact.evidenceIds.every((id) => ids.has(id))).toBe(true);
  }
  expect(compact.limitations?.some((item) => item.code === 'response_sampled')).toBe(true);
  expect(report.evidence.length).toBe(51);
});
