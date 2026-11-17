import { getDocumentProxy } from 'unpdf';
import { safeTruncateMarkdown, estimateTokens } from './enrichment.js';
import { currentCaller } from './security/caller.js';
import { type QueuePolicy, SimpleSemaphore } from './security/fair_queue.js';
import { limits } from './security/limits.js';
import { type ScrapeResult, DEFAULT_MAX_CHARS, HIGHLIGHT_SOURCE_MAX_CHARS } from './types.js';

/**
 * PDF の解析（pdf.js。1 つのスレッドで動く）の順番（設計 6。穴 26）。同時に動かすのは 2 件までで、全員で共有する。
 * 待っている tenant を順番に回して公平に渡し、待つ数（利用者ごと・全体）と待ち時間に上限を置く（limits.ts の pdf*）。
 */
export const PDF_CONCURRENCY = 2;

export function pdfQueuePolicy(): QueuePolicy {
  const current = limits();
  return { perTenant: current.pdfQueuePerTenant, total: current.pdfQueueTotal, waitMs: current.pdfQueueWaitMs, sharePercent: 100 };
}

export const pdfSlots = new SimpleSemaphore(PDF_CONCURRENCY, { resource: 'pdf', policy: pdfQueuePolicy });

export interface PdfParseOptions {
  /** 順番を数える利用者。省略時は、呼んでいる利用者（currentCaller。呼び出しの外は legacy） */
  tenantId?: string;
  /** 順番を待つ間に中止されたら、待ちから外れる */
  signal?: AbortSignal;
  /** 現在の時刻（ミリ秒）。1 回の解析の時間の上限（pdfMaxParseMs）を調べる。既定は Date.now（テスト用） */
  now?: () => number;
}

/** 文書情報（Info 辞書）のうち、返す項目。PDF の側が決める任意のキー（Custom など）と大きさは、そのまま返さない */
const INFO_FIELDS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'PDFFormatVersion'] as const;
/** Title・Author（title・author として返る）の長さの上限（字）。ほかの項目は、その 5/3 倍 */
const INFO_TEXT_MAX = 300;
const capText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 文書情報から、決まった項目だけを、長さを切って取り出す（文字列でないもの・空は捨てる） */
function pickInfo(info: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of INFO_FIELDS) {
    const value = info[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    out[field] = capText(value.trim(), field === 'Title' || field === 'Author' ? INFO_TEXT_MAX : Math.round((INFO_TEXT_MAX * 5) / 3));
  }
  return out;
}

/**
 * 本文を、これだけ読んだら止める（文字数）。結果に使うのは、先頭の maxChars 字と、ハイライトの元の先頭 20 万字だけ。
 * 空白の圧縮で縮む分と、ページの境目の整形の余裕を見て、必要な量の 1.5 倍に 1,000 字を足す
 */
const extractCharsNeeded = (maxChars: number): number => Math.ceil(Math.max(maxChars, HIGHLIGHT_SOURCE_MAX_CHARS) * 1.5) + 1000;

/** unpdf の extractText({ mergePages: true }) と同じ整形（空白を詰め、改行の構造は残し、空行は 1 つまで） */
const mergePageTexts = (texts: readonly string[]): string => texts.join('\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');

/** PDF バッファからテキスト・メタデータを抽出し Markdown へ構造化 */
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
  let pagesRead = 0;
  let timeBudgetHit = false;
  let pdfMetadata: Record<string, string> = {};
  let rawText = '';
  try {
    const bytes = typeof buffer === 'function' ? await buffer() : buffer;
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const pdf = await getDocumentProxy(uint8);
    try {
      totalPages = pdf.numPages;
      const pageLimit = Math.min(totalPages, limits().pdfMaxPages);
      const needed = extractCharsNeeded(maxChars);
      const now = options.now ?? Date.now;
      const startedAt = now();
      const budgetMs = limits().pdfMaxParseMs;
      const texts: string[] = [];
      let chars = 0;
      // 先頭から 1 ページずつ読み、必要な文字数に達するか、上限のページまで読むか、時間の上限に達したら止める（以前は、全ページを一度に読んでいた）
      for (let pageNumber = 1; pageNumber <= pageLimit && chars < needed; pageNumber++) {
        if (now() - startedAt >= budgetMs) {
          timeBudgetHit = true;
          break;
        }
        // ページの合間に、イベントループへ処理を譲る（待ち・読み込みはマイクロタスクだけで進むので、譲らないと、全ページのあいだ、タイマーも I/O も動かない）
        await new Promise<void>((resolve) => setImmediate(resolve));
        const content = await (await pdf.getPage(pageNumber)).getTextContent();
        const text = content.items.filter((item) => 'str' in item && item.str != null).map((item) => `${(item as { str: string }).str}${(item as { hasEOL?: boolean }).hasEOL ? '\n' : ''}`).join('');
        texts.push(text);
        chars += text.length;
        pagesRead = pageNumber;
      }
      rawText = mergePageTexts(texts);
      try {
        pdfMetadata = pickInfo(((await pdf.getMetadata())?.info ?? {}) as Record<string, unknown>);
      } catch {}
    } finally {
      await pdf.loadingTask.destroy();
    }
  } finally {
    lease();
  }

  const title = pdfMetadata.Title || targetUrl.split('/').pop() || 'PDF Document';
  const author = pdfMetadata.Author || undefined;
  const markdown = rawText.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

  // 本文が maxChars を超える、または、読まなかったページがある（ページの上限・必要な量に達した）とき、切れている
  const isTruncated = markdown.length > maxChars || pagesRead < totalPages;
  const truncatedContent = safeTruncateMarkdown(markdown, maxChars);
  const estimatedTokens = estimateTokens(truncatedContent);

  return {
    url: targetUrl,
    title,
    author,
    content: truncatedContent,
    isTruncated,
    contentType: 'application/pdf',
    source: 'web',
    metadata: { ...pdfMetadata, totalPages, pagesRead },
    // 時間の上限で止めた結果は、負荷で変わる（決まった内容ではない）ので、警告を付ける（scrape のキャッシュが、短くだけ残す）
    ...(timeBudgetHit ? { warnings: [`PDF の解析が時間の上限（${Math.round(limits().pdfMaxParseMs / 1000)} 秒）に達し、先頭の ${pagesRead} ページまでの結果です（全 ${totalPages} ページ）`] } : {}),
    estimatedTokens,
    fullContent: safeTruncateMarkdown(markdown, HIGHLIGHT_SOURCE_MAX_CHARS),
  };
}
