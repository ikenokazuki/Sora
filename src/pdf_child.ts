import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PdfChildEvent, type PdfExtractParams, pickInfo } from './pdf_extract.js';
import { childEnv } from './security/child_env.js';

export type { PdfChildEvent, PdfExtractParams };

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

export interface PdfChildLimits {
  /** 子の RSS の上限（MB）。超えたら止める（Linux の /proc が読めない環境では、省く） */
  memoryMb: number;
  /** 子の起動から、この時間（ミリ秒）たっても終わらなければ止める */
  hardMs: number;
  /** 子の標準出力の合計の上限（バイト）。超えたら止める */
  maxOutputBytes: number;
  /** RSS を調べる間隔（ミリ秒） */
  pollMs: number;
  /** done（または error）を受けたあと、子が終わるのを待つ時間（ミリ秒）。過ぎたら止める（結果は変えない）。子が終わったあと、読みが終わる（EOF）のを待つ時間にも使う（孫プロセスがパイプを握っていると、EOF が来ない） */
  exitGraceMs: number;
}

/** 止めた理由: time = 時間・memory = メモリ・output = 出力量・crashed = 勝手に終わった（カーネルの OOM など）・protocol = 約束違反 */
export type PdfKillReason = 'time' | 'memory' | 'output' | 'crashed' | 'protocol';

export type PdfChildOutcome =
  | { kind: 'done'; timeBudgetHit: boolean }
  | { kind: 'error'; name: string; message: string }
  /** 止めた・止まった。それまでに届いた行（onEvent に渡したもの）は、呼び出し側が持っている。detail と stderrTail は記録用（利用者には見せない） */
  | { kind: 'killed'; reason: PdfKillReason; detail: string; stderrTail: string };

export interface RunPdfChildOptions {
  /** 起動するコマンド（pdfChildCommand で作る。テストは偽の子を渡す） */
  command: string[];
  /** 子に渡す環境変数。既定は PATH・HOME・TMPDIR・LD_LIBRARY_PATH・TZ だけ（pdfChildEnv） */
  env?: Record<string, string>;
  /** 子を起動した直後に、pid を知らせる（テスト用） */
  onSpawn?: (pid: number) => void;
  /** 子の RSS（MB）を読む。読めなければ undefined。既定は /proc/<pid>/status（テスト用に替えられる） */
  readRssMb?: (pid: number) => number | undefined;
}

/** error の行の名前・文の長さの上限（字）。利用者に見える文になりうるので、切る */
const ERROR_NAME_MAX = 100;
const ERROR_MESSAGE_MAX = 300;
/** 子の標準エラーの、記録に残す末尾の大きさ（バイト） */
const STDERR_TAIL_MAX = 4096;
/** ページ数として受け入れる最大（pdf.js の numPages は、PDF の側が決める） */
const NUM_PAGES_MAX = 2 ** 31 - 1;

/** 子に渡す環境変数の名前。bun を動かすのに要るものだけ（子は何も取得しないので、プロキシ〔URL に認証情報を含みうる〕・証明書・ロケールなどは要らない） */
const CHILD_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR', 'LD_LIBRARY_PATH', 'TZ'];

/** 子に渡す環境変数。Sora の環境変数から、上の名前だけを取る（許可リスト childEnv を通す）。extra は足す（起動用バイナリへの伝言など） */
export function pdfChildEnv(source: Record<string, string | undefined> = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const picked: Record<string, string | undefined> = {};
  for (const name of CHILD_ENV_NAMES) picked[name] = source[name];
  return childEnv(extra, picked);
}

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

/** 子の RSS（MB）。Linux の /proc/<pid>/status の VmRSS。読めない（/proc が無い・子が終わった）なら undefined */
export function readChildRssMb(pid: number): number | undefined {
  try {
    const kb = /^VmRSS:\s+(\d+)\s*kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
    return kb === undefined ? undefined : Number(kb) / 1024;
  } catch {
    return undefined;
  }
}

const spawnChild = (command: string[], bytes: Uint8Array, env: Record<string, string>) => Bun.spawn(command, { stdin: bytes, stdout: 'pipe', stderr: 'pipe', env });

/** 動いている子。親が終わるとき（SIGTERM などで process.exit したとき）に、子を残さない */
type Killable = Pick<ReturnType<typeof spawnChild>, 'kill'>;
const liveChildren = new Set<Killable>();
let exitHookInstalled = false;
function trackChild(proc: Killable): void {
  liveChildren.add(proc);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of liveChildren) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  });
}

/**
 * バイト列を、改行（0x0A）で行に分ける。足したバイトだけを調べるので、改行のない長い出力も、1 バイトずつ滴らせる出力も、費用が線形で済む
 * （文字列に足しては探し直す作りは、足すたびに全体を調べ直して、乗っ取られた子が本体を長く占められた）。
 * 改行は UTF-8 の文字の途中には現れないので、バイトで分けてから文字にすれば、文字の途中で切れない。
 */
export class LineBuffer {
  private bytes = new Uint8Array(16 * 1024);
  private length = 0;

  /** バイト列を足し、完成した行（改行を除く。呼び出しのあいだだけ有効）を onLine に渡す。onLine が true を返したら、残りを捨てて止める */
  push(chunk: Uint8Array, onLine: (line: Uint8Array) => boolean): void {
    const searchFrom = this.length;
    if (this.length + chunk.length > this.bytes.length) {
      let size = this.bytes.length;
      while (size < this.length + chunk.length) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.bytes.subarray(0, this.length));
      this.bytes = grown;
    }
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
    const view = this.bytes.subarray(0, this.length);
    let lineStart = 0;
    for (let newline = view.indexOf(10, searchFrom); newline >= 0; newline = view.indexOf(10, lineStart)) {
      const stop = onLine(view.subarray(lineStart, newline));
      lineStart = newline + 1;
      if (stop) {
        this.length = 0;
        return;
      }
    }
    if (lineStart > 0) {
      this.bytes.copyWithin(0, lineStart, this.length);
      this.length -= lineStart;
    }
  }

  /** まだ行になっていない残り（末尾に改行の無い最後の行） */
  rest(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const cap = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * 子を 1 つ起動して PDF を解析させ、届いた行を onEvent に渡す。時間（hardMs）・メモリ（memoryMb）・出力量（maxOutputBytes）の上限を超えるか、
 * 約束を破るか、勝手に終わったら、子を止めて（SIGKILL）killed を返す。例外は投げない（起動できなかったときも killed の crashed）。
 * 返したときには、子は終わっている。
 */
export async function runPdfChild(
  bytes: Uint8Array,
  params: PdfExtractParams,
  limits: PdfChildLimits,
  onEvent: (event: PdfChildEvent) => void,
  options: RunPdfChildOptions,
): Promise<PdfChildOutcome> {
  let proc: ReturnType<typeof spawnChild>;
  try {
    proc = spawnChild(options.command, bytes, options.env ?? pdfChildEnv());
  } catch (error) {
    return { kind: 'killed', reason: 'crashed', detail: `起動できませんでした（${error instanceof Error ? error.message : String(error)}）`, stderrTail: '' };
  }
  trackChild(proc);
  options.onSpawn?.(proc.pid);
  const readRss = options.readRssMb ?? readChildRssMb;

  let stopped: { reason: PdfKillReason; detail: string } | undefined;
  let final: Extract<PdfChildOutcome, { kind: 'done' | 'error' }> | undefined;
  let phase: 'start' | 'open' | 'ended' = 'start';
  let numPages = 0;
  let nextPage = 1;
  let stderrTail = '';
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const kill = (): void => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  };
  const stop = (reason: PdfKillReason, detail: string): void => {
    if (stopped) return;
    stopped = { reason, detail };
    kill();
  };
  const hardTimer = setTimeout(() => stop('time', `${limits.hardMs} ミリ秒たっても終わらない`), limits.hardMs);
  const pollTimer = setInterval(() => {
    const rss = readRss(proc.pid);
    if (rss === undefined || rss <= limits.memoryMb) return;
    // done・error を受けたあとの暴走（終わるのを待つ間に確保する）は、結果を変えずに、止めるだけ
    if (final) kill();
    else stop('memory', `${Math.round(rss)} MB（上限 ${limits.memoryMb} MB）`);
  }, limits.pollMs);
  /** done・error を受けた: 仕事は終わったので、時間の監視はやめ、子が終わるのを少しだけ待つ（メモリの監視は、子が終わるまで続ける） */
  const finish = (outcome: typeof final): void => {
    final = outcome;
    phase = 'ended';
    clearTimeout(hardTimer);
    graceTimer = setTimeout(kill, limits.exitGraceMs);
  };

  /** 1 行を検査して処理する。約束違反なら、その理由の文を返す（正しければ undefined） */
  const handleLine = (raw: string): string | undefined => {
    if (raw.trim() === '') return undefined;
    if (phase === 'ended') return 'done の後に出力がありました';
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return 'JSON として読めない行がありました';
    }
    if (!isRecord(message)) return 'JSON のオブジェクトでない行がありました';
    switch (message.t) {
      case 'open': {
        if (phase !== 'start') return 'open が 2 回ありました';
        const pages = message.numPages;
        if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 0 || pages > NUM_PAGES_MAX) return 'numPages が正しくありません';
        numPages = pages;
        phase = 'open';
        onEvent({ t: 'open', numPages: pages, info: isRecord(message.info) ? pickInfo(message.info) : {} });
        return undefined;
      }
      case 'page': {
        if (phase !== 'open') return 'open の前に page がありました';
        if (message.n !== nextPage) return `ページ番号が連番ではありません（${typeof message.n === 'number' ? message.n : `数でない値〔${typeof message.n}〕`}。次は ${nextPage}）`;
        if (nextPage > Math.min(numPages, params.pageLimit)) return '頼んだページ数を超えて返しました';
        if (typeof message.text !== 'string') return 'text が文字列ではありません';
        onEvent({ t: 'page', n: nextPage, text: message.text });
        nextPage++;
        return undefined;
      }
      case 'done': {
        if (phase !== 'open') return 'open の前に done がありました';
        if (typeof message.timeBudgetHit !== 'boolean') return 'timeBudgetHit が真偽値ではありません';
        finish({ kind: 'done', timeBudgetHit: message.timeBudgetHit });
        return undefined;
      }
      case 'error':
        finish({ kind: 'error', name: cap(message.name, ERROR_NAME_MAX), message: cap(message.message, ERROR_MESSAGE_MAX) });
        return undefined;
      default:
        return '知らない種類の行がありました';
    }
  };
  const feed = (line: string): void => {
    const violation = handleLine(line);
    if (violation !== undefined) stop('protocol', violation);
  };

  // 読み手は外で持つ: 子が終わったあと、孫プロセスがパイプを握り続けて EOF が来なくても、あとから打ち切れるように
  const outReader = proc.stdout.getReader();
  const errReader = proc.stderr.getReader();
  const lineDecoder = new TextDecoder();
  const lines = new LineBuffer();
  let total = 0;
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await outReader.read();
        if (done || stopped) break;
        total += value.byteLength;
        if (total > limits.maxOutputBytes) {
          stop('output', `出力が ${limits.maxOutputBytes} バイトを超えました`);
          break;
        }
        lines.push(value, (line) => {
          feed(lineDecoder.decode(line));
          return stopped !== undefined;
        });
        if (stopped) break;
      }
    } catch {
      // 子が死んで、読みが途切れた。結果は、終わり方で決める
    }
  })();
  const errDecoder = new TextDecoder();
  let errTotal = 0;
  const readingErr = (async () => {
    try {
      for (;;) {
        const { done, value } = await errReader.read();
        if (done || stopped) break;
        errTotal += value.byteLength;
        if (errTotal > limits.maxOutputBytes) {
          stop('output', `標準エラーが ${limits.maxOutputBytes} バイトを超えました`);
          break;
        }
        stderrTail = (stderrTail + errDecoder.decode(value, { stream: true })).slice(-STDERR_TAIL_MAX);
      }
    } catch {}
  })();

  try {
    const exitCode = await proc.exited;
    // 子が終わったあと、読みが終わるのを、少しだけ待つ。孫プロセスがパイプを握っていると、EOF が来ない（その場合は、打ち切る）
    const readers = Promise.all([reading, readingErr]);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainedInTime = await Promise.race([readers.then(() => true), new Promise<boolean>((resolve) => (drainTimer = setTimeout(() => resolve(false), limits.exitGraceMs)))]);
    if (drainTimer) clearTimeout(drainTimer);
    if (!drainedInTime) {
      outReader.cancel().catch(() => {});
      errReader.cancel().catch(() => {});
      await readers;
    }
    const cleanExit = exitCode === 0 && !proc.signalCode;
    // 末尾に改行の無い最後の行は、きれいに終わった子のものだけ受ける（OOM などで途中で死んだ子の、途中で切れた行は、約束違反でなく、勝手な終了）
    if (!stopped && cleanExit && lines.rest().length > 0) feed(lineDecoder.decode(lines.rest()));
    if (stopped) return { kind: 'killed', ...stopped, stderrTail };
    if (final) return final;
    const how = proc.signalCode ? `シグナル ${proc.signalCode} で終わりました` : `終了コード ${exitCode} で終わりました`;
    return { kind: 'killed', reason: 'crashed', detail: `done の前に${how}`, stderrTail };
  } finally {
    clearTimeout(hardTimer);
    clearInterval(pollTimer);
    if (graceTimer) clearTimeout(graceTimer);
    liveChildren.delete(proc);
    kill();
  }
}
