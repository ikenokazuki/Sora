import { describe, expect, test } from 'bun:test';
import { scanRepository, scanReturnNotes, type Finding, type FindingKind } from './scan.js';

let cached: Promise<Finding[]> | undefined;
const findings = () => (cached ??= scanRepository());

async function expectNoFindings(kinds: FindingKind[]): Promise<void> {
  const remaining = (await findings()).filter((f) => kinds.includes(f.kind)).map((f) => `${f.kind} ${f.key} :: ${f.detail}`);
  expect(remaining).toEqual([]);
}

describe('API input notation (MCP + OpenAPI)', () => {
  test('documented defaults are declared and match', async () => {
    await expectNoFindings(['default_undeclared', 'default_mismatch', 'default_unparseable']);
  }, 30_000);

  test('listed values are declared as enum', async () => {
    await expectNoFindings(['enum_missing']);
  }, 30_000);

  test('integer bounds and documented ranges are declared', async () => {
    await expectNoFindings(['unbounded_integer', 'range_mismatch']);
  }, 30_000);

  test('MCP tools and REST twins agree', async () => {
    await expectNoFindings(['pair_mismatch']);
  }, 30_000);

  test('no notation findings remain', async () => {
    expect((await findings()).map((f) => `${f.kind} ${f.key}`)).toEqual([]);
  }, 30_000);

  test('MCP 返却 notes name keys that the documented response has', async () => {
    expect((await scanReturnNotes()).map((f) => `${f.key} :: ${f.detail}`)).toEqual([]);
  }, 30_000);
});
