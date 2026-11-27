import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type PdfChildEvent, type PdfExtractParams, pickInfo } from './pdf_extract.js';
import { type ChildKilled, type ChildKillReason, type ChildLimits, type ChildLineVerdict, LineBuffer, readChildRssMb, type RunChildOptions, runLimitedChild } from './child_runner.js';
import { minimalChildEnv } from './security/child_env.js';

export type { PdfChildEvent, PdfExtractParams };
/** 子の RSS の読み取りと、行の分け方は、共通の部品（child_runner.ts）のもの */
export { LineBuffer, readChildRssMb };

/**
 * PDF の解析を、別プロセス（pdf_child_main.ts。本番は同梱の pdf-parse.js）で動かす、親の側。
 *
 * なぜ別プロセスか: PDF の解析（pdf.js）は、入力しだいで、メモリも時間も際限なく使える（Flate で膨らむ 1.6MB のファイルが、メモリを 2GB まで広げて、
 * 本体ごと強制終了させた。実測）。同じプロセスの中では、止められない（スレッドの Worker も、メモリの上限を守らない。Bun 1.4.4 で実測）。
 * 別プロセスなら、時間・メモリ・出力量の上限を超えたものだけを、確実に止められる。1 件ごとに起動して使い捨てるので、利用者のあいだで状態が残らない。
 *
 * 子との約束: 標準入力に PDF のバイト列を渡す。子は、標準出力に 1 行ずつ JSON を返す（open → page … → done。または error）。
 * 子は乗っ取られうる（壊れた・悪意のある PDF を読む）ので、返ってきた行は信用せず、形・順番・大きさを検査する。
 */

/** 子の上限（時間・メモリ・出力量。child_runner.ts と同じもの） */
export type PdfChildLimits = ChildLimits;

/** 止めた理由（child_runner.ts と同じもの） */
export type PdfKillReason = ChildKillReason;

export type PdfChildOutcome =
  | { kind: 'done'; timeBudgetHit: boolean }
  | { kind: 'error'; name: string; message: string }
  /** 止めた・止まった。それまでに届いた行（onEvent に渡したもの）は、呼び出し側が持っている。detail と stderrTail は記録用（利用者には見せない） */
  | ChildKilled;

export type RunPdfChildOptions = RunChildOptions;

/** error の行の名前・文の長さの上限（字）。利用者に見える文になりうるので、切る */
const ERROR_NAME_MAX = 100;
const ERROR_MESSAGE_MAX = 300;
/** ページ数として受け入れる最大（pdf.js の numPages は、PDF の側が決める） */
const NUM_PAGES_MAX = 2 ** 31 - 1;

/** 子に渡す環境変数。bun を動かすのに要るものだけ（security/child_env.ts の minimalChildEnv） */
export const pdfChildEnv = minimalChildEnv;

/** 同梱の pdf-parse.js（本番）を優先し、無ければ TypeScript の入口（開発・テスト）を使う。どちらも無ければ undefined */
export function resolvePdfChildEntry(moduleDir: string, exists: (path: string) => boolean = existsSync): string | undefined {
  for (const name of ['pdf-parse.js', 'pdf_child_main.ts']) {
    const path = join(moduleDir, name);
    if (exists(path)) return path;
  }
  return undefined;
}

/** 子の起動コマンド。.env を読ませない（--no-env-file）。頼み方は --params の JSON で渡す（子は環境変数から水準を読まない） */
export function pdfChildCommand(entry: string, params: PdfExtractParams): string[] {
  return [process.execPath, '--no-env-file', entry, '--params', JSON.stringify(params)];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const cap = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * 子を 1 つ起動して PDF を解析させ、届いた行を onEvent に渡す。時間（hardMs）・メモリ（memoryMb）・出力量（maxOutputBytes）の上限を超えるか、
 * 約束を破るか、勝手に終わったら、子を止めて（SIGKILL）killed を返す。例外は投げない（起動できなかったときも killed の crashed）。
 * 返したときには、子は終わっている。止め方・上限は child_runner.ts の runLimitedChild。ここは、行の約束（open → page … → done。または error）を検査する。
 */
export async function runPdfChild(
  bytes: Uint8Array,
  params: PdfExtractParams,
  limits: PdfChildLimits,
  onEvent: (event: PdfChildEvent) => void,
  options: RunPdfChildOptions,
): Promise<PdfChildOutcome> {
  type Final = Extract<PdfChildOutcome, { kind: 'done' | 'error' }>;
  let phase: 'start' | 'open' = 'start';
  let numPages = 0;
  let nextPage = 1;
  const violation = (text: string): ChildLineVerdict<Final> => ({ violation: text });

  /** 1 行を検査して処理する（空行と、終わりの行のあとの出力は、runLimitedChild が扱う） */
  const handleLine = (raw: string): ChildLineVerdict<Final> => {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return violation('JSON として読めない行がありました');
    }
    if (!isRecord(message)) return violation('JSON のオブジェクトでない行がありました');
    switch (message.t) {
      case 'open': {
        if (phase !== 'start') return violation('open が 2 回ありました');
        const pages = message.numPages;
        if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 0 || pages > NUM_PAGES_MAX) return violation('numPages が正しくありません');
        numPages = pages;
        phase = 'open';
        onEvent({ t: 'open', numPages: pages, info: isRecord(message.info) ? pickInfo(message.info) : {} });
        return undefined;
      }
      case 'page': {
        if (phase !== 'open') return violation('open の前に page がありました');
        if (message.n !== nextPage) return violation(`ページ番号が連番ではありません（${typeof message.n === 'number' ? message.n : `数でない値〔${typeof message.n}〕`}。次は ${nextPage}）`);
        if (nextPage > Math.min(numPages, params.pageLimit)) return violation('頼んだページ数を超えて返しました');
        if (typeof message.text !== 'string') return violation('text が文字列ではありません');
        onEvent({ t: 'page', n: nextPage, text: message.text });
        nextPage++;
        return undefined;
      }
      case 'done': {
        if (phase !== 'open') return violation('open の前に done がありました');
        if (typeof message.timeBudgetHit !== 'boolean') return violation('timeBudgetHit が真偽値ではありません');
        return { final: { kind: 'done', timeBudgetHit: message.timeBudgetHit } };
      }
      case 'error':
        return { final: { kind: 'error', name: cap(message.name, ERROR_NAME_MAX), message: cap(message.message, ERROR_MESSAGE_MAX) } };
      default:
        return violation('知らない種類の行がありました');
    }
  };

  const outcome = await runLimitedChild<Final>(bytes, limits, handleLine, { ...options, env: options.env ?? pdfChildEnv() });
  return outcome.kind === 'final' ? outcome.value : outcome;
}
