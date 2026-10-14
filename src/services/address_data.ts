import { AsyncLocalStorage } from 'node:async_hooks';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressConfig } from './address_config.js';
import { AddressDisabledError, AddressPendingError, AddressUnavailableError } from './address_errors.js';
import { AddressHttpError } from './address_http.js';
import { cityNameOf, lgCode6, type JaCity, type JaJson, type TownJson } from './address_names.js';
import {
  AddressStore, jobArtifactId, ttlFor, type AddressStatus, type ArtifactMeta, type BuildJob,
} from './address_store.js';
import { GeoIndexReader } from './address_geo_index.js';
import type { NumberRanges } from './address_numbers.js';
import { PostalReader } from './postal_code.js';

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
  /** 使ったデータのうち最も古い取得元の最終更新日（YYYY-MM-DD）。答えの新しさはこれで決まる。 */
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

/** 全国マスターの 1 市区町村。 */
export interface MasterCity {
  /** 6 桁の全国地方公共団体コード。 */
  lgCode: string;
  lg5: string;
  prefCode: string;
  pref: string;
  /** 郡 + 市 + 区。 */
  name: string;
  city: JaCity;
}

export interface MasterIndex {
  ver: string;
  /** `${都道府県名}/${市区町村名}`。 */
  byName: Map<string, MasterCity>;
  byLgCode: Map<string, MasterCity>;
  byLg5: Map<string, MasterCity>;
}

function buildMasterIndex(ver: string, ja: JaJson): MasterIndex {
  const index: MasterIndex = { ver, byName: new Map(), byLgCode: new Map(), byLg5: new Map() };
  for (const pref of ja.data) {
    const prefCode = lgCode6(pref.code).slice(0, 2);
    for (const city of pref.cities) {
      const lgCode = lgCode6(city.code);
      const entry: MasterCity = { lgCode, lg5: lgCode.slice(0, 5), prefCode, pref: pref.pref, name: cityNameOf(city), city };
      index.byName.set(`${pref.pref}/${entry.name}`, entry);
      index.byLgCode.set(lgCode, entry);
      index.byLg5.set(entry.lg5, entry);
    }
  }
  return index;
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

/**
 * 成果物が無いときの扱い。'never' は構築を頼まず、'background' は頼むが待たない。
 * どちらも待たずに AddressPendingError を返す。指定が無ければ、頼んで待つ（既定）。
 */
export type BuildPolicy = 'never' | 'background';
const buildPolicy = new AsyncLocalStorage<BuildPolicy>();
const PRIORITY: Record<BuildJob['kind'], number> = { master: 0, postal: 1, index: 2, city: 3, num: 4 };
const TOWN_CACHE_MAX = 50;
const NUMBERS_CACHE_MAX = 30;
/** 郵便番号を作り直したあと、古い読み取り役を閉じるまでの猶予。使用中の呼び出しを壊さない。 */
const READER_GRACE_MS = 30_000;

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
  private masterCache: MasterIndex | null = null;
  private readonly townCache = new Map<string, { ver: string; json: TownJson }>();
  private postalCache: { ver: string; reader: PostalReader } | null = null;
  private geoCache: { ver: string; reader: GeoIndexReader } | null = null;
  private readonly numbersCache = new Map<string, { ver: string; path: string; ranges: NumberRanges }>();

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

  /** fn の中の ensure を、成果物が無いとき待たずに諦める。policy で構築を頼むか決める。 */
  withoutWaiting<T>(policy: BuildPolicy, fn: () => Promise<T>): Promise<T> {
    return buildPolicy.run(policy, fn);
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
    const policy = buildPolicy.getStore();
    if (policy) {
      if (policy === 'background' && !this.cooling(id)) void this.enqueue(job);
      throw new AddressPendingError(id);
    }
    const failure = this.failures.get(id);
    if (failure && this.cooling(id)) throw new AddressUnavailableError(failure.message, failure.blocked, id);
    await this.wait(this.enqueue(job), waitMs, id);
    const built = this.peek(id);
    if (!built) throw new AddressUnavailableError(`${id} を取得できませんでした`, false, id);
    return built;
  }

  /** 全国マスター（都道府県・市区町村）の索引。版ごとにメモリへ置く。 */
  async master(waitMs?: number): Promise<MasterIndex> {
    const ready = await this.ensure({ kind: 'master' }, waitMs);
    if (this.masterCache?.ver === ready.ver) return this.masterCache;
    const ja = JSON.parse(await Bun.file(join(ready.path, 'ja.json')).text()) as JaJson;
    this.masterCache = buildMasterIndex(ready.ver, ja);
    return this.masterCache;
  }

  /** 市区町村の町字（段A の town.json）。lgCode は 6 桁。最大 50 市区町村を版ごとにメモリへ置く。 */
  async towns(lgCode: string, waitMs?: number): Promise<{ ver: string; json: TownJson }> {
    if (!/^\d{6}$/.test(lgCode)) throw new Error(`市区町村コードは 6 桁で指定してください: ${lgCode}`);
    const ready = await this.ensure({ kind: 'city', lgCode }, waitMs);
    const cached = this.townCache.get(lgCode);
    if (cached?.ver === ready.ver) {
      this.townCache.delete(lgCode);
      this.townCache.set(lgCode, cached);
      return cached;
    }
    const json = JSON.parse(await Bun.file(join(ready.path, 'town.json')).text()) as TownJson;
    const entry = { ver: ready.ver, json };
    this.townCache.delete(lgCode);
    this.townCache.set(lgCode, entry);
    while (this.townCache.size > TOWN_CACHE_MAX) this.townCache.delete(this.townCache.keys().next().value as string);
    return entry;
  }

  /** 市区町村の番地・号（段B）。節の範囲表と、rsdt.txt / chiban.txt のあるディレクトリ。最大 30 市区町村を版ごとにメモリへ置く。 */
  async numbers(lgCode: string, waitMs?: number): Promise<{ ver: string; path: string; ranges: NumberRanges }> {
    if (!/^\d{6}$/.test(lgCode)) throw new Error(`市区町村コードは 6 桁で指定してください: ${lgCode}`);
    const ready = await this.ensure({ kind: 'num', lgCode }, waitMs);
    const cached = this.numbersCache.get(lgCode);
    if (cached?.ver === ready.ver) {
      this.numbersCache.delete(lgCode);
      this.numbersCache.set(lgCode, cached);
      return cached;
    }
    const ranges = JSON.parse(await Bun.file(join(ready.path, 'ranges.json')).text()) as NumberRanges;
    const entry = { ver: ready.ver, path: ready.path, ranges };
    this.numbersCache.delete(lgCode);
    this.numbersCache.set(lgCode, entry);
    while (this.numbersCache.size > NUMBERS_CACHE_MAX) this.numbersCache.delete(this.numbersCache.keys().next().value as string);
    return entry;
  }

  /** 郵便番号の読み取り役。版が変わったら新しいものに替え、古いものは猶予のあとで閉じる。 */
  async postal(waitMs?: number): Promise<{ ver: string; reader: PostalReader }> {
    const ready = await this.ensure({ kind: 'postal' }, waitMs);
    if (this.postalCache?.ver === ready.ver) return this.postalCache;
    const previous = this.postalCache;
    this.postalCache = { ver: ready.ver, reader: new PostalReader(join(ready.path, 'postal.sqlite')) };
    if (previous) setTimeout(() => previous.reader.close(), READER_GRACE_MS).unref();
    return this.postalCache;
  }

  /** 町字の点の全国索引の読み取り役（逆ジオコーディング用）。版が変わったら新しいものに替え、古いものは猶予のあとで閉じる。 */
  async geoIndex(waitMs?: number): Promise<{ ver: string; reader: GeoIndexReader }> {
    const ready = await this.ensure({ kind: 'index' }, waitMs);
    if (this.geoCache?.ver === ready.ver) return this.geoCache;
    const previous = this.geoCache;
    this.geoCache = { ver: ready.ver, reader: new GeoIndexReader(join(ready.path, 'geo.sqlite')) };
    if (previous) setTimeout(() => previous.reader.close(), READER_GRACE_MS).unref();
    return this.geoCache;
  }

  /** 待機中・実行中のジョブがすべて終わるまで待つ（テストの後始末と、終了処理用）。 */
  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0 || this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }

  datasetInfo(ids: readonly string[]): DatasetInfo {
    const artifacts = this.status().artifacts;
    let updatedAt: string | null = null;
    let stale = false;
    let error: string | undefined;
    for (const id of ids) {
      const meta = artifacts[id];
      if (!meta) continue;
      if (meta.sourceDate && (updatedAt === null || meta.sourceDate < updatedAt)) updatedAt = meta.sourceDate;
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

  /** 空きがあれば待機中のジョブを始める。小さくて他の前提になる全国マスター・郵便番号を、市区町村より先にする。 */
  private pump(): void {
    while (this.running < this.config.concurrency && this.queue.length > 0) {
      let next = 0;
      for (let index = 1; index < this.queue.length; index++) {
        if (PRIORITY[(this.queue[index] as QueueItem).job.kind] < PRIORITY[(this.queue[next] as QueueItem).job.kind]) next = index;
      }
      const [item] = this.queue.splice(next, 1) as [QueueItem];
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

  /** 事前取得（SORA_ADDRESS_PRELOAD）の範囲にある市区町村の成果物か。 */
  inPreloadScope(id: string): boolean {
    const { preload } = this.config;
    if (!preload) return false;
    const match = /^(?:city|num):(\d{2})\d{4}$/.exec(id);
    return match !== null && (preload === 'all' || preload.includes(match[1] as string));
  }

  /**
   * 使用量が maxBytes に収まるまで、最近使われていない市区町村から破棄する。破棄した ID を返す。
   * 事前取得の範囲にあり、印が付いた成果物は破棄しない。範囲外の印や、指定を外したあとの印は効かない。
   */
  evictTo(maxBytes: number, protect: ReadonlySet<string> = new Set()): Promise<string[]> {
    return this.store.evict(maxBytes, protect, (id, meta) => meta.pinned === true && this.inPreloadScope(id));
  }

  /** 予算を超えていれば破棄する。直前に作ったものと、構築中・待機中のものは残す。 */
  private async afterBuild(id: string): Promise<void> {
    try {
      await this.evictTo(this.config.maxBytes, new Set([id, ...this.inflight.keys()]));
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
