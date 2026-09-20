import type { Database } from 'bun:sqlite';
import { statSync } from 'fs';
import { applyMigrations, getDb } from '../../db.js';
import { COUNTRY_INTEL_MIGRATIONS } from './migrations.js';
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
  evidence: number;
  events: number;
  dailyMetrics: number;
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
  if (!Number.isFinite(timestamp)) throw new TypeError(`Invalid timestamp: ${value}`);
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
        excerpt, content_hash, primary_source, latency_class, event_cluster_id, expires_at
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
        expires_at = excluded.expires_at`)
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
          item.question, JSON.stringify(item.responses), item.sourceUrl, item.evidenceId,
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

export function pruneCountryIntel(now = Date.now()): CountryIntelPruneResult {
  const db = getDb();
  return db.transaction(() => {
    const count = (table: string) => db.query<{ count: number }, [number]>(
      `SELECT count(*) AS count FROM ${table} WHERE expires_at < ?`,
    ).get(now)!.count;
    const result = {
      reports: count('intel_reports'),
      evidence: count('intel_evidence'),
      events: count('intel_events'),
      dailyMetrics: count('intel_daily_metrics'),
    };
    db.query('DELETE FROM intel_reports WHERE expires_at < ?').run(now);
    db.query('DELETE FROM intel_evidence WHERE expires_at < ?').run(now);
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
