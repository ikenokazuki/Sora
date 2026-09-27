import type {
  ActualWindow,
  BaselineOrigin,
  CountryEvidence,
  CoverageReport,
  CoverageState,
  CountryContextReport,
  Fact,
  ForeignRelationContext,
  IntelEvent,
  JapanContextView,
  PollObservation,
  ProviderRun,
  SituationSection,
  TemporalMetric,
} from './types.js';
import type { RegionLink } from './region_link.js';
import { classifyActionType } from './event_extract.js';

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

/** 単独観測の昇格対象。分野タグ付きの証拠だけを扱い、無属性ニュースの政治・治安への誤分類はしない。 */
const PROMOTABLE_TOPIC_TO_AREA: Readonly<Record<string, SituationArea>> = Object.freeze({
  economy: 'economy',
  disasters: 'disasters',
  humanitarian: 'humanitarian',
  social_observations: 'social',
});
const SINGLE_OBSERVATION_CAP = 5;

function oneLineEvidence(evidence: CountryEvidence): string {
  const title = evidence.title?.normalize('NFKC').replace(/\s+/gu, ' ').trim() || evidence.url;
  const date = evidence.publishedAt?.slice(0, 10) ?? 'date unknown';
  const publisher = evidence.publisher?.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const tail = publisher ? publisher + ', ' + date : date;
  return (title + ' — ' + tail).slice(0, 200);
}

/**
 * クラスタのない分野に、地域関連の確認済み単独証拠を構造化で載せる。
 * eventIds は作らない（単独観測と分かる形）。非LLM・抽出のみ。
 */
export function promoteSingleObservations(
  situation: CountryContextReport['situation'],
  facts: readonly Fact[],
  evidenceById: ReadonlyMap<string, CountryEvidence>,
  links: ReadonlyMap<string, RegionLink>,
  clusteredEvidenceIds: ReadonlySet<string>,
): void {
  const promoted = new Set<string>();
  const collect = (match: (fact: Fact, evidence: CountryEvidence) => SituationArea | undefined): Map<SituationArea, CountryEvidence[]> => {
    const buckets = new Map<SituationArea, CountryEvidence[]>();
    for (const fact of facts) {
      for (const id of fact.evidenceIds) {
        if (promoted.has(id) || clusteredEvidenceIds.has(id)) continue;
        const link = links.get(id);
        if (link !== 'direct' && link !== 'related') continue;
        const evidence = evidenceById.get(id);
        if (!evidence) continue;
        const area = match(fact, evidence);
        if (!area) continue;
        promoted.add(id);
        const list = buckets.get(area) ?? [];
        list.push(evidence);
        buckets.set(area, list);
      }
    }
    return buckets;
  };
  const assign = (buckets: Map<SituationArea, CountryEvidence[]>): void => {
    for (const [area, candidates] of buckets) {
      const section = situation[area];
      if (section.eventIds.length > 0 || section.evidenceIds.length > 0) continue;
      candidates.sort((a, b) => {
        if (a.primarySource !== b.primarySource) return a.primarySource ? -1 : 1;
        const at = a.publishedAt ?? '';
        const bt = b.publishedAt ?? '';
        if (at !== bt) return at < bt ? 1 : -1;
        return a.id < b.id ? -1 : 1;
      });
      const picked = candidates.slice(0, SINGLE_OBSERVATION_CAP);
      section.evidenceIds = picked.map((evidence) => evidence.id);
      const head = picked.length === 1
        ? '1 single observation (uncorroborated, no event cluster) in the requested period.'
        : picked.length + ' single observations (uncorroborated, no event cluster) in the requested period.';
      section.summaryFacts = [head, ...picked.map(oneLineEvidence)];
    }
  };
  // 1) 分野タグ付きの fast path。2) 見出し型付け（クラスタと同一規則・見出しのみ）。
  assign(collect((fact) => PROMOTABLE_TOPIC_TO_AREA[fact.topic]));
  assign(collect((fact, evidence) => {
    if (!evidence.title) return undefined;
    const area = SITUATION_CLASSIFICATION[classifyActionType(evidence.title)];
    return area;
  }));
}

function areaRuns(area: keyof CoverageReport['byArea'], runs: readonly ProviderRun[]): ProviderRun[] {
  const aliases = new Set(AREA_ALIASES[area].map(normalizeAreaKey));
  return runs.filter(({ coverage }) => coverage?.some((item) => aliases.has(normalizeAreaKey(item))) ?? false);
}

/** 分野名の表記ゆれ（disaster/disasters 等）を入口で正規化する。 */
export function normalizeAreaKey(value: string): string {
  return value.replace(/[^a-z]/giu, '').toLocaleLowerCase('en-US');
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
  extraIds: readonly string[] = [],
): CoverageReport {
  const byArea = {} as CoverageReport['byArea'];
  const missingEvidence: string[] = [];
  // 記事以外の統計・カレンダー（detail/calendar の ID）も対応する証拠として評価する。
  const evidenceIds = new Set([...evidence.map(({ id }) => id), ...extraIds]);
  for (const area of Object.keys(AREA_ALIASES) as (keyof CoverageReport['byArea'])[]) {
    const coveredRuns = areaRuns(area, runs);
    // provider 申告の分野名は表記ゆれがあるため正規化して突き合わせる。
    // 例: Coverage の disaster に対し provider は disasters を申告する。
    const aliases = AREA_ALIASES[area].map(normalizeAreaKey);
    const hasEvidence = coveredRuns.some(
      ({ provider, itemCount }) => itemCount > 0 && aliases.some((alias) =>
        Object.entries(evidenceByProviderArea).some(([key, ids]) => {
          const separator = key.indexOf(':');
          return separator >= 0
            && key.slice(0, separator) === provider
            && normalizeAreaKey(key.slice(separator + 1)) === alias
            && ids.some((id) => evidenceIds.has(id));
        }),
      ),
    );
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

export interface ProviderWindowHint {
  provider: string;
  status: ProviderRun['status'];
  /** 申告された収集範囲（日数）。未申告は不明。 */
  collectionWindowDays?: number;
}

/** 収集範囲の表示。1日未満は時間・分で表す。 */
export function formatWindowDays(days: number): string {
  if (days >= 1) return '~' + String(Math.round(days * 10) / 10) + 'd';
  const minutes = Math.round(days * 24 * 60);
  if (minutes >= 60) return '~' + String(Math.round(minutes / 60 * 10) / 10) + 'h';
  return '~' + String(Math.max(1, minutes)) + 'min';
}

/**
 * 要求期間のコピーではなく取得元の実収集範囲から期間を生成する。
 * 24時間フィードや最新15分 Export だけで 30 日間を完全取得した扱いにしない。
 */
export function buildActualWindows(
  from: string,
  to: string,
  runs: readonly ProviderRun[],
  hints: readonly ProviderWindowHint[],
  periodDays: number,
): ActualWindow[] {
  const gaps: { from: string; to: string; reason: string }[] = [];
  for (const run of runs) {
    if (run.status !== 'success') {
      gaps.push({ from, to, reason: run.provider + ':' + run.status + (run.errorCode ? ' ' + run.errorCode : '') });
    }
  }
  for (const hint of hints) {
    if (hint.status !== 'success' || hint.collectionWindowDays === undefined) continue;
    if (hint.collectionWindowDays < periodDays) {
      gaps.push({ from, to, reason: hint.provider + ':partial_window covers ' + formatWindowDays(hint.collectionWindowDays) + ' of ' + String(periodDays) + 'd' });
    }
  }
  return [{ from, to, complete: gaps.length === 0 && runs.length > 0, gaps }];
}
