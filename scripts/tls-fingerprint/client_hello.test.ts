import { describe, expect, test } from 'bun:test';
import { comparable, diffHellos, isGrease, parseClientHello } from './client_hello.js';

const u8 = (n: number) => [n & 0xff];
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string) => Array.from(new TextEncoder().encode(s));
const withLength16 = (bytes: number[]) => [...u16(bytes.length), ...bytes];
const withLength8 = (bytes: number[]) => [...u8(bytes.length), ...bytes];

/** テスト用に、ClientHello を含む TLS レコードを作る */
function record(options: { ciphers: number[]; extensions: Array<[number, number[]]> }): Uint8Array {
  const extensions = options.extensions.flatMap(([type, data]) => [...u16(type), ...withLength16(data)]);
  const body = [
    ...u16(0x0303),
    ...new Array(32).fill(7), // random
    ...withLength8([]), // session_id
    ...withLength16(options.ciphers.flatMap(u16)),
    ...withLength8([0]), // compression: null
    ...withLength16(extensions),
  ];
  const handshake = [0x01, ...u24(body.length), ...body];
  return Uint8Array.from([0x16, 0x03, 0x01, ...u16(handshake.length), ...handshake]);
}

const sni = (name: string): [number, number[]] => [0, withLength16([0, ...withLength16(ascii(name))])];
const groups = (list: number[]): [number, number[]] => [10, withLength16(list.flatMap(u16))];
const sigalgs = (list: number[]): [number, number[]] => [13, withLength16(list.flatMap(u16))];
const alpn = (list: string[]): [number, number[]] => [16, withLength16(list.flatMap((p) => withLength8(ascii(p))))];
const versions = (list: number[]): [number, number[]] => [43, withLength8(list.flatMap(u16))];
const keyShare = (list: number[]): [number, number[]] => [51, withLength16(list.flatMap((group) => [...u16(group), ...withLength16([1, 2, 3])]))];
const compression = (list: number[]): [number, number[]] => [27, withLength8(list.flatMap(u16))];
const alps = (type: number, list: string[]): [number, number[]] => [type, withLength16(list.flatMap((p) => withLength8(ascii(p))))];

const sample = () =>
  record({
    ciphers: [0x1a1a, 0x1301, 0x1302, 0xc02b],
    extensions: [
      [0x2a2a, []],
      sni('localhost'),
      groups([0x3a3a, 4588, 29, 23]),
      sigalgs([1027, 2052, 1025]),
      alpn(['h2', 'http/1.1']),
      versions([0x4a4a, 0x0304, 0x0303]),
      keyShare([0x3a3a, 4588]),
      compression([2]),
      alps(17613, ['h2']),
      [0xfe0d, [0, 1, 2, 3]],
      [21, [0, 0, 0]],
    ],
  });

describe('isGrease', () => {
  test('0x0a0a・0x1a1a …・0xfafa だけが GREASE', () => {
    for (let n = 0; n < 16; n++) expect(isGrease((n << 12) | 0x0a00 | (n << 4) | 0x0a)).toBe(true);
    expect(isGrease(0x0a1a)).toBe(false);
    expect(isGrease(0x1301)).toBe(false);
    expect(isGrease(0x0304)).toBe(false);
  });
});

describe('parseClientHello', () => {
  test('暗号スイート・拡張・曲線・署名アルゴリズム・ALPN・TLS の版・key_share・証明書の圧縮・ALPS・ECH を取り出す（GREASE は GREASE にそろえる）', () => {
    const hello = parseClientHello(sample())!;
    expect(hello.legacyVersion).toBe(0x0303);
    expect(hello.cipherSuites).toEqual(['GREASE', 0x1301, 0x1302, 0xc02b]);
    expect(hello.compressionMethods).toEqual([0]);
    expect(hello.extensionTypes).toEqual(['GREASE', 0, 10, 13, 16, 43, 51, 27, 17613, 0xfe0d, 21]);
    expect(hello.serverName).toBe('localhost');
    expect(hello.supportedGroups).toEqual(['GREASE', 4588, 29, 23]);
    expect(hello.signatureAlgorithms).toEqual([1027, 2052, 1025]);
    expect(hello.alpn).toEqual(['h2', 'http/1.1']);
    expect(hello.supportedVersions).toEqual(['GREASE', 0x0304, 0x0303]);
    expect(hello.keyShareGroups).toEqual(['GREASE', 4588]);
    expect(hello.certificateCompression).toEqual([2]);
    expect(hello.alps).toEqual([{ type: 17613, protocols: ['h2'] }]);
    expect(hello.ech).toBe('outer');
    expect(hello.padding).toBe(true);
  });

  test('レコードが途中までなら null。ハンドシェイクでなければ例外', () => {
    const full = sample();
    expect(parseClientHello(full.slice(0, 4))).toBeNull();
    expect(parseClientHello(full.slice(0, full.length - 1))).toBeNull();
    expect(() => parseClientHello(Uint8Array.from([0x17, 3, 3, 0, 1, 0]))).toThrow('not a TLS handshake');
  });
});

describe('diffHellos', () => {
  test('拡張の並びが違っても（Chrome は実行ごとに入れ替える）、同じ集合なら差なし', () => {
    const a = parseClientHello(sample())!;
    const reordered = parseClientHello(record({
      ciphers: [0x1a1a, 0x1301, 0x1302, 0xc02b],
      extensions: [
        [21, [0, 0, 0]], [0xfe0d, [0, 9, 9, 9]], alps(17613, ['h2']), compression([2]), keyShare([0x3a3a, 4588]),
        versions([0x4a4a, 0x0304, 0x0303]), alpn(['h2', 'http/1.1']), sigalgs([1027, 2052, 1025]), groups([0x3a3a, 4588, 29, 23]), sni('localhost'), [0x2a2a, []],
      ],
    }))!;
    expect(diffHellos(a, reordered)).toEqual([]);
    expect(comparable(a).extensionTypes).toEqual([0, 10, 13, 16, 21, 27, 43, 51, 17613, 0xfe0d]);
  });

  test('署名アルゴリズムの先頭に ML-DSA が付いた差を、項目名と両方の値つきで返す', () => {
    const browser = parseClientHello(record({ ciphers: [0x1301], extensions: [sigalgs([0x0904, 0x0905, 0x0906, 1027])] }))!;
    const wreq = parseClientHello(record({ ciphers: [0x1301], extensions: [sigalgs([1027])] }))!;
    expect(diffHellos(browser, wreq)).toEqual([{ field: 'signatureAlgorithms', browser: [2308, 2309, 2310, 1027], wreq: [1027] }]);
  });

  test('暗号スイートや拡張の種類の違いも見つける', () => {
    const a = parseClientHello(record({ ciphers: [0x1301, 0x1302], extensions: [[0xca34, []]] }))!;
    const b = parseClientHello(record({ ciphers: [0x1301], extensions: [] }))!;
    expect(diffHellos(a, b).map((d) => d.field).sort()).toEqual(['cipherSuites', 'extensionTypes']);
  });
});
