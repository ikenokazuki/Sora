/**
 * README §4.3 の環境変数の表が、登録簿（src/config.ts）と一致することを確かめる。
 * 表は目印の間を `bun run gen:env`（scripts/gen-env-table.ts）で書き直す。手で直さない。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EXTERNAL, renderEnvTable, SETTINGS } from './config.js';

const START = '<!-- env-table:start -->';
const END = '<!-- env-table:end -->';
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** 目印の間（目印は 1 組だけ）。無ければ undefined。 */
function envTableBlock(): string | undefined {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + 1) >= 0 || readme.indexOf(END, end + 1) >= 0) return undefined;
  return readme.slice(start + START.length, end);
}

describe('README §4.3 の環境変数の表', () => {
  test('目印の間が renderEnvTable() の出力と同じ（違えば bun run gen:env）', () => {
    expect(envTableBlock()).toBe(`\n${renderEnvTable()}\n`);
  });

  test('表の行の名前が、登録簿（SETTINGS と EXTERNAL）の名前とちょうど同じ', () => {
    const rows = (envTableBlock() ?? '').split('\n').filter((line) => line.startsWith('| `'));
    const names = rows.map((line) => line.slice(3, line.indexOf('`', 3)));
    expect(names.toSorted()).toEqual([...Object.keys(SETTINGS), ...Object.keys(EXTERNAL)].toSorted());
  });
});
