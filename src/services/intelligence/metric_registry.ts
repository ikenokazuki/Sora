import type { MetricDefinition } from './types.js';

/** 初期 metric 定義。統計処理は kind ごとに異なり、一律に異常度へ変換しない。 */
const DEFINITIONS: readonly MetricDefinition[] = Object.freeze([
  { key: 'event_cluster_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'independent_source_event_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'official_event_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'protest_event_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'violence_event_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'military_activity_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'trade_restriction_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'business_action_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'disaster_event_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'media_article_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'media_cluster_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'social_observation_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'calendar_event_count', kind: 'count', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'primary_source_ratio', kind: 'share', baselineMode: 'provider_history', minBaselineSamples: 14 },
  { key: 'source_diversity', kind: 'level', baselineMode: 'none', minBaselineSamples: 14 },
  // World Bank GDP 等の level は、そのまま異常度へ変換しない。
  { key: 'gdp_nominal', kind: 'level', baselineMode: 'none', minBaselineSamples: 14 },
]);

const BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

export function getMetricDefinition(key: string): MetricDefinition {
  const definition = BY_KEY.get(key);
  if (!definition) throw new Error(`Unknown intelligence metric: ${key}`);
  return definition;
}

export function listMetricDefinitions(): MetricDefinition[] {
  return [...DEFINITIONS];
}
