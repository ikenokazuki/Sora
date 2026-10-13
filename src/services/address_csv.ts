import Papa from 'papaparse';
import yauzl from 'yauzl';

/** zip の最初のファイルを読む。ABR・日本郵便の配布物は 1 ファイルだけを含む。小さい zip（数MB 以下）向け。 */
export function readZipEntry(zipPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('zip を開けません'));
        return;
      }
      let settled = false;
      const finish = (error: Error | null, value?: Buffer): void => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* すでに閉じている */ }
        if (error) reject(error);
        else resolve(value as Buffer);
      };
      zip.on('error', (error) => finish(error));
      zip.on('end', () => finish(new Error('zip にファイルがありません')));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error('zip のエントリを開けません'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', (error) => finish(error));
          stream.on('end', () => finish(null, Buffer.concat(chunks)));
        });
      });
      zip.readEntry();
    });
  });
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
