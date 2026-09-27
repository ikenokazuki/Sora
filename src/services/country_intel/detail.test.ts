import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { getEvidenceDetails, getEvidencePage, saveEvidenceDetails } from './db.js';
import type { EvidenceDetail } from './detail.js';

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
});
