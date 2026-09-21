import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb, initDatabase } from '../../db.js';
import {
  pruneMetricObservations,
  queryBaselineObservations,
  runMigrations,
  saveMetricObservations,
  type MetricObservationInput,
} from './db.js';

let directory: string;
let previousDatabasePath: string | undefined;

function observation(overrides: Partial<MetricObservationInput> = {}): MetricObservationInput {
  return {
    regionId: 'country:KR',
    metricKey: 'protest_event_count',
    metricKind: 'count',
    window: '7d',
    bucketEnd: '2026-09-19',
    observedAt: '2026-09-19T00:00:00Z',
    currentValue: 3,
    origin: 'scheduled_local',
    providerIds: ['gdelt'],
    evidenceIds: ['ev-1'],
    ...overrides,
  };
}

beforeEach(() => {
  closeDb();
  previousDatabasePath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-obs-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
  const legacy = new Database(join(directory, 'test.db'), { create: true });
  legacy.run(`CREATE TABLE watch_targets (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, selector TEXT,
    last_hash TEXT, last_content TEXT, webhook_url TEXT,
    interval_seconds INTEGER DEFAULT 3600, last_checked_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  legacy.query('INSERT INTO watch_targets(id, url, created_at) VALUES (?, ?, ?)').run('watch-existing', 'https://example.com', 1);
  legacy.close();
  initDatabase();
});

afterEach(() => {
  closeDb();
  if (previousDatabasePath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousDatabasePath;
  rmSync(directory, { recursive: true, force: true });
});

test('migration preserves existing watch and country intelligence rows', () => {
  saveMetricObservations([observation()]);
  runMigrations(getDb());
  const watch = getDb().query<{ id: string }, []>('SELECT id FROM watch_targets').all();
  expect(watch).toEqual([{ id: 'watch-existing' }]);
  expect(queryBaselineObservations('country:KR', 'protest_event_count', '7d')).toHaveLength(1);
});

test('window is part of metric observation identity', () => {
  saveMetricObservations([observation({ window: '7d' }), observation({ window: '30d' })]);
  saveMetricObservations([observation({ window: '7d' })]);
  expect(queryBaselineObservations('country:KR', 'protest_event_count', '7d')).toHaveLength(1);
  expect(queryBaselineObservations('country:KR', 'protest_event_count', '30d')).toHaveLength(1);
});

test('ad-hoc observations are persisted but excluded from baseline query', () => {
  saveMetricObservations([observation({ origin: 'ad_hoc', currentValue: 99 })]);
  expect(queryBaselineObservations('country:KR', 'protest_event_count', '7d')).toEqual([]);
});

test('scheduled and provider historical observations are baseline eligible', () => {
  saveMetricObservations([
    observation({ origin: 'scheduled_local', bucketEnd: '2026-09-18' }),
    observation({ origin: 'provider_historical', bucketEnd: '2026-09-17' }),
  ]);
  expect(queryBaselineObservations('country:KR', 'protest_event_count', '7d')).toHaveLength(2);
});

test('reopening database preserves observations', () => {
  saveMetricObservations([observation()]);
  closeDb();
  initDatabase();
  expect(queryBaselineObservations('country:KR', 'protest_event_count', '7d')).toHaveLength(1);
});

test('pruning does not delete still-valid historical baseline', () => {
  saveMetricObservations([
    observation({ origin: 'provider_historical', bucketEnd: '2026-01-01' }),
    observation({ origin: 'scheduled_local', bucketEnd: '2020-01-01', expiresAt: 1 }),
  ]);
  expect(pruneMetricObservations(Date.parse('2026-09-19T00:00:00Z'))).toBe(1);
  const remaining = queryBaselineObservations('country:KR', 'protest_event_count', '7d');
  expect(remaining).toHaveLength(1);
  expect(remaining[0].origin).toBe('provider_historical');
});
