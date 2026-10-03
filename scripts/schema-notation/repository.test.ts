import { describe, expect, test } from 'bun:test';
import { scanRepository, type Finding, type FindingKind } from './scan.js';

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
});
