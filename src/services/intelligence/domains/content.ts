import { pick, type DomainViewBase, type DomainViewInput } from './shared.js';

export interface ContentContextView extends DomainViewBase {
  attention: ReturnType<typeof pick>;
  disaster: ReturnType<typeof pick>;
  socialActivity: ReturnType<typeof pick>;
  calendar: ReturnType<typeof pick>;
}

export function buildContentView(input: DomainViewInput): ContentContextView {
  return {
    regionId: input.regionId,
    coverage: input.coverage,
    attention: pick(input.signals, ['media_article_count', 'media_cluster_count', 'event_cluster_count']),
    disaster: pick(input.signals, ['disaster_event_count']),
    socialActivity: pick(input.signals, ['social_observation_count', 'protest_event_count']),
    calendar: [],
  };
}
