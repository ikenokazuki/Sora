import { pick, type DomainViewBase, type DomainViewInput } from './shared.js';

export interface MarketingContextView extends DomainViewBase {
  attention: ReturnType<typeof pick>;
  businessActivity: ReturnType<typeof pick>;
  calendar: ReturnType<typeof pick>;
  socialActivity: ReturnType<typeof pick>;
  disruption: ReturnType<typeof pick>;
}

export function buildMarketingView(input: DomainViewInput): MarketingContextView {
  return {
    regionId: input.regionId,
    coverage: input.coverage,
    attention: pick(input.signals, ['media_article_count', 'media_cluster_count']),
    businessActivity: pick(input.signals, ['business_action_count', 'trade_restriction_count']),
    calendar: [],
    socialActivity: pick(input.signals, ['social_observation_count', 'protest_event_count']),
    disruption: pick(input.signals, ['disaster_event_count', 'violence_event_count']),
  };
}
