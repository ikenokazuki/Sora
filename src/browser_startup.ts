/**
 * strict の起動の確認（設計 2。段階 8）。待ち受ける前に、次の 3 つを行う。呼ぶのは起動の処理だけ（index.ts の import.meta.main）。
 * - 前回の実行が異常終了（OOM・docker kill）して残った Chromium のプロファイル（/tmp/sora-chromium-*。別の uid 所有の 0700）を消す。
 *   残っていると、次の起動で同じ uid をもらった別の tenant に、前の tenant の Cookie・セッションを読まれうる。
 * - PDF の解析を、別プロセス（同梱の pdf-parse.js）で 1 回動かす（ごく小さな PDF を読む）。strict は、重い PDF が本体のメモリと時間を使い切るのを、
 *   別プロセスで止めるので、その入口と bun が動くことを、最初の PDF ではなく、起動のときに知る。
 * - Chromium を、サンドボックス有効・別の uid で、1 回起動して閉じる。設定の値を見るだけの検査（startup_check.ts）では分からない、
 *   実際に起動できるか（seccomp・ユーザー名前空間・capability）を、最初の要求ではなく、起動のときに知る。
 * strict でなければ、何もしない（何も起動せず、何も消さない）。
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserSandboxStatus, CHROME_EXECUTABLE_PATH, closeSharedBrowser, getBrowser } from './browser_engine.js';
import { errorMessage } from './errors.js';
import { parsePdfToMarkdown } from './pdf.js';
import { readChildRssMb } from './pdf_child.js';
import { PDF_PROBE_TEXT, startupProbePdf } from './pdf_probe.js';
import { PdfDropError } from './pdf_uid.js';
import { isolationLevel } from './security/limits.js';

const PREFIX = '[Sora/Strict]';

/** 試し起動の tenant。利用者の tenant（name:・key:・legacy・public）と重ならない */
export const STARTUP_PROBE_TENANT = '*startup-probe*';

/** createProfileDir（browser_launch_plan.ts）の mkdtemp が作る名前。接尾辞は 6 文字 */
const PROFILE_DIR = /^sora-chromium-[A-Za-z0-9]{6}$/;

export interface SweepResult {
  removed: string[];
  /** Chromium が動いているので、消さなかったもの */
  inUse: string[];
  failed: Array<{ path: string; error: string }>;
  /** プロセスの一覧を読めず、動いているか分からないので、何も消さなかった */
  skipped?: 'processes-unreadable';
}

/** 動いているプロセスの引数（/proc/<pid>/cmdline。引数は NUL 区切り）。/proc を読めない環境は undefined */
function readCommandLines(): string[] | undefined {
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  if (pids.length === 0) return undefined;
  const lines: string[] = [];
  for (const pid of pids) {
    try {
      lines.push(readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
    } catch {
      // 読む間に終わったプロセス
    }
  }
  return lines;
}

/**
 * 前回の実行が残したプロファイルを消す。tmp の直下の `sora-chromium-XXXXXX` の「ディレクトリ」だけが対象（ファイル・シンボリックリンクは触らない）。
 * 引数のどこかにそのパスを持つプロセスがあれば、使用中として消さない（子プロセスの --database=<パス>/Crashpad なども。迷えば残す側）。
 * 前提: この /tmp を使う Sora は 1 つ（同じ /tmp を共有する別の Sora が、起動の直前に作ったプロファイルを消しうる）。
 */
export function sweepStaleProfileDirs(
  deps: { dir?: string; commandLines?: () => string[] | undefined; remove?: (path: string) => void } = {},
): SweepResult {
  const dir = deps.dir ?? tmpdir();
  const result: SweepResult = { removed: [], inUse: [], failed: [] };
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROFILE_DIR.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return result;
  }
  if (names.length === 0) return result;
  const lines = (deps.commandLines ?? readCommandLines)();
  if (!lines) return { ...result, skipped: 'processes-unreadable' };
  const remove = deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  for (const name of names) {
    const path = join(dir, name);
    if (lines.some((line) => line.includes(path))) {
      result.inUse.push(path);
      continue;
    }
    try {
      remove(path);
      result.removed.push(path);
    } catch (error) {
      result.failed.push({ path, error: errorMessage(error) ?? String(error) });
    }
  }
  return result;
}

export type StrictBrowserCheck = { status: 'ok' } | { status: 'skipped' } | { status: 'failed'; problem: string };

export interface StrictBrowserDeps {
  chromiumAvailable: boolean;
  getBrowser: typeof getBrowser;
  closeAll: () => Promise<void>;
  sandboxStatus: () => 'on' | 'off' | 'unknown';
}

const realBrowserDeps = (): StrictBrowserDeps => ({
  chromiumAvailable: CHROME_EXECUTABLE_PATH !== undefined,
  getBrowser,
  closeAll: closeSharedBrowser,
  sandboxStatus: browserSandboxStatus,
});

/**
 * 原因の連鎖のうち、いちばん奥の、空でない文。サンドボックスで起動できなかったときの包んだ文は、「auto にするか」と助言するが、strict は auto に戻せないので、
 * 元の原因（puppeteer の文）を出して、strict の助言は呼び出し側が付ける。puppeteer の ProtocolError のように、文が空の原因もあるので、空は飛ばす
 * （実機で確かめた連鎖: Error → TargetCloseError「Protocol error … Target closed」→ ProtocolError「」）。全部が空なら、いちばん外側の文。
 */
function rootCauseMessage(error: unknown): string {
  let deepest = error instanceof Error ? error.message : String(error);
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.message.trim() !== '') deepest = current.message;
    current = current.cause;
  }
  return deepest;
}

/**
 * Chromium を、いつもの経路（tenant ごとのプロセス・別の uid・サンドボックス on・出口のゲートウェイ）で 1 回起動して、閉じる。
 * 起動できなければ、理由を返す。閉じる失敗は握る（確かめた結果は変えない）。Chromium が無いときは、試さない。
 */
export async function verifyStrictBrowser(deps: StrictBrowserDeps = realBrowserDeps()): Promise<StrictBrowserCheck> {
  if (!deps.chromiumAvailable) return { status: 'skipped' };
  try {
    await deps.getBrowser(undefined, STARTUP_PROBE_TENANT);
    if (deps.sandboxStatus() !== 'on') {
      return { status: 'failed', problem: `Chromium を起動できましたが、サンドボックスが有効になっていません（状態: ${deps.sandboxStatus()}）。SORA_BROWSER_SANDBOX=on を確かめてください` };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      problem: `Chromium を、サンドボックス有効・別の uid で起動できませんでした: ${rootCauseMessage(error)}（strict は、サンドボックス on が必須で、auto には戻せません。capability・seccomp（Docker は deploy/seccomp-sora.json）・Chromium の場所を確かめてください。docs/operations/strict.md）`,
    };
  } finally {
    try {
      await deps.closeAll();
    } catch {
      // 閉じる失敗で、確かめた結果を変えない
    }
  }
}

export type StrictPdfCheck = { status: 'ok' } | { status: 'failed'; problem: string };

/**
 * ごく小さな PDF を、いつもの経路（別プロセス）で 1 回読んで、本文が合うことを確かめる。入口（pdf-parse.js）が無い・bun が動かない・
 * 子が約束どおりに返さない、のどれも、ここで分かる（strict は、入口が無いときに、このプロセスの中で解析することはしない）。
 */
export async function verifyStrictPdf(parse: typeof parsePdfToMarkdown = parsePdfToMarkdown, readRss: (pid: number) => number | undefined = readChildRssMb): Promise<StrictPdfCheck> {
  // メモリの上限は、子の RSS を /proc/<pid>/status から読んで効かせる。読めない環境（/proc を隠した・Linux 以外）では、黙って効かなくなるので、ここで断る
  if (readRss(process.pid) === undefined) {
    return {
      status: 'failed',
      problem: 'プロセスのメモリ（RSS）を /proc/<pid>/status から読めません。strict は、PDF の解析のメモリの暴走を、この読み取りで止めるので、読める環境（Linux。/proc を隠さない）が要ります',
    };
  }
  try {
    const result = await parse(startupProbePdf(), 'sora-startup-probe.pdf', 1000, { tenantId: STARTUP_PROBE_TENANT });
    if (!result.content.includes(PDF_PROBE_TEXT)) {
      return { status: 'failed', problem: `PDF の解析を別プロセスで試しましたが、結果の本文が合いません（${JSON.stringify(result.content.slice(0, 80))}）。同梱の pdf-parse.js と bun を確かめてください` };
    }
    return { status: 'ok' };
  } catch (error) {
    if (error instanceof PdfDropError) {
      // 別プロセスの入口の問題ではない。PDF の解析のプロセスを、別の uid に落とせない（落とす条件は、その文に入っている）
      return { status: 'failed', problem: `PDF の解析の別プロセスを、別の uid に落とせませんでした: ${error.message}（docs/operations/strict.md）` };
    }
    return {
      status: 'failed',
      problem: `PDF の解析を別プロセスで動かせませんでした: ${errorMessage(error) ?? String(error)}（strict は、重い PDF が本体を巻き込まないよう、PDF の解析を別プロセスで動かすことが必須です。同梱の pdf-parse.js と bun を確かめてください）`,
    };
  }
}

/** 待ち受ける前の、strict の起動の確認。失敗したら exit(1) */
export async function runStrictStartup(
  deps: {
    stderr?: (line: string) => void;
    exit?: (code: number) => void;
    isStrict?: () => boolean;
    sweep?: () => SweepResult;
    verifyPdf?: () => Promise<StrictPdfCheck>;
    verify?: () => Promise<StrictBrowserCheck>;
  } = {},
): Promise<void> {
  const stderr = deps.stderr ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  if (!(deps.isStrict ?? (() => isolationLevel() === 'strict'))()) return;

  const swept = (deps.sweep ?? sweepStaleProfileDirs)();
  if (swept.removed.length > 0) {
    stderr(`${PREFIX} 前回の実行が残した Chromium のプロファイルを ${swept.removed.length} 個消しました（異常終了のあとに残る。別の tenant に読まれないようにします）`);
  }
  // 消せなかった残りがあれば断る: 残したまま起動すると、同じ uid をもらった別の tenant に、前の tenant の Cookie・セッションを読まれうる（掃除の目的が満たされない）
  if (swept.failed.length > 0) {
    for (const { path, error } of swept.failed) {
      stderr(`${PREFIX} エラー: 前回の実行が残したプロファイル ${path} を消せませんでした（${error}）。残したまま起動すると、同じ uid をもらった別の tenant に読まれうるので、起動しません。root で起動して DAC_OVERRIDE の capability を足すか、手で消してください`);
    }
    stderr(`${PREFIX} SORA_ISOLATION=strict の起動の確認に失敗したので、起動しません`);
    exit(1);
    return;
  }
  if (swept.inUse.length > 0) {
    stderr(`${PREFIX} 警告: Chromium が動いているプロファイルが ${swept.inUse.length} 個あり、消しませんでした（${swept.inUse.join('、')}）。前の Sora の Chromium が残っているか、同じ一時ディレクトリを使う別の Sora があります。確かめてください`);
  }
  if (swept.skipped) stderr(`${PREFIX} 警告: 動いているプロセスの一覧（/proc）を読めないので、前回の実行が残したプロファイルの掃除を省きました`);

  const pdfCheck = await (deps.verifyPdf ?? (() => verifyStrictPdf()))();
  if (pdfCheck.status === 'failed') {
    stderr(`${PREFIX} エラー: ${pdfCheck.problem}`);
    stderr(`${PREFIX} SORA_ISOLATION=strict の起動の確認に失敗したので、起動しません`);
    exit(1);
    return;
  }
  stderr(`${PREFIX} PDF の解析を、別の uid に落とした別プロセスで動かせることを確かめました`);

  const check = await (deps.verify ?? (() => verifyStrictBrowser()))();
  if (check.status === 'failed') {
    stderr(`${PREFIX} エラー: ${check.problem}`);
    stderr(`${PREFIX} SORA_ISOLATION=strict の起動の確認に失敗したので、起動しません`);
    exit(1);
    return;
  }
  if (check.status === 'skipped') {
    stderr(`${PREFIX} 警告: Chromium が見つからないので、ブラウザの起動の確認を省きました（ブラウザを使う機能は動きません）`);
    return;
  }
  stderr(`${PREFIX} 起動の確認が通りました（Chromium を、サンドボックス有効・別の uid で起動できました）`);
}
