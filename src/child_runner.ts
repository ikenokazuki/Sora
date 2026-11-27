import { readFileSync } from 'node:fs';
import { minimalChildEnv } from './security/child_env.js';

/**
 * 信頼できない入力を扱う子プロセスを、1 件ごとに起動して使い捨てる、親の側の共通の部品（PDF の解析 pdf_child.ts と、HTML の変換 html_convert.ts）。
 *
 * 子は乗っ取られうるので、時間・メモリ（RSS）・出力量の上限を超えたら SIGKILL で止め、返ってきた行は、呼び出し側（onLine）が形・順番・大きさを検査する。
 * 子の標準出力は、改行（0x0A）で区切った行で受け取る。行の意味は、呼び出し側の約束で決める。
 */

export interface ChildLimits {
  /** 子の RSS の上限（MB）。超えたら止める（Linux の /proc が読めない環境では、省く） */
  memoryMb: number;
  /** 子の起動から、この時間（ミリ秒）たっても終わらなければ止める */
  hardMs: number;
  /** 子の標準出力の合計の上限（バイト）。超えたら止める */
  maxOutputBytes: number;
  /** RSS を調べる間隔（ミリ秒） */
  pollMs: number;
  /** 終わりの行を受けたあと、子が終わるのを待つ時間（ミリ秒）。過ぎたら止める（結果は変えない）。子が終わったあと、読みが終わる（EOF）のを待つ時間にも使う（孫プロセスがパイプを握っていると、EOF が来ない） */
  exitGraceMs: number;
}

/** 止めた理由: time = 時間・memory = メモリ・output = 出力量・crashed = 勝手に終わった（カーネルの OOM など）・protocol = 約束違反 */
export type ChildKillReason = 'time' | 'memory' | 'output' | 'crashed' | 'protocol';

/** 止めた・止まった。それまでに届いた行（onLine に渡したもの）は、呼び出し側が持っている。detail と stderrTail は記録用（利用者には見せない） */
export type ChildKilled = { kind: 'killed'; reason: ChildKillReason; detail: string; stderrTail: string };

/** 1 行を検査した結果: undefined = 続きを待つ・violation = 約束違反（子を止める）・final = 終わりの行（このあとの出力は約束違反） */
export type ChildLineVerdict<F> = undefined | { violation: string } | { final: F };

export interface RunChildOptions {
  /** 起動するコマンド */
  command: string[];
  /** 子に渡す環境変数。既定は PATH・HOME・TMPDIR・LD_LIBRARY_PATH・TZ だけ（security/child_env.ts の minimalChildEnv。運用者の秘密は渡さない） */
  env?: Record<string, string>;
  /** 子の作業ディレクトリ。省略すると、親と同じ */
  cwd?: string;
  /** 子を起動した直後に、pid を知らせる（テスト用） */
  onSpawn?: (pid: number) => void;
  /** 子の RSS（MB）を読む。読めなければ undefined。既定は /proc/<pid>/status（テスト用に替えられる） */
  readRssMb?: (pid: number) => number | undefined;
}

/** 子の標準エラーの、記録に残す末尾の大きさ（バイト） */
const STDERR_TAIL_MAX = 4096;

/** 子の RSS（MB）。Linux の /proc/<pid>/status の VmRSS。読めない（/proc が無い・子が終わった）なら undefined */
export function readChildRssMb(pid: number): number | undefined {
  try {
    const kb = /^VmRSS:\s+(\d+)\s*kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
    return kb === undefined ? undefined : Number(kb) / 1024;
  } catch {
    return undefined;
  }
}

const spawnChild = (command: string[], stdin: Uint8Array | Blob, env: Record<string, string>, cwd?: string) =>
  Bun.spawn(command, { stdin, stdout: 'pipe', stderr: 'pipe', env, ...(cwd === undefined ? {} : { cwd }) });

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

/**
 * 子を 1 つ起動して、標準入力に stdin を渡し、標準出力の行を onLine に渡す。時間（hardMs）・メモリ（memoryMb）・出力量（maxOutputBytes）の上限を超えるか、
 * 約束を破る（onLine が violation を返す・終わりの行のあとに出力がある）か、終わりの行の前に勝手に終わったら、子を止めて（SIGKILL）killed を返す。
 * 終わりの行（onLine が final を返した行）を受けたら、時間の監視をやめ、子が終わるのを exitGraceMs だけ待つ（メモリの監視は、子が終わるまで続ける）。
 * 例外は投げない（起動できなかったときも killed の crashed）。返したときには、子は終わっている。
 */
export async function runLimitedChild<F>(
  stdin: Uint8Array | Blob,
  limits: ChildLimits,
  onLine: (raw: string) => ChildLineVerdict<F>,
  options: RunChildOptions,
): Promise<{ kind: 'final'; value: F } | ChildKilled> {
  let proc: ReturnType<typeof spawnChild>;
  try {
    proc = spawnChild(options.command, stdin, options.env ?? minimalChildEnv(), options.cwd);
  } catch (error) {
    return { kind: 'killed', reason: 'crashed', detail: `起動できませんでした（${error instanceof Error ? error.message : String(error)}）`, stderrTail: '' };
  }
  trackChild(proc);
  options.onSpawn?.(proc.pid);
  const readRss = options.readRssMb ?? readChildRssMb;

  let stopped: { reason: ChildKillReason; detail: string } | undefined;
  let final: { value: F } | undefined;
  let stderrTail = '';
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const kill = (): void => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  };
  const stop = (reason: ChildKillReason, detail: string): void => {
    if (stopped) return;
    stopped = { reason, detail };
    kill();
  };
  const hardTimer = setTimeout(() => stop('time', `${limits.hardMs} ミリ秒たっても終わらない`), limits.hardMs);
  const pollTimer = setInterval(() => {
    const rss = readRss(proc.pid);
    if (rss === undefined || rss <= limits.memoryMb) return;
    // 終わりの行を受けたあとの暴走（終わるのを待つ間に確保する）は、結果を変えずに、止めるだけ
    if (final) kill();
    else stop('memory', `${Math.round(rss)} MB（上限 ${limits.memoryMb} MB）`);
  }, limits.pollMs);

  const feed = (raw: string): void => {
    if (raw.trim() === '') return;
    if (final) {
      stop('protocol', 'done の後に出力がありました');
      return;
    }
    const verdict = onLine(raw);
    if (verdict === undefined) return;
    if ('violation' in verdict) {
      stop('protocol', verdict.violation);
      return;
    }
    // 仕事は終わったので、時間の監視はやめ、子が終わるのを少しだけ待つ
    final = { value: verdict.final };
    clearTimeout(hardTimer);
    graceTimer = setTimeout(kill, limits.exitGraceMs);
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
    if (final) return { kind: 'final', value: final.value };
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
