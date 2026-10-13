/**
 * 住所データの構築専用の入口。親プロセス（Sora 本体）が `--dir <保存先> --job <JSON>` で起動する。
 * アプリ本体（MCP・ブラウザなど）は読み込まない。終了コード: 0 成功 / 1 失敗 / 2 引数の誤り / 3 国外 IP の拒否（403）。
 */
import { setPriority } from 'node:os';
import { AddressHttpError, type HttpDeps } from './address_http.js';
import { runBuildJob, type JobMinimum } from './address_jobs.js';
import { AddressStore, type BuildJob } from './address_store.js';

const USAGE = 'usage: address-build --dir <path> --job <json>';

export function parseChildArgs(argv: readonly string[]): { dir: string; job: BuildJob } {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dir = value('--dir');
  const raw = value('--job');
  if (!dir || !raw) throw new Error(USAGE);
  let parsed: { kind?: unknown; lgCode?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`--job は JSON で指定してください: ${raw}`);
  }
  if (parsed.kind === 'master' || parsed.kind === 'postal') return { dir, job: { kind: parsed.kind } };
  if ((parsed.kind === 'city' || parsed.kind === 'num') && typeof parsed.lgCode === 'string' && /^\d{6}$/.test(parsed.lgCode)) {
    return { dir, job: { kind: parsed.kind, lgCode: parsed.lgCode } };
  }
  throw new Error(`不明なジョブです: ${raw}`);
}

export interface ChildDeps {
  http?: HttpDeps;
  minimum?: Partial<JobMinimum>;
  nowSeconds?: () => number;
  err?: (line: string) => void;
}

export async function runChild(argv: readonly string[], deps: ChildDeps = {}): Promise<number> {
  const err = deps.err ?? ((line: string) => console.error(line));
  let parsed: ReturnType<typeof parseChildArgs>;
  try {
    parsed = parseChildArgs(argv);
  } catch (error) {
    err(error instanceof Error && error.message === USAGE ? USAGE : `${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  try {
    await runBuildJob(parsed.job, { store: new AddressStore(parsed.dir), http: deps.http, minimum: deps.minimum, nowSeconds: deps.nowSeconds });
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return error instanceof AddressHttpError && error.blocked ? 3 : 1;
  }
}

if (import.meta.main) {
  try {
    // 本体のイベントループと CPU を奪わないよう、優先度を下げる。下げられなくても構築はできる。
    setPriority(0, 10);
  } catch {
    // 続行する
  }
  process.exit(await runChild(process.argv.slice(2)));
}
