import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { getEvidenceDetails, getEvidencePage, saveEvidenceDetails } from './db.js';
import type { EvidenceDetail } from './detail.js';
import { createIntelligenceRoutes } from '../../routes/intelligence.js';

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-detail-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

function makeDetail(i: number): EvidenceDetail {
  return {
    evidenceId: 'e-' + String(i).padStart(3, '0'),
    providerId: 'fixture',
    providerItemId: String(i),
    sourceRecordUrl: 'https://example.org/' + String(i),
    contentKind: 'excerpt',
    blocks: [{ index: 0, text: 'Notice number ' + String(i) }],
    retrievedAt: '2026-09-22T00:00:00.000Z',
    timeBasis: 'retrieved',
    geographyBasis: 'unknown',
    sourceStatus: 'unverified',
    contentTruncated: false,
  };
}

describe('evidence pages', () => {
  test('every stored record can be reached through evidence pages', () => {
    const details = Array.from({ length: 61 }, (_, i) => makeDetail(i));
    saveEvidenceDetails('ctx-page-1', details);
    const first = getEvidencePage('ctx-page-1', { limit: 40 });
    expect(first.items).toHaveLength(40);
    expect(first.totalStored).toBe(61);
    expect(first.nextCursor).toBeDefined();
    const second = getEvidencePage('ctx-page-1', { cursor: first.nextCursor, limit: 40 });
    const ids = [...first.items, ...second.items].map((item) => item.evidenceId);
    expect(new Set(ids).size).toBe(61);
    expect(second.nextCursor).toBeUndefined();
    expect(getEvidenceDetails('ctx-page-1', [details[0].evidenceId])).toHaveLength(1);
  });

  test('foreign context ids and tampered cursors are rejected', () => {
    saveEvidenceDetails('ctx-page-1', [makeDetail(0)]);
    expect(getEvidenceDetails('ctx-other', ['e-000'])).toEqual([]);
    expect(getEvidencePage('ctx-other', { limit: 40 }).items).toEqual([]);
    expect(() => getEvidencePage('ctx-page-1', { cursor: 'broken' })).toThrow(RangeError);
    const first = getEvidencePage('ctx-page-1', { limit: 40 });
    expect(() => getEvidencePage('ctx-other', { cursor: first.nextCursor ?? 'x' })).toThrow(RangeError);
  });

  test('ids that do not belong to the report come back as missingIds', () => {
    saveEvidenceDetails('ctx-page-1', Array.from({ length: 3 }, (_, i) => makeDetail(i)));
    saveEvidenceDetails('ctx-other', [makeDetail(9)]);
    const page = getEvidencePage('ctx-page-1', { ids: ['e-001', 'e-bogus', 'e-009', 'e-000', 'e-001'] });
    expect(page.items.map((item) => item.evidenceId)).toEqual(['e-001', 'e-000']);
    expect(page.missingIds).toEqual(['e-bogus', 'e-009']);
    expect(page.nextCursor).toBeUndefined();
    expect(page.totalStored).toBe(3);
    // 全部見つかれば missingIds は付けない
    expect(getEvidencePage('ctx-page-1', { ids: ['e-000'] }).missingIds).toBeUndefined();
  });

  test('ids beyond limit continue through nextCursor and cursor', () => {
    saveEvidenceDetails('ctx-page-1', Array.from({ length: 10 }, (_, i) => makeDetail(i)));
    const ids = ['e-000', 'e-001', 'e-nope', 'e-002', 'e-003', 'e-004', 'e-005'];
    const first = getEvidencePage('ctx-page-1', { ids, limit: 3 });
    expect(first.items.map((item) => item.evidenceId)).toEqual(['e-000', 'e-001']);
    expect(first.missingIds).toEqual(['e-nope']);
    expect(first.nextCursor).toBeDefined();
    const second = getEvidencePage('ctx-page-1', { ids, limit: 3, cursor: first.nextCursor });
    expect(second.items.map((item) => item.evidenceId)).toEqual(['e-002', 'e-003', 'e-004']);
    expect(second.missingIds).toBeUndefined();
    const third = getEvidencePage('ctx-page-1', { ids, limit: 3, cursor: second.nextCursor });
    expect(third.items.map((item) => item.evidenceId)).toEqual(['e-005']);
    expect(third.nextCursor).toBeUndefined();
  });

  test('REST answers a stale or mismatched cursor (ids, page scan, updates) with 400, not 500', async () => {
    saveEvidenceDetails('ctx-page-1', Array.from({ length: 10 }, (_, i) => makeDetail(i)));
    const routes = createIntelligenceRoutes();
    const ids = ['e-000', 'e-001', 'e-002', 'e-003'];
    const idsCursor = getEvidencePage('ctx-page-1', { ids, limit: 2 }).nextCursor;
    const scanCursor = getEvidencePage('ctx-page-1', { limit: 2 }).nextCursor;
    const get = (query: string) => routes.request(`/intelligence/context/ctx-page-1/evidence?${query}`);
    for (const res of [
      await get(`ids=e-005,e-006,e-007,e-008&limit=2&cursor=${idsCursor}`),
      await get(`limit=2&cursor=${idsCursor}`),
      await get(`ids=${ids.join(',')}&limit=2&cursor=${scanCursor}`),
      await get('cursor=broken'),
      await routes.request('/intelligence/context/ctx-page-1/updates?cursor=not-a-date'),
    ]) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_INPUT');
    }
    expect((await get(`ids=${ids.join(',')}&limit=2&cursor=${idsCursor}`)).status).toBe(200);
  });

  test('an ids cursor is bound to its ids and cannot be mixed with page scanning', () => {
    saveEvidenceDetails('ctx-page-1', Array.from({ length: 10 }, (_, i) => makeDetail(i)));
    const ids = ['e-000', 'e-001', 'e-002', 'e-003'];
    const cursor = getEvidencePage('ctx-page-1', { ids, limit: 2 }).nextCursor;
    expect(cursor).toBeDefined();
    expect(() => getEvidencePage('ctx-page-1', { ids: ['e-005', 'e-006', 'e-007', 'e-008'], limit: 2, cursor })).toThrow(RangeError);
    expect(() => getEvidencePage('ctx-page-1', { limit: 2, cursor })).toThrow(RangeError);
    const scanCursor = getEvidencePage('ctx-page-1', { limit: 2 }).nextCursor;
    expect(() => getEvidencePage('ctx-page-1', { ids, limit: 2, cursor: scanCursor })).toThrow(RangeError);
  });
});
