import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** `open` の位置の `(` に対応する `)` までの本文（入れ子の括弧を数える。引数に括弧を含む文字列がある呼び出しは想定しない）。 */
function callBody(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

describe('子プロセスの環境変数', () => {
  test('子プロセスを起こす呼び出し（spawn・Bun.spawn）は、すべて env を明示する（運用者の秘密を継承させない。security/child_env.ts）', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\b(?:Bun\.spawn|spawn)\(/g)) {
        const body = callBody(text, match.index! + match[0].length - 1);
        if (!/\benv\b/.test(body)) missing.push(`${relative(SRC, file)}:${text.slice(0, match.index).split('\n').length}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
