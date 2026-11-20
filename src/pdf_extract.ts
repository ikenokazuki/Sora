import { getDocumentProxy } from 'unpdf';

/**
 * PDF から本文を取り出す部分（pdf.js）。別プロセス（pdf_child_main.ts）の中でも、このプロセスの中でも（テスト・入口が見つからないとき）、
 * 同じものを使う。順番（pdf.ts の pdfSlots）・結果の整形・上限の判断は、呼ぶ側（pdf.ts）にある。
 */

/** 解析の頼み方。呼ぶ側が決めて渡す（別プロセスは、環境変数から水準を読まない） */
export interface PdfExtractParams {
  /** 読むページ数の上限（先頭から） */
  pageLimit: number;
  /** 本文を、これだけ（文字数）読んだら止める */
  needed: number;
  /** 1 回の解析の時間の上限（ミリ秒）。文書を開いたあと、ページを読み始める前に調べる */
  budgetMs: number;
}

/** 別プロセスから親へ、1 行の JSON で送る出来事（文書を開いた・1 ページ読んだ） */
export type PdfChildEvent =
  | { t: 'open'; numPages: number; info: Record<string, string> }
  | { t: 'page'; n: number; text: string };

/** 文書情報（Info 辞書）のうち、返す項目。PDF の側が決める任意のキー（Custom など）と大きさは、そのまま返さない */
const INFO_FIELDS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'PDFFormatVersion'] as const;
/** Title・Author（title・author として返る）の長さの上限（字）。ほかの項目は、その 5/3 倍 */
const INFO_TEXT_MAX = 300;
const capText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 文書情報から、決まった項目だけを、長さを切って取り出す（文字列でないもの・空は捨てる）。別プロセスから届いた値にも、もう一度かける */
export function pickInfo(info: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of INFO_FIELDS) {
    const value = info[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    out[field] = capText(value.trim(), field === 'Title' || field === 'Author' ? INFO_TEXT_MAX : Math.round((INFO_TEXT_MAX * 5) / 3));
  }
  return out;
}

/**
 * PDF の先頭から 1 ページずつ読み、文書を開いたとき（open）と 1 ページ読むごと（page）に emit する。必要な文字数に達するか、ページの上限まで
 * 読むか、時間の上限に達したら止める（以前は、全ページを一度に読んでいた）。時間の上限で止めたときは timeBudgetHit を返す。
 * emit が Promise を返すなら、待つ（別プロセスは、書き込みが終わってから次へ進む）。壊れた PDF などは、pdf.js の例外のまま投げる。
 */
export async function extractPdfPages(
  bytes: Uint8Array,
  params: PdfExtractParams,
  emit: (event: PdfChildEvent) => void | Promise<void>,
  now: () => number = Date.now,
): Promise<{ timeBudgetHit: boolean }> {
  const pdf = await getDocumentProxy(bytes);
  try {
    // PDF の側が決める値。負の値や整数でない値は 0 にする（親は、負のページ数を約束違反として止める）
    const totalPages = Math.max(0, Math.trunc(pdf.numPages) || 0);
    let info: Record<string, string> = {};
    try {
      info = pickInfo(((await pdf.getMetadata())?.info ?? {}) as Record<string, unknown>);
    } catch {}
    await emit({ t: 'open', numPages: totalPages, info });
    const pageLimit = Math.min(totalPages, params.pageLimit);
    const startedAt = now();
    let chars = 0;
    for (let pageNumber = 1; pageNumber <= pageLimit && chars < params.needed; pageNumber++) {
      if (now() - startedAt >= params.budgetMs) return { timeBudgetHit: true };
      // ページの合間に、イベントループへ処理を譲る（待ち・読み込みはマイクロタスクだけで進むので、譲らないと、全ページのあいだ、タイマーも I/O も動かない）
      await new Promise<void>((resolve) => setImmediate(resolve));
      const content = await (await pdf.getPage(pageNumber)).getTextContent();
      const text = content.items
        .filter((item) => 'str' in item && item.str != null)
        .map((item) => `${(item as { str: string }).str}${(item as { hasEOL?: boolean }).hasEOL ? '\n' : ''}`)
        .join('');
      chars += text.length;
      await emit({ t: 'page', n: pageNumber, text });
    }
    return { timeBudgetHit: false };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
