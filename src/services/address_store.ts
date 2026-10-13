import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** 構築ジョブ。親プロセスと子プロセスで共有する。 */
export type BuildJob = { kind: 'master' } | { kind: 'postal' } | { kind: 'city'; lgCode: string };

export function jobArtifactId(job: BuildJob): string {
  return job.kind === 'city' ? `city:${job.lgCode}` : job.kind;
}

const DAY = 86_400_000;

/** 確認日時がこれを過ぎたら、使われたときに裏で再確認する。 */
export function ttlFor(id: string): number {
  if (id.startsWith('city:')) return 7 * DAY;
  if (id === 'postal') return 7 * DAY;
  return 30 * DAY;
}

export interface ArtifactMeta {
  /** `address/<種類>/<ver>/` のディレクトリ名。 */
  ver: string;
  /** 入力の署名（取得元の ETag / Last-Modified / サイズのハッシュ）。 */
  sig: string;
  builtAt: number;
  checkedAt: number;
  usedAt: number;
  bytes: number;
  /** 取得元の最終更新日（YYYY-MM-DD）。 */
  sourceDate?: string;
  pinned?: boolean;
  error?: string;
  errorAt?: number;
}

export interface AddressStatus {
  version: 1;
  /** 公開・破棄のたびに増える。ライブラリのモジュールを作り直す目印。 */
  seq: number;
  artifacts: Record<string, ArtifactMeta>;
  /** 成果物がまだ無い ID の直近の失敗。 */
  failures: Record<string, { message: string; at: number }>;
}

const emptyStatus = (): AddressStatus => ({ version: 1, seq: 0, artifacts: {}, failures: {} });

export function artifactRelDir(id: string): string {
  if (id === 'master' || id === 'postal' || id === 'index') return id;
  if (id.startsWith('city:') && /^\d{6}$/.test(id.slice(5))) return join('city', id.slice(5));
  throw new Error(`unknown address artifact id: ${id}`);
}

function dirSize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const USE_FLUSH_MS = 60_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AddressStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly used = new Map<string, number>();
  private lastFlush: number;

  constructor(readonly dir: string, private readonly now: () => number = Date.now) {
    // 起動直後の最初の利用で書き込まない（最終利用日時の保存は 60 秒に 1 回まで）。
    this.lastFlush = now();
  }

  private get statusPath(): string {
    return join(this.dir, 'status.json');
  }

  private get lockPath(): string {
    return join(this.dir, 'lock');
  }

  read(): AddressStatus {
    try {
      const parsed = JSON.parse(readFileSync(this.statusPath, 'utf8')) as Partial<AddressStatus>;
      if (parsed.version !== 1 || typeof parsed.artifacts !== 'object' || parsed.artifacts === null) return emptyStatus();
      return { version: 1, seq: parsed.seq ?? 0, artifacts: parsed.artifacts, failures: parsed.failures ?? {} };
    } catch {
      return emptyStatus();
    }
  }

  /** ロックを取り、最新の状態に変更を加えて、一時ファイル経由で原子的に書く。 */
  async update<T>(fn: (status: AddressStatus) => T): Promise<T> {
    const run = this.chain.then(() => this.locked(() => {
      const status = this.read();
      const result = fn(status);
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.statusPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(status));
      renameSync(tmp, this.statusPath);
      return result;
    }));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async locked<T>(fn: () => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(this.lockPath);
        } catch { /* 他のプロセスが先に解放した */ }
        if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('address store lock timeout');
        await sleep(15 + Math.random() * 25);
      }
    }
    try {
      return fn();
    } finally {
      try { unlinkSync(this.lockPath); } catch { /* すでに無い */ }
    }
  }

  artifactPath(id: string, ver: string): string {
    return join(this.dir, artifactRelDir(id), ver);
  }

  /** 公開済みの現行版。ディレクトリが消えていれば null。 */
  current(id: string): { meta: ArtifactMeta; path: string } | null {
    const meta = this.read().artifacts[id];
    if (!meta) return null;
    const path = this.artifactPath(id, meta.ver);
    return existsSync(path) ? { meta, path } : null;
  }

  /** 構築用の作業ディレクトリ。公開先と同じボリュームに作り、rename で原子的に移す。 */
  makeWorkDir(): string {
    const path = join(this.dir, 'tmp', `${process.pid}-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(path, { recursive: true });
    return path;
  }

  /** 作業ディレクトリを版つきの場所へ移し、状態を更新して、旧版を直近 1 つだけ残して消す。 */
  async publish(id: string, builtDir: string, meta: { sig: string; sourceDate?: string; pinned?: boolean }): Promise<ArtifactMeta> {
    const ver = `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const target = this.artifactPath(id, ver);
    const previousVer = this.read().artifacts[id]?.ver;
    mkdirSync(join(target, '..'), { recursive: true });
    renameSync(builtDir, target);
    const bytes = dirSize(target);
    const at = this.now();
    const published = await this.update((status) => {
      const previous = status.artifacts[id];
      const next: ArtifactMeta = { ...meta, ver, bytes, builtAt: at, checkedAt: at, usedAt: previous?.usedAt ?? at };
      if (next.pinned === undefined && previous?.pinned) next.pinned = true;
      status.artifacts[id] = next;
      delete status.failures[id];
      status.seq += 1;
      return next;
    });
    const parent = join(this.dir, artifactRelDir(id));
    for (const entry of readdirSync(parent)) {
      if (entry !== ver && entry !== previousVer) rmSync(join(parent, entry), { recursive: true, force: true });
    }
    return published;
  }

  async markChecked(id: string, sourceDate?: string): Promise<void> {
    await this.update((status) => {
      const meta = status.artifacts[id];
      if (meta) {
        meta.checkedAt = this.now();
        delete meta.error;
        delete meta.errorAt;
        if (sourceDate) meta.sourceDate = sourceDate;
      }
      delete status.failures[id];
    });
  }

  async markError(id: string, message: string): Promise<void> {
    await this.update((status) => {
      const at = this.now();
      const meta = status.artifacts[id];
      if (meta) {
        meta.error = message;
        meta.errorAt = at;
      } else {
        status.failures[id] = { message, at };
      }
    });
  }

  /** 最終利用日時をメモリに記録する。ファイルへの書き込みは 60 秒に 1 回まで。 */
  touch(id: string): void {
    this.used.set(id, this.now());
    if (this.now() - this.lastFlush > USE_FLUSH_MS) void this.flushUse().catch(() => undefined);
  }

  async flushUse(): Promise<void> {
    this.lastFlush = this.now();
    if (this.used.size === 0) return;
    const entries = [...this.used];
    this.used.clear();
    await this.update((status) => {
      for (const [id, at] of entries) {
        const meta = status.artifacts[id];
        if (meta && at > meta.usedAt) meta.usedAt = at;
      }
    });
  }

  /** 予算を超えていれば、最近使われていない市区町村から破棄する。破棄した ID を返す。 */
  async evict(maxBytes: number, protect: ReadonlySet<string> = new Set()): Promise<string[]> {
    const removed: string[] = [];
    await this.update((status) => {
      let total = Object.values(status.artifacts).reduce((sum, meta) => sum + meta.bytes, 0);
      const candidates = Object.entries(status.artifacts)
        .filter(([id, meta]) => id.startsWith('city:') && !meta.pinned && !protect.has(id))
        .sort((a, b) => a[1].usedAt - b[1].usedAt);
      for (const [id, meta] of candidates) {
        if (total <= maxBytes) break;
        rmSync(join(this.dir, artifactRelDir(id)), { recursive: true, force: true });
        total -= meta.bytes;
        delete status.artifacts[id];
        removed.push(id);
      }
      if (removed.length > 0) status.seq += 1;
    });
    return removed;
  }
}
