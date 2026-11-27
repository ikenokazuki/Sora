import { describe, expect, test } from 'bun:test';
import { type ConvertRequest, decodeConvertRequest, encodeConvertRequest } from './html_convert_protocol.js';

/** 変換の別プロセスの約束（html_convert_protocol.ts）: 標準入力の、頼み方の 1 行と HTML の分け方 */

const REQUEST: ConvertRequest = { v: 1, url: 'https://example.com/a', maxChars: 1000, isRendered: false, onlyMainContent: true, want: { links: true, images: false, jsonLd: false, tables: false, html: false } };
const bytesOf = async (request: unknown, html: string) => new Uint8Array(await encodeConvertRequest(request as ConvertRequest, html).arrayBuffer());

describe('頼み方と HTML の受け渡し', () => {
  test('HTML は、一字も変えずに届く（先頭の改行・空白、日本語・絵文字、HTML の中の改行も）', async () => {
    const html = '\n\n  <p>本文\nの 🎉 段落</p>\r\n<p>次</p>\n';
    const { request, html: received } = decodeConvertRequest(await bytesOf(REQUEST, html));
    expect(received).toBe(html);
    expect(request).toEqual(REQUEST);
  });

  test('知らない版（v が 1 でない）の頼み方は、ほかの欄が正しくても断る', async () => {
    expect(() => decodeConvertRequest(new Uint8Array(0))).toThrow();
    const bytes = await bytesOf({ ...REQUEST, v: 2 }, '<p>x</p>');
    expect(() => decodeConvertRequest(bytes)).toThrow();
  });
});
