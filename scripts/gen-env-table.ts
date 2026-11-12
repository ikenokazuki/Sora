/**
 * README §4.3 の環境変数の表を、登録簿（src/config.ts の renderEnvTable()）から書き直す。使い方: bun run gen:env
 * 書き直すのは目印（<!-- env-table:start --> と <!-- env-table:end -->）の間だけ。一致は src/config_docs.test.ts が確かめる。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderEnvTable } from '../src/config.js';

const START = '<!-- env-table:start -->';
const END = '<!-- env-table:end -->';

const path = new URL('../README.md', import.meta.url);
const readme = readFileSync(path, 'utf8');
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start < 0 || end < start || readme.indexOf(START, start + 1) >= 0 || readme.indexOf(END, end + 1) >= 0) {
  console.error(`gen:env: README.md に目印 ${START} と ${END} が 1 組（この順）で要ります`);
  process.exit(1);
}
const next = `${readme.slice(0, start + START.length)}\n${renderEnvTable()}\n${readme.slice(end)}`;
if (next === readme) console.log('gen:env: README.md の表は登録簿と同じです');
else {
  writeFileSync(path, next);
  console.log('gen:env: README.md の表を書き直しました');
}
