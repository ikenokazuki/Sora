import { describe, expect, test } from 'bun:test';
import { measureContext } from '../scripts/measure-context.js';

/**
 * モデルの文脈に載る固定の量（tools/list）を、実際のクライアントが受け取る HTTP の経路で測って守る。
 * しきい値は 2026-10-15 の実測（既定 24,457、全ツール 59,988）に小さな余裕を足した値。
 * ツールや引数の説明を増やして超えたときは、増やす理由を確かめたうえで、意識してしきい値を上げる
 * （`bun scripts/measure-context.ts` で現在の値を出せる。上げたらコミットメッセージに理由を書く）。
 */
const LIMITS = { defaultToolsListChars: 25_000, allToolsListChars: 61_500 };

describe('context budget', () => {
  test('tools/list over HTTP stays within the pinned size', async () => {
    const measured = await measureContext();
    expect(measured.defaultToolsList.tools).toBe(14);
    expect(measured.defaultToolsList.chars).toBeLessThanOrEqual(LIMITS.defaultToolsListChars);
    expect(measured.allToolsList.tools).toBe(50);
    expect(measured.allToolsList.chars).toBeLessThanOrEqual(LIMITS.allToolsListChars);
  });
});
