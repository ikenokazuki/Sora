// 表の結合（colspan・rowspan）と、行×列の大きさの上限。どれもページの側が決める値で、上限が無いと、セル 1 つの小さなページで
// 止まる・メモリを使い切る。結合の値は HTML の仕様の上限で切り、結合で増やせる量と、整形する表の大きさは、1 回の変換（文書）ごとの予算にする

/** colspan の上限（HTML の仕様） */
export const MAX_COLSPAN = 1000;
/** rowspan の上限（HTML の仕様） */
export const MAX_ROWSPAN = 65_534;
/** 1 回の変換で、結合で増やせる量（増えるマスの数 ×（セルの字数 + 1）。出力の字数の目安） */
const SPAN_BUDGET = 1_000_000;
/** 1 回の変換で、列の削除と空欄の埋め込み（行×列の大きさになる）をする表の、行×列の合計 */
const MATRIX_BUDGET = 1_000_000;

export interface TableBudget {
  span: number;
  matrix: number;
}

export const newTableBudget = (): TableBudget => ({ span: SPAN_BUDGET, matrix: MATRIX_BUDGET });

/** colspan・rowspan の値（読めない値・1 未満は 1。上限まで） */
export function spanValue(value: string | null | undefined, max: number): number {
  const n = Number.parseInt(value || '1', 10);
  return n > 1 ? Math.min(n, max) : 1;
}

/** 広げる行と列の数。予算を超える結合は、結合しない（1×1）ものとして扱う */
export function spanWithinBudget(rowspan: number, colspan: number, textLength: number, budget: TableBudget): [rows: number, cols: number] {
  const cost = (rowspan * colspan - 1) * (textLength + 1);
  if (cost > budget.span) return [1, 1];
  budget.span -= cost;
  return [rowspan, colspan];
}

/** 表の行×列が予算の内なら、予算から引いて true。超える表は、列の削除と空欄の埋め込みをしない */
export function takeMatrix(grid: string[][], budget: TableBudget): boolean {
  const cells = grid.length * grid.reduce((max, row) => Math.max(max, row.length), 0);
  if (cells > budget.matrix) return false;
  budget.matrix -= cells;
  return true;
}

/** 大きすぎる表は、行ごとにそのまま書き出す（Markdown の表は、短い行の残りを空欄として扱う）。空いた位置は詰める */
export function plainMarkdownTable(grid: string[][]): string {
  const lines = grid.map((row) => `| ${Object.values(row).join(' | ')} |`);
  const columns = Object.keys(grid[0]).length;
  return `\n\n${lines[0]}\n| ${Array.from({ length: columns }, () => '---').join(' | ')} |${lines.length > 1 ? `\n${lines.slice(1).join('\n')}` : ''}\n\n`;
}
