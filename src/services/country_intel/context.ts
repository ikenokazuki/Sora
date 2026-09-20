import type {
  BaselineOrigin,
  CountryEvidence,
  CoverageReport,
  CoverageState,
  ForeignRelationContext,
  IntelEvent,
  JapanContextView,
  PollObservation,
  ProviderRun,
  TemporalMetric,
} from './types.js';

const AREA_ALIASES: Record<keyof CoverageReport['byArea'], readonly string[]> = {
  politics: ['politics', 'elections'],
  economy: ['economy', 'trade', 'business'],
  security: ['security', 'military', 'political_violence'],
  disaster: ['disaster', 'disasters'],
  health: ['health', 'humanitarian'],
  polls: ['polls', 'public_opinion'],
  media: ['media', 'media_activity'],
  social: ['social', 'social_issues', 'social_observations'],
  calendar: ['calendar', 'holidays', 'commemorations'],
  foreignRelations: ['foreign_relations', 'diplomacy', 'japan_related_events'],
};

function normalized(value: string | undefined): string | undefined {
  const result = value?.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  return result || undefined;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function relationEvents(relation: ForeignRelationContext): IntelEvent[] {
  return [
    ...relation.officialEvents,
    ...relation.protestEvents,
    ...relation.tradeEvents,
    ...relation.businessEvents,
    ...relation.culturalEvents,
    ...relation.violenceEvents,
  ].filter((event, index, events) => events.findIndex(({ id }) => id === event.id) === index);
}

function relationBucket(event: IntelEvent, relation: ForeignRelationContext): void {
  if (['protest', 'demonstration', 'strike', 'boycott'].includes(event.type)) relation.protestEvents.push(event);
  else if (event.type === 'trade_restriction') relation.tradeEvents.push(event);
  else if (event.type === 'business_action') relation.businessEvents.push(event);
  else if (['cultural_event', 'memorial_event', 'celebration'].includes(event.type)) relation.culturalEvents.push(event);
  else if (['violence', 'threat'].includes(event.type)) relation.violenceEvents.push(event);
  else relation.officialEvents.push(event);
}

export function pollsComparable(left: PollObservation, right: PollObservation): boolean {
  const fields = [left.question, left.population, left.mode, right.question, right.population, right.mode].map(normalized);
  return fields.every(Boolean) && fields[0] === fields[3] && fields[1] === fields[4] && fields[2] === fields[5];
}

export function normalizeCalendarDate(date: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) return date;
  const instant = new Date(date);
  if (Number.isNaN(instant.getTime())) throw new RangeError(`Invalid calendar date: ${date}`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function computeTemporalMetric(
  key: string,
  current: number,
  window: string,
  samples: readonly number[],
  origin: BaselineOrigin,
): TemporalMetric {
  const baselineSamples = samples.filter(Number.isFinite);
  if (baselineSamples.length === 0) {
    return { key, current, window, baseline: { sampleCount: 0, origin }, direction: 'unknown' };
  }
  const center = median(baselineSamples);
  const mad = median(baselineSamples.map((sample) => Math.abs(sample - center)));
  const anomalyZ = Math.max(-6, Math.min(6, (current - center) / Math.max(mad, 1e-9)));
  return {
    key, current, window,
    baseline: { median: center, mad, sampleCount: baselineSamples.length, origin },
    anomalyZ,
    direction: current > center ? 'rising' : current < center ? 'falling' : 'stable',
  };
}

export function buildForeignRelations(
  events: readonly IntelEvent[],
  polls: readonly PollObservation[],
  mediaMetrics: readonly TemporalMetric[],
): ForeignRelationContext[] {
  const relations = new Map<string, ForeignRelationContext>();
  for (const event of events) {
    const counterparts = new Set(event.targets.map((target) => target.countryCode).filter((code): code is string => Boolean(code)));
    for (const counterpartCountryCode of counterparts) {
      const relation = relations.get(counterpartCountryCode) ?? {
        counterpartCountryCode,
        officialEvents: [], protestEvents: [], tradeEvents: [], businessEvents: [], culturalEvents: [], violenceEvents: [],
        relevantPolls: [...polls], mediaMetrics: [...mediaMetrics], recentEventIds: [],
      };
      if (!relations.has(counterpartCountryCode)) relations.set(counterpartCountryCode, relation);
      relationBucket(event, relation);
      if (!relation.recentEventIds.includes(event.id)) relation.recentEventIds.push(event.id);
    }
  }
  return [...relations.values()].sort((left, right) => left.counterpartCountryCode.localeCompare(right.counterpartCountryCode));
}

export function buildJapanView(relations: readonly ForeignRelationContext[]): JapanContextView | undefined {
  const relation = relations.find(({ counterpartCountryCode }) => counterpartCountryCode === 'JP');
  if (!relation) return undefined;
  const events = relationEvents(relation);
  return {
    countryCode: 'JP',
    officialEvents: relation.officialEvents,
    protests: events.filter(({ type }) => ['protest', 'demonstration', 'strike'].includes(type)),
    boycotts: events.filter(({ type }) => type === 'boycott'),
    tradeRestrictions: events.filter(({ type }) => type === 'trade_restriction'),
    culturalEvents: relation.culturalEvents,
    violenceEvents: relation.violenceEvents,
    polls: relation.relevantPolls,
    mediaMetrics: relation.mediaMetrics,
  };
}

function areaRuns(area: keyof CoverageReport['byArea'], runs: readonly ProviderRun[]): ProviderRun[] {
  const aliases = new Set(AREA_ALIASES[area].map((item) => item.replace(/[^a-z]/giu, '').toLocaleLowerCase('en-US')));
  return runs.filter(({ coverage }) => coverage?.some((item) => aliases.has(item.replace(/[^a-z]/giu, '').toLocaleLowerCase('en-US'))) ?? false);
}

function coverageState(runs: readonly ProviderRun[], hasEvidence: boolean): CoverageState {
  if (!hasEvidence || runs.length === 0 || !runs.some(({ itemCount }) => itemCount > 0)) return 'limited';
  if (runs.every(({ status }) => status === 'success')) return 'good';
  return runs.some(({ status }) => status === 'partial' || status === 'success') ? 'partial' : 'limited';
}

export function buildCoverage(runs: readonly ProviderRun[], evidence: readonly CountryEvidence[]): CoverageReport {
  const byArea = {} as CoverageReport['byArea'];
  const missingEvidence: string[] = [];
  for (const area of Object.keys(AREA_ALIASES) as (keyof CoverageReport['byArea'])[]) {
    const coveredRuns = areaRuns(area, runs);
    const hasEvidence = evidence.length > 0 && coveredRuns.some(({ itemCount }) => itemCount > 0);
    byArea[area] = coverageState(coveredRuns, hasEvidence);
    if (!hasEvidence) missingEvidence.push(area);
  }
  return {
    overall: Object.values(byArea).includes('limited') ? 'limited' : Object.values(byArea).includes('partial') ? 'partial' : 'good',
    byArea,
    missingEvidence,
    unavailableProviders: runs.filter(({ status }) => ['unavailable', 'rate_limited', 'error'].includes(status)).map(({ provider }) => provider),
  };
}
