import type { Database } from 'bun:sqlite';
import { statSync } from 'fs';
import { applyMigrations, getDb } from '../../db.js';
import { COUNTRY_INTEL_MIGRATIONS } from './migrations.js';
import { isBaselineEligible } from '../intelligence/observations.js';
import type { MetricKind, ObservationOrigin } from '../intelligence/types.js';
import type {
  CalendarEvent,
  CountryContextReport,
  CountryEvidence,
  CountrySource,
  IntelEvent,
  PollObservation,
  ProviderRun,
  TemporalMetric,
} from './types.js';

const DAY = 86_400_000;
const REPORT_RETENTION = 90 * DAY;
const EVIDENCE_RETENTION = 180 * DAY;

export interface DailyMetricRecord {
  regionId: string;
  observedAt: string | number;
  metric: TemporalMetric;
}

export interface CountryContextRecords {
  sources?: readonly CountrySource[];
  providerRuns?: readonly ProviderRun[];
  evidence?: readonly CountryEvidence[];
  events?: readonly IntelEvent[];
  polls?: readonly PollObservation[];
  calendar?: readonly CalendarEvent[];
  dailyMetrics?: readonly DailyMetricRecord[];
}

export interface CountryIntelPruneResult {
  reports: number;
  evidenceExcerpts: number;
  events: number;
  dailyMetrics: number;
  details: number;
}

export interface CountryIntelDbMetrics {
  path: string;
  mainBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
}

function epoch(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || Number.isNaN(new Date(timestamp).getTime())) {
    throw new TypeError(`Invalid epoch milliseconds: ${value}`);
  }
  return timestamp;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function addCalendarYears(timestamp: number, years: number): number {
  const date = new Date(timestamp);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.getTime();
}

function uniqueEvents(report: CountryContextReport): IntelEvent[] {
  const relations = report.foreignRelations.flatMap((relation) => [
    ...relation.officialEvents, ...relation.protestEvents, ...relation.tradeEvents,
    ...relation.businessEvents, ...relation.culturalEvents, ...relation.violenceEvents,
  ]);
  const events = [...report.keyEvents, ...report.elections, ...relations];
  return [...new Map(events.map((item) => [item.id, item])).values()];
}

export function runMigrations(db: Database): void {
  applyMigrations(db, COUNTRY_INTEL_MIGRATIONS.map(({ version, name, statements }) => ({
    version,
    name,
    up(database) {
      for (const statement of statements) database.run(statement);
    },
  })));
}

export function saveCountryContext(
  report: CountryContextReport,
  records: CountryContextRecords = {},
): void {
  const db = getDb();
  const reportTimestamp = epoch(report.asOf)!;
  const providerRuns = records.providerRuns ?? report.providerCoverage;
  const evidence = records.evidence ?? report.evidence;
  const events = records.events ?? uniqueEvents(report);
  const polls = records.polls ?? report.polls;
  const calendarEvents = records.calendar ?? report.calendar;
  const dailyMetrics = records.dailyMetrics ?? report.temporalMetrics.map((item) => ({
    regionId: report.region.id,
    observedAt: reportTimestamp,
    metric: item,
  }));

  const save = db.transaction(() => {
    db.query(`INSERT INTO intel_reports(
      context_id, region_id, as_of, report_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(context_id) DO UPDATE SET
      region_id = excluded.region_id,
      as_of = excluded.as_of,
      report_json = excluded.report_json,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at`)
      .run(
        report.contextId,
        report.region.id,
        reportTimestamp,
        JSON.stringify(report),
        reportTimestamp,
        reportTimestamp + REPORT_RETENTION,
      );

    for (const item of records.sources ?? []) {
      db.query(`INSERT INTO country_sources(
        id, region_id, domain, source_type, discovered_at, verified_at,
        verification_status, discovery_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        region_id = excluded.region_id,
        domain = excluded.domain,
        source_type = excluded.source_type,
        discovered_at = excluded.discovered_at,
        verified_at = excluded.verified_at,
        verification_status = excluded.verification_status,
        discovery_method = excluded.discovery_method`)
        .run(
          item.id, item.regionId, item.domain, item.sourceType, epoch(item.discoveredAt),
          epoch(item.verifiedAt), item.verificationStatus, item.discoveryMethod,
        );
    }

    db.query('DELETE FROM intel_provider_runs WHERE report_id = ?').run(report.contextId);
    providerRuns.forEach((item, index) => {
      db.query(`INSERT INTO intel_provider_runs(
        id, report_id, provider, started_at, finished_at, status, item_count,
        coverage_json, latency_ms, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          `${report.contextId}:${index}`,
          report.contextId,
          item.provider,
          epoch(item.startedAt),
          epoch(item.finishedAt),
          item.status,
          item.itemCount,
          json(item.coverage),
          item.latencyMs ?? null,
          item.errorCode ?? null,
        );
    });

    for (const item of evidence) {
      const retrievedAt = epoch(item.retrievedAt)!;
      db.query(`INSERT INTO intel_evidence(
        id, region_id, url, title, publisher, publisher_country, event_country,
        mentioned_countries_json, source_type, language, published_at, retrieved_at,
        excerpt, content_hash, primary_source, latency_class, event_cluster_id, excerpt_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        region_id = excluded.region_id,
        url = excluded.url,
        title = excluded.title,
        publisher = excluded.publisher,
        publisher_country = excluded.publisher_country,
        event_country = excluded.event_country,
        mentioned_countries_json = excluded.mentioned_countries_json,
        source_type = excluded.source_type,
        language = excluded.language,
        published_at = excluded.published_at,
        retrieved_at = excluded.retrieved_at,
        excerpt = excluded.excerpt,
        content_hash = excluded.content_hash,
        primary_source = excluded.primary_source,
        latency_class = excluded.latency_class,
        event_cluster_id = excluded.event_cluster_id,
        excerpt_expires_at = excluded.excerpt_expires_at`)
        .run(
          item.id, item.regionId, item.url, item.title ?? null, item.publisher ?? null,
          item.publisherCountry ?? null, item.eventCountry ?? null, json(item.mentionedCountries),
          item.sourceType, item.language ?? null, epoch(item.publishedAt), retrievedAt,
          item.excerpt ?? null, item.contentHash ?? null, item.primarySource ? 1 : 0,
          item.latencyClass, item.eventClusterId ?? null, retrievedAt + EVIDENCE_RETENTION,
        );
    }

    for (const item of events) {
      const lastSeenAt = epoch(item.lastSeenAt)!;
      db.query(`INSERT INTO intel_events(
        id, report_id, region_id, type, title, occurred_at, location_json, actors_json,
        targets_json, evidence_count, independent_source_count, primary_source_count,
        first_seen_at, last_seen_at, confidence, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        report_id = excluded.report_id,
        region_id = excluded.region_id,
        type = excluded.type,
        title = excluded.title,
        occurred_at = excluded.occurred_at,
        location_json = excluded.location_json,
        actors_json = excluded.actors_json,
        targets_json = excluded.targets_json,
        evidence_count = excluded.evidence_count,
        independent_source_count = excluded.independent_source_count,
        primary_source_count = excluded.primary_source_count,
        first_seen_at = excluded.first_seen_at,
        last_seen_at = excluded.last_seen_at,
        confidence = excluded.confidence,
        expires_at = excluded.expires_at`)
        .run(
          item.id, report.contextId, item.regionId, item.type, item.title,
          epoch(item.occurredAt), json(item.location), JSON.stringify(item.actors),
          JSON.stringify(item.targets), item.evidenceCount, item.independentSourceCount,
          item.primarySourceCount, epoch(item.firstSeenAt), lastSeenAt, item.confidence,
          addCalendarYears(lastSeenAt, 1),
        );
      db.query('DELETE FROM intel_event_evidence WHERE event_id = ?').run(item.id);
      for (const evidenceId of item.evidenceIds) {
        db.query('INSERT INTO intel_event_evidence(event_id, evidence_id) VALUES (?, ?)')
          .run(item.id, evidenceId);
      }
    }

    for (const item of polls) {
      const observedAt = epoch(item.fieldEnd) ?? reportTimestamp;
      db.query(`INSERT INTO intel_poll_observations(
        id, region_id, pollster, field_start, field_end, observed_at, sample_size,
        population, mode, question, responses_json, source_url, evidence_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        region_id = excluded.region_id,
        pollster = excluded.pollster,
        field_start = excluded.field_start,
        field_end = excluded.field_end,
        observed_at = excluded.observed_at,
        sample_size = excluded.sample_size,
        population = excluded.population,
        mode = excluded.mode,
        question = excluded.question,
        responses_json = excluded.responses_json,
        source_url = excluded.source_url,
        evidence_id = excluded.evidence_id`)
        .run(
          item.id, item.regionId, item.pollster, epoch(item.fieldStart), epoch(item.fieldEnd),
          observedAt, item.sampleSize ?? null, item.population ?? null, item.mode ?? null,
          item.question, JSON.stringify(item.responses), item.sourceUrl, item.evidenceId ?? null,
        );
    }

    for (const item of calendarEvents) {
      db.query(`INSERT INTO intel_calendar_events(
        id, region_id, event_at, date, title, type, official,
        related_countries_json, source_url, evidence_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        region_id = excluded.region_id,
        event_at = excluded.event_at,
        date = excluded.date,
        title = excluded.title,
        type = excluded.type,
        official = excluded.official,
        related_countries_json = excluded.related_countries_json,
        source_url = excluded.source_url,
        evidence_id = excluded.evidence_id`)
        .run(
          item.id, report.region.id, epoch(item.date), item.date, item.title, item.type,
          item.official ? 1 : 0, json(item.relatedCountries), item.sourceUrl,
          item.evidenceId ?? null,
        );
    }

    for (const { regionId, observedAt: rawObservedAt, metric } of dailyMetrics) {
      const observedAt = epoch(rawObservedAt)!;
      db.query(`INSERT INTO intel_daily_metrics(
        region_id, observed_at, metric_key, current_value, window, baseline_json,
        anomaly_z, direction, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(region_id, observed_at, metric_key) DO UPDATE SET
        current_value = excluded.current_value,
        window = excluded.window,
        baseline_json = excluded.baseline_json,
        anomaly_z = excluded.anomaly_z,
        direction = excluded.direction,
        expires_at = excluded.expires_at`)
        .run(
          regionId, observedAt, metric.key, metric.current, metric.window, json(metric.baseline),
          metric.anomalyZ ?? null, metric.direction, addCalendarYears(observedAt, 2),
        );
    }
  });
  save();
}

export function getCountryContext(contextId: string): CountryContextReport | undefined {
  const row = getDb().query<{ report_json: string }, [string]>(
    'SELECT report_json FROM intel_reports WHERE context_id = ?',
  ).get(contextId);
  return row ? JSON.parse(row.report_json) as CountryContextReport : undefined;
}

interface CountrySourceRow {
  id: string;
  region_id: string;
  domain: string;
  source_type: string;
  discovered_at: number;
  verified_at: number | null;
  verification_status: CountrySource['verificationStatus'];
  discovery_method: CountrySource['discoveryMethod'];
}

/** 指定 region で検証済みの source を返す。pass2 計画の入力に使う。 */
export function getVerifiedCountrySources(regionId: string): CountrySource[] {
  const rows = getDb().query<CountrySourceRow, [string]>(
    `SELECT id, region_id, domain, source_type, discovered_at, verified_at,
      verification_status, discovery_method
     FROM country_sources
     WHERE region_id = ? AND verification_status = 'verified'
     ORDER BY verified_at DESC`,
  ).all(regionId);
  return rows.map((row) => ({
    id: row.id,
    regionId: row.region_id,
    domain: row.domain,
    sourceType: row.source_type,
    discoveredAt: new Date(row.discovered_at).toISOString(),
    ...(row.verified_at !== null ? { verifiedAt: new Date(row.verified_at).toISOString() } : {}),
    verificationStatus: row.verification_status,
    discoveryMethod: row.discovery_method,
  }));
}

export interface MetricObservationInput {
  regionId: string;
  metricKey: string;
  metricKind: MetricKind;
  window: string;
  bucketStart?: string | number;
  bucketEnd?: string | number;
  observedAt: string | number;
  currentValue: number;
  origin: ObservationOrigin;
  providerIds?: readonly string[];
  evidenceIds?: readonly string[];
  expiresAt?: number;
}

export interface StoredMetricObservation extends MetricObservationInput {
  baselineEligible: boolean;
  expiresAt: number;
}

function epochOrDay(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  const asDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (asDay) return Date.parse(`${asDay[1]}-${asDay[2]}-${asDay[3]}T00:00:00Z`);
  return epoch(value);
}

const OBSERVATION_RETENTION = 2 * 365 * DAY;

/** 観測を保存する。同一次元の再送は置換し、sample を水増ししない。 */
export function saveMetricObservations(inputs: readonly MetricObservationInput[]): void {
  const db = getDb();
  const save = db.transaction(() => {
    for (const input of inputs) {
      const observedAt = epoch(input.observedAt);
      if (observedAt === null) throw new TypeError(`Invalid observedAt: ${input.observedAt}`);
      db.query(`INSERT INTO intel_metric_observations(
        region_id, metric_key, metric_kind, window, bucket_start, bucket_end,
        observed_at, current_value, origin, baseline_eligible,
        provider_ids_json, evidence_ids_json, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(region_id, metric_key, window, bucket_end, origin, observed_at) DO UPDATE SET
        metric_kind = excluded.metric_kind, current_value = excluded.current_value,
        baseline_eligible = excluded.baseline_eligible,
        provider_ids_json = excluded.provider_ids_json, evidence_ids_json = excluded.evidence_ids_json,
        expires_at = excluded.expires_at`)
        .run(
          input.regionId, input.metricKey, input.metricKind, input.window,
          epochOrDay(input.bucketStart), epochOrDay(input.bucketEnd), observedAt, input.currentValue,
          input.origin, isBaselineEligible(input.origin) ? 1 : 0,
          json(input.providerIds ?? []), json(input.evidenceIds ?? []),
          input.expiresAt ?? observedAt + OBSERVATION_RETENTION,
        );
    }
  });
  save();
}

interface MetricObservationRow {
  region_id: string;
  metric_key: string;
  metric_kind: MetricKind;
  window: string;
  bucket_start: number | null;
  bucket_end: number | null;
  observed_at: number;
  current_value: number;
  origin: ObservationOrigin;
  baseline_eligible: number;
  provider_ids_json: string | null;
  evidence_ids_json: string | null;
  expires_at: number;
}

/** baseline 対象の観測だけを bucket 順に返す。ad-hoc は除外する。 */
export function queryBaselineObservations(
  regionId: string,
  metricKey: string,
  window: string,
): StoredMetricObservation[] {
  const rows = getDb().query<MetricObservationRow, [string, string, string]>(
    `SELECT region_id, metric_key, metric_kind, window, bucket_start, bucket_end,
      observed_at, current_value, origin, baseline_eligible,
      provider_ids_json, evidence_ids_json, expires_at
     FROM intel_metric_observations
     WHERE region_id = ? AND metric_key = ? AND window = ? AND baseline_eligible = 1
     ORDER BY bucket_end ASC, observed_at ASC`,
  ).all(regionId, metricKey, window);
  return rows.map((row) => ({
    regionId: row.region_id,
    metricKey: row.metric_key,
    metricKind: row.metric_kind,
    window: row.window,
    ...(row.bucket_start !== null ? { bucketStart: row.bucket_start } : {}),
    ...(row.bucket_end !== null ? { bucketEnd: row.bucket_end } : {}),
    observedAt: row.observed_at,
    currentValue: row.current_value,
    origin: row.origin,
    providerIds: row.provider_ids_json ? JSON.parse(row.provider_ids_json) : [],
    evidenceIds: row.evidence_ids_json ? JSON.parse(row.evidence_ids_json) : [],
    baselineEligible: row.baseline_eligible === 1,
    expiresAt: row.expires_at,
  }));
}

/** 期限切れの観測を削除する。有効な履歴 baseline は残す。 */
export function pruneMetricObservations(now = Date.now()): number {
  const result = getDb().query(`DELETE FROM intel_metric_observations WHERE expires_at < ?`).run(now);
  return Number(result.changes ?? 0);
}

export function pruneCountryIntel(now = Date.now()): CountryIntelPruneResult {
  const db = getDb();
  return db.transaction(() => {
    const expiredDetails = db.query<{ count: number }, [number]>('SELECT count(*) AS count FROM intel_evidence_details WHERE expires_at < ?').get(now)!.count;
    const count = (table: string) => db.query<{ count: number }, [number]>(
      `SELECT count(*) AS count FROM ${table} WHERE expires_at < ?`,
    ).get(now)!.count;
    const result = {
      reports: count('intel_reports'),
      evidenceExcerpts: db.query<{ count: number }, [number]>(
        'SELECT count(*) AS count FROM intel_evidence WHERE excerpt IS NOT NULL AND excerpt_expires_at < ?',
      ).get(now)!.count,
      events: count('intel_events'),
      dailyMetrics: count('intel_daily_metrics'),
      details: expiredDetails,
    };
    db.query('DELETE FROM intel_context_evidence WHERE evidence_id IN (SELECT evidence_id FROM intel_evidence_details WHERE expires_at < ?)').run(now);
    db.query('DELETE FROM intel_evidence_details WHERE expires_at < ?').run(now);
    db.query('DELETE FROM intel_reports WHERE expires_at < ?').run(now);
    db.query(`UPDATE intel_evidence SET excerpt = NULL
      WHERE excerpt IS NOT NULL AND excerpt_expires_at < ?`).run(now);
    db.query('DELETE FROM intel_events WHERE expires_at < ?').run(now);
    db.query('DELETE FROM intel_daily_metrics WHERE expires_at < ?').run(now);
    return result;
  })();
}

export function checkpointCountryIntel(): number {
  const row = getDb().query<{ checkpointed: number }, []>('PRAGMA wal_checkpoint(PASSIVE)').get();
  return row?.checkpointed ?? 0;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function getCountryIntelDbMetrics(): CountryIntelDbMetrics {
  const path = getDb().filename;
  const mainBytes = path === ':memory:' ? 0 : fileSize(path);
  const walBytes = path === ':memory:' ? 0 : fileSize(`${path}-wal`);
  const shmBytes = path === ':memory:' ? 0 : fileSize(`${path}-shm`);
  return { path, mainBytes, walBytes, shmBytes, totalBytes: mainBytes + walBytes + shmBytes };
}

import type { ContextChange, ContextUpdates, EvidenceDetail, EvidencePage, SourceState } from './detail.js';
import { EvidenceDetailSchema } from './detail.js';

interface EvidenceDetailRow {
  evidence_id: string;
  provider_id: string;
  provider_item_id: string;
  source_record_url: string;
  content_kind: EvidenceDetail['contentKind'];
  language: string | null;
  blocks_json: string;
  structured_json: string | null;
  occurred_at: number | null;
  published_at: number | null;
  updated_at: number | null;
  retrieved_at: number;
  valid_from: number | null;
  valid_until: number | null;
  time_basis: string;
  geography_basis: string;
  source_status: EvidenceDetail['sourceStatus'];
  content_truncated: number;
}

function toEvidenceDetail(row: EvidenceDetailRow): EvidenceDetail {
  const asIso = (value: number | null): string | undefined => (value === null ? undefined : new Date(value).toISOString());
  return {
    evidenceId: row.evidence_id,
    providerId: row.provider_id,
    providerItemId: row.provider_item_id,
    sourceRecordUrl: row.source_record_url,
    contentKind: row.content_kind,
    ...(row.language ? { language: row.language } : {}),
    blocks: JSON.parse(row.blocks_json),
    ...(row.structured_json ? { structuredData: JSON.parse(row.structured_json) } : {}),
    ...(asIso(row.occurred_at) ? { occurredAt: asIso(row.occurred_at) } : {}),
    ...(asIso(row.published_at) ? { publishedAt: asIso(row.published_at) } : {}),
    ...(asIso(row.updated_at) ? { updatedAt: asIso(row.updated_at) } : {}),
    retrievedAt: new Date(row.retrieved_at).toISOString(),
    ...(asIso(row.valid_from) ? { validFrom: asIso(row.valid_from) } : {}),
    ...(asIso(row.valid_until) ? { validUntil: asIso(row.valid_until) } : {}),
    timeBasis: row.time_basis,
    geographyBasis: row.geography_basis,
    sourceStatus: row.source_status,
    contentTruncated: row.content_truncated === 1,
  };
}

/** Saves detail rows (context-linked). */
export function saveEvidenceDetails(contextId: string, details: readonly EvidenceDetail[]): void {
  const db = getDb();
  const save = db.transaction(() => {
    details.forEach((raw, index) => {
      const detail = EvidenceDetailSchema.parse(raw);
      const retrievedAt = epoch(detail.retrievedAt);
      if (retrievedAt === null) throw new TypeError('Invalid retrievedAt');
      db.query('INSERT INTO intel_evidence_details(' + 'evidence_id, provider_id, provider_item_id, source_record_url, content_kind, language, blocks_json, structured_json, occurred_at, published_at, updated_at, retrieved_at, valid_from, valid_until, time_basis, geography_basis, source_status, content_truncated, expires_at' + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(evidence_id) DO UPDATE SET provider_id = excluded.provider_id, provider_item_id = excluded.provider_item_id, source_record_url = excluded.source_record_url, content_kind = excluded.content_kind, language = excluded.language, blocks_json = excluded.blocks_json, structured_json = excluded.structured_json, occurred_at = excluded.occurred_at, published_at = excluded.published_at, updated_at = excluded.updated_at, retrieved_at = excluded.retrieved_at, valid_from = excluded.valid_from, valid_until = excluded.valid_until, time_basis = excluded.time_basis, geography_basis = excluded.geography_basis, source_status = excluded.source_status, content_truncated = excluded.content_truncated, expires_at = excluded.expires_at').run(detail.evidenceId, detail.providerId, detail.providerItemId, detail.sourceRecordUrl, detail.contentKind, detail.language ?? null, JSON.stringify(detail.blocks), detail.structuredData ? JSON.stringify(detail.structuredData) : null, epoch(detail.occurredAt), epoch(detail.publishedAt), epoch(detail.updatedAt), retrievedAt, epoch(detail.validFrom), epoch(detail.validUntil), detail.timeBasis, detail.geographyBasis, detail.sourceStatus, detail.contentTruncated ? 1 : 0, retrievedAt + EVIDENCE_RETENTION);
      db.query('INSERT INTO intel_context_evidence(context_id, evidence_id, sort_key) VALUES (?, ?, ?) ON CONFLICT(context_id, evidence_id) DO UPDATE SET sort_key = excluded.sort_key').run(contextId, detail.evidenceId, String(index).padStart(6, '0'));
    });
  });
  save();
}

export function getEvidenceDetails(contextId: string, ids: readonly string[]): EvidenceDetail[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const out: EvidenceDetail[] = [];
  for (const id of ids) {
    const row = db.query<EvidenceDetailRow, [string, string]>('SELECT d.evidence_id, d.provider_id, d.provider_item_id, d.source_record_url, d.content_kind, d.language, d.blocks_json, d.structured_json, d.occurred_at, d.published_at, d.updated_at, d.retrieved_at, d.valid_from, d.valid_until, d.time_basis, d.geography_basis, d.source_status, d.content_truncated FROM intel_evidence_details d INNER JOIN intel_context_evidence c ON c.evidence_id = d.evidence_id WHERE c.context_id = ? AND d.evidence_id = ?').get(contextId, id);
    if (row) out.push(toEvidenceDetail(row));
  }
  return out;
}

interface SourceStateRow {
  source_id: string;
  last_checked_at: number | null;
  last_success_at: number | null;
  provider_updated_at: number | null;
  last_error_code: string | null;
  etag: string | null;
  last_modified: string | null;
  retry_at: number | null;
  cursor: string | null;
}

export function readSourceState(sourceId: string): SourceState | undefined {
  const row = getDb().query<SourceStateRow, [string]>('SELECT source_id, last_checked_at, last_success_at, provider_updated_at, last_error_code, etag, last_modified, retry_at, cursor FROM intel_source_states WHERE source_id = ?').get(sourceId);
  if (!row) return undefined;
  const asIso = (value: number | null): string | undefined => (value === null ? undefined : new Date(value).toISOString());
  return {
    sourceId: row.source_id,
    ...(asIso(row.last_checked_at) ? { lastCheckedAt: asIso(row.last_checked_at) } : {}),
    ...(asIso(row.last_success_at) ? { lastSuccessfulFetchAt: asIso(row.last_success_at) } : {}),
    ...(asIso(row.provider_updated_at) ? { providerUpdatedAt: asIso(row.provider_updated_at) } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.etag ? { etag: row.etag } : {}),
    ...(row.last_modified ? { lastModified: row.last_modified } : {}),
    ...(asIso(row.retry_at) ? { retryAt: asIso(row.retry_at) } : {}),
    ...(row.cursor ? { cursor: row.cursor } : {}),
  };
}

export function writeSourceState(state: SourceState): void {
  const toEpoch = (value: string | undefined): number | null => (value === undefined ? null : epoch(value));
  getDb().query('INSERT INTO intel_source_states(source_id, last_checked_at, last_success_at, provider_updated_at, last_error_code, etag, last_modified, retry_at, cursor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET last_checked_at = excluded.last_checked_at, last_success_at = excluded.last_success_at, provider_updated_at = excluded.provider_updated_at, last_error_code = excluded.last_error_code, etag = excluded.etag, last_modified = excluded.last_modified, retry_at = excluded.retry_at, cursor = excluded.cursor').run(state.sourceId, toEpoch(state.lastCheckedAt), toEpoch(state.lastSuccessfulFetchAt), toEpoch(state.providerUpdatedAt), state.lastErrorCode ?? null, state.etag ?? null, state.lastModified ?? null, toEpoch(state.retryAt), state.cursor ?? null);
}

const PAGE_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

function encodePageCursor(contextId: string, offset: number, now: number): string {
  return Buffer.from(JSON.stringify({ v: 1, contextId, offset, exp: now + PAGE_CURSOR_TTL_MS }), 'utf8').toString('base64url');
}

function decodePageCursor(contextId: string, cursor: string, now: number): number {
  let payload: { v?: unknown; contextId?: unknown; offset?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new RangeError('Invalid evidence page cursor');
  }
  if (payload.v !== 1 || payload.contextId !== contextId || typeof payload.offset !== 'number' || payload.offset < 0 || !(typeof payload.exp === 'number' && payload.exp > now)) {
    throw new RangeError('Invalid evidence page cursor');
  }
  return Math.floor(payload.offset);
}

function countContextEvidence(contextId: string): number {
  const row = getDb().query<{ count: number }, [string]>('SELECT count(*) AS count FROM intel_context_evidence WHERE context_id = ?').get(contextId);
  return row?.count ?? 0;
}

export function getEvidencePage(contextId: string, options: { ids?: readonly string[]; cursor?: string; limit?: number } = {}): EvidencePage {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
  const totalStored = countContextEvidence(contextId);
  if (options.ids) {
    return { contextId, items: getEvidenceDetails(contextId, options.ids).slice(0, limit), totalStored };
  }
  const offset = options.cursor ? decodePageCursor(contextId, options.cursor, Date.now()) : 0;
  const rows = getDb().query<{ evidence_id: string }, [string, number, number]>('SELECT evidence_id FROM intel_context_evidence WHERE context_id = ? ORDER BY sort_key ASC, evidence_id ASC LIMIT ? OFFSET ?').all(contextId, limit + 1, offset);
  const pageIds = rows.slice(0, limit).map((row) => row.evidence_id);
  const byId = new Map(getEvidenceDetails(contextId, pageIds).map((detail) => [detail.evidenceId, detail]));
  return {
    contextId,
    items: pageIds.flatMap((id) => { const detail = byId.get(id); return detail ? [detail] : []; }),
    totalStored,
    ...(rows.length > limit ? { nextCursor: encodePageCursor(contextId, offset + limit, Date.now()) } : {}),
  };
}

interface ContextChangeRow {
  id: string;
  context_id: string;
  observed_at: number;
  change_kind: string;
  evidence_id: string | null;
  summary_json: string | null;
}

export function getContextUpdates(contextId: string, cursor?: string): ContextUpdates {
  const since = cursor ? Date.parse(cursor) : 0;
  if (cursor && !Number.isFinite(since)) throw new RangeError('Invalid updates cursor');
  const rows = getDb().query<ContextChangeRow, [string, number]>('SELECT id, context_id, observed_at, change_kind, evidence_id, summary_json FROM intel_context_changes WHERE context_id = ? AND observed_at > ? ORDER BY observed_at ASC LIMIT 100').all(contextId, Number.isFinite(since) ? since : 0);
  const changes: ContextChange[] = rows.map((row) => ({
    id: row.id,
    contextId: row.context_id,
    observedAt: new Date(row.observed_at).toISOString(),
    changeKind: row.change_kind,
    ...(row.evidence_id ? { evidenceId: row.evidence_id } : {}),
    ...(row.summary_json ? { summary: JSON.parse(row.summary_json) } : {}),
  }));
  const last = changes.at(-1);
  return { contextId, changes, ...(last ? { nextCursor: last.observedAt } : {}) };
}

const HOT_OBSERVATION_RETENTION = 30 * DAY;

export interface HotObservationInput {
  sourceId: string;
  topicId: string;
  regionId: string;
  observedAt: string | number;
  rank?: number | null;
  hot?: string;
  pinned?: boolean;
  title: string;
  url: string;
  upstreamUpdatedAt?: string | number;
}

export interface HotObservation {
  sourceId: string;
  topicId: string;
  regionId: string;
  observedAt: string;
  rank?: number;
  hot?: string;
  pinned: boolean;
  title: string;
  url: string;
  upstreamUpdatedAt?: string;
}

/** 熱榜の観測履歴を保存する。同一次元の再送は置換する。 */
export function saveHotObservations(inputs: readonly HotObservationInput[]): void {
  const db = getDb();
  const save = db.transaction(() => {
    for (const input of inputs) {
      const observedAt = epoch(input.observedAt);
      if (observedAt === null) throw new TypeError('Invalid observedAt: ' + String(input.observedAt));
      const upstream = input.upstreamUpdatedAt === undefined ? null : epoch(input.upstreamUpdatedAt);
      if (input.upstreamUpdatedAt !== undefined && upstream === null) throw new TypeError('Invalid upstreamUpdatedAt');
      db.query('INSERT INTO intel_hot_observations(source_id, topic_id, region_id, observed_at, rank, hot, pinned, title, url, upstream_updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, topic_id, observed_at) DO UPDATE SET region_id = excluded.region_id, rank = excluded.rank, hot = excluded.hot, pinned = excluded.pinned, title = excluded.title, url = excluded.url, upstream_updated_at = excluded.upstream_updated_at, expires_at = excluded.expires_at')
        .run(input.sourceId, input.topicId, input.regionId, observedAt, input.rank ?? null, input.hot ?? null, input.pinned ? 1 : 0, input.title, input.url, upstream, observedAt + HOT_OBSERVATION_RETENTION);
    }
  });
  save();
}

interface HotObservationRow {
  source_id: string;
  topic_id: string;
  region_id: string;
  observed_at: number;
  rank: number | null;
  hot: string | null;
  pinned: number;
  title: string;
  url: string;
  upstream_updated_at: number | null;
}

function toHotObservation(row: HotObservationRow): HotObservation {
  return {
    sourceId: row.source_id,
    topicId: row.topic_id,
    regionId: row.region_id,
    observedAt: new Date(row.observed_at).toISOString(),
    ...(row.rank !== null ? { rank: row.rank } : {}),
    ...(row.hot ? { hot: row.hot } : {}),
    pinned: row.pinned === 1,
    title: row.title,
    url: row.url,
    ...(row.upstream_updated_at !== null ? { upstreamUpdatedAt: new Date(row.upstream_updated_at).toISOString() } : {}),
  };
}

function hotSnapshotAt(sourceId: string, observedAt: number): HotObservation[] {
  const rows = getDb().query<HotObservationRow, [string, number]>('SELECT source_id, topic_id, region_id, observed_at, rank, hot, pinned, title, url, upstream_updated_at FROM intel_hot_observations WHERE source_id = ? AND observed_at = ? ORDER BY rank ASC, topic_id ASC').all(sourceId, observedAt);
  return rows.map(toHotObservation);
}

/** 最新と直前の観測スナップショットを返す。差分計算用。 */
export function latestHotSnapshots(sourceId: string): { latest: HotObservation[]; previous: HotObservation[] } {
  const stamps = getDb().query<{ observed_at: number }, [string]>('SELECT DISTINCT observed_at FROM intel_hot_observations WHERE source_id = ? ORDER BY observed_at DESC LIMIT 2').all(sourceId);
  const latest = stamps[0] ? hotSnapshotAt(sourceId, stamps[0].observed_at) : [];
  const previous = stamps[1] ? hotSnapshotAt(sourceId, stamps[1].observed_at) : [];
  return { latest, previous };
}

/** 期限切れの熱榜観測を削除する。 */
export function pruneHotObservations(now = Date.now()): number {
  const result = getDb().query('DELETE FROM intel_hot_observations WHERE expires_at < ?').run(now);
  return Number(result.changes ?? 0);
}
