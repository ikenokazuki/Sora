import { describe, expect, test } from 'bun:test';
import { hasSensitiveRequestCredentials } from './credential_scope.js';

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
