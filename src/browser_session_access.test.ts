import { describe, expect, test } from 'bun:test';
import { verifySessionAccess } from './browser_session.js';

describe('browser session access (P1-SEC-05)', () => {
  test('owner-less legacy sessions stay accessible', () => {
    expect(verifySessionAccess({}, {})).toBe(true);
  });
  test('owner token still enforced', () => {
    expect(verifySessionAccess({ ownerTokenHash: 'abc' }, {})).toBe(false);
  });
  test('tenant-bound sessions reject cross-tenant access', () => {
    const sess = { tenantId: 'key:1234' };
    expect(verifySessionAccess(sess, { tenantId: 'key:1234' })).toBe(true);
    expect(verifySessionAccess(sess, { tenantId: 'key:9999' })).toBe(false);
    expect(verifySessionAccess(sess, {})).toBe(false);
  });
  test('legacy tenant sessions stay accessible', () => {
    expect(verifySessionAccess({ tenantId: 'legacy' }, {})).toBe(true);
  });
});
