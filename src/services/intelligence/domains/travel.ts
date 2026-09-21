import { pick, type DomainViewBase, type DomainViewInput } from './shared.js';

export interface TravelContextView extends DomainViewBase {
  disruptionSignals: ReturnType<typeof pick>;
  disasterSignals: ReturnType<typeof pick>;
  healthSignals: ReturnType<typeof pick>;
  calendarSignals: ReturnType<typeof pick>;
}

export function buildTravelView(input: DomainViewInput): TravelContextView {
  return {
    regionId: input.regionId,
    coverage: input.coverage,
    disruptionSignals: pick(input.signals, ['violence_event_count', 'military_activity_count']),
    disasterSignals: pick(input.signals, ['disaster_event_count']),
    healthSignals: [],
    calendarSignals: [],
  };
}
