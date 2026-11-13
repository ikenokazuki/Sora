import { describe, expect, test } from 'bun:test';
import { bypassesSharedCache, hasSensitiveRequestCredentials, isHarmlessHeaderName } from './credential_scope.js';

describe('credential_scope (P0-SEC-01)', () => {
  test('detects sensitive headers case-insensitively', () => {
    expect(hasSensitiveRequestCredentials({ headers: { Authorization: 'Bearer x' } })).toBe(true);
    expect(hasSensitiveRequestCredentials({ headers: { authorization: 'Bearer x' } })).toBe(true);
    expect(hasSensitiveRequestCredentials({ headers: { Cookie: 'a=b' } })).toBe(true);
    expect(hasSensitiveRequestCredentials({ headers: { 'X-API-Key': 'k' } })).toBe(true);
    expect(hasSensitiveRequestCredentials({ headers: { 'x-auth-token': 't' } })).toBe(true);
    expect(hasSensitiveRequestCredentials({ headers: { 'Proxy-Authorization': 'p' } })).toBe(true);
  });
  test('detects cookies array', () => {
    expect(hasSensitiveRequestCredentials({ cookies: [{ name: 'a', value: 'b' }] })).toBe(true);
  });
  test('benign headers are not sensitive', () => {
    expect(hasSensitiveRequestCredentials({ headers: { 'User-Agent': 'x' } })).toBe(false);
    expect(hasSensitiveRequestCredentials({ headers: {} })).toBe(false);
    expect(hasSensitiveRequestCredentials({})).toBe(false);
  });
});

describe('bypassesSharedCache（共有キャッシュを読まず、書かない取得）', () => {
  test('Cookie を渡した取得は、共有しない', () => {
    expect(bypassesSharedCache({ cookies: [{ name: 'a', value: 'b' }] })).toBe(true);
  });

  test('資格情報の名前でなくても、ヘッダーを渡した取得は、共有しない（名前の一覧に頼らない）', () => {
    for (const name of ['Authorization', 'X-Auth', 'Api-Key', 'X-CSRF-Token', 'X-Amz-Security-Token', 'X-Shopify-Access-Token', 'X-Session', 'X-Foo', 'Cookie']) {
      expect(bypassesSharedCache({ headers: { [name]: 'v' } }), name).toBe(true);
    }
  });

  test('結果の言語・形にだけ影響する、無害なヘッダーだけなら、共有する（大文字小文字は問わない）', () => {
    for (const name of ['Accept', 'accept-language', 'ACCEPT-LANGUAGE', 'User-Agent', 'Referer', 'Cache-Control', 'Pragma', 'DNT']) {
      expect(isHarmlessHeaderName(name), name).toBe(true);
      expect(bypassesSharedCache({ headers: { [name]: 'v' } }), name).toBe(false);
    }
    expect(bypassesSharedCache({ headers: { 'Accept-Language': 'ja', Accept: 'text/html' } })).toBe(false);
  });

  test('無害なヘッダーに、1 つでも別のヘッダーが混じれば、共有しない', () => {
    expect(bypassesSharedCache({ headers: { 'Accept-Language': 'ja', 'X-Trace': '1' } })).toBe(true);
  });

  test('ヘッダーも Cookie も無ければ、共有する', () => {
    expect(bypassesSharedCache({})).toBe(false);
    expect(bypassesSharedCache({ headers: {}, cookies: [] })).toBe(false);
    expect(bypassesSharedCache({ headers: undefined, cookies: undefined })).toBe(false);
  });

  test('isHarmlessHeaderName: 資格情報の名前は無害ではない', () => {
    for (const name of ['authorization', 'cookie', 'x-api-key', 'x-auth-token', 'x-access-token', 'proxy-authorization', 'x-foo']) expect(isHarmlessHeaderName(name), name).toBe(false);
  });
});

