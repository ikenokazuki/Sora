import { randomUUID } from 'node:crypto';
import { getDb } from '../../db.js';
import { readSourceState, writeSourceState } from './db.js';
import type { EvidenceDetail, SourceState } from './detail.js';

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
    writeSourceState({ ...before, sourceId, cursor: batch.cursor, lastCheckedAt: checkedAt, lastSuccessfulFetchAt: checkedAt, lastErrorCode: undefined, retryAt: undefined });
  } catch (error) {
    writeSourceState({ ...before, sourceId, lastCheckedAt: checkedAt, lastErrorCode: error instanceof Error ? error.message.slice(0, 200) : 'COLLECT_FAILED', retryAt: new Date(Date.parse(checkedAt) + collectorBackoffMs(before, Date.parse(checkedAt))).toISOString() });
    throw error;
  }
}
/** 失敗時は5分→10分→20分→最大30分で再試行する。 */
export function collectorBackoffMs(previous: SourceState | undefined, now: number): number {
  const FIVE_MINUTES = 5 * 60_000;
  const MAX_DELAY = 30 * 60_000;
  const previousDelay = previous?.retryAt && previous?.lastCheckedAt ? Date.parse(previous.retryAt) - Date.parse(previous.lastCheckedAt) : Number.NaN;
  if (!Number.isFinite(previousDelay) || (previousDelay as number) <= 0) return FIVE_MINUTES;
  return Math.min(MAX_DELAY, (previousDelay as number) * 2);
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
        const state = readSourceState(job.sourceId);
        if (state?.retryAt && Date.parse(state.retryAt) > now) continue;
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
