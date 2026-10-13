import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestAddressData } from '../test_fixtures/address/builders.js';
import { createAddressContext, getAddressContext, setAddressContextForTest } from './address_context.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-ctx-'));
});
afterEach(() => {
  setAddressContextForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

test('テストでは、差し替えなしの取得を拒否する（実通信を避ける）', () => {
  expect(() => getAddressContext()).toThrow('setAddressContextForTest');
});

test('差し替えたコンテキストを返し、null で元に戻す', () => {
  const ctx = createAddressContext(createTestAddressData(dir).data);
  setAddressContextForTest(ctx);
  expect(getAddressContext()).toBe(ctx);
  expect(ctx.normalizer).toBeDefined();
  setAddressContextForTest(null);
  expect(() => getAddressContext()).toThrow();
});
