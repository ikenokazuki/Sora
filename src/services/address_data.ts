import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressConfig } from './address_config.js';
import { AddressDisabledError, AddressPendingError, AddressUnavailableError } from './address_errors.js';
import { AddressHttpError } from './address_http.js';
import {
  AddressStore, jobArtifactId, ttlFor, type AddressStatus, type ArtifactMeta, type BuildJob,
} from './address_store.js';

export type { BuildJob } from './address_store.js';

/** 構築ジョブを 1 件実行する。失敗は例外で返す。本番は子プロセス、テストは同じプロセス。 */
export interface AddressBuilder {
  run(job: BuildJob): Promise<void>;
}

export interface ReadyArtifact {
  id: string;
  ver: string;
  path: string;
  meta: ArtifactMeta;
}

export interface DatasetInfo {
  /** 取得元の最終更新日（YYYY-MM-DD）の最大。 */
  updatedAt: string | null;
  /** 確認日時が期限の 2 倍を超えた成果物がある。 */
  stale: boolean;
  /** 直近の再確認の失敗。 */
  error?: string;
}

export interface AddressDataOptions {
  config: AddressConfig;
  builder: AddressBuilder;
  /** 省略時は new AddressStore(config.dir, now)。 */
  store?: AddressStore;
  now?: () => number;
  /** 失敗した構築をやり直すまでの待ち。失敗のたびに 2 倍にして、上限は 1 時間。 */
  cooldownMs?: number;
  /** 国外 IP の拒否（403）のあとの待ち。 */
  blockedCooldownMs?: number;
  log?: (message: string) => void;
}

interface QueueItem {
  job: BuildJob;
  id: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface FailureRecord {
  message: string;
  blocked: boolean;
  at: number;
  count: number;
}

const HOUR = 3_600_000;

function toUnavailable(error: unknown, id: string): AddressUnavailableError {
  if (error instanceof AddressUnavailableError) {
    return error.artifact === id ? error : new AddressUnavailableError(error.message, error.blocked, id);
  }
  if (error instanceof AddressHttpError) return new AddressUnavailableError(error.message, error.blocked, id);
  return new AddressUnavailableError(error instanceof Error ? error.message : String(error), false, id);
}

/**
 * 住所データの管理役。使われたときだけ構築を頼み、同じ ID の構築は 1 回にまとめ、
 * 同時に走る数を絞り、予算を超えたら古いものから破棄する。起動時には何もしない。
 */
export class AddressData {
  readonly store: AddressStore;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly blockedCooldownMs: number;
  private readonly log: (message: string) => void;
  private readonly queue: QueueItem[] = [];
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, FailureRecord>();
  private running = 0;
  private snapshot: { key: string; status: AddressStatus } | null = null;

  constructor(private readonly options: AddressDataOptions) {
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new AddressStore(options.config.dir, this.now);
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.blockedCooldownMs = options.blockedCooldownMs ?? 600_000;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  get config(): AddressConfig {
    return this.options.config;
  }

  get enabled(): boolean {
    return this.config.mode !== 'off';
  }

  /** status.json のスナップショット。別プロセスの公開も、ファイルの置き換え（inode の変化）で検知する。 */
  status(): AddressStatus {
    let key = 'none';
    try {
      const stat = statSync(join(this.store.dir, 'status.json'));
      key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      // まだ無い
    }
    if (this.snapshot?.key !== key) this.snapshot = { key, status: this.store.read() };
    return this.snapshot.status;
  }

  /** 待たずに、いまある版を返す。構築は頼まない。 */
  peek(id: string): ReadyArtifact | null {
    const meta = this.status().artifacts[id];
    if (!meta) return null;
    return { id, ver: meta.ver, path: this.store.artifactPath(id, meta.ver), meta };
  }

  /** 構築を頼む（同じ ID は 1 回にまとめる）。終わりを待つなら返り値を、待たないなら無視してよい。 */
  request(job: BuildJob): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.enqueue(job);
  }

  /** 成果物を使える状態にする。無ければ構築を頼み、waitMs まで待つ。 */
  async ensure(job: BuildJob, waitMs: number = this.config.waitMs): Promise<ReadyArtifact> {
    if (!this.enabled) throw new AddressDisabledError();
    const id = jobArtifactId(job);
    const ready = this.peek(id);
    if (ready) {
      this.store.touch(id);
      if (this.now() - ready.meta.checkedAt > ttlFor(id)) this.revalidate(job);
      return ready;
    }
    const failure = this.failures.get(id);
    if (failure && this.cooling(id)) throw new AddressUnavailableError(failure.message, failure.blocked, id);
    await this.wait(this.enqueue(job), waitMs, id);
    const built = this.peek(id);
    if (!built) throw new AddressUnavailableError(`${id} を取得できませんでした`, false, id);
    return built;
  }

  datasetInfo(ids: readonly string[]): DatasetInfo {
    const artifacts = this.status().artifacts;
    let updatedAt: string | null = null;
    let stale = false;
    let error: string | undefined;
    for (const id of ids) {
      const meta = artifacts[id];
      if (!meta) continue;
      if (meta.sourceDate && (updatedAt === null || meta.sourceDate > updatedAt)) updatedAt = meta.sourceDate;
      if (this.now() - meta.checkedAt > 2 * ttlFor(id)) stale = true;
      error ??= meta.error;
    }
    return error ? { updatedAt, stale, error } : { updatedAt, stale };
  }

  private revalidate(job: BuildJob): void {
    const id = jobArtifactId(job);
    if (this.inflight.has(id) || this.cooling(id)) return;
    void this.enqueue(job);
  }

  private cooling(id: string): boolean {
    const failure = this.failures.get(id);
    if (!failure) return false;
    const base = failure.blocked ? this.blockedCooldownMs : this.cooldownMs;
    return this.now() - failure.at < Math.min(base * 2 ** (failure.count - 1), HOUR);
  }

  private enqueue(job: BuildJob): Promise<void> {
    const id = jobArtifactId(job);
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({ job, id, resolve, reject });
    });
    // 待つ人がいない裏の再確認が失敗しても、未処理の rejection にしない。
    promise.catch(() => undefined);
    this.inflight.set(id, promise);
    this.pump();
    return promise;
  }

  private pump(): void {
    while (this.running < this.config.concurrency && this.queue.length > 0) {
      const item = this.queue.shift() as QueueItem;
      this.running += 1;
      void this.execute(item);
    }
  }

  private async execute(item: QueueItem): Promise<void> {
    const { job, id } = item;
    try {
      await this.options.builder.run(job);
      this.failures.delete(id);
      this.inflight.delete(id);
      await this.afterBuild(id);
      item.resolve();
    } catch (error) {
      const failure = toUnavailable(error, id);
      const previous = this.failures.get(id);
      this.failures.set(id, { message: failure.message, blocked: failure.blocked, at: this.now(), count: (previous?.count ?? 0) + 1 });
      this.log(`[Sora/Address] ${id}: ${failure.message}`);
      this.inflight.delete(id);
      item.reject(failure);
    } finally {
      this.running -= 1;
      this.pump();
    }
  }

  /** 予算を超えていれば破棄する。直前に作ったものと、構築中・待機中のものは残す。 */
  private async afterBuild(id: string): Promise<void> {
    try {
      await this.store.evict(this.config.maxBytes, new Set([id, ...this.inflight.keys()]));
    } catch (error) {
      this.log(`[Sora/Address] evict failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async wait(build: Promise<void>, waitMs: number, id: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, waitMs));
    });
    try {
      const outcome = await Promise.race([build.then(() => 'done' as const), timeout]);
      if (outcome === 'timeout') throw new AddressPendingError(id);
    } finally {
      clearTimeout(timer);
    }
  }
}
