import { COUNTRY_INTEL_TOPICS } from './types.js';
import type { CountryContextRequest, CountryIntelTopic, CountrySource, RegionIdentity } from './types.js';

export interface ProviderCapability {
  id: string;
  areas: readonly string[];
}

export interface ResearchQuery {
  pass: 1 | 2;
  providerId: string;
  query: string;
  topics: readonly CountryIntelTopic[];
  maxItems: number;
  sourceDomain?: string;
}

export interface ResearchPlanLimits {
  maxPass1Queries: 12;
  maxPass2Queries: 8;
  maxItemsPerQuery: 100;
}

export interface ResearchPlan {
  request: CountryContextRequest;
  region: RegionIdentity;
  pass1: ResearchQuery[];
  pass2: ResearchQuery[];
  limits: ResearchPlanLimits;
}

const LIMITS: ResearchPlanLimits = {
  maxPass1Queries: 12,
  maxPass2Queries: 8,
  maxItemsPerQuery: 100,
};

function sourceHost(domain: string): string | undefined {
  try {
    const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function planCountryResearch(
  request: CountryContextRequest,
  region: RegionIdentity,
  capabilities: readonly ProviderCapability[],
  sources: readonly CountrySource[],
): ResearchPlan {
  const topics = request.topics?.length ? [...request.topics] : [...COUNTRY_INTEL_TOPICS];
  const baseQuery = [region.name, request.query?.trim(), request.topics?.join(' ')]
    .filter(Boolean)
    .join(' ');
  const pass1 = capabilities.slice(0, LIMITS.maxPass1Queries).map((capability) => ({
    pass: 1 as const,
    providerId: capability.id,
    query: baseQuery,
    topics,
    maxItems: LIMITS.maxItemsPerQuery,
  }));
  const webProvider = capabilities.find(({ id }) => id.includes('web'))?.id
    ?? capabilities[0]?.id
    ?? 'official_web';
  const pass2 = sources
    .filter((source) => source.verificationStatus === 'verified' && source.verifiedAt)
    .flatMap((source) => {
      const domain = sourceHost(source.domain);
      return domain ? [{ source, domain }] : [];
    })
    .slice(0, LIMITS.maxPass2Queries)
    .map(({ domain }) => ({
      pass: 2 as const,
      providerId: webProvider,
      query: `site:${domain} ${baseQuery}`,
      topics,
      maxItems: LIMITS.maxItemsPerQuery,
      sourceDomain: domain,
    }));

  return {
    request: { ...request, topics: request.topics ? [...request.topics] : undefined },
    region: { ...region, languages: [...region.languages], aliases: [...region.aliases] },
    pass1,
    pass2,
    limits: { ...LIMITS },
  };
}
