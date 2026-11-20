import { constants, deflateRawSync } from 'node:zlib';

// テスト用の合成の PDF（ASCII の行だけ。Helvetica。1 ページに何行でも）。実在の文書は使わない。

const escapePdfText = (line: string): string => line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** pages[i] はそのページの行。info を渡すと、文書情報（Title・Author）を付ける。xref は正しく作る（pdf.js が作り直さずに読める） */
export function makePdf(pages: ReadonlyArray<readonly string[]>, info?: { title?: string; author?: string; subject?: string; custom?: Record<string, string>; extraInfo?: Record<string, string> }): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const [i, lines] of pages.entries()) {
    const content = `BT /F1 10 Tf 40 800 Td 12 TL ${lines.map((line) => `(${escapePdfText(line)}) Tj T*`).join(' ')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  if (info) {
    const entries = [
      info.title !== undefined ? `/Title (${escapePdfText(info.title)})` : '',
      info.author !== undefined ? `/Author (${escapePdfText(info.author)})` : '',
      info.subject !== undefined ? `/Subject (${escapePdfText(info.subject)})` : '',
      info.custom ? `/Custom << ${Object.entries(info.custom).map(([k, v]) => `/${k} (${escapePdfText(v)})`).join(' ')} >>` : '',
      ...Object.entries(info.extraInfo ?? {}).map(([k, v]) => `/${k} (${escapePdfText(v)})`),
    ].filter(Boolean);
    objects.push(`<< ${entries.join(' ')} >>`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info ? ` /Info ${objects.length} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/**
 * 圧縮爆弾の PDF（試験用）: 1 ページの内容が、Flate で `megabytes` MB の空白に膨らむ（ファイルは数十 KB）。
 * 16MB の空白を圧縮した断片（raw deflate。Z_SYNC_FLUSH で終わるので、つなげられる）を並べて作る（大きな配列を作らず、速い）。
 * goodLines を渡すと、その前に、普通の 1 ページ（先頭）を置く（爆弾のページは 2 ページ目）。
 */
export function makeBombPdf(megabytes: number, goodLines?: readonly string[]): Uint8Array {
  const chunkMb = 16;
  const segment = deflateRawSync(Buffer.alloc(chunkMb * 1024 * 1024, 0x20), { finishFlush: constants.Z_SYNC_FLUSH });
  const count = Math.ceil(megabytes / chunkMb);
  // zlib の頭（78 01）+ 断片 + 最後の空のブロック（01 00 00 ff ff）+ Adler-32（pdf.js は確かめない）
  const bomb = Buffer.concat([Buffer.from([0x78, 0x01]), ...Array.from({ length: count }, () => segment), Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff, 0, 0, 0, 1])]);
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (data: Buffer | string): void => {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    parts.push(buffer);
    size += buffer.length;
  };
  const object = (id: number, body: Buffer | string): void => {
    offsets[id] = size;
    push(`${id} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };
  const good = goodLines !== undefined;
  push('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${good ? '3 0 R 5 0 R' : '3 0 R'}] /Count ${good ? 2 : 1} >>`);
  const bombPage = good ? 5 : 3;
  const bombContents = good ? 6 : 4;
  if (good) {
    object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>');
    const content = `BT /F1 10 Tf 40 800 Td 12 TL ${goodLines.map((line) => `(${line.replace(/[\\()]/g, '\\$&')}) Tj T*`).join(' ')} ET`;
    object(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  }
  object(bombPage, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${bombContents} 0 R >>`);
  offsets[bombContents] = size;
  push(`${bombContents} 0 obj\n<< /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`);
  push(bomb);
  push('\nendstream\nendobj\n');
  const last = good ? 7 : bombContents;
  const xref = size;
  push(`xref\n0 ${last + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= last; id++) push(offsets[id] === undefined ? '0000000000 65535 f \n' : `${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}
