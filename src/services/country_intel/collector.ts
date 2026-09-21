import { randomUUID } from 'node:crypto';
import { getDb } from '../../db.js';
import { readSourceState, writeSourceState } from './db.js';
import type { EvidenceDetail } from './detail.js';

export interface CollectionBatch { cursor: string; details: EvidenceDetail[]; }

export interface CollectionJob {
  sourceId: string;
  intervalMs: number;
  collect: () => Promise<CollectionBatch>;
}

const LEASE_SOURCE_ID = 'collector:lease';

export async function collectSourceOnce(sourceId: string, collect: () => Promise<CollectionBatch>): Promise<void> {
  const before = readSourceState(sourceId);
  const checkedAt = new Date().toISOString();
  try {
    const batch = await collect();
    writeSourceState({ ...before, sourceId, cursor: batch.cursor, lastCheckedAt: checkedAt, lastSuccessfulFetchAt: checkedAt });
  } catch (error) {
    writeSourceState({ ...before, sourceId, lastCheckedAt: checkedAt, lastErrorCode: error instanceof Error ? error.message.slice(0, 200) : 'COLLECT_FAILED' });
    throw error;
  }
}

export function acquireCollectorLease(ownerId: string = randomUUID(), ttlMs = 60_000, now: number = Date.now()): boolean {
  const current = readSourceState(LEASE_SOURCE_ID);
  const expiresAt = current?.retryAt ? Date.parse(current.retryAt) : Number.NaN;
  if (current && Number.isFinite(expiresAt) && expiresAt > now && current.cursor !== ownerId) return false;
  writeSourceState({ sourceId: LEASE_SOURCE_ID, cursor: ownerId, lastCheckedAt: new Date(now).toISOString(), retryAt: new Date(now + ttlMs).toISOString() });
  return true;
}

export function releaseCollectorLease(ownerId: string): void {
  const current = readSourceState(LEASE_SOURCE_ID);
  if (current?.cursor === ownerId) getDb().query('DELETE FROM intel_source_states WHERE source_id = ?').run(LEASE_SOURCE_ID);
}

export interface CollectorHandle { stop(): Promise<void>; ownerId: string; }

export function startCountryCollector(jobs: readonly CollectionJob[] = [], options: { tickMs?: number; leaseTtlMs?: number } = {}): CollectorHandle {
  const ownerId = randomUUID();
  const tickMs = options.tickMs ?? 60_000;
  const leaseTtlMs = options.leaseTtlMs ?? 120_000;
  const lastRun = new Map<string, number>();
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      if (stopped) return;
      if (!acquireCollectorLease(ownerId, leaseTtlMs)) return;
      const now = Date.now();
      for (const job of jobs) {
        if (stopped) return;
        if (now - (lastRun.get(job.sourceId) ?? 0) < job.intervalMs) continue;
        lastRun.set(job.sourceId, now);
        try {
          await collectSourceOnce(job.sourceId, job.collect);
        } catch { /* next tick retries with backoff via retryAt */ }
      }
    })();
  }, tickMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    ownerId,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      releaseCollectorLease(ownerId);
    },
  };
}
