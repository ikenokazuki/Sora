import { pick, type DomainViewBase, type DomainViewInput } from './shared.js';

export interface FinanceContextView extends DomainViewBase {
  economy: ReturnType<typeof pick>;
  trade: ReturnType<typeof pick>;
  businessAction: ReturnType<typeof pick>;
  policyActivity: ReturnType<typeof pick>;
}

export function buildFinanceView(input: DomainViewInput): FinanceContextView {
  return {
    regionId: input.regionId,
    coverage: input.coverage,
    economy: pick(input.signals, ['gdp_nominal', 'trade_restriction_count', 'business_action_count']),
    trade: pick(input.signals, ['trade_restriction_count']),
    businessAction: pick(input.signals, ['business_action_count']),
    policyActivity: pick(input.signals, ['event_cluster_count', 'official_event_count']),
  };
}
