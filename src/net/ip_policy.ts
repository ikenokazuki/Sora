/**
 * 宛先の IP・ホスト名が、公開の宛先か（内部・予約・メタデータの宛先でないか）の判定。
 * 出口のゲートウェイ（egress_gateway.ts）、ブラウザのページ内の通信の検査、静的取得の検査が、これを使う。
 * IPv4 の別の書き方（8 進・16 進・短縮・32bit 整数。getaddrinfo はそのまま数として読む）と、IPv4 を埋め込む IPv6（射影・NAT64・6to4）は、
 * 中の IPv4 を数にして判定する（文字列の前方一致にしない）。
 */

/**
 * 任意の IPv4 表記（10進ドット、8進数、16進数、短縮表記、32bit整数）を 32bit 符号なし整数に正規化する。
 * SSRF バイパス攻撃（0177.0.0.1 や 0x7f000001、127.1 等）を確実に検知・遮断するために使用。
 */
export function parseIpv4ToUint32(host: string): number | null {
  const clean = host.toLowerCase().trim().replace(/^\[|\]$/g, '');
  const parts = clean.split('.');
  if (parts.length > 4 || parts.length === 0) return null;

  const values: number[] = [];
  for (const p of parts) {
    if (!p) return null;
    let val: number;
    if (p.startsWith('0x')) {
      val = parseInt(p.slice(2), 16);
    } else if (p.startsWith('0') && p.length > 1 && !/[89a-f]/i.test(p)) {
      val = parseInt(p, 8);
    } else if (/^\d+$/.test(p)) {
      val = parseInt(p, 10);
    } else {
      return null;
    }
    if (Number.isNaN(val) || val < 0) return null;
    values.push(val);
  }

  let ip = 0;
  if (values.length === 1) {
    ip = values[0];
  } else if (values.length === 2) {
    if (values[0] > 0xff || values[1] > 0xffffff) return null;
    ip = ((values[0] << 24) >>> 0) + values[1];
  } else if (values.length === 3) {
    if (values[0] > 0xff || values[1] > 0xff || values[2] > 0xffff) return null;
    ip = ((values[0] << 24) >>> 0) + (values[1] << 16) + values[2];
  } else if (values.length === 4) {
    if (values.some((v) => v > 0xff)) return null;
    ip = ((values[0] << 24) >>> 0) + (values[1] << 16) + (values[2] << 8) + values[3];
  } else {
    return null;
  }
  return ip >>> 0;
}

export function isPrivateIpUint32(num: number): boolean {
  const b0 = (num >>> 24) & 0xff;
  const b1 = (num >>> 16) & 0xff;
  const b2 = (num >>> 8) & 0xff;

  // 0.0.0.0/8 (Current network / broadcast)
  if (b0 === 0) return true;
  // 10.0.0.0/8 (Private)
  if (b0 === 10) return true;
  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;
  // 100.64.0.0/10 (CGNAT / RFC 6598)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 169.254.0.0/16 (Link-Local / Cloud Metadata)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12 (Private)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments: DS-Lite の AFTR・NAT64 の発見用など。公開の宛先ではない)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  // 192.168.0.0/16 (Private)
  if (b0 === 192 && b1 === 168) return true;
  // 198.18.0.0/15 (Benchmark testing)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved) & 255.255.255.255 (Broadcast)
  if (b0 >= 224) return true;

  return false;
}

/**
 * IPv6 アドレス文字列を 8 個の 16bit 値へ展開する。`::` の省略、末尾の IPv4 表記（::ffff:1.2.3.4）、
 * ゾーン ID（fe80::1%eth0）に対応。解釈できなければ null。
 */
function parseIpv6(text: string): number[] | null {
  let s = text;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;

  // 末尾が IPv4 表記なら 2 個の 16bit 値に直す
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return null;
    const v4 = parseIpv4ToUint32(tail);
    if (v4 === null) return null;
    s = s.slice(0, lastColon + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }

  let groups: string[];
  const dc = s.indexOf('::');
  if (dc >= 0) {
    if (s.indexOf('::', dc + 1) >= 0) return null; // `::` は 1 回だけ
    const [left, right] = s.split('::');
    const head = left ? left.split(':') : [];
    const rest = right ? right.split(':') : [];
    if (head.length + rest.length > 7) return null;
    groups = [...head, ...new Array<string>(8 - head.length - rest.length).fill('0'), ...rest];
  } else {
    groups = s.split(':');
    if (groups.length !== 8) return null;
  }

  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** IPv6 リテラルが、ループバック・プライベート・リンクローカル・マルチキャスト等の宛先か（埋め込み IPv4 も見る） */
function isPrivateIpv6(text: string): boolean {
  const g = parseIpv6(text);
  // ':' を含むのに IPv6 として読めない文字列は、通すより止める方が安全
  if (!g) return true;
  const [a, b, c, d, e, f, x, y] = g;
  const embeddedV4 = (((x << 16) | y) >>> 0);
  const upperFiveZero = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;

  // ::/96 は、未指定（::）・ループバック（::1）・IPv4 互換の旧形式（::a.b.c.d）で、どれも公開された宛先にならない
  if (upperFiveZero && f === 0) return true;
  if (upperFiveZero && f === 0xffff) return isPrivateIpUint32(embeddedV4); // IPv4-mapped  ::ffff:a.b.c.d
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) return isPrivateIpUint32(embeddedV4); // IPv4-translated
  if (a === 0x64 && b === 0xff9b) {
    if (c === 0 && d === 0 && e === 0 && f === 0) return isPrivateIpUint32(embeddedV4); // NAT64 64:ff9b::/96
    if (c === 1) return true; // 64:ff9b:1::/48 ローカル用 NAT64
  }
  if (a === 0x2002) return isPrivateIpUint32((((b << 16) | c) >>> 0)); // 6to4 2002::/16（IPv4 は 16〜47bit）
  if (a === 0x2001 && b === 0) return true; // Teredo 2001::/32
  if (a === 0x2001 && b === 0x0db8) return true; // ドキュメント用 2001:db8::/32
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // 100::/64 破棄用
  if ((a & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // リンクローカル fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true; // サイトローカル fec0::/10（非推奨）
  if ((a & 0xff00) === 0xff00) return true; // マルチキャスト ff00::/8
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');

  // 1. IPv6 リテラルは必ず ':' を含み、ホスト名には現れない。':' の有無で IPv6 判定に入るかを決める。
  //    （以前は先頭が 'fc'/'fd'/'ff' の文字列を無条件に IPv6 扱いにして、fda.gov や ffmpeg.org まで遮断していた）
  if (trimmed.includes(':')) return isPrivateIpv6(trimmed);

  // 2. 任意の進数・短縮表記を含む IPv4 の 32bit 整数への正規化
  const num = parseIpv4ToUint32(trimmed);
  if (num !== null) {
    return isPrivateIpUint32(num);
  }

  // 3. 先頭が IPv4 の名前（127.0.0.1.nip.io のようなワイルドカード DNS）は、解決を待たずに止める。
  //    先頭の 4 ラベルが IPv4 として読める場合だけ見る（10.example.com のような通常の名前は対象外）。
  const lead = trimmed.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\./);
  if (lead) {
    const leadNum = parseIpv4ToUint32(lead[1]);
    if (leadNum !== null) return isPrivateIpUint32(leadNum);
  }

  return false;
}

/**
 * クラウドのメタデータの名前と IP。運用者が許す宛先に挙げても通さない。
 * 169.254.169.254（AWS・GCP・Azure ほか。リンクローカルなので、どのみち内部として通さない）のほかに、通す範囲の中にあるものを挙げる:
 * 100.100.100.200（Alibaba Cloud。CGNAT の範囲）と fd00:ec2::254（AWS の IPv6。ULA の範囲）
 */
const METADATA_HOSTNAMES: ReadonlySet<string> = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.internal', 'instance-data', '100.100.100.200', 'fd00:ec2::254']);

const normalizeHostname = (hostname: string): string => hostname.toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

/** クラウドのメタデータの名前・IP か（IPv6 は、書き方が違っても、正規形で比べる） */
export function isMetadataHostname(hostname: string): boolean {
  return METADATA_HOSTNAMES.has(canonicalHost(hostname));
}

/** ブロック対象ホスト名判定ヘルパー */
export function isBlockedHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '::' ||
    h === '0.0.0.0' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }
  if (METADATA_HOSTNAMES.has(h)) return true;
  return isPrivateIp(h);
}

/**
 * 正準な IP リテラルか。IPv4 は 10 進のドット表記（各 0〜255・先頭の 0 なし）、IPv6 は解釈できる表記（ゾーン ID なし。[ ] は付けない）。
 * 4・6・どちらでもなければ 0（別の書き方の IPv4 〈0x7f.1・127.1・整数・8 進〉は、0）。
 */
export function ipLiteralVersion(host: string): 0 | 4 | 6 {
  if (/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(host)) return 4;
  const lower = host.toLowerCase();
  return lower.includes(':') && !lower.includes('%') && parseIpv6(lower) !== null ? 6 : 0;
}

/**
 * 照合のための、宛先の整え方（挙げた宛先の一覧も、要求の宛先も、これで整えてから比べる）。名前は小文字にして、末尾のドットと IPv6 の [ ] を外す。
 * IPv6 は URL の正規形（0 の省略・小文字）にそろえる。IPv4 は 10 進のドット表記のまま（別の書き方は、そろえない。一覧には載らないので、挙げた宛先とは一致しない）。
 */
export function canonicalHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (ipLiteralVersion(h) !== 6) return h;
  try {
    return new URL(`http://[${h}]/`).hostname.slice(1, -1);
  } catch {
    return h;
  }
}

/** 運用者が許す宛先に挙げたとき、通してよい内部の IPv4（ループバック・プライベート・CGNAT） */
function isAllowableInternalIpv4(num: number): boolean {
  if (num === 0x646464c8) return false; // 100.100.100.200（Alibaba Cloud のメタデータ。CGNAT の範囲の中）
  const b0 = (num >>> 24) & 0xff;
  const b1 = (num >>> 16) & 0xff;
  return b0 === 127 || b0 === 10 || (b0 === 172 && b1 >= 16 && b1 <= 31) || (b0 === 192 && b1 === 168) || (b0 === 100 && b1 >= 64 && b1 <= 127);
}

/**
 * 運用者が、出口のゲートウェイの許す宛先（SORA_EGRESS_ALLOW_HOSTS）に挙げたとき、内部の IP として通してよいか。
 * 通すのは、ループバック（127/8・::1）・プライベート（10/8・172.16/12・192.168/16）・CGNAT（100.64/10）・ULA（fc00::/7）だけ。
 * リンクローカル（クラウドのメタデータの 169.254.169.254 を含む）・未指定・マルチキャスト・予約・ドキュメント用などは、挙げても通さない
 * （通す範囲を挙げ、それ以外の内部の範囲は、既定で通さない。あとから増える予約の範囲も、通さない側に倒れる）。
 * 通す範囲の中にある、Alibaba Cloud のメタデータ（100.100.100.200）と AWS の IPv6 のメタデータ（fd00:ec2::254）も、通さない。
 * IPv4 射影（::ffff:a.b.c.d）は、中の IPv4 で判定する。NAT64・6to4 など、ほかの埋め込みは通さない。
 * 公開の IP は、内部ではないので対象外（false）。公開の IP は、もともと通る。
 */
export function isAllowableInternalIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (trimmed.includes(':')) {
    const g = parseIpv6(trimmed);
    if (!g) return false;
    const [a, b, c, d, e, f, x, y] = g;
    const upperFiveZero = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
    if (upperFiveZero && f === 0 && x === 0 && y === 1) return true; // ::1
    if (upperFiveZero && f === 0xffff) return isAllowableInternalIpv4(((x << 16) | y) >>> 0); // ::ffff:a.b.c.d
    if (a === 0xfd00 && b === 0x0ec2 && c === 0 && d === 0 && e === 0 && f === 0 && x === 0 && y === 0x0254) return false; // fd00:ec2::254（AWS の IPv6 のメタデータ。ULA の範囲の中）
    return (a & 0xfe00) === 0xfc00; // ULA fc00::/7
  }
  const num = parseIpv4ToUint32(trimmed);
  return num !== null && isAllowableInternalIpv4(num);
}
