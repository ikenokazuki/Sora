import { describe, expect, test } from 'bun:test';
import { isProxyBypassed } from './no_proxy.js';

describe('isProxyBypassed', () => {
  const list = 'localhost,127.0.0.0/8,::1,.internal.example,*.svc.cluster.local,api.example.com:8443,10.0.0.0/8';

  test('ホスト名はそのものとサブドメインに当たる', () => {
    expect(isProxyBypassed('localhost', list)).toBe(true);
    expect(isProxyBypassed('a.internal.example', list)).toBe(true);
    expect(isProxyBypassed('internal.example', list)).toBe(true);
    expect(isProxyBypassed('x.svc.cluster.local', list)).toBe(true);
    expect(isProxyBypassed('api.example.com', list)).toBe(true);
    expect(isProxyBypassed('example.com', list)).toBe(false);
    expect(isProxyBypassed('notlocalhost', list)).toBe(false);
  });

  test('IPv4 の CIDR と IPv6 のアドレスに当たる', () => {
    expect(isProxyBypassed('127.0.0.1', list)).toBe(true);
    expect(isProxyBypassed('10.255.0.3', list)).toBe(true);
    expect(isProxyBypassed('11.0.0.1', list)).toBe(false);
    expect(isProxyBypassed('[::1]', list)).toBe(true);
  });

  test('"*" はすべて、空のリストは何も除外しない', () => {
    expect(isProxyBypassed('example.com', '*')).toBe(true);
    expect(isProxyBypassed('example.com', undefined)).toBe(false);
    expect(isProxyBypassed('example.com', '')).toBe(false);
  });
});
