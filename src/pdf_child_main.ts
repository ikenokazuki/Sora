/**
 * PDF の解析専用の入口。親プロセス（Sora 本体。pdf_child.ts）が `--params <JSON>` で起動し、標準入力に PDF のバイト列を渡す。
 * 標準出力には、1 行ずつ JSON を返す（open → page … → done。壊れた PDF などは error を 1 行）。終了コードは、結果にかかわらず 0（頼み方の誤りも error の行）。
 * アプリ本体（MCP・ブラウザ・DB など）は読み込まない。本番は `bun build` で 1 つにまとめた pdf-parse.js として同梱する（Containerfile）。
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（穴 26）。親が上限を超えたら SIGKILL で止めるので、ここに時間やメモリの制御は要らない。
 */
import { lowerOomPriority } from './child_oom.js';
import { extractPdfPages, type PdfExtractParams } from './pdf_extract.js';

const USAGE = 'usage: pdf-parse --params <json>（標準入力に PDF）';

/** 子の OOM スコアを最大にする（child_oom.ts。試験はここから読む） */
export { lowerOomPriority };

/** --params の JSON を検査して読む。誤りは例外（頼み方が分からないまま PDF を読まない） */
export function parseChildParams(argv: readonly string[]): PdfExtractParams {
  const index = argv.indexOf('--params');
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (raw === undefined) throw new Error(USAGE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--params は JSON で指定してください: ${raw.slice(0, 100)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`--params はオブジェクトで指定してください: ${raw.slice(0, 100)}`);
  const record = parsed as Record<string, unknown>;
  const value = (name: 'pageLimit' | 'needed' | 'budgetMs'): number => {
    const v = record[name];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`--params の ${name} は 0 以上の数で指定してください`);
    return v;
  };
  return { pageLimit: value('pageLimit'), needed: value('needed'), budgetMs: value('budgetMs') };
}

/**
 * PDF を解析して、行（改行つき）を write に流す。解析の例外は、error の行にする（投げない）。親が先に死んで書けなくなっても、投げない。
 */
export async function runChild(bytes: Uint8Array, params: PdfExtractParams, write: (line: string) => void | Promise<void>): Promise<void> {
  try {
    try {
      const { timeBudgetHit } = await extractPdfPages(bytes, params, (event) => write(`${JSON.stringify(event)}\n`));
      await write(`${JSON.stringify({ t: 'done', timeBudgetHit })}\n`);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      await write(`${JSON.stringify({ t: 'error', name, message })}\n`);
    }
  } catch {
    // 書き込みの失敗（親が先に死んだ）。もう読む人がいない
  }
}

if (import.meta.main) {
  lowerOomPriority();
  // pdf.js は警告を console.log で出す。標準出力は結果の行だけにするので、console は標準エラー（親が末尾だけ記録する）へ流す
  const toStderr = (...args: unknown[]): void => void process.stderr.write(`${args.map(String).join(' ')}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
  const write = async (line: string): Promise<void> => void (await Bun.write(Bun.stdout, line));
  let params: PdfExtractParams | undefined;
  try {
    params = parseChildParams(process.argv.slice(2));
  } catch (error) {
    await write(`${JSON.stringify({ t: 'error', name: 'Error', message: error instanceof Error ? error.message : String(error) })}\n`);
  }
  if (params) await runChild(new Uint8Array(await Bun.stdin.arrayBuffer()), params, write);
  // process.exit() は呼ばない: 入口の守り（import.meta.main）を誤って外すと、試験を動かしているプロセスが成功のまま途中で終わってしまう。
  // 何かが取り残されて終われないときの保険は、unref したタイマー（何も残っていなければ待たない）
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 1000).unref();
}
