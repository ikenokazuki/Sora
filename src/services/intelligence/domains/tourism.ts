import { pick, type DomainViewBase, type DomainViewInput } from './shared.js';

export interface TourismContextView extends DomainViewBase {
  attention: ReturnType<typeof pick>;
  culturalEvents: ReturnType<typeof pick>;
  disasterSignals: ReturnType<typeof pick>;
  calendarSignals: ReturnType<typeof pick>;
  disruption: ReturnType<typeof pick>;
}

export function buildTourismView(input: DomainViewInput): TourismContextView {
  return {
    regionId: input.regionId,
    coverage: input.coverage,
    attention: pick(input.signals, ['media_article_count', 'media_cluster_count']),
    culturalEvents: pick(input.signals, ['cultural_event_count']),
    disasterSignals: pick(input.signals, ['disaster_event_count']),
    calendarSignals: pick(input.signals, ['calendar_event_count']),
    disruption: pick(input.signals, ['violence_event_count', 'protest_event_count']),
  };
}
