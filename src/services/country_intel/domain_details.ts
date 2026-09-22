import type { AcquiredItem } from './provider_registry.js';
import type { ActionType, Domain, Fact, IntelEvent, Limitation, DomainContext } from './types.js';
import type { EvidenceDetail } from './detail.js';
import type { RegionLink } from './region_link.js';

export type { Domain, Fact, Limitation, DomainContext };

export function buildDomainContext(
  domain: Domain,
  facts: Fact[],
  limitations: Limitation[],
  events: readonly IntelEvent[] = [],
  relevance?: ReadonlyMap<string, RegionLink>,
): DomainContext {
  // relevance 省略時は従来互換（全件フォールバックあり）。report 経路は必ず relevance を渡す。
  if (!relevance) return buildDomainContextLegacy(domain, facts, limitations, events);
  const relevantFacts = facts.filter((fact) =>
    fact.evidenceIds.some((id) => relevance.get(id) === 'direct' || relevance.get(id) === 'related'),
  );
  const missingInformation = [...limitations];
  if (domain === 'general') {
    const candidateFactors = facts.filter((fact) =>
      !relevantFacts.includes(fact) && fact.evidenceIds.some((id) => {
        const link = relevance.get(id);
        return link === 'candidate' || link === 'unknown';
      }),
    );
    if (relevantFacts.length === 0) {
      missingInformation.push({
        code: 'factors_missing', area: 'general',
        message: 'no region-relevant factors; see candidateFactors and limitations', evidenceIds: [],
      });
    }
    return { domain, factors: [...relevantFacts], candidateFactors, missingInformation };
  }
  const salience = DOMAIN_SALIENCE[domain];
  const typeByEvidence = new Map<string, ActionType>();
  for (const event of events) {
    for (const id of event.evidenceIds) {
      if (!typeByEvidence.has(id)) typeByEvidence.set(id, event.type);
    }
  }
  const selected = relevantFacts.filter((fact) =>
    salience.areas.includes(fact.topic)
    || fact.evidenceIds.some((id) => {
      const eventType = typeByEvidence.get(id);
      return eventType !== undefined && (salience.eventTypes as readonly string[]).includes(eventType);
    }));
  // 該当なしは空配列＋不足理由を返す。全件への差し戻しはしない。
  if (selected.length === 0) {
    missingInformation.push({
      code: 'factors_missing', area: domain,
      message: 'no matching factors for domain; region-relevant facts: ' + String(relevantFacts.length),
      evidenceIds: [],
    });
  }
  return { domain, factors: selected, missingInformation };
}

function buildDomainContextLegacy(domain: Domain, facts: Fact[], limitations: Limitation[], events: readonly IntelEvent[]): DomainContext {
  if (domain === 'general') return { domain, factors: [...facts], missingInformation: [...limitations] };
  const salience = DOMAIN_SALIENCE[domain];
  const typeByEvidence = new Map<string, ActionType>();
  for (const event of events) {
    for (const id of event.evidenceIds) {
      if (!typeByEvidence.has(id)) typeByEvidence.set(id, event.type);
    }
  }
  const selected = facts.filter((fact) =>
    salience.areas.includes(fact.topic)
    || fact.evidenceIds.some((id) => {
      const eventType = typeByEvidence.get(id);
      return eventType !== undefined && (salience.eventTypes as readonly string[]).includes(eventType);
    }));
  return { domain, factors: selected.length > 0 ? selected : [...facts], missingInformation: [...limitations] };
}

interface DomainSalience {
  areas: readonly string[];
  eventTypes: readonly ActionType[];
}

const DOMAIN_SALIENCE: Record<Exclude<Domain, 'general'>, DomainSalience> = {
  content: {
    areas: ['disasters', 'media_activity', 'current_events', 'social_observations', 'humanitarian', 'official', 'calendar', 'holidays'],
    eventTypes: ['disaster_response', 'protest', 'demonstration', 'violence', 'threat', 'memorial_event', 'celebration', 'cultural_event', 'boycott', 'statement', 'meeting', 'election', 'strike', 'arrest', 'sanction'],
  },
  marketing: {
    areas: ['disasters', 'media_activity', 'current_events', 'social_observations', 'calendar', 'holidays', 'economy', 'humanitarian', 'official'],
    eventTypes: ['boycott', 'protest', 'demonstration', 'disaster_response', 'cultural_event', 'celebration', 'memorial_event', 'business_action', 'trade_restriction', 'statement', 'strike'],
  },
  finance: {
    areas: ['economy', 'current_events', 'media_activity', 'official', 'historical_context'],
    eventTypes: ['trade_restriction', 'business_action', 'sanction', 'agreement', 'legislation', 'election', 'meeting', 'statement'],
  },
  tourism: {
    areas: ['disasters', 'calendar', 'holidays', 'humanitarian', 'media_activity', 'current_events', 'social_observations', 'official'],
    eventTypes: ['disaster_response', 'violence', 'threat', 'protest', 'demonstration', 'strike', 'celebration', 'cultural_event', 'memorial_event'],
  },
  travel: {
    areas: ['disasters', 'calendar', 'holidays', 'humanitarian', 'media_activity', 'current_events', 'social_observations', 'official'],
    eventTypes: ['disaster_response', 'violence', 'threat', 'protest', 'demonstration', 'strike', 'celebration', 'cultural_event', 'memorial_event'],
  },
};

function clean(text: string | undefined): string | undefined {
  const normalized = text?.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized || undefined;
}

const FACT_TEXT_MAX = 1000;

/** 本文取得済みなら本文を使う。なければ見出し＋抜粋。非LLMで説明文は生成しない。 */
export function evidenceToFacts(items: readonly AcquiredItem[]): Fact[] {
  return items.flatMap((wrapped, index) => {
    const evidence = wrapped.item.evidence;
    if (!evidence) return [];
    const detail: EvidenceDetail | undefined = wrapped.item.detail;
    if (detail?.contentKind === 'extracted_text' && detail.blocks.length > 0) {
      const body = detail.blocks.map((block) => block.text).join('\n');
      const title = clean(evidence.title);
      const raw = title ? title + ' \u2014 ' + body : body;
      if (!raw) return [];
      return [{
        id: 'fact-' + String(index) + '-' + evidence.id,
        topic: wrapped.areas[0] ?? 'general',
        text: raw.slice(0, FACT_TEXT_MAX),
        basis: 'source_excerpt' as const,
        evidenceIds: [evidence.id],
        ...(raw.length > FACT_TEXT_MAX || detail.contentTruncated ? { truncated: true } : {}),
      }];
    }
    const title = clean(evidence.title);
    const excerpt = clean(evidence.excerpt);
    const raw = title && excerpt && excerpt !== title ? title + ' \u2014 ' + excerpt : (title ?? excerpt);
    if (!raw) return [];
    return [{
      id: 'fact-' + String(index) + '-' + evidence.id,
      topic: wrapped.areas[0] ?? 'general',
      text: raw.slice(0, FACT_TEXT_MAX),
      basis: 'source_excerpt' as const,
      evidenceIds: [evidence.id],
      ...(raw.length > FACT_TEXT_MAX ? { truncated: true } : {}),
    }];
  });
}
