import { COUNTRY_INTEL_TOPICS } from './types.js';
import type { CountryContextRequest, CountryIntelTopic, CountrySource, RegionIdentity } from './types.js';

export interface ProviderCapability {
  id: string;
  areas: readonly string[];
  /** 対応国コード。未指定・空は全地域で実行する。 */
  regions?: readonly string[];
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
  maxPass1Queries: 24;
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

export const LIMITS: ResearchPlanLimits = {
  maxPass1Queries: 24,
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

export interface Pass2SourceInput {
  verifiedSources?: readonly CountrySource[];
  /** 未検証 candidate。pass2 query には使用しない (テストで固定)。 */
  candidates?: readonly CountrySource[];
}

/** identity が検証された source のみ pass2 で使用する。availability_only は除外する。 */
export function isPass2EligibleSource(source: CountrySource): boolean {
  return source.verificationStatus === 'verified'
    && Boolean(source.verifiedAt)
    && source.verificationBasis !== 'availability_only';
}

export function planCountryResearchPass1(
  request: CountryContextRequest,
  region: RegionIdentity,
  capabilities: readonly ProviderCapability[],
): ResearchQuery[] {
  const topics = request.topics?.length ? [...request.topics] : [...COUNTRY_INTEL_TOPICS];
  const baseQuery = [region.name, request.query?.trim()].filter(Boolean).join(' ');
  return applicableCapabilities(region, capabilities)
    .slice(0, LIMITS.maxPass1Queries)
    .map((capability) => ({
      pass: 1 as const,
      providerId: capability.id,
      query: baseQuery,
      topics,
      maxItems: LIMITS.maxItemsPerQuery,
    }));
}

/** 地域に対応する取得先だけを残す。地域未解決時は落とさない。 */
export function applicableCapabilities(
  region: RegionIdentity,
  capabilities: readonly ProviderCapability[],
): ProviderCapability[] {
  return capabilities.filter((capability) =>
    !(capability.regions?.length)
    || !region.countryCode
    || capability.regions.includes(region.countryCode),
  );
}

/** 地域条件で除外した取得先ID。未実行の理由付けに使う。 */
export function inapplicableProviderIds(
  region: RegionIdentity,
  capabilities: readonly ProviderCapability[],
): string[] {
  return capabilities
    .filter((capability) => !applicableCapabilities(region, [capability]).length)
    .map((capability) => capability.id);
}

/** 対応地域だが上限で落とした取得先ID。黙って消さない。 */
export function cappedProviderIds(
  region: RegionIdentity,
  capabilities: readonly ProviderCapability[],
): string[] {
  return applicableCapabilities(region, capabilities)
    .slice(LIMITS.maxPass1Queries)
    .map((capability) => capability.id);
}

export function planCountryResearchPass2(
  request: CountryContextRequest,
  region: RegionIdentity,
  capabilities: readonly ProviderCapability[],
  input: Pass2SourceInput = {},
): ResearchQuery[] {
  const topics = request.topics?.length ? [...request.topics] : [...COUNTRY_INTEL_TOPICS];
  const baseQuery = [region.name, request.query?.trim()].filter(Boolean).join(' ');
  const webProvider = capabilities.find(({ id }) => id.includes('web'))?.id
    ?? capabilities[0]?.id
    ?? 'official_web';
  void input.candidates;
  return (input.verifiedSources ?? [])
    .filter(isPass2EligibleSource)
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
}

export function planCountryResearch(
  request: CountryContextRequest,
  region: RegionIdentity,
  capabilities: readonly ProviderCapability[],
  sources: readonly CountrySource[],
): ResearchPlan {
  const pass1 = planCountryResearchPass1(request, region, capabilities);
  const pass2 = planCountryResearchPass2(request, region, capabilities, { verifiedSources: sources });
  return {
    request: { ...request, topics: request.topics ? [...request.topics] : undefined },
    region: { ...region, languages: [...region.languages], aliases: [...region.aliases] },
    pass1,
    pass2,
    limits: { ...LIMITS },
  };
}
