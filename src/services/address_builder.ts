import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressBuilder } from './address_data.js';
import { AddressUnavailableError } from './address_errors.js';
import { jobArtifactId, type BuildJob } from './address_store.js';

/** 同梱の address-build.js（本番）を優先し、無ければ TypeScript の入口（開発・テスト）を使う。 */
export function resolveBuildEntry(moduleDir: string, exists: (path: string) => boolean = existsSync): string {
  for (const name of ['address-build.js', 'address_build_main.ts']) {
    const path = join(moduleDir, name);
    if (exists(path)) return path;
  }
  throw new Error(`住所データの構築用の入口が見つかりません（${moduleDir}）`);
}

const DEFAULT_TIMEOUT_MS: Record<BuildJob['kind'], number> = { city: 300_000, num: 600_000, postal: 180_000, master: 180_000, index: 300_000 };

export interface ChildProcessBuilderOptions {
  /** 住所データの保存先。 */
  dir: string;
  /** 起動コマンド。省略時は [bun, 入口, --dir, dir, --job, JSON]。 */
  command?: (job: BuildJob) => string[];
  timeoutMs?: (job: BuildJob) => number;
}

/** 構築を別プロセス（低優先度）で行う。本体のイベントループを塞がない。 */
export class ChildProcessBuilder implements AddressBuilder {
  constructor(private readonly options: ChildProcessBuilderOptions) {}

  command(job: BuildJob): string[] {
    if (this.options.command) return this.options.command(job);
    const entry = resolveBuildEntry(dirname(fileURLToPath(import.meta.url)));
    return [process.execPath, entry, '--dir', this.options.dir, '--job', JSON.stringify(job)];
  }

  async run(job: BuildJob): Promise<void> {
    const id = jobArtifactId(job);
    const timeoutMs = this.options.timeoutMs?.(job) ?? DEFAULT_TIMEOUT_MS[job.kind];
    const proc = Bun.spawn(this.command(job), { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    try {
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (timedOut) throw new AddressUnavailableError(`${id} の構築が ${Math.round(timeoutMs / 1000)} 秒以内に終わりませんでした`, false, id);
      if (code === 0) return;
      const message = stderr.trim().split('\n').filter(Boolean).pop() ?? `構築プロセスが終了コード ${code} で終わりました`;
      throw new AddressUnavailableError(message, code === 3, id);
    } finally {
      clearTimeout(timer);
    }
  }
}
