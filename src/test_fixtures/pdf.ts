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
