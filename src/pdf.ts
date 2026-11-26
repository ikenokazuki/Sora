import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeTruncateMarkdown, estimateTokens } from './enrichment.js';
import { type PdfChildLimits, type PdfChildOutcome, type PdfKillReason, pdfChildCommand, readChildRssMb, resolvePdfChildEntry, runPdfChild } from './pdf_child.js';
import { type PdfChildEvent, type PdfExtractParams, extractPdfPages } from './pdf_extract.js';
import { PDF_CONCURRENCY, withPdfUid } from './pdf_uid.js';
import { currentCaller } from './security/caller.js';
import { type QueuePolicy, SimpleSemaphore } from './security/fair_queue.js';
import { isolationLevel, limits } from './security/limits.js';
import { incrementSecurityCounter } from './security/metrics.js';
import { type ScrapeResult, DEFAULT_MAX_CHARS, HIGHLIGHT_SOURCE_MAX_CHARS } from './types.js';

/**
 * PDF の解析（pdf.js）の順番（設計 6。穴 26）。同時に動かすのは 2 件までで、全員で共有する。
 * 待っている tenant を順番に回して公平に渡し、待つ数（利用者ごと・全体）と待ち時間に上限を置く（limits.ts の pdf*）。
 * strict では、1 人が同時に持てる枠は 1 つ（pdfTenantSharePercent）。本文は枠を取ってから読むので、読み込みには timeoutMs の上限がある（safe_transport.ts）。
 * 解析そのものは、1 件ごとに別プロセス（pdf_child.ts・pdf_child_main.ts）で動かし、時間・メモリ・出力量の上限を超えたら、そのプロセスだけを止める。
 * 別プロセスは、本体と別の uid に落として動かす（pdf_uid.ts。同時の 2 件が別の uid になるよう、数 PDF_CONCURRENCY はそちらで定める）。
 */
export { PDF_CONCURRENCY };

export function pdfQueuePolicy(): QueuePolicy {
  const current = limits();
  return { perTenant: current.pdfQueuePerTenant, total: current.pdfQueueTotal, waitMs: current.pdfQueueWaitMs, sharePercent: current.pdfTenantSharePercent };
}

export const pdfSlots = new SimpleSemaphore(PDF_CONCURRENCY, { resource: 'pdf', policy: pdfQueuePolicy });

export interface PdfParseOptions {
  /** 順番を数える利用者。省略時は、呼んでいる利用者（currentCaller。呼び出しの外は legacy） */
  tenantId?: string;
  /** 順番を待つ間に中止されたら、待ちから外れる */
  signal?: AbortSignal;
  /** true なら、別プロセスを使わず、このプロセスの中で解析する（時計 now を差し替える試験用）。strict でも効くので、本番のコードは渡さない */
  inline?: boolean;
  /** 現在の時刻（ミリ秒）。1 回の解析の時間の上限（pdfMaxParseMs）を調べる。既定は Date.now。inline のときだけ効く（試験用） */
  now?: () => number;
  /** 別プロセスの扱いを替える（試験用）。limits = 上限の一部・command = 起動コマンド・entryDir = 入口（pdf-parse.js）を探す場所・onSpawn = 起動した pid を知らせる */
  child?: { limits?: Partial<PdfChildLimits>; command?: string[]; entryDir?: string; onSpawn?: (pid: number) => void };
}

/**
 * 別プロセスの解析を、上限のために止めた（または、勝手に終わった・約束を破った）あと、1 ページも読めていなかったときの失敗。
 * 1 ページでも読めていれば、失敗にせず、そこまでの結果に警告を付けて返す。reason = 止めた理由（time・memory・output・crashed・protocol）
 */
export class PdfParseLimitError extends Error {
  constructor(
    message: string,
    readonly reason: PdfKillReason,
  ) {
    super(message);
    this.name = 'PdfParseLimitError';
  }
}

/** 別プロセスの出力の合計の上限（バイト）。正当な出力は、必要な文字数（既定でも 50 万字ほど）の数倍までなので、ゆとりを見て 32MB */
const PDF_CHILD_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** 別プロセスの RSS を調べる間隔（ミリ秒）。圧縮爆弾は 1 秒に 500MB ほど広がる（実測）。上限からの超過は、数十 MB（実測で 45〜58MB。調べる間隔が 50ms のとき） */
const PDF_CHILD_POLL_MS = 25;
/** 時間の上限（pdfMaxParseMs）はページの合間にしか調べられない。それを過ぎても、ページや文書を開く途中で止まっている別プロセスを、止めるまでの猶予（ミリ秒） */
const PDF_HARD_GRACE_MS = 10_000;
/** 別プロセスが done のあと、終わるのを待つ時間（ミリ秒）。過ぎたら止める */
const PDF_CHILD_EXIT_GRACE_MS = 2_000;
/** 同梱の入口（pdf-parse.js。本番は server.js と同じ場所）か、TypeScript の入口（開発・テスト）を探す場所 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 本文を、これだけ読んだら止める（文字数）。結果に使うのは、先頭の maxChars 字と、ハイライトの元の先頭 20 万字だけ。
 * 空白の圧縮で縮む分と、ページの境目の整形の余裕を見て、必要な量の 1.5 倍に 1,000 字を足す
 */
const extractCharsNeeded = (maxChars: number): number => Math.ceil(Math.max(maxChars, HIGHLIGHT_SOURCE_MAX_CHARS) * 1.5) + 1000;

/** unpdf の extractText({ mergePages: true }) と同じ整形（空白を詰め、改行の構造は残し、空行は 1 つまで） */
const mergePageTexts = (texts: readonly string[]): string => texts.join('\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');

/** 別プロセスへの頼み方。ページ数と時間は水準の表（limits.ts）、必要な文字数は maxChars から */
export function pdfExtractParams(maxChars: number): PdfExtractParams {
  const current = limits();
  return { pageLimit: current.pdfMaxPages, needed: extractCharsNeeded(maxChars), budgetMs: current.pdfMaxParseMs };
}

/** 別プロセスの上限。メモリは水準の表、時間は 1 回の解析の時間（ページの合間にしか調べられない）に猶予を足したもの。overrides は試験用 */
export function pdfChildLimits(overrides?: Partial<PdfChildLimits>): PdfChildLimits {
  const current = limits();
  return {
    memoryMb: current.pdfMaxChildMemoryMb,
    hardMs: current.pdfMaxParseMs + PDF_HARD_GRACE_MS,
    maxOutputBytes: PDF_CHILD_MAX_OUTPUT_BYTES,
    pollMs: PDF_CHILD_POLL_MS,
    exitGraceMs: PDF_CHILD_EXIT_GRACE_MS,
    ...overrides,
  };
}

let warnedInline = false;
let rssWatchable: boolean | undefined;
/** 試験用: 1 回だけ出す警告を、もう一度出せるようにする */
export function resetPdfWarnings(): void {
  warnedInline = false;
  rssWatchable = undefined;
}

/** 別プロセスのメモリ（RSS）を /proc から読めないとき（Linux 以外・/proc を隠した環境）、メモリの上限が効かないことを、1 回だけ知らせる */
function warnIfMemoryWatchOff(): void {
  rssWatchable ??= readChildRssMb(process.pid) !== undefined;
  if (rssWatchable) return;
  rssWatchable = true;
  console.warn('[Sora/PDF] 子プロセスのメモリ（RSS）を /proc から読めないので、PDF の解析のメモリの上限は効きません（時間と出力量の上限は効きます）。コンテナのメモリの上限（--memory）を付けてください');
}
/** 入口が見つからないとき、standard はこのプロセスの中で解析する。隔離が効かないことを、1 回だけ知らせる */
function warnInlineOnce(): void {
  if (warnedInline) return;
  warnedInline = true;
  console.warn('[Sora/PDF] PDF の解析の入口（pdf-parse.js）が見つからないので、このプロセスの中で解析します（重い PDF が、本体のメモリと時間を使い切るのを止められません）');
}

/** 別プロセスの起動コマンド。undefined は、このプロセスの中で解析する（standard で入口が見つからないとき）。strict は、見つからなければ失敗する */
function childCommandFor(params: PdfExtractParams, options: PdfParseOptions): string[] | undefined {
  if (options.child?.command) return options.child.command;
  const entry = resolvePdfChildEntry(options.child?.entryDir ?? MODULE_DIR);
  if (entry !== undefined) return pdfChildCommand(entry, params);
  if (isolationLevel() === 'strict') {
    throw new Error('PDF の解析の入口（pdf-parse.js）が見つかりません。SORA_ISOLATION=strict は、PDF の解析を別プロセスで動かすので、同梱の pdf-parse.js が要ります');
  }
  warnInlineOnce();
  return undefined;
}

/** 別プロセスを止めた（止まった）理由の言い回し。警告（読めたページまでを返すとき）と失敗（1 ページも読めなかったとき）の両方に使う */
const killedCause = (reason: PdfKillReason, childLimits: PdfChildLimits): string => {
  switch (reason) {
    case 'time':
      return `時間の上限（${Math.round(limits().pdfMaxParseMs / 1000)} 秒）を過ぎても終わらなかったので、止めました`;
    case 'memory':
      return `メモリの上限（${childLimits.memoryMb} MB）に達したので、止めました`;
    case 'output':
      return '出力が上限を超えたので、止めました';
    case 'crashed':
      return '解析のプロセスが途中で終了しました';
    case 'protocol':
      return '解析のプロセスが想定外の出力をしたので、止めました';
  }
};

/** 1 ページも読めなかったときの失敗の文。time は「タイムアウト」を含める（REST で 408 に分類される） */
const killedMessage = (reason: PdfKillReason, childLimits: PdfChildLimits): string =>
  `PDF の解析が${reason === 'time' ? 'タイムアウトしました' : '中止されました'}: ${killedCause(reason, childLimits)}`;

/**
 * 止めた・止まった別プロセスを、運用者のために記録し、数える（`/metrics` の sora_pdf_child_killed_<理由>_total）。利用者の応答には出さない。
 * stderr の末尾は、子が書いたものなので、JSON の文字列にして（改行や制御文字でログを偽造されないように）出す
 */
function logKilled(outcome: Extract<PdfChildOutcome, { kind: 'killed' }>): void {
  incrementSecurityCounter(`sora_pdf_child_killed_${outcome.reason}_total`);
  const tail = outcome.stderrTail.trim().slice(-300);
  console.warn(`[Sora/PDF] PDF の解析のプロセスを止めました（${outcome.reason}: ${outcome.detail}）${tail ? ` stderr: ${JSON.stringify(tail)}` : ''}`);
}

/** PDF バッファからテキスト・メタデータを抽出し Markdown へ構造化。解析は別プロセスで動かす（options.inline で、このプロセスの中） */
export async function parsePdfToMarkdown(
  /** PDF のバイト列。関数で渡すと、順番が来てから呼ぶ（待っている間に、本体（最大 30MB）をメモリに持たない） */
  buffer: ArrayBuffer | Uint8Array | (() => Promise<Uint8Array>),
  targetUrl: string,
  maxChars = DEFAULT_MAX_CHARS,
  options: PdfParseOptions = {},
): Promise<ScrapeResult & { fullContent: string }> {
  // 解析の順番（断ったら ResourceBusyError）。バイト列を受け取る前、文書を開く前に取る（開くだけでも重い）
  const lease = await pdfSlots.acquire(options.tenantId ?? currentCaller(), { signal: options.signal });
  let totalPages = 0;
  let timeBudgetHit = false;
  let pdfMetadata: Record<string, string> = {};
  const pageTexts: string[] = [];
  const warnings: string[] = [];
  try {
    const bytes = typeof buffer === 'function' ? await buffer() : buffer;
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const params = pdfExtractParams(maxChars);
    const onEvent = (event: PdfChildEvent): void => {
      if (event.t === 'open') {
        totalPages = event.numPages;
        pdfMetadata = event.info;
      } else {
        pageTexts.push(event.text);
      }
    };
    const command = options.inline ? undefined : childCommandFor(params, options);
    if (command === undefined) {
      ({ timeBudgetHit } = await extractPdfPages(uint8, params, onEvent, options.now));
    } else {
      const childLimits = pdfChildLimits(options.child?.limits);
      warnIfMemoryWatchOff();
      // 別の uid に落とすときは、起動用バイナリ経由のコマンドで動かし、終わったら、その uid のプロセスを片づける（pdf_uid.ts）
      const outcome = await withPdfUid(command, (launch) => runPdfChild(uint8, params, childLimits, onEvent, { ...launch, onSpawn: options.child?.onSpawn }));
      if (outcome.kind === 'error') {
        // pdf.js の例外（壊れた PDF・パスワード付きなど）。このプロセスの中で解析したときと、同じ名前・同じ文で投げ直す
        const error = new Error(outcome.message);
        error.name = outcome.name;
        throw error;
      }
      if (outcome.kind === 'killed') {
        logKilled(outcome);
        if (pageTexts.length === 0) throw new PdfParseLimitError(killedMessage(outcome.reason, childLimits), outcome.reason);
        warnings.push(`PDF の解析が途中で終わりました: ${killedCause(outcome.reason, childLimits)}。先頭の ${pageTexts.length} ページまでの結果です（全 ${totalPages} ページ）`);
      } else {
        timeBudgetHit = outcome.timeBudgetHit;
      }
    }
  } finally {
    lease();
  }

  const pagesRead = pageTexts.length;
  const rawText = mergePageTexts(pageTexts);
  const title = pdfMetadata.Title || targetUrl.split('/').pop() || 'PDF Document';
  const author = pdfMetadata.Author || undefined;
  const markdown = rawText.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

  // 本文が maxChars を超える、または、読まなかったページがある（ページの上限・必要な量に達した）とき、切れている
  const isTruncated = markdown.length > maxChars || pagesRead < totalPages;
  const truncatedContent = safeTruncateMarkdown(markdown, maxChars);
  const estimatedTokens = estimateTokens(truncatedContent);
  // 時間の上限で止めた結果は、負荷で変わる（決まった内容ではない）ので、警告を付ける（scrape のキャッシュが、短くだけ残す）
  if (timeBudgetHit) warnings.push(`PDF の解析が時間の上限（${Math.round(limits().pdfMaxParseMs / 1000)} 秒）に達し、先頭の ${pagesRead} ページまでの結果です（全 ${totalPages} ページ）`);

  return {
    url: targetUrl,
    title,
    author,
    content: truncatedContent,
    isTruncated,
    contentType: 'application/pdf',
    source: 'web',
    metadata: { ...pdfMetadata, totalPages, pagesRead },
    ...(warnings.length > 0 ? { warnings } : {}),
    estimatedTokens,
    fullContent: safeTruncateMarkdown(markdown, HIGHLIGHT_SOURCE_MAX_CHARS),
  };
}
