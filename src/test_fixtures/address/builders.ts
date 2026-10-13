import type { AddressConfig, AddressMode } from '../../services/address_config.js';
import { AddressData, type AddressBuilder } from '../../services/address_data.js';
import { runBuildJob } from '../../services/address_jobs.js';
import { AddressStore, type BuildJob } from '../../services/address_store.js';
import { SMALL_MINIMUM, sampleUpstream, type FakeUpstream } from './harness.js';

/** 偽の取得元に対して、構築ジョブを同じプロセスの中で実行する。 */
export class InProcessBuilder implements AddressBuilder {
  readonly runs: BuildJob[] = [];

  constructor(
    private readonly store: AddressStore,
    readonly up: FakeUpstream,
    private readonly nowSeconds: () => number = () => 1_700_000_000,
  ) {}

  async run(job: BuildJob): Promise<void> {
    this.runs.push(job);
    await runBuildJob(job, {
      store: this.store,
      http: { fetchFn: this.up.fetchFn, sleep: async () => undefined },
      minimum: SMALL_MINIMUM,
      nowSeconds: this.nowSeconds,
    });
  }
}

/** release() するまで、中身の構築役を呼ばずに待たせる。同時に走っている数を数える。gates で待たせるジョブを絞れる。 */
export class GatedBuilder implements AddressBuilder {
  active = 0;
  maxActive = 0;
  readonly started: BuildJob[] = [];
  private open!: () => void;
  private readonly gate: Promise<void>;

  constructor(
    private readonly inner: AddressBuilder,
    private readonly gates: (job: BuildJob) => boolean = () => true,
  ) {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open();
  }

  async run(job: BuildJob): Promise<void> {
    this.started.push(job);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.gates(job)) await this.gate;
      await this.inner.run(job);
    } finally {
      this.active -= 1;
    }
  }
}

export interface TestAddressDataOptions {
  up?: FakeUpstream;
  mode?: AddressMode;
  maxBytes?: number;
  concurrency?: number;
  waitMs?: number;
  now?: () => number;
  cooldownMs?: number;
  /** 中身の構築役を包む（GatedBuilder など）。 */
  wrap?: (inner: InProcessBuilder) => AddressBuilder;
}

/** 偽の取得元と同じプロセスの構築役で動く AddressData。dir は呼び出し側が用意して消す。 */
export function createTestAddressData(dir: string, options: TestAddressDataOptions = {}) {
  const now = options.now ?? Date.now;
  const store = new AddressStore(dir, now);
  const up = options.up ?? sampleUpstream();
  const inner = new InProcessBuilder(store, up);
  const builder = options.wrap ? options.wrap(inner) : inner;
  const config: AddressConfig = {
    mode: options.mode ?? 'lazy',
    dir,
    maxBytes: options.maxBytes ?? 1024 * 1024 * 1024,
    waitMs: options.waitMs ?? 20_000,
    concurrency: options.concurrency ?? 1,
    preload: null,
  };
  const data = new AddressData({ config, builder, store, now, cooldownMs: options.cooldownMs, log: () => undefined });
  return { data, store, up, inner, builder };
}

/** 条件が成り立つまで少しずつ待つ（裏で走る構築の完了待ち）。 */
export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** 待機中の非同期処理が進むのを待つ。 */
export const tick = (ms = 20): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
