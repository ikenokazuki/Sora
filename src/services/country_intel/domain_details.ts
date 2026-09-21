import type { AcquiredItem } from './provider_registry.js';

export type Domain = 'general' | 'content' | 'marketing' | 'finance' | 'tourism' | 'travel';

export interface Fact {
  id: string;
  topic: string;
  text: string;
  basis: 'provider_field' | 'source_excerpt' | 'rule_derived';
  evidenceIds: string[];
}

export interface Limitation {
  code: string;
  area: string;
  providerId?: string;
  message: string;
  evidenceIds: string[];
}

export interface DomainContext {
  domain: Domain;
  factors: Fact[];
  missingInformation: Limitation[];
}

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
