/**
 * TLS の ClientHello の解析と、2 つの ClientHello の比較。
 * 静的取得（wreq-js のプロファイル）とブラウザ（Chromium）が、同じ Chrome の姿を送っているかを、外部のサービスに頼らずに確かめる。
 * 比べる項目は、暗号スイート・拡張の種類・曲線・署名アルゴリズム・ALPN・TLS の版・key_share の群・証明書の圧縮・ALPS・ECH。
 * GREASE の値は 'GREASE' にそろえ、拡張の並びは Chrome が実行ごとに入れ替える（permute）ので、集合として比べる。
 */

export interface ClientHello {
  /** ClientHello の legacy_version（TLS 1.3 でも 0x0303） */
  legacyVersion: number;
  /** 暗号スイート（送った順。GREASE は 'GREASE'） */
  cipherSuites: Array<number | 'GREASE'>;
  compressionMethods: number[];
  /** 拡張の種類（送った順。GREASE は 'GREASE'） */
  extensionTypes: Array<number | 'GREASE'>;
  serverName?: string;
  supportedGroups: Array<number | 'GREASE'>;
  /** 署名アルゴリズム（送った順。Chrome 152 以降は GREASE の値を 1 つ混ぜる（TlsGreaseSigalgs）ので、GREASE は 'GREASE'） */
  signatureAlgorithms: Array<number | 'GREASE'>;
  alpn: string[];
  supportedVersions: Array<number | 'GREASE'>;
  keyShareGroups: Array<number | 'GREASE'>;
  certificateCompression: number[];
  pskKeyExchangeModes: number[];
  ecPointFormats: number[];
  /** ECH（0xfe0d）の外側の ClientHello の種類。無ければ undefined */
  ech?: 'outer' | 'inner' | 'unknown';
  /** ALPS（application_settings）の拡張の種類と、そこに載せた ALPN */
  alps: Array<{ type: number; protocols: string[] }>;
  /** padding 拡張（21）があるか（長さは ClientHello の大きさで変わるので、有無だけ） */
  padding: boolean;
}

export const isGrease = (value: number): boolean => (value & 0x0f0f) === 0x0a0a && (value >> 8) === (value & 0xff);
const g = (value: number): number | 'GREASE' => (isGrease(value) ? 'GREASE' : value);

const EXT = {
  serverName: 0,
  supportedGroups: 10,
  ecPointFormats: 11,
  signatureAlgorithms: 13,
  alpn: 16,
  padding: 21,
  compressCertificate: 27,
  supportedVersions: 43,
  pskKeyExchangeModes: 45,
  keyShare: 51,
  alpsOld: 17513,
  alpsNew: 17613,
  ech: 0xfe0d,
} as const;

class Reader {
  offset = 0;
  constructor(readonly buf: Uint8Array) {}
  get remaining() { return this.buf.length - this.offset; }
  u8() { return this.buf[this.offset++]; }
  u16() { const v = (this.buf[this.offset] << 8) | this.buf[this.offset + 1]; this.offset += 2; return v; }
  u24() { const v = (this.buf[this.offset] << 16) | (this.buf[this.offset + 1] << 8) | this.buf[this.offset + 2]; this.offset += 3; return v; }
  bytes(n: number) { const v = this.buf.slice(this.offset, this.offset + n); this.offset += n; return v; }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function u16List(bytes: Uint8Array): number[] {
  const r = new Reader(bytes);
  const out: number[] = [];
  while (r.remaining >= 2) out.push(r.u16());
  return out;
}

function protocolList(bytes: Uint8Array): string[] {
  const r = new Reader(bytes);
  const out: string[] = [];
  while (r.remaining >= 1) out.push(text(r.bytes(r.u8())));
  return out;
}

/**
 * TLS のレコード（ClientHello を含む最初のレコード）から ClientHello を取り出す。
 * レコードが途中までなら null（呼び出し側が、続きを読んでからもう一度呼ぶ）。ClientHello でなければ例外。
 */
export function parseClientHello(record: Uint8Array): ClientHello | null {
  if (record.length < 5) return null;
  if (record[0] !== 0x16) throw new Error(`not a TLS handshake record (type ${record[0]})`);
  const recordLength = (record[3] << 8) | record[4];
  if (record.length < 5 + recordLength) return null;
  const r = new Reader(record.slice(5, 5 + recordLength));
  if (r.u8() !== 0x01) throw new Error('not a ClientHello');
  r.u24(); // ハンドシェイクの長さ
  const legacyVersion = r.u16();
  r.bytes(32); // random
  r.bytes(r.u8()); // session_id
  const cipherSuites = u16List(r.bytes(r.u16())).map(g);
  const compressionMethods = Array.from(r.bytes(r.u8()));

  const hello: ClientHello = {
    legacyVersion,
    cipherSuites,
    compressionMethods,
    extensionTypes: [],
    supportedGroups: [],
    signatureAlgorithms: [],
    alpn: [],
    supportedVersions: [],
    keyShareGroups: [],
    certificateCompression: [],
    pskKeyExchangeModes: [],
    ecPointFormats: [],
    alps: [],
    padding: false,
  };

  const extensions = new Reader(r.bytes(r.u16()));
  while (extensions.remaining >= 4) {
    const type = extensions.u16();
    const data = extensions.bytes(extensions.u16());
    hello.extensionTypes.push(g(type));
    const d = new Reader(data);
    switch (type) {
      case EXT.serverName: {
        d.u16(); // リストの長さ
        d.u8(); // 名前の種類
        hello.serverName = text(d.bytes(d.u16()));
        break;
      }
      case EXT.supportedGroups: hello.supportedGroups = u16List(d.bytes(d.u16())).map(g); break;
      case EXT.ecPointFormats: hello.ecPointFormats = Array.from(d.bytes(d.u8())); break;
      case EXT.signatureAlgorithms: hello.signatureAlgorithms = u16List(d.bytes(d.u16())).map(g); break;
      case EXT.alpn: hello.alpn = protocolList(d.bytes(d.u16())); break;
      case EXT.padding: hello.padding = true; break;
      case EXT.compressCertificate: hello.certificateCompression = u16List(d.bytes(d.u8())); break;
      case EXT.supportedVersions: hello.supportedVersions = u16List(d.bytes(d.u8())).map(g); break;
      case EXT.pskKeyExchangeModes: hello.pskKeyExchangeModes = Array.from(d.bytes(d.u8())); break;
      case EXT.keyShare: {
        const entries = new Reader(d.bytes(d.u16()));
        while (entries.remaining >= 4) {
          hello.keyShareGroups.push(g(entries.u16()));
          entries.bytes(entries.u16());
        }
        break;
      }
      case EXT.alpsOld:
      case EXT.alpsNew: hello.alps.push({ type, protocols: protocolList(d.bytes(d.u16())) }); break;
      case EXT.ech: hello.ech = data[0] === 0 ? 'outer' : data[0] === 1 ? 'inner' : 'unknown'; break;
      default: break;
    }
  }
  return hello;
}

/** 拡張の種類は集合として比べる（Chrome は実行ごとに並びを入れ替える）。GREASE は個数も見ない（Chrome は 2 つ付けるが、位置が変わる）。 */
export function comparable(hello: ClientHello) {
  const set = (values: Array<number | 'GREASE'>) => [...new Set(values.filter((v): v is number => v !== 'GREASE'))].sort((a, b) => a - b);
  return {
    legacyVersion: hello.legacyVersion,
    cipherSuites: hello.cipherSuites,
    compressionMethods: hello.compressionMethods,
    extensionTypes: set(hello.extensionTypes),
    extensionGrease: hello.extensionTypes.includes('GREASE'),
    serverName: hello.serverName,
    supportedGroups: hello.supportedGroups,
    signatureAlgorithms: hello.signatureAlgorithms,
    alpn: hello.alpn,
    supportedVersions: hello.supportedVersions,
    keyShareGroups: hello.keyShareGroups,
    certificateCompression: hello.certificateCompression,
    pskKeyExchangeModes: hello.pskKeyExchangeModes,
    ecPointFormats: hello.ecPointFormats,
    ech: hello.ech,
    alps: hello.alps,
  };
}

export interface HelloDifference {
  field: string;
  /** 比べる前の側（ブラウザ）にだけある値（配列のとき）か、その値 */
  browser: unknown;
  /** wreq の側の値 */
  wreq: unknown;
}

/** ブラウザと wreq の ClientHello の差。同じなら空。 */
export function diffHellos(browser: ClientHello, wreq: ClientHello): HelloDifference[] {
  const a = comparable(browser);
  const b = comparable(wreq);
  const out: HelloDifference[] = [];
  for (const field of Object.keys(a) as Array<keyof typeof a>) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) out.push({ field, browser: a[field], wreq: b[field] });
  }
  return out;
}
