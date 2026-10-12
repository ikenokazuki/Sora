import { describe, expect, test } from 'bun:test';
import { isBlockedHostname, isPrivateIp, validateHostIpDns } from './browser_engine.js';

// SSRF ガードの判定。内部宛先は止め、公開ホスト名は通す。
// 以前は IPv6 の前方一致（'fc' / 'fd' / 'ff'）をホスト名にも当てていたため、fda.gov や ffmpeg.org まで遮断していた。

describe('公開ホスト名は遮断しない（IPv6 の前方一致をホスト名に当てない）', () => {
  const publicHosts = [
    'fda.gov', 'www.fda.gov', 'fcc.gov', 'fdic.gov', 'ffiec.gov', 'ffmpeg.org', 'fc2.com', 'fdroid.org',
    'fcbayern.com', 'fd.example.com', 'ff-api.example.com', 'fc-cdn.example.net', 'fdn.fr',
    'feedly.com', 'fe80.example.com', 'ff00.example.org',
    // 数字で始まるだけの通常のホスト名
    '10.example.com', '0.example.com', '192.168.example.org', '172.16.example.net',
  ];
  for (const host of publicHosts) {
    test(`${host}`, () => {
      expect(isPrivateIp(host)).toBe(false);
      expect(isBlockedHostname(host)).toBe(false);
    });
  }

  test('validateHostIpDns は公開ホスト名を SSRF として拒否しない', async () => {
    // DNS 解決に失敗する環境でも（空配列を返すだけで）例外にならない。拒否メッセージだけを不合格とする
    for (const host of ['fda.gov', 'fcc.gov', 'ffmpeg.org']) {
      let message = '';
      try {
        await validateHostIpDns(host);
      } catch (e) {
        message = String((e as Error)?.message ?? e);
      }
      expect(message).not.toContain('遮断');
    }
  });
});

describe('IPv6 リテラルの内部宛先は引き続き遮断する', () => {
  const blocked = [
    '::1', '::', '0:0:0:0:0:0:0:1', '[::1]',
    'fc00::1', 'fd12:3456:789a::1', 'FD00::1',
    'fe80::1', 'fe81::1', 'febf::1', 'fe80::1%eth0', // fe80::/10 の全体
    'fec0::1', // サイトローカル（非推奨）
    'ff02::1', 'ff05::2',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254',
    '::7f00:1', '::808:808', // IPv4 互換の旧形式（::/96）は埋め込みが公開 IPv4 でも宛先にならない
    '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1', // NAT64 経由の内部 IPv4
    '64:ff9b:1::1', // ローカル用 NAT64
    '2002:7f00:1::', '2002:a9fe:a9fe::1', // 6to4 経由の内部 IPv4
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '2001:db8::1', // ドキュメント用
    '100::1', // 破棄用
  ];
  for (const ip of blocked) {
    test(`${ip}`, () => {
      expect(isPrivateIp(ip)).toBe(true);
      expect(isBlockedHostname(ip)).toBe(true);
    });
  }

  test('解釈できない IPv6 風の文字列は安全側に倒して遮断する', () => {
    expect(isPrivateIp('1:2:3')).toBe(true);
    expect(isPrivateIp(':::')).toBe(true);
    expect(isPrivateIp('gggg::1')).toBe(true);
  });

  test('isBlockedHostname も 16 進表記の IPv4-mapped を遮断する（以前は通っていた）', () => {
    expect(isBlockedHostname('::ffff:7f00:1')).toBe(true);
    expect(isBlockedHostname('[::ffff:7f00:1]')).toBe(true);
  });
});

describe('公開 IPv6 アドレスは通す', () => {
  const allowed = [
    '2606:4700:4700::1111', // Cloudflare DNS
    '2a00:1450:4001:81b::200e', // Google
    '2001:4860:4860::8888', // Google DNS（2001:db8 / 2001:0 ではない）
    '64:ff9b::808:808', // 8.8.8.8 の NAT64
    '2002:808:808::', // 8.8.8.8 の 6to4
    '::ffff:8.8.8.8',
  ];
  for (const ip of allowed) {
    test(`${ip}`, () => {
      expect(isPrivateIp(ip)).toBe(false);
      expect(isBlockedHostname(ip)).toBe(false);
    });
  }
});

describe('先頭が IPv4 のワイルドカード DNS 名は解決を待たずに遮断する', () => {
  test('内部 IPv4 を埋め込んだ名前', () => {
    for (const host of ['127.0.0.1.nip.io', '10.0.0.1.sslip.io', '192.168.1.5.nip.io', '169.254.169.254.nip.io', '0.0.0.0.nip.io']) {
      expect(isBlockedHostname(host)).toBe(true);
    }
  });
  test('公開 IPv4 を埋め込んだ名前は DNS 解決の結果に任せる', () => {
    expect(isBlockedHostname('8.8.8.8.nip.io')).toBe(false);
  });
});
