import { describe, expect, test } from 'bun:test';
import { canonicalHost, ipLiteralVersion, isAllowableInternalIp, isBlockedHostname, isMetadataHostname, isPrivateIp, parseIpv4ToUint32 } from './ip_policy.js';

// 出口のゲートウェイ（egress_gateway.ts）は、解決した IP をこの判定だけで通す。
// ここが「公開」と答えた宛先には接続するので、書き方を変えた内部の宛先が「公開」になる誤りが、最も危ない。

describe('isPrivateIp: 公開でない宛先は、書き方によらず true', () => {
  const nonPublic: Array<[string, string]> = [
    // IPv4（10 進の標準の書き方）
    ['0.0.0.0', '0/8'],
    ['10.1.2.3', '10/8'],
    ['100.64.0.1', '100.64/10 の下端'],
    ['100.127.255.255', '100.64/10 の上端'],
    ['127.0.0.1', 'ループバック'],
    ['127.255.255.254', 'ループバックの上端'],
    ['169.254.169.254', 'クラウドのメタデータ'],
    ['172.16.0.1', '172.16/12 の下端'],
    ['172.31.255.255', '172.16/12 の上端'],
    ['192.0.0.1', '192.0.0/24（IETF の予約。DS-Lite の AFTR）'],
    ['192.0.0.170', '192.0.0/24（NAT64 の発見用）'],
    ['192.0.0.255', '192.0.0/24 の上端'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.168.0.1', '192.168/16'],
    ['198.18.0.1', '198.18/15 の下端'],
    ['198.19.255.255', '198.18/15 の上端'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', 'マルチキャスト'],
    ['239.255.255.255', 'マルチキャストの上端'],
    ['240.0.0.1', '予約'],
    ['255.255.255.255', 'ブロードキャスト'],
    // IPv4 の別の書き方（getaddrinfo は、これらをそのまま数として読む）
    ['127.1', '短縮'],
    ['0x7f.1', '16 進と短縮'],
    ['0x7f000001', '16 進の 32bit'],
    ['2130706433', '10 進の 32bit'],
    ['0177.0.0.1', '8 進'],
    ['017700000001', '8 進の 32bit'],
    ['0300.0250.0.1', '8 進で 192.168.0.1'],
    ['3232235521', '10 進の 32bit で 192.168.0.1'],
    // IPv6
    ['::', '未指定'],
    ['::1', 'ループバック'],
    ['[::1]', '角括弧つき'],
    ['fc00::1', 'ULA fc00::/7'],
    ['fd12:3456::1', 'ULA（fd）'],
    ['fe80::1', 'リンクローカル'],
    ['fe80::1%eth0', 'ゾーン ID つき'],
    ['ff02::1', 'マルチキャスト'],
    ['2001:db8::1', 'ドキュメント用'],
    ['100::1', '破棄用 100::/64'],
    // IPv4 を埋め込む IPv6（中の IPv4 で判定する）
    ['::ffff:127.0.0.1', 'IPv4 射影（ループバック）'],
    ['::ffff:7f00:1', 'IPv4 射影の 16 進表記'],
    ['::ffff:10.0.0.1', 'IPv4 射影（10/8）'],
    ['64:ff9b::7f00:1', 'NAT64 で 127.0.0.1'],
    ['64:ff9b::a00:1', 'NAT64 で 10.0.0.1'],
    ['2002:7f00:1::', '6to4 で 127.0.0.1'],
    ['2002:c0a8:101::', '6to4 で 192.168.1.1'],
    // 読めない IPv6 は、通すより止める
    ['1:2:3', '読めない'],
    ['gggg::1', '16 進でない'],
  ];
  test.each(nonPublic)('%s（%s）', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });
});

describe('isPrivateIp: 公開の宛先は、境界のすぐ外でも false（誤って止めない）', () => {
  const publicAddresses: Array<[string, string]> = [
    ['8.8.8.8', 'Google DNS'],
    ['1.1.1.1', 'Cloudflare'],
    ['93.184.216.34', 'example.com'],
    ['100.63.255.255', '100.64/10 のすぐ下'],
    ['100.128.0.1', '100.64/10 のすぐ上'],
    ['172.15.255.255', '172.16/12 のすぐ下'],
    ['172.32.0.1', '172.16/12 のすぐ上'],
    ['192.0.1.1', '192.0.0/24 のすぐ上'],
    ['192.169.0.1', '192.168/16 のすぐ上'],
    ['198.17.255.255', '198.18/15 のすぐ下'],
    ['198.20.0.1', '198.18/15 のすぐ上'],
    ['223.255.255.255', 'マルチキャストのすぐ下'],
    ['2606:4700:4700::1111', 'Cloudflare（IPv6）'],
    ['2001:4860:4860::8888', 'Google DNS（IPv6）'],
    ['::ffff:8.8.8.8', 'IPv4 射影（公開）'],
    ['64:ff9b::808:808', 'NAT64 で 8.8.8.8'],
    ['2002:808:808::', '6to4 で 8.8.8.8'],
  ];
  test.each(publicAddresses)('%s（%s）', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  test.each([
    'localhost',
    'LOCALHOST.',
    'foo.localhost',
    'printer.local',
    'db.internal',
    'metadata.google.internal',
    'instance-data',
    '127.0.0.1.nip.io',
    '[::1]',
  ])('名前で止める: %s', (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  test.each(['example.com', 'localhost.example.com', 'internal.example.com', 'fda.gov', 'ffmpeg.org', '8.8.8.8.nip.io'])(
    '普通の名前は通す: %s',
    (host) => {
      expect(isBlockedHostname(host)).toBe(false);
    },
  );
});

describe('parseIpv4ToUint32', () => {
  test.each([
    ['127.0.0.1', 2130706433],
    ['127.1', 2130706433],
    ['0x7f.1', 2130706433],
    ['2130706433', 2130706433],
    ['0177.0.0.1', 2130706433],
    ['255.255.255.255', 4294967295],
  ])('%s は %d', (host, expected) => {
    expect(parseIpv4ToUint32(host)).toBe(expected);
  });

  test.each(['256.0.0.1', '1.2.3.4.5', 'a.b.c.d', '', '1..2'])('IPv4 として読めない: %j は null', (host) => {
    expect(parseIpv4ToUint32(host)).toBeNull();
  });
});

describe('isAllowableInternalIp: 運用者が、許す宛先に挙げたとき、内部の IP として通してよいか', () => {
  test.each([
    ['127.0.0.1', 'ループバック'],
    ['127.8.8.8', 'ループバック（127/8）'],
    ['10.1.2.3', '10/8'],
    ['172.16.0.1', '172.16/12 の下端'],
    ['172.31.255.255', '172.16/12 の上端'],
    ['192.168.1.1', '192.168/16'],
    ['100.64.0.1', 'CGNAT の下端'],
    ['100.127.255.255', 'CGNAT の上端'],
    ['::1', 'IPv6 のループバック'],
    ['fd00::5', 'ULA'],
    ['fc00::1', 'ULA の下端'],
    ['::ffff:10.0.0.1', 'IPv4 射影のプライベート'],
    ['::ffff:127.0.0.1', 'IPv4 射影のループバック'],
  ])('%s（%s）は、通してよい', (ip) => {
    expect(isAllowableInternalIp(ip)).toBe(true);
  });

  test.each([
    ['169.254.169.254', 'クラウドのメタデータ'],
    ['169.254.0.1', 'リンクローカル'],
    ['0.0.0.0', '未指定'],
    ['0.1.2.3', '0/8'],
    ['224.0.0.1', 'マルチキャスト'],
    ['239.255.255.255', 'マルチキャストの上端'],
    ['240.0.0.1', '予約'],
    ['255.255.255.255', 'ブロードキャスト'],
    ['192.0.0.1', 'IETF の予約'],
    ['192.0.2.5', 'TEST-NET-1'],
    ['198.18.0.1', 'ベンチマーク'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['fe80::1', 'IPv6 のリンクローカル'],
    ['::', 'IPv6 の未指定'],
    ['ff02::1', 'IPv6 のマルチキャスト'],
    ['2001:db8::1', 'ドキュメント用'],
    ['64:ff9b::7f00:1', 'NAT64 に埋めたループバック'],
    ['2002:7f00:1::', '6to4 に埋めたループバック'],
    ['::ffff:169.254.169.254', 'IPv4 射影のメタデータ'],
    ['::ffff:224.0.0.1', 'IPv4 射影のマルチキャスト'],
    ['fec0::1', 'サイトローカル（非推奨）'],
    ['100.100.100.200', 'Alibaba Cloud のメタデータ（CGNAT の範囲の中）'],
    ['::ffff:100.100.100.200', 'IPv4 射影の Alibaba Cloud のメタデータ'],
    ['fd00:ec2::254', 'AWS の IPv6 のメタデータ（ULA の範囲の中）'],
    ['FD00:EC2:0:0:0:0:0:254', 'AWS の IPv6 のメタデータの別の書き方'],
  ])('%s（%s）は、挙げても通さない', (ip) => {
    expect(isAllowableInternalIp(ip)).toBe(false);
  });

  test.each(['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.167.0.1', '192.169.0.1'])(
    '公開の IP（%s）は、内部ではないので対象外（false）。公開の IP は、もともと通る',
    (ip) => {
      expect(isAllowableInternalIp(ip)).toBe(false);
    },
  );

  test('読めない文字列・名前は false', () => {
    for (const text of ['', 'example.com', 'fd00::zz', 'localhost', '10.example.com']) expect(isAllowableInternalIp(text), text).toBe(false);
  });
});

describe('isMetadataHostname: クラウドのメタデータの名前', () => {
  test.each(['169.254.169.254', 'metadata.google.internal', 'Metadata.Google.Internal.', 'metadata.internal', 'instance-data', '100.100.100.200', 'fd00:ec2::254', 'FD00:EC2:0:0:0:0:0:254', '[fd00:ec2:0:0:0:0:0:254]'])('%s は true（IPv6 は、書き方が違っても）', (host) => {
    expect(isMetadataHostname(host)).toBe(true);
  });

  test.each(['localhost', 'example.com', 'fxembed.internal', '10.0.0.5', 'metadata.example.com', '100.100.100.201', 'fd00:ec2::255'])('%s は false', (host) => {
    expect(isMetadataHostname(host)).toBe(false);
  });
});

describe('ipLiteralVersion: 正準な IP リテラルか', () => {
  test.each([
    ['10.0.0.5', 4],
    ['255.255.255.255', 4],
    ['fd00::5', 6],
    ['FD00::5', 6],
    ['::1', 6],
    ['::ffff:10.0.0.1', 6],
    ['2001:db8:0:0:0:0:0:1', 6],
  ])('%s は %d', (host, version) => {
    expect(ipLiteralVersion(host as string)).toBe(version as 4 | 6);
  });

  test.each(['010.0.0.5', '0x7f.1', '127.1', '2130706433', '256.1.1.1', '1.2.3', 'fe80::1%eth0', '[::1]', 'example.com', 'fd00::zz', ''])('%j は 0（IP リテラルでない・別の書き方）', (host) => {
    expect(ipLiteralVersion(host)).toBe(0);
  });
});

describe('canonicalHost: 挙げた宛先と、要求の宛先を、同じ書き方にそろえる', () => {
  test.each([
    ['FxEmbed.Internal.', 'fxembed.internal'],
    ['localhost', 'localhost'],
    ['[FD00:0:0:0:0:0:0:5]', 'fd00::5'],
    ['fd00:0:0:0:0:0:0:5', 'fd00::5'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['::ffff:10.0.0.1', '::ffff:a00:1'],
    ['10.0.0.5', '10.0.0.5'],
    ['0x7f.1', '0x7f.1'],
  ])('%s は %s', (host, expected) => {
    expect(canonicalHost(host)).toBe(expected);
  });
});
