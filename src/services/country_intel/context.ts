import type {
  BaselineOrigin,
  CountryEvidence,
  CoverageReport,
  CoverageState,
  CountryContextReport,
  ForeignRelationContext,
  IntelEvent,
  JapanContextView,
  PollObservation,
  ProviderRun,
  SituationSection,
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
  if (baselineSamples.length < 3) {
    return { key, current, window, baseline: { sampleCount: baselineSamples.length, origin: 'insufficient' }, direction: 'unknown' };
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
  evidence: readonly CountryEvidence[] = [],
): ForeignRelationContext[] {
  const relations = new Map<string, ForeignRelationContext>();
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  for (const poll of polls) {
    for (const counterpartCountryCode of new Set(evidenceById.get(poll.evidenceId)?.mentionedCountries ?? [])) {
      const relation = relations.get(counterpartCountryCode) ?? {
        counterpartCountryCode,
        officialEvents: [], protestEvents: [], tradeEvents: [], businessEvents: [], culturalEvents: [], violenceEvents: [],
        relevantPolls: [], mediaMetrics: [...mediaMetrics], recentEventIds: [],
      };
      if (!relations.has(counterpartCountryCode)) relations.set(counterpartCountryCode, relation);
      relation.relevantPolls.push(poll);
    }
  }
  for (const event of events) {
    const counterparts = new Set(event.targets.map((target) => target.countryCode).filter((code): code is string => Boolean(code)));
    for (const evidenceId of event.evidenceIds) {
      for (const countryCode of evidenceById.get(evidenceId)?.mentionedCountries ?? []) counterparts.add(countryCode);
    }
    for (const counterpartCountryCode of counterparts) {
      const relation = relations.get(counterpartCountryCode) ?? {
        counterpartCountryCode,
        officialEvents: [], protestEvents: [], tradeEvents: [], businessEvents: [], culturalEvents: [], violenceEvents: [],
        relevantPolls: [], mediaMetrics: [...mediaMetrics], recentEventIds: [],
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

type SituationArea = keyof CountryContextReport['situation'];

const SITUATION_CLASSIFICATION: Readonly<Record<string, SituationArea>> = Object.freeze({
  election: 'politics',
  legislation: 'politics',
  trade_restriction: 'economy',
  business_action: 'economy',
  military_activity: 'security',
  violence: 'security',
  threat: 'security',
  disaster_response: 'disasters',
  protest: 'social',
  demonstration: 'social',
  strike: 'social',
});

function emptySituationSection(): SituationSection {
  return { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] };
}

/** イベントを分類可能な section にだけ配置する。分類不能は section に入れない。 */
export function assembleSituation(
  events: readonly IntelEvent[],
  evidence: readonly CountryEvidence[],
  window: string,
): CountryContextReport['situation'] {
  void window;
  const evidenceByEvent = new Map<string, CountryEvidence[]>();
  for (const item of evidence) {
    if (!item.eventClusterId) continue;
    const list = evidenceByEvent.get(item.eventClusterId) ?? [];
    list.push(item);
    evidenceByEvent.set(item.eventClusterId, list);
  }
  const situation: CountryContextReport['situation'] = {
    politics: emptySituationSection(),
    economy: emptySituationSection(),
    security: emptySituationSection(),
    disasters: emptySituationSection(),
    health: emptySituationSection(),
    humanitarian: emptySituationSection(),
    social: emptySituationSection(),
  };
  const byArea = new Map<SituationArea, IntelEvent[]>();
  for (const event of events) {
    const area = SITUATION_CLASSIFICATION[event.type];
    if (!area) continue;
    const list = byArea.get(area) ?? [];
    list.push(event);
    byArea.set(area, list);
  }
  for (const [area, areaEvents] of byArea) {
    const section = situation[area];
    section.eventIds = areaEvents.map((event) => event.id);
    section.evidenceIds = [...new Set(areaEvents.flatMap((event) => event.evidenceIds))];
    const kinds = [...new Set(areaEvents.map((event) => event.type))].sort();
    const scope = kinds.length === 1 ? `${kinds[0]} ` : '';
    const unit = areaEvents.length === 1 ? 'event cluster was' : 'event clusters were';
    section.summaryFacts = [`${areaEvents.length} ${scope}${unit} observed in the requested period.`];
  }
  return situation;
}

function areaRuns(area: keyof CoverageReport['byArea'], runs: readonly ProviderRun[]): ProviderRun[] {
  const aliases = new Set(AREA_ALIASES[area].map((item) => item.replace(/[^a-z]/giu, '').toLocaleLowerCase('en-US')));
  return runs.filter(({ coverage }) => coverage?.some((item) => aliases.has(item.replace(/[^a-z]/giu, '').toLocaleLowerCase('en-US'))) ?? false);
}

function coverageState(runs: readonly ProviderRun[], hasEvidence: boolean): CoverageState {
  if (!hasEvidence || runs.length === 0) return 'limited';
  if (runs.every(({ status }) => status === 'success')) return 'good';
  return runs.some(({ status }) => status === 'partial' || status === 'success') ? 'partial' : 'limited';
}

export function buildCoverage(
  runs: readonly ProviderRun[],
  evidence: readonly CountryEvidence[],
  evidenceByProviderArea: Readonly<Record<string, readonly string[]>> = {},
): CoverageReport {
  const byArea = {} as CoverageReport['byArea'];
  const missingEvidence: string[] = [];
  const evidenceIds = new Set(evidence.map(({ id }) => id));
  for (const area of Object.keys(AREA_ALIASES) as (keyof CoverageReport['byArea'])[]) {
    const coveredRuns = areaRuns(area, runs);
    const hasEvidence = coveredRuns.some(({ provider, itemCount }) => itemCount > 0 && evidenceByProviderArea[`${provider}:${area}`]?.some((id) => evidenceIds.has(id)));
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
