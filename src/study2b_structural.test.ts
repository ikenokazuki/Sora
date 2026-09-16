import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  detectStudy2BStructuralGate,
  selectStructuralEvidenceStudy2B,
} from './study2b_structural.js';

describe('Phase 4 selective structural Study 2B', () => {
  test('ordinary heading documents remain on the normal rho-select-v2 path', () => {
    const markdown = `
# 君と見るそら

## ソライロ
コールの説明です。

## 季節外れのリナリア
作詞者の説明です。
`;
    const gate = detectStudy2BStructuralGate(markdown);
    expect(gate.activated).toBe(false);

    const result = selectStructuralEvidenceStudy2B(markdown, 'ソライロ コール');
    expect(result.applied).toBe(false);
    expect(result.highlights).toEqual([]);
  });

  test('table rows are atomically closed with their header', () => {
    const markdown = `
# SPARK 山中湖

## タイムテーブル
| 出演者 | 出演時間 | ステージ |
| --- | --- | --- |
| 君と見るそら | 18:20 | Lake Stage |
| Example Idol | 19:00 | Lake Stage |
`;
    const result = selectStructuralEvidenceStudy2B(
      markdown,
      '君と見るそら 出演時間',
    );

    expect(result.gate.activated).toBe(true);
    expect(result.gate.reasons).toContain('markdown_table');
    expect(result.applied).toBe(true);
    expect(result.highlights.join('\n')).toContain('出演者');
    expect(result.highlights.join('\n')).toContain('出演時間');
    expect(result.highlights.join('\n')).toContain('君と見るそら');
    expect(result.highlights.join('\n')).toContain('18:20');
  });

  test('repeated leaf headings under different parents remain address-bound', () => {
    const markdown = `
# Event A

## 君と見るそら

### 出演時間
18:20

# Event B

## 君と見るそら

### 出演時間
20:10
`;
    const result = selectStructuralEvidenceStudy2B(
      markdown,
      'Event A 君と見るそら 出演時間',
    );

    expect(result.gate.reasons).toContain('repeated_leaf_across_parents');
    expect(result.applied).toBe(true);
    expect(result.highlights.join('\n')).toContain('Event A');
  });

  test('footnote dependencies are included in the same atomic bundle', () => {
    const markdown = `
# 入場条件

## チケット
入場には整理券が必要です[^rule]。

[^rule]: 整理券は当日10:00から配布します。
`;
    const result = selectStructuralEvidenceStudy2B(
      markdown,
      '整理券 配布',
    );

    expect(result.gate.reasons).toContain('footnote_dependency');
    expect(result.applied).toBe(true);
    expect(result.highlights.join('\n')).toContain('当日10:00から配布');
  });

  test('integration feature flag is opt-in', () => {
    const source = readFileSync(new URL('./scraper.ts', import.meta.url), 'utf8');
    expect(
      /process\.env\.SORA_STUDY2B_STRUCTURAL\s*===\s*['"]true['"]/.test(source),
    ).toBe(true);
  });

  test('integration cache is partitioned by Study 2B mode', () => {
    const source = readFileSync(new URL('./scraper.ts', import.meta.url), 'utf8');
    expect(
      /structuralStudy2B\s*\?\s*['"]s2b-on['"]\s*:\s*['"]s2b-off['"]/.test(source),
    ).toBe(true);
  });

  test('integration calls Study 2B with source content and original query', () => {
    const source = readFileSync(new URL('./scraper.ts', import.meta.url), 'utf8');
    expect(
      /selectStructuralEvidenceStudy2B\s*\(\s*scrape\.content\s*,\s*query\s*,/s.test(source),
    ).toBe(true);
  });

  test('integration never overwrites source-faithful scrape.content', () => {
    const source = readFileSync(new URL('./scraper.ts', import.meta.url), 'utf8');
    expect(/scrape\.content\s*=\s*structural/.test(source)).toBe(false);
  });

  test('structural bundles go directly to low-level rho-select-v2', () => {
    const source = readFileSync(
      new URL('./study2b_structural.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('selectEvidenceSetRhoV2(');
    expect(source).not.toContain('extractQueryHighlightsRhoV2(');
  });

  test('certified rho-v2 selection is not truncated after solving', () => {
    const source = readFileSync(
      new URL('./study2b_structural.ts', import.meta.url),
      'utf8',
    );
    expect(/selectedIndices\.slice\s*\(\s*0\s*,/.test(source)).toBe(false);
    expect(source).toContain('const selectedIndices = selection.indices.slice();');
  });
});
