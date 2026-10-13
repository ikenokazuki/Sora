import Papa from 'papaparse';
import yauzl from 'yauzl';

/**
 * zip の最初のファイルを開き、読み取りストリームを渡す。ABR・日本郵便の配布物は 1 ファイルだけを含む。
 * onStream は終わったら done() を、失敗したら done(error) を呼ぶ。
 */
function openFirstEntry(zipPath: string, onStream: (stream: NodeJS.ReadableStream, done: (error?: Error) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('zip を開けません'));
        return;
      }
      let settled = false;
      const done = (error?: Error): void => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* すでに閉じている */ }
        if (error) reject(error);
        else resolve();
      };
      zip.on('error', (error) => done(error));
      zip.on('end', () => done(new Error('zip にファイルがありません')));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            done(streamError ?? new Error('zip のエントリを開けません'));
            return;
          }
          onStream(stream, done);
        });
      });
      zip.readEntry();
    });
  });
}

/** zip の最初のファイルを読む。小さい zip（数MB 以下）向け。大きいものは streamZipCsv を使う。 */
export async function readZipEntry(zipPath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await openFirstEntry(zipPath, (stream, done) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', (error) => done(error));
    stream.on('end', () => done());
  });
  return Buffer.concat(chunks);
}

export async function readZipText(zipPath: string, encoding = 'utf-8'): Promise<string> {
  const buffer = await readZipEntry(zipPath);
  return new TextDecoder(encoding).decode(buffer).replace(/^﻿/, '');
}

export function parseCsvRows(text: string): Record<string, string>[] {
  return Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, delimiter: ',' }).data;
}

export function parseCsvMatrix(text: string): string[][] {
  return Papa.parse<string[]>(text, { skipEmptyLines: true, delimiter: ',' }).data;
}

// ---------- ストリーム処理（大きい CSV 向け） ----------

const COMMA = 44;
const LF = 10;
const CR = 13;
const QUOTE = 34;

/**
 * 増分の CSV 解析（RFC 4180）。文字列のチャンクを push すると、行（列の配列）ができるたびに onRow を呼ぶ。
 * チャンクはどこで切れてもよい。onRow が false を返したら以降は渡さず、push も false を返す。空行は渡さない。
 */
export class CsvRowParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  /** 引用符の中で " を見た直後。次が " なら引用符そのもの、そうでなければ引用符が閉じる。 */
  private pendingQuote = false;
  private stopped = false;

  constructor(private readonly onRow: (row: string[]) => unknown) {}

  push(text: string): boolean {
    let i = 0;
    const n = text.length;
    while (i < n && !this.stopped) {
      if (this.inQuotes) {
        if (this.pendingQuote) {
          if (text.charCodeAt(i) === QUOTE) {
            this.field += '"';
            this.pendingQuote = false;
            i += 1;
            continue;
          }
          // 引用符が閉じた。同じ位置の文字を、引用符の外として処理し直す。
          this.inQuotes = false;
          this.pendingQuote = false;
          continue;
        }
        const quote = text.indexOf('"', i);
        if (quote === -1) {
          this.field += text.slice(i);
          i = n;
        } else {
          this.field += text.slice(i, quote);
          this.pendingQuote = true;
          i = quote + 1;
        }
        continue;
      }
      let j = i;
      for (; j < n; j++) {
        const code = text.charCodeAt(j);
        if (code === COMMA || code === LF || code === CR || code === QUOTE) break;
      }
      if (j > i) {
        this.field += text.slice(i, j);
        i = j;
        if (i >= n) break;
      }
      const code = text.charCodeAt(i);
      i += 1;
      if (code === COMMA) {
        this.row.push(this.field);
        this.field = '';
      } else if (code === LF) {
        this.endRow();
      } else if (code === QUOTE) {
        // 列の先頭の引用符だけが、引用符の始まり。行の途中の引用符は文字として扱う。
        if (this.field === '') this.inQuotes = true;
        else this.field += '"';
      }
      // CR は読み捨てる（CRLF の改行は LF で行を終える）。
    }
    return !this.stopped;
  }

  /** 末尾の改行が無い最後の行を渡す。 */
  end(): void {
    if (this.stopped) return;
    if (this.field !== '' || this.row.length > 0) this.endRow();
  }

  private endRow(): void {
    this.row.push(this.field);
    const row = this.row;
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.pendingQuote = false;
    if (row.length === 1 && row[0] === '') return;
    if (this.onRow(row) === false) this.stopped = true;
  }
}

/** UTF-8 のバイト列を、複数バイトの文字の途中で切れても壊さずに CSV の行にする（BOM は除く）。 */
export class CsvByteStream {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly parser: CsvRowParser;
  private first = true;

  constructor(onRow: (row: string[]) => unknown) {
    this.parser = new CsvRowParser(onRow);
  }

  /** false が返ったら、これ以上読まなくてよい。 */
  write(chunk: Uint8Array): boolean {
    let text = this.decoder.decode(chunk, { stream: true });
    if (this.first && text !== '') {
      this.first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    return this.parser.push(text);
  }

  end(): void {
    this.parser.push(this.decoder.decode());
    this.parser.end();
  }
}

/**
 * zip の最初のファイルを展開しながら、CSV を 1 行（列の配列）ずつ onRow に渡す。ヘッダー行も通常の行として渡す。
 * メモリに載せるのは 1 チャンクと 1 行だけ。onRow が false を返したら読み終える。
 */
export function streamZipCsv(zipPath: string, onRow: (row: string[]) => unknown): Promise<void> {
  return openFirstEntry(zipPath, (stream, done) => {
    const reader = new CsvByteStream(onRow);
    let finished = false;
    stream.on('data', (chunk: Buffer) => {
      if (finished) return;
      try {
        if (!reader.write(chunk)) {
          finished = true;
          (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
          done();
        }
      } catch (error) {
        finished = true;
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stream.on('error', (error) => {
      if (!finished) done(error);
    });
    stream.on('end', () => {
      if (finished) return;
      finished = true;
      try {
        reader.end();
        done();
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
