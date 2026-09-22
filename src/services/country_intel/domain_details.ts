import type { AcquiredItem } from './provider_registry.js';
import type { Domain, Fact, Limitation, DomainContext } from './types.js';

export type { Domain, Fact, Limitation, DomainContext };

export function buildDomainContext(domain: Domain, facts: Fact[], limitations: Limitation[]): DomainContext {
  return { domain, factors: [...facts], missingInformation: [...limitations] };
}

function clean(text: string | undefined): string | undefined {
  const normalized = text?.normalize('NFKC').replace(/\\s+/gu, ' ').trim();
  return normalized || undefined;
}

export function evidenceToFacts(items: readonly AcquiredItem[]): Fact[] {
  return items.flatMap((wrapped, index) => {
    const evidence = wrapped.item.evidence;
    if (!evidence) return [];
    const title = clean(evidence.title);
    const excerpt = clean(evidence.excerpt);
    const text = title && excerpt && excerpt !== title ? title + ' \u2014 ' + excerpt : (title ?? excerpt);
    if (!text) return [];
    return [{
      id: 'fact-' + String(index) + '-' + evidence.id,
      topic: wrapped.areas[0] ?? 'general',
      text: text.slice(0, 1000),
      basis: 'source_excerpt' as const,
      evidenceIds: [evidence.id],
    }];
  });
}
