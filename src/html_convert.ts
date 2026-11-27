import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ChildKilled, type ChildKillReason, type ChildLimits, type ChildLineVerdict, readChildRssMb, runLimitedChild } from './child_runner.js';
import { envPath } from './config.js';
import { extractMainContentWithRs } from './extractor/rs_trafilatura.js';
import { withExtractionUid } from './extractor/rs_uid.js';
import { type ConvertRequest, type ConvertWant, ConvertDoneSchema, ConvertErrorSchema, encodeConvertRequest } from './html_convert_protocol.js';
import { convertHtmlToMarkdown } from './html_parser.js';

export type { ConvertWant };
import { detectMemoryLimitBytes } from './memory_limit.js';
import { currentCaller } from './security/caller.js';
import { type QueuePolicy, SimpleSemaphore } from './security/fair_queue.js';
import { type IsolationLevel, isolationLevel, limits } from './security/limits.js';
import { incrementSecurityCounter } from './security/metrics.js';

/**
 * 取得したページの HTML の変換（html_parser.ts の convertHtmlToMarkdown と、本文の抽出 rs-trafilatura の前後の処理）を、どこで動かすかを決めて動かす。
 *
 * なぜ別プロセスか: 全員の要求は 1 本のメインスレッドで処理するので、重いページの変換は、その間、ほかの利用者の要求を止める。メモリも、
 * 大きいページでは数百 MB〜数 GB 使い、足りなくなると本体ごと止まる。別プロセスなら、時間とメモリの上限を超えたものだけを止められる。
 * strict は、すべてのページを別プロセスで変換する。standard は、要素（タグ）が多いページだけを別プロセスで変換し、ほかは今までどおり本体の中で変換する
 * （別プロセスは、起こすのに約 0.2 秒と約 60MB かかる。本物のページ 20 件で、要素が 1 万を超えたのは Wikipedia の長い記事 2 件だけ）。
 */

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** 同時に動かす変換の子の数。機械のメモリが 4GB 以上なら 2、それ未満と分からないときは 1（今のやり方〔本体で 1 件ずつ〕よりメモリの最大を増やさない） */
export function convertChildConcurrency(memBytes: number | undefined): number {
  return memBytes !== undefined && memBytes >= 4 * GB ? 2 : 1;
}

/** 1 件の変換の子のメモリ（RSS）の上限（MB）。機械のメモリの 25% を、256〜1,024 MB に丸める。分からないときは 1,024 MB */
export function convertChildMemoryMb(memBytes: number | undefined): number {
  if (memBytes === undefined) return 1024;
  return Math.min(1024, Math.max(256, Math.round(memBytes / MB / 4)));
}

/** standard で別プロセスに回すページの、要素（開きタグ）の数の下限（これを超えたら別プロセス） */
export const STANDARD_CHILD_MIN_TAGS = 10_000;

/**
 * HTML の要素（`<` の直後が英字のもの）を数える。limit を超えたら数えるのをやめ、limit + 1 を返す。
 * コメントやスクリプトの中の `<x>` も数えるので、多めに数える側にだけずれる（そのページは別プロセスで変換されるだけ）
 */
export function countTagsUpTo(html: string, limit: number): number {
  let count = 0;
  for (let at = html.indexOf('<'); at >= 0; at = html.indexOf('<', at + 1)) {
    const next = html.charCodeAt(at + 1);
    if ((next >= 65 && next <= 90) || (next >= 97 && next <= 122)) {
      count++;
      if (count > limit) return count;
    }
  }
  return count;
}

/** 変換を別プロセスでするか: strict は常に。standard は、要素が STANDARD_CHILD_MIN_TAGS を超えるページだけ */
export function convertsInChild(html: string, level: IsolationLevel): boolean {
  return level === 'strict' || countTagsUpTo(html, STANDARD_CHILD_MIN_TAGS) > STANDARD_CHILD_MIN_TAGS;
}

/**
 * 直前の 1 件（HTML と URL が同じ）の答えを覚えて返す。ブラウザの描画を待つ間の「本文が出たか」の確認は、同じ HTML を続けて確かめる
 * （待ちの最後と、確認の画面かの判定）ので、変換（strict では別プロセス）を 1 回で済ませる。失敗は覚えない
 */
export function rememberLast<T>(check: (html: string, url: string) => Promise<T>): (html: string, url: string) => Promise<T> {
  let last: { html: string; url: string; value: T } | undefined;
  return async (html, url) => {
    if (last && last.url === url && last.html === html) return last.value;
    const value = await check(html, url);
    last = { html, url, value };
    return value;
  };
}

// ==========================================
// 変換を動かす（本体の中か、別プロセスか）
// ==========================================

/** 変換の結果（html_parser.ts の convertHtmlToMarkdown の戻り値） */
export type ConvertResult = ReturnType<typeof convertHtmlToMarkdown>;

/** 本文の抽出（rs-trafilatura）が使えず、結果が変わりうるときに、応答の warnings に書く文。内部の設定は書かない（理由は、運用者向けのログに出る） */
export const RS_UNAVAILABLE_WARNINGS = {
  content: '本文の抽出（rs-trafilatura）が使えなかったので、別の方式（Readability）で本文を取り出しました。ページの種類（一覧・掲示板など）によっては、いつもと違う結果になることがあります',
  images: '本文の抽出（rs-trafilatura）の、画像を戻す処理が使えなかったので、本文の中の画像が抜けていることがあります',
} as const;

/** 変換する HTML と、convertHtmlToMarkdown に渡す引数 */
export interface ConvertInput {
  html: string;
  url: string;
  maxChars: number;
  isRendered?: boolean;
  onlyMainContent?: boolean;
  selectors?: Record<string, string>;
  removeSelectors?: string[];
  stripLinks?: boolean;
  keepDataImages?: boolean;
}

export interface ConvertOptions {
  /** 順番を数える利用者。省略時は、呼んでいる利用者（currentCaller。呼び出しの外は legacy） */
  tenantId?: string;
  /** 順番を待つ間に中止されたら、待ちから外れる */
  signal?: AbortSignal;
  /** 本文の抽出（rs-trafilatura）もする（scrape の onlyMainContent のとき）。別プロセスで変換するときは、抽出も別プロセスの中でする */
  mainContent?: { removeSelectors?: string[]; includeMedia?: boolean };
  /** 結果に入れる、大きくなりうる欄。別プロセスは、入れないものを返さない（既定はすべて入れる） */
  want?: Partial<ConvertWant>;
  /** 試験用: level = 水準・limits = 上限の一部・command = 起動コマンド・entryDir = 入口を探す場所・onSpawn = 起動した pid を知らせる */
  child?: { level?: IsolationLevel; limits?: Partial<ChildLimits>; command?: string[]; entryDir?: string; onSpawn?: (pid: number) => void };
}

/**
 * 別プロセスの変換を、上限のために止めた（または、勝手に終わった・約束を破った）ときの失敗。reason = 止めた理由。
 * 時間のときは、文に「タイムアウト」を入れる（REST で 408 に分類される）
 */
export class ConvertLimitError extends Error {
  constructor(
    message: string,
    readonly reason: ChildKillReason,
  ) {
    super(message);
    this.name = 'ConvertLimitError';
  }
}

/** 機械のメモリ（cgroup の上限と搭載メモリの小さい方）。起動のときに 1 回だけ読む（ブラウザの同時数と同じ） */
const MACHINE_MEMORY_BYTES = detectMemoryLimitBytes();

export function convertQueuePolicy(): QueuePolicy {
  const current = limits();
  return { perTenant: current.convertQueuePerTenant, total: current.convertQueueTotal, waitMs: current.convertQueueWaitMs, sharePercent: current.convertTenantSharePercent };
}

/** 別プロセスの変換の順番。同時に動かすのは、機械のメモリから決めた数（1 か 2）で、全員で共有する。本体の中の変換は、順番を取らない */
export const convertSlots = new SimpleSemaphore(convertChildConcurrency(MACHINE_MEMORY_BYTES), { resource: 'convert', policy: convertQueuePolicy });

/** 別プロセスの出力の合計の上限（バイト）。結果の JSON は、ページの大きさの数倍まで（頼んだ欄による）。乗っ取られた子が、親のメモリを増やさないように */
const CONVERT_CHILD_MAX_OUTPUT_BYTES = 64 * MB;
/** 別プロセスの RSS を調べる間隔（ミリ秒） */
const CONVERT_CHILD_POLL_MS = 25;
/** 別プロセスが結果を返したあと、終わるのを待つ時間（ミリ秒）。過ぎたら止める */
const CONVERT_CHILD_EXIT_GRACE_MS = 2_000;
/** error の行の名前・文の長さの上限（字）。利用者に見える文になりうるので、切る */
const ERROR_NAME_MAX = 100;
const ERROR_MESSAGE_MAX = 300;
/** 同梱の入口（html-convert.js。本番は server.js と同じ場所）か、TypeScript の入口（開発・試験）を探す場所 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** 別プロセスの上限。メモリは機械のメモリから、時間は水準の表（convertMaxMs）。overrides は試験用 */
export function convertChildLimits(overrides?: Partial<ChildLimits>): ChildLimits {
  return {
    memoryMb: convertChildMemoryMb(MACHINE_MEMORY_BYTES),
    hardMs: limits().convertMaxMs,
    maxOutputBytes: CONVERT_CHILD_MAX_OUTPUT_BYTES,
    pollMs: CONVERT_CHILD_POLL_MS,
    exitGraceMs: CONVERT_CHILD_EXIT_GRACE_MS,
    ...overrides,
  };
}

/** 同梱の html-convert.js（本番）を優先し、無ければ TypeScript の入口（開発・試験）を使う。どちらも無ければ undefined */
export function resolveConvertChildEntry(moduleDir: string, exists: (path: string) => boolean = existsSync): string | undefined {
  for (const name of ['html-convert.js', 'html_convert_child_main.ts']) {
    const path = join(moduleDir, name);
    if (exists(path)) return path;
  }
  return undefined;
}

/** 子の起動コマンド。.env を読ませない（--no-env-file）。頼み方は標準入力で渡す */
export const convertChildCommand = (entry: string): string[] => [process.execPath, '--no-env-file', entry];

let warnedInline = false;
let rssWatchable: boolean | undefined;
/** 試験用: 1 回だけ出す警告を、もう一度出せるようにする */
export function resetConvertWarnings(): void {
  warnedInline = false;
  rssWatchable = undefined;
}

/** 別プロセスのメモリ（RSS）を /proc から読めないとき、メモリの上限が効かないことを、1 回だけ知らせる */
function warnIfMemoryWatchOff(): void {
  rssWatchable ??= readChildRssMb(process.pid) !== undefined;
  if (rssWatchable) return;
  rssWatchable = true;
  console.warn('[Sora/変換] 子プロセスのメモリ（RSS）を /proc から読めないので、ページの変換のメモリの上限は効きません（時間と出力量の上限は効きます）。コンテナのメモリの上限（--memory）を付けてください');
}

/** 入口が見つからないとき、standard はこのプロセスの中で変換する。隔離が効かないことを、1 回だけ知らせる */
function warnInlineOnce(): void {
  if (warnedInline) return;
  warnedInline = true;
  console.warn('[Sora/変換] ページの変換の入口（html-convert.js）が見つからないので、このプロセスの中で変換します（大きいページが、本体のメモリと時間を使い切るのを止められません）');
}

/** 別プロセスの起動コマンド。undefined は、このプロセスの中で変換する（standard で入口が見つからないとき）。strict は、見つからなければ失敗する */
function childCommandFor(options: ConvertOptions, level: IsolationLevel): string[] | undefined {
  if (options.child?.command) return options.child.command;
  const entry = resolveConvertChildEntry(options.child?.entryDir ?? MODULE_DIR);
  if (entry !== undefined) return convertChildCommand(entry);
  if (level === 'strict') {
    throw new Error('ページの変換の入口（html-convert.js）が見つかりません。SORA_ISOLATION=strict は、ページの変換を別プロセスで動かすので、同梱の html-convert.js が要ります');
  }
  warnInlineOnce();
  return undefined;
}

/** このプロセスの中で、本文の抽出（頼まれたら）と変換をする（今までのやり方） */
async function convertInProcess(input: ConvertInput, options: ConvertOptions): Promise<{ parsed: ConvertResult; warnings: string[] }> {
  const warnings: string[] = [];
  const rsMain = options.mainContent
    ? await extractMainContentWithRs(input.html, input.url, undefined, {
        ...options.mainContent,
        onUnavailable: (missed) => warnings.push(RS_UNAVAILABLE_WARNINGS[missed]),
      })
    : undefined;
  const parsed = convertHtmlToMarkdown(
    input.html,
    input.url,
    input.maxChars,
    input.isRendered ?? false,
    input.onlyMainContent ?? true,
    input.selectors,
    input.removeSelectors,
    input.stripLinks,
    input.keepDataImages ?? false,
    rsMain,
  );
  return { parsed, warnings };
}

/** 別プロセスへの頼み方 */
function convertRequestFor(input: ConvertInput, options: ConvertOptions): ConvertRequest {
  const bin = options.mainContent ? envPath('SORA_RS_TRAFILATURA_PATH') : undefined;
  return {
    v: 1,
    url: input.url,
    maxChars: input.maxChars,
    isRendered: input.isRendered ?? false,
    onlyMainContent: input.onlyMainContent ?? true,
    ...(input.selectors ? { selectors: input.selectors } : {}),
    ...(input.removeSelectors ? { removeSelectors: input.removeSelectors } : {}),
    ...(input.stripLinks !== undefined ? { stripLinks: input.stripLinks } : {}),
    ...(input.keepDataImages !== undefined ? { keepDataImages: input.keepDataImages } : {}),
    ...(options.mainContent && bin ? { mainContent: { bin, ...options.mainContent } } : {}),
    want: { links: true, images: true, jsonLd: true, tables: true, html: true, ...options.want },
  };
}

type ChildFinal = { kind: 'done'; parsed: ConvertResult; rsUnavailable: Array<'content' | 'images'>; counters: Record<string, number> } | { kind: 'error'; name: string; message: string };

/** 子の 1 行を検査する。子は乗っ取られうるので、形の合わない行は約束違反として捨てる */
function readChildLine(raw: string): ChildLineVerdict<ChildFinal> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return { violation: 'JSON として読めない行がありました' };
  }
  const done = ConvertDoneSchema.safeParse(message);
  if (done.success) return { final: { kind: 'done', parsed: done.data.result as ConvertResult, rsUnavailable: done.data.rsUnavailable, counters: done.data.counters } };
  const failed = ConvertErrorSchema.safeParse(message);
  if (failed.success) return { final: { kind: 'error', name: failed.data.name.slice(0, ERROR_NAME_MAX), message: failed.data.message.slice(0, ERROR_MESSAGE_MAX) } };
  return { violation: '結果の形が正しくありません' };
}

/** 止めた（止まった）理由の言い回し。time は「タイムアウト」を含める（REST で 408 に分類される） */
function killedMessage(reason: ChildKillReason, childLimits: ChildLimits): string {
  switch (reason) {
    case 'time':
      return `ページの変換がタイムアウトしました: 時間の上限（${Math.round(childLimits.hardMs / 1000)} 秒）を過ぎても終わらなかったので、止めました`;
    case 'memory':
      return `ページの変換が中止されました: メモリの上限（${childLimits.memoryMb} MB）に達したので、止めました（ページが大きすぎます）`;
    case 'output':
      return 'ページの変換が中止されました: 出力が上限を超えたので、止めました';
    case 'crashed':
      return 'ページの変換が中止されました: 変換のプロセスが途中で終了しました';
    case 'protocol':
      return 'ページの変換が中止されました: 変換のプロセスが想定外の出力をしたので、止めました';
  }
}

/**
 * 止めた・止まった別プロセスを、運用者のために記録し、数える（`/metrics` の sora_convert_child_killed_<理由>_total）。利用者の応答には出さない。
 * stderr の末尾は、子が書いたものなので、JSON の文字列にして（改行や制御文字でログを偽造されないように）出す。ページは、ホスト名だけを書く
 * （URL のパス・問い合わせには、署名や鍵が入ることがある）
 */
function logKilled(outcome: ChildKilled, url: string): void {
  incrementSecurityCounter(`sora_convert_child_killed_${outcome.reason}_total`);
  const tail = outcome.stderrTail.trim().slice(-300);
  let host = '';
  try {
    host = new URL(url).host;
  } catch {}
  console.warn(`[Sora/変換] ページの変換のプロセスを止めました（${outcome.reason}: ${outcome.detail}。ホスト ${JSON.stringify(host)}）${tail ? ` stderr: ${JSON.stringify(tail)}` : ''}`);
}

/**
 * 取得したページの HTML を変換する（頼まれたら、本文の抽出も）。strict はすべて、standard は要素の多いページだけ、別プロセスで動かす（convertsInChild）。
 * 別プロセスのとき: 順番（convertSlots）を取り、本文の抽出と同じ uid の範囲から借りた uid に落として、時間・メモリ・出力量の上限の中で動かす。
 * 上限を超えたら ConvertLimitError（それまでの結果は無い）。子が変換の例外を返したら、同じ名前・同じ文で投げ直す。
 * warnings は、本文の抽出が使えなかったときの、利用者向けの文
 */
export async function convertPage(input: ConvertInput, options: ConvertOptions = {}): Promise<{ parsed: ConvertResult; warnings: string[] }> {
  const level = options.child?.level ?? isolationLevel();
  if (!convertsInChild(input.html, level)) return convertInProcess(input, options);
  const command = childCommandFor(options, level);
  if (command === undefined) return convertInProcess(input, options);

  const lease = await convertSlots.acquire(options.tenantId ?? currentCaller(), { signal: options.signal });
  try {
    const childLimits = convertChildLimits(options.child?.limits);
    warnIfMemoryWatchOff();
    const stdin = encodeConvertRequest(convertRequestFor(input, options), input.html);
    // 別の uid に落とすときは、起動用バイナリ経由のコマンドで動かし、終わったら、その uid のプロセスを片づける（extractor/rs_uid.ts）
    const outcome = await withExtractionUid(command, (launch) => runLimitedChild<ChildFinal>(stdin, childLimits, readChildLine, { ...launch, onSpawn: options.child?.onSpawn }));
    if (outcome.kind === 'killed') {
      logKilled(outcome, input.url);
      throw new ConvertLimitError(killedMessage(outcome.reason, childLimits), outcome.reason);
    }
    const final = outcome.value;
    if (final.kind === 'error') {
      // 変換の例外（正しくないセレクタなど）。このプロセスの中で変換したときと、同じ名前・同じ文で投げ直す
      const error = new Error(final.message);
      error.name = final.name;
      throw error;
    }
    for (const [name, count] of Object.entries(final.counters)) incrementSecurityCounter(name, count);
    return { parsed: final.parsed, warnings: final.rsUnavailable.map((missed) => RS_UNAVAILABLE_WARNINGS[missed]) };
  } finally {
    lease();
  }
}
