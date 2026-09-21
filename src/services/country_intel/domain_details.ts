import type { AcquiredItem } from './provider_registry.js';
import type { Domain, Fact, Limitation, DomainContext } from './types.js';

export type { Domain, Fact, Limitation, DomainContext };

export function buildDomainContext(domain: Domain, facts: Fact[], limitations: Limitation[]): DomainContext {
  return { domain, factors: [...facts], missingInformation: [...limitations] };
}

export function evidenceToFacts(items: readonly AcquiredItem[]): Fact[] {
  return items.flatMap((wrapped, index) => {
    const evidence = wrapped.item.evidence;
    if (!evidence) return [];
    const text = evidence.title ?? evidence.excerpt;
    if (!text) return [];
    return [{
      id: 'fact-' + String(index) + '-' + evidence.id,
      topic: wrapped.areas[0] ?? 'general',
      text,
      basis: 'source_excerpt' as const,
      evidenceIds: [evidence.id],
    }];
  });
}
