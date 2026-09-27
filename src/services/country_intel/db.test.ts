import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyMigrations, closeDb, getDb, initDatabase } from '../../db.js';
import {
  checkpointCountryIntel,
  getCountryContext,
  getCountryIntelDbMetrics,
  pruneCountryIntel,
  runMigrations,
  saveCountryContext,
  saveEvidenceDetails,
  getEvidenceDetails,
} from './db.js';
import type {
  CalendarEvent,
  CountryContextReport,
  CountryEvidence,
  CountrySource,
  IntelEvent,
  PollObservation,
  TemporalMetric,
} from './types.js';

const DAY = 86_400_000;
let directory: string;
let databasePath: string;
let previousDatabasePath: string | undefined;

function createLegacyDatabase(path: string): void {
  const db = new Database(path, { create: true });
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE watch_targets (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, selector TEXT,
    last_hash TEXT, last_content TEXT, webhook_url TEXT,
    interval_seconds INTEGER DEFAULT 3600, last_checked_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE cache_entries (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE domain_cookies (
    domain TEXT PRIMARY KEY, cookies_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE domain_storage (
    domain TEXT PRIMARY KEY, storage_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.query('INSERT INTO watch_targets(id, url, created_at) VALUES (?, ?, ?)')
    .run('watch-existing', 'https://example.com', 1);
  db.query('INSERT INTO cache_entries(key, value, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run('cache-existing', '{}', Number.MAX_SAFE_INTEGER, 1);
  db.query('INSERT INTO domain_cookies(domain, cookies_json, updated_at) VALUES (?, ?, ?)')
    .run('cookie.example', '[]', 1);
  db.query('INSERT INTO domain_storage(domain, storage_json, updated_at) VALUES (?, ?, ?)')
    .run('storage.example', '{}', 1);
  db.close();
}

function evidence(id: string, retrievedAt: number): CountryEvidence {
  return {
    id,
    regionId: 'country:KR',
    url: `https://news.example/${id}`,
    title: `Evidence ${id}`,
    publisher: 'Example News',
    publisherCountry: 'US',
    eventCountry: 'KR',
    mentionedCountries: ['JP'],
    sourceType: 'international_media',
    language: 'en',
    publishedAt: new Date(retrievedAt - 1_000).toISOString(),
    retrievedAt: new Date(retrievedAt).toISOString(),
    excerpt: 'A factual excerpt.',
    contentHash: `hash-${id}`,
    primarySource: false,
    latencyClass: 'near_realtime',
    eventClusterId: `event-${id}`,
  };
}

function event(id: string, evidenceId: string, lastSeenAt: number): IntelEvent {
  return {
    id,
    regionId: 'country:KR',
    type: 'statement',
    title: `Event ${id}`,
    occurredAt: new Date(lastSeenAt - 1_000).toISOString(),
    location: { name: 'Seoul', countryCode: 'KR' },
    actors: [{ name: 'Example Ministry', type: 'government', countryCode: 'KR' }],
    targets: [{ name: 'Japan', type: 'country', countryCode: 'JP' }],
    evidenceIds: [evidenceId],
    evidenceCount: 1,
    independentSourceCount: 1,
    primarySourceCount: 0,
    firstSeenAt: new Date(lastSeenAt - 2_000).toISOString(),
    lastSeenAt: new Date(lastSeenAt).toISOString(),
    confidence: 'medium',
  };
}

function poll(id: string, evidenceId: string, timestamp: number): PollObservation {
  return {
    id,
    regionId: 'country:KR',
    pollster: 'Example Polling',
    fieldStart: new Date(timestamp - DAY).toISOString(),
    fieldEnd: new Date(timestamp).toISOString(),
    sampleSize: 1_000,
    population: 'adults',
    mode: 'online',
    question: 'Example question?',
    responses: [{ label: 'yes', value: 50 }],
    sourceUrl: 'https://poll.example/result',
    evidenceId,
  };
}

function calendar(id: string, evidenceId: string, timestamp: number): CalendarEvent {
  return {
    id,
    date: new Date(timestamp).toISOString().slice(0, 10),
    title: 'Example observance',
    type: 'official_observance',
    official: true,
    relatedCountries: ['KR', 'JP'],
    sourceUrl: 'https://calendar.example/event',
    evidenceId,
  };
}

function metric(key = 'media_cluster_count'): TemporalMetric {
  return {
    key,
    current: 2,
    window: '24h',
    baseline: { median: 1, mad: 0.5, sampleCount: 5, origin: 'local_observed' },
    anomalyZ: 1.349,
    direction: 'rising',
  };
}

function report(contextId: string, asOf: number, itemEvidence: CountryEvidence, itemEvent: IntelEvent): CountryContextReport {
  const section = { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] };
  const domains = {
    content: { regionId: 'country:KR', attention: [], disaster: [], socialActivity: [], calendar: [], coverage: 'limited' as const },
    marketing: { regionId: 'country:KR', attention: [], businessActivity: [], calendar: [], socialActivity: [], disruption: [], coverage: 'limited' as const },
    travel: { regionId: 'country:KR', disruptionSignals: [], disasterSignals: [], healthSignals: [], calendarSignals: [], coverage: 'limited' as const },
    finance: { regionId: 'country:KR', economy: [], trade: [], businessAction: [], policyActivity: [], coverage: 'limited' as const },
  };
  const coverageByArea = {
    politics: 'partial', economy: 'limited', security: 'limited', disaster: 'limited',
    health: 'limited', polls: 'partial', media: 'partial', social: 'limited',
    calendar: 'partial', foreignRelations: 'partial',
  } as const;
  return {
    contextId,
    region: {
      id: 'country:KR', name: 'South Korea', nativeName: '한국', countryCode: 'KR',
      languages: ['ko'], aliases: ['Korea'], timezone: 'Asia/Seoul', confidence: 'high',
    },
    asOf: new Date(asOf).toISOString(),
    situation: {
      politics: section, economy: section, security: section, disasters: section,
      health: section, humanitarian: section, social: section,
    },
    elections: [],
    calendar: [calendar(`calendar-${contextId}`, itemEvidence.id, asOf)],
    foreignRelations: [],
    polls: [poll(`poll-${contextId}`, itemEvidence.id, asOf)],
    keyEvents: [itemEvent],
    temporalMetrics: [metric()],
    signals: [],
    domains,
    providerCoverage: [{
      provider: 'fixture', startedAt: new Date(asOf - 100).toISOString(),
      finishedAt: new Date(asOf).toISOString(), status: 'success', itemCount: 1,
      coverage: ['politics'], latencyMs: 100,
    }],
    coverage: {
      overall: 'partial', byArea: coverageByArea,
      missingEvidence: ['economy'], unavailableProviders: [],
    },
    evidence: [itemEvidence],
  };
}

function source(timestamp: number): CountrySource {
  return {
    id: 'source-existing', regionId: 'country:KR', domain: 'news.example',
    sourceType: 'international_media', discoveredAt: new Date(timestamp).toISOString(),
    verifiedAt: new Date(timestamp).toISOString(), verificationStatus: 'verified',
    discoveryMethod: 'manual_seed',
  };
}

beforeEach(() => {
  closeDb();
  previousDatabasePath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'sora-country-intel-db-'));
  databasePath = join(directory, 'sora.db');
  process.env.SORA_DB_PATH = databasePath;
  createLegacyDatabase(databasePath);
});

afterEach(() => {
  closeDb();
  if (previousDatabasePath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousDatabasePath;
  rmSync(directory, { recursive: true, force: true });
});

test('migrates a legacy file idempotently with foreign keys and required indexes', () => {
  const db = initDatabase();
  const tableNames = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all().map(({ name }) => name);
  expect(tableNames).toEqual(expect.arrayContaining([
    'schema_migrations', 'country_sources', 'intel_provider_runs', 'intel_evidence',
    'intel_events', 'intel_event_evidence', 'intel_poll_observations',
    'intel_daily_metrics', 'intel_reports', 'intel_calendar_events',
  ]));
  expect(db.query('SELECT id FROM watch_targets').get()).toEqual({ id: 'watch-existing' });
  expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  expect(db.query<{ table: string }, []>("PRAGMA foreign_key_list('intel_provider_runs')").all())
    .toContainEqual(expect.objectContaining({ table: 'intel_reports' }));
  expect(db.query<{ table: string }, []>("PRAGMA foreign_key_list('intel_event_evidence')").all())
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'intel_events' }),
      expect.objectContaining({ table: 'intel_evidence' }),
    ]));
  expect(db.query<{ table: string; on_delete: string }, []>("PRAGMA foreign_key_list('intel_events')").all())
    .toContainEqual(expect.objectContaining({ table: 'intel_reports', on_delete: 'SET NULL' }));
  expect(db.query<{ table: string; on_delete: string }, []>("PRAGMA foreign_key_list('intel_poll_observations')").all())
    .toContainEqual(expect.objectContaining({ table: 'intel_evidence', on_delete: 'SET NULL' }));
  expect(db.query<{ table: string; on_delete: string }, []>("PRAGMA foreign_key_list('intel_calendar_events')").all())
    .toContainEqual(expect.objectContaining({ table: 'intel_evidence', on_delete: 'SET NULL' }));

  const migrationCount = db.query<{ count: number }, []>('SELECT count(*) AS count FROM schema_migrations').get()!.count;
  runMigrations(db);
  expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM schema_migrations').get()!.count)
    .toBe(migrationCount);

  const indexes = [
    ...db.query<{ name: string }, []>("PRAGMA index_list('country_sources')").all(),
    ...db.query<{ name: string }, []>("PRAGMA index_list('intel_provider_runs')").all(),
    ...db.query<{ name: string }, []>("PRAGMA index_list('intel_evidence')").all(),
    ...db.query<{ name: string }, []>("PRAGMA index_list('intel_events')").all(),
    ...db.query<{ name: string }, []>("PRAGMA index_list('intel_event_evidence')").all(),
    ...db.query<{ name: string }, []>("PRAGMA index_list('intel_poll_observations')").all(),
    ...db.query<{ name: string }, []>("PRAGMA index_list('intel_daily_metrics')").all(),
    ...db.query<{ name: string }, []>("PRAGMA index_list('intel_reports')").all(),
    ...db.query<{ name: string }, []>("PRAGMA index_list('intel_calendar_events')").all(),
  ].map(({ name }) => name);
  expect(indexes).toEqual(expect.arrayContaining([
    'idx_country_sources_region', 'idx_country_sources_domain',
    'idx_provider_runs_report', 'idx_provider_runs_provider_started',
    'idx_evidence_region_published', 'idx_evidence_retrieved', 'idx_evidence_excerpt_expires',
    'idx_events_region_occurred', 'idx_events_report', 'idx_events_expires',
    'idx_event_evidence_evidence', 'idx_polls_region_observed',
    'idx_daily_metrics_region_observed', 'idx_daily_metrics_expires',
    'idx_reports_region_as_of', 'idx_reports_expires', 'idx_calendar_region_event',
  ]));

  for (const [table, columns] of [
    ['intel_reports', ['as_of', 'created_at', 'expires_at']],
    ['intel_evidence', ['published_at', 'retrieved_at', 'excerpt_expires_at']],
    ['intel_events', ['occurred_at', 'first_seen_at', 'last_seen_at', 'expires_at']],
    ['intel_provider_runs', ['started_at', 'finished_at']],
    ['country_sources', ['discovered_at', 'verified_at']],
    ['intel_poll_observations', ['field_start', 'field_end', 'observed_at']],
    ['intel_daily_metrics', ['observed_at', 'expires_at']],
    ['intel_calendar_events', ['event_at']],
  ] as const) {
    const info = db.query<{ name: string; type: string }, []>(`PRAGMA table_info('${table}')`).all();
    for (const column of columns) expect(info.find(({ name }) => name === column)?.type).toBe('INTEGER');
  }
});

test('rolls back both schema and migration record when a migration fails', () => {
  const db = new Database(':memory:');
  expect(() => applyMigrations(db, [{
    version: 999,
    name: 'fails atomically',
    up(database) {
      database.run('CREATE TABLE must_rollback (id INTEGER PRIMARY KEY)');
      throw new Error('migration failure');
    },
  }])).toThrow('migration failure');
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'must_rollback'").get()).toBeNull();
  expect(db.query('SELECT version FROM schema_migrations WHERE version = 999').get()).toBeNull();
  db.close();
});

test('persists every report record atomically and survives close and reopen', () => {
  initDatabase();
  const now = Date.UTC(2026, 8, 21);
  const itemEvidence = evidence('evidence-persisted', now);
  const itemEvent = event('event-persisted', itemEvidence.id, now);
  const itemReport = report('ctx_test', now, itemEvidence, itemEvent);
  saveCountryContext(itemReport, { sources: [source(now)] });

  closeDb();
  const reopened = initDatabase();
  expect(reopened.query('SELECT id FROM watch_targets').get()).toEqual({ id: 'watch-existing' });
  expect(getCountryContext('ctx_test')).toEqual(itemReport);
  for (const table of [
    'country_sources', 'intel_provider_runs', 'intel_evidence', 'intel_events',
    'intel_event_evidence', 'intel_poll_observations', 'intel_daily_metrics',
    'intel_reports', 'intel_calendar_events',
  ]) {
    expect(reopened.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count)
      .toBeGreaterThan(0);
  }

  const brokenEvidence = evidence('evidence-rollback', now);
  const brokenReport = report(
    'ctx_rollback',
    now,
    brokenEvidence,
    event('event-rollback', 'missing-evidence', now),
  );
  expect(() => saveCountryContext(brokenReport)).toThrow();
  expect(getCountryContext('ctx_rollback')).toBeUndefined();
  expect(reopened.query('SELECT id FROM intel_evidence WHERE id = ?').get('evidence-rollback')).toBeNull();
  expect(reopened.query('SELECT id FROM intel_events WHERE id = ?').get('event-rollback')).toBeNull();
});

test('prunes only expired country intelligence rows and keeps retention boundaries', () => {
  const db = initDatabase();
  const now = Date.UTC(2026, 8, 21);
  const oldEvidence = evidence('evidence-expired', now - 181 * DAY);
  const recentEvent = event('event-recent', oldEvidence.id, now - DAY);
  const oldReport = report('ctx_expired', now - 91 * DAY, oldEvidence, recentEvent);
  saveCountryContext(oldReport, {
    sources: [source(now - 1_000 * DAY)],
    dailyMetrics: [
      { regionId: 'country:KR', observedAt: now - 730 * DAY, metric: metric('boundary') },
      { regionId: 'country:KR', observedAt: now - 730 * DAY - 1, metric: metric('expired') },
    ],
  });

  const expiredEventEvidence = evidence('evidence-old-event', now - 500 * DAY);
  const expiredEvent = event('event-expired', expiredEventEvidence.id, now - 366 * DAY);
  saveCountryContext(report('ctx_recent', now, expiredEventEvidence, expiredEvent));

  const result = pruneCountryIntel(now);
  expect(result).toEqual({ reports: 1, evidenceExcerpts: 2, events: 1, dailyMetrics: 1, details: 0 });
  expect(db.query('SELECT context_id FROM intel_reports WHERE context_id = ?').get('ctx_expired')).toBeNull();
  expect(db.query('SELECT id, report_id FROM intel_events WHERE id = ?').get('event-recent'))
    .toEqual({ id: 'event-recent', report_id: null });
  expect(db.query('SELECT id, excerpt FROM intel_evidence ORDER BY id').all()).toEqual([
    { id: 'evidence-expired', excerpt: null },
    { id: 'evidence-old-event', excerpt: null },
  ]);
  expect(db.query('SELECT event_id, evidence_id FROM intel_event_evidence').all())
    .toEqual([{ event_id: 'event-recent', evidence_id: 'evidence-expired' }]);
  expect(db.query('SELECT metric_key FROM intel_daily_metrics ORDER BY metric_key').all())
    .toEqual([{ metric_key: 'boundary' }, { metric_key: 'media_cluster_count' }]);
  expect(db.query('SELECT id FROM country_sources').get()).toEqual({ id: 'source-existing' });
  expect(db.query('SELECT id FROM intel_poll_observations WHERE id = ?').get('poll-ctx_expired'))
    .toEqual({ id: 'poll-ctx_expired' });
  expect(db.query('SELECT id FROM watch_targets').get()).toEqual({ id: 'watch-existing' });
  expect(db.query('SELECT key FROM cache_entries').get()).toEqual({ key: 'cache-existing' });
  expect(db.query('SELECT domain FROM domain_cookies').get()).toEqual({ domain: 'cookie.example' });
  expect(db.query('SELECT domain FROM domain_storage').get()).toEqual({ domain: 'storage.example' });

  closeDb();
  const reopened = initDatabase();
  expect(reopened.query('SELECT id FROM watch_targets').get()).toEqual({ id: 'watch-existing' });
  expect(reopened.query('SELECT key FROM cache_entries').get()).toEqual({ key: 'cache-existing' });
  expect(reopened.query('SELECT domain FROM domain_cookies').get()).toEqual({ domain: 'cookie.example' });
  expect(reopened.query('SELECT domain FROM domain_storage').get()).toEqual({ domain: 'storage.example' });
  expect(pruneCountryIntel(now)).toEqual({ reports: 0, evidenceExcerpts: 0, events: 0, dailyMetrics: 0, details: 0 });
});

test('nulls poll and calendar evidence links when evidence metadata is explicitly deleted', () => {
  const db = initDatabase();
  const now = Date.UTC(2026, 8, 21);
  const itemEvidence = evidence('evidence-fk-lifecycle', now);
  const itemEvent = event('event-fk-lifecycle', itemEvidence.id, now);
  const itemReport = report('ctx_fk_lifecycle', now, itemEvidence, itemEvent);
  saveCountryContext(itemReport);

  db.query('DELETE FROM intel_evidence WHERE id = ?').run(itemEvidence.id);

  expect(db.query('SELECT evidence_id FROM intel_poll_observations WHERE id = ?').get('poll-ctx_fk_lifecycle'))
    .toEqual({ evidence_id: null });
  expect(db.query('SELECT evidence_id FROM intel_calendar_events WHERE id = ?').get('calendar-ctx_fk_lifecycle'))
    .toEqual({ evidence_id: null });
  expect(db.query('SELECT event_id FROM intel_event_evidence WHERE event_id = ?').get(itemEvent.id)).toBeNull();
});

test('rejects fractional and out-of-range numeric epoch milliseconds atomically', () => {
  initDatabase();
  const now = Date.UTC(2026, 8, 21);
  const itemEvidence = evidence('evidence-invalid-epoch', now);
  const itemEvent = event('event-invalid-epoch', itemEvidence.id, now);

  for (const [contextId, observedAt] of [
    ['ctx_fractional_epoch', now + 0.5],
    ['ctx_out_of_range_epoch', Number.MAX_SAFE_INTEGER],
  ] as const) {
    const itemReport = report(contextId, now, itemEvidence, itemEvent);
    expect(() => saveCountryContext(itemReport, {
      dailyMetrics: [{ regionId: 'country:KR', observedAt, metric: metric() }],
    })).toThrow();
    expect(getCountryContext(contextId)).toBeUndefined();
  }
});

test('passively checkpoints WAL and reports main WAL and SHM sizes', () => {
  initDatabase();
  getDb().query('INSERT INTO cache_entries(key, value, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run('wal-write', '{}', Date.now() + DAY, Date.now());
  expect(checkpointCountryIntel()).toBeGreaterThanOrEqual(0);
  const metrics = getCountryIntelDbMetrics();
  expect(metrics.path).toBe(databasePath);
  expect(metrics.mainBytes).toBeGreaterThan(0);
  expect(metrics.walBytes).toBeGreaterThanOrEqual(0);
  expect(metrics.shmBytes).toBeGreaterThanOrEqual(0);
  expect(metrics.totalBytes).toBe(metrics.mainBytes + metrics.walBytes + metrics.shmBytes);
});

test('retains events for one calendar year and daily metrics for two across leap day', () => {
  initDatabase();
  const pruneAt = Date.UTC(2024, 1, 29, 12);
  const itemEvidence = evidence('evidence-leap-retention', pruneAt);
  const itemEvent = event('event-leap-retention', itemEvidence.id, Date.UTC(2023, 2, 1));
  saveCountryContext(report('ctx_leap_retention', pruneAt, itemEvidence, itemEvent), {
    dailyMetrics: [{
      regionId: 'country:KR',
      observedAt: Date.UTC(2022, 2, 1),
      metric: metric('leap-retention'),
    }],
  });

  expect(pruneCountryIntel(pruneAt)).toEqual({ reports: 0, evidenceExcerpts: 0, events: 0, dailyMetrics: 0, details: 0 });
  expect(getDb().query('SELECT id FROM intel_events WHERE id = ?').get(itemEvent.id)).toEqual({ id: itemEvent.id });
  expect(getDb().query('SELECT metric_key FROM intel_daily_metrics WHERE metric_key = ?').get('leap-retention'))
    .toEqual({ metric_key: 'leap-retention' });
});

test('persists evidence details with context links and survives reopen', () => {
  const details = [{
    evidenceId: 'evd-test-1',
    providerId: 'gdacs',
    providerItemId: 'FL-1104081-19',
    sourceRecordUrl: 'https://www.gdacs.org/report.aspx?eventid=1104081&episodeid=19&eventtype=FL',
    contentKind: 'structured_record' as const,
    blocks: [{ index: 0, text: 'Flood affecting Myanmar and China' }],
    structuredData: { affectedCountryCodes: ['MM', 'CN'] },
    retrievedAt: '2026-09-22T00:00:00.000Z',
    timeBasis: 'retrieved',
    geographyBasis: 'provider_affected_countries',
    sourceStatus: 'unverified' as const,
    contentTruncated: false,
  }];
  saveEvidenceDetails('ctx-detail-1', details);
  closeDb();
  expect(getEvidenceDetails('ctx-detail-1', ['evd-test-1'])).toEqual(details);
  expect(getEvidenceDetails('ctx-other', ['evd-test-1'])).toEqual([]);
});
