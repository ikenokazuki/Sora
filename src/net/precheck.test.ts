import { beforeEach, describe, expect, test } from 'bun:test';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { countPrecheckDenied, deniesHost, hostDenyReason, type PrecheckReason } from './precheck.js';

/**
 * URL の事前検査が断った理由と、その数え方（設計 8）。
 * 理由の見分け方は、出口のゲートウェイと同じ（IP が先、次に名前）。カウンターの名前は `sora_precheck_denied_<理由>_total`。
 */

const counted = (): Record<string, number> =>
  Object.fromEntries(Object.entries(getSecurityMetrics()).filter(([name]) => name.startsWith('sora_precheck_denied_')));

beforeEach(() => resetSecurityMetrics());

describe('hostDenyReason', () => {
  const cases: Array<[string, ReturnType<typeof hostDenyReason>]> = [
    // IP（ループバック・プライベート・リンクローカル・IPv6・別の書き方・先頭が IPv4 の名前）
    ['127.0.0.1', 'private_ip'],
    ['10.1.2.3', 'private_ip'],
    ['192.168.0.1', 'private_ip'],
    ['169.254.169.254', 'private_ip'], // メタデータの IP。名前の一覧にもあるが、IP が先
    ['::1', 'private_ip'],
    ['[::1]', 'private_ip'],
    ['fd00::1', 'private_ip'],
    ['0x7f.1', 'private_ip'],
    ['127.0.0.1.nip.io', 'private_ip'],
    // 名前
    ['localhost', 'blocked_host'],
    ['LOCALHOST.', 'blocked_host'],
    ['app.localhost', 'blocked_host'],
    ['printer.local', 'blocked_host'],
    ['metadata.google.internal', 'blocked_host'],
    ['instance-data', 'blocked_host'],
    // 通す宛先
    ['example.com', undefined],
    ['8.8.8.8', undefined],
    ['2606:4700:4700::1111', undefined],
    ['fda.gov', undefined], // 'fd' で始まるだけの公開の名前を、IPv6 と取り違えない
    ['10.example.com', undefined],
  ];
  for (const [host, reason] of cases) {
    test(`${host} → ${reason ?? '通す'}`, () => {
      expect(hostDenyReason(host)).toBe(reason);
    });
  }
});

describe('deniesHost', () => {
  test('内部の IP は true で、private_ip を 1 つ数える', () => {
    expect(deniesHost('127.0.0.1')).toBe(true);
    expect(counted()).toEqual({ sora_precheck_denied_private_ip_total: 1 });
  });

  test('遮断する名前は true で、blocked_host を 1 つ数える', () => {
    expect(deniesHost('localhost')).toBe(true);
    expect(counted()).toEqual({ sora_precheck_denied_blocked_host_total: 1 });
  });

  test('通す宛先は false で、何も数えない', () => {
    expect(deniesHost('example.com')).toBe(false);
    expect(deniesHost('8.8.8.8')).toBe(false);
    expect(counted()).toEqual({});
  });

  test('呼ぶたびに数える（同じ宛先を 3 回断れば 3）', () => {
    for (let i = 0; i < 3; i++) deniesHost('10.0.0.1');
    expect(counted()).toEqual({ sora_precheck_denied_private_ip_total: 3 });
  });
});

describe('countPrecheckDenied', () => {
  test('理由ごとの名前で数える（3 つの理由は、互いに別のカウンター）', () => {
    const reasons: PrecheckReason[] = ['private_ip', 'blocked_host', 'dns'];
    reasons.forEach((reason, index) => {
      for (let i = 0; i <= index; i++) countPrecheckDenied(reason);
    });
    expect(counted()).toEqual({
      sora_precheck_denied_private_ip_total: 1,
      sora_precheck_denied_blocked_host_total: 2,
      sora_precheck_denied_dns_total: 3,
    });
  });
});
