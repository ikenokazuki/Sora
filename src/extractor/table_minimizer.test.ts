import { describe, it, expect } from 'bun:test';
import { minimizeTableMatrix } from './table_minimizer.js';

describe('Smart Table Minimizer', () => {
  it('全行が空欄の列を自動削除すること', () => {
    const grid = [
      ['商品名', '空列', '価格'],
      ['Item A', '', '1,000円'],
      ['Item B', '  ', '2,000円'],
      ['Item C', '', '3,000円'],
    ];

    const result = minimizeTableMatrix(grid);
    expect(result).toEqual([
      ['商品名', '価格'],
      ['Item A', '1,000円'],
      ['Item B', '2,000円'],
      ['Item C', '3,000円'],
    ]);
  });

  it('全行が同一の無情報記号 (- や N/A) の列を自動削除すること', () => {
    const grid = [
      ['モデル', '機能1', '未対応機能', '備考'],
      ['Pro', 'あり', '-', '限定モデル'],
      ['Standard', 'あり', '-', '標準モデル'],
      ['Lite', 'なし', '-', 'エントリー'],
    ];

    const result = minimizeTableMatrix(grid);
    expect(result).toEqual([
      ['モデル', '機能1', '備考'],
      ['Pro', 'あり', '限定モデル'],
      ['Standard', 'あり', '標準モデル'],
      ['Lite', 'なし', 'エントリー'],
    ]);
  });

  it('全セルが空欄の行を自動削除すること', () => {
    const grid = [
      ['項目', '値'],
      ['A', '1'],
      ['', ''],
      ['B', '2'],
      ['  ', ' '],
    ];

    const result = minimizeTableMatrix(grid);
    expect(result).toEqual([
      ['項目', '値'],
      ['A', '1'],
      ['B', '2'],
    ]);
  });

  it('すべて有用な列・行の場合はそのまま保持すること', () => {
    const grid = [
      ['名前', '年齢', '都市'],
      ['Alice', '25', 'Tokyo'],
      ['Bob', '30', 'Osaka'],
    ];

    const result = minimizeTableMatrix(grid);
    expect(result).toEqual(grid);
  });

  it('空テーブルや1行のみの場合は安全に元の構造を返すこと', () => {
    expect(minimizeTableMatrix([])).toEqual([]);
    expect(minimizeTableMatrix([['ヘッダーのみ']])).toEqual([['ヘッダーのみ']]);
  });
});
