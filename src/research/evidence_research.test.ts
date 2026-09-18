/**
 * Sora Evidence Compiler Research — Unit Tests
 */

import { describe, expect, it } from 'bun:test';
import {
  normalizeEvidenceText,
  isRedundantWithHighlights,
  hasSupplementalHighlight,
  projectIntegratedSearchEvidenceItemV2,
} from './evidence_projection_v2.js';
import {
  buildArmACandidates,
  buildArmBCandidates,
  buildArmCCandidates,
  reconstructArmCHighlights,
  splitSentencesWithOffsets,
} from './evidence_atoms.js';
import {
  PRECISION_FIXTURES,
  STRUCTURAL_FIXTURES,
  ADVERSARIAL_FIXTURES,
  generateSyntheticMarkdown,
} from './evidence_benchmark_fixtures.js';
import {
  evaluateTestCaseUnderArm,
} from './evidence_evaluator.js';

describe('Evidence Projection v2 & Normalization', () => {
  it('normalizes markdown decoration, unicode, whitespace, and case', () => {
    const raw = '# 見出し\n\n**重要**: これは　`テスト`　です。[詳細リンク](https://example.com) — *注釈*';
    const normalized = normalizeEvidenceText(raw);
    expect(normalized).toBe('見出し 重要: これは テスト です。詳細リンク — 注釈');
  });

  it('correctly detects complete containment redundancy', () => {
    const highlights = [
      '## 概要\n\n君と見るそらの代表曲「ソライロ」の公式コール表です。',
      '## サビ\n\nソライロの風に乗って飛べるよ',
    ];

    // Completely contained
    const desc1 = '君と見るそらの代表曲「ソライロ」の公式コール表です。';
    expect(isRedundantWithHighlights(desc1, highlights)).toBe(true);

    // Inverse direction (description contains more unique info): MUST NOT BE PRUNED
    const desc2 = '君と見るそらの代表曲「ソライロ」の公式コール表です。会場全体で盛り上がりましょう！限定グッズも販売中。';
    expect(isRedundantWithHighlights(desc2, highlights)).toBe(false);

    // Empty or short
    expect(isRedundantWithHighlights('', highlights)).toBe(false);
    expect(isRedundantWithHighlights('abc', highlights)).toBe(false);
  });

  it('preserves supplemental snippet and fallback risk in P2', () => {
    const fallbackItem = {
      title: 'Fallback Site',
      url: 'https://example.com',
      isSnippetFallback: true,
      snippet: '補完スニペット内容',
      highlights: ['> 📌 **補完証拠 (スニペット)**: 補完スニペット内容'],
    };

    const projected = projectIntegratedSearchEvidenceItemV2(fallbackItem, { variant: 'P2' });
    // Snippet must be protected and NOT deleted
    expect(projected.snippet).toBe('補完スニペット内容');
  });

  it('prunes redundant description in P2 when safely enclosed in highlights', () => {
    const item = {
      title: 'Normal Site',
      url: 'https://example.com',
      markdown: '# Full Markdown Body',
      description: 'ソライロの公式コール表です。',
      snippet: '他の独自スニペット情報',
      highlights: ['## 概要\n\nソライロの公式コール表です。'],
    };

    const projected = projectIntegratedSearchEvidenceItemV2(item, { variant: 'P2' });
    expect(projected.markdown).toBeUndefined(); // markdown elided
    expect(projected.description).toBeUndefined(); // redundant description pruned
    expect(projected.snippet).toBe('他の独自スニペット情報'); // unique snippet preserved
  });

  it('P3 prunes presentation metadata without modifying canonical properties', () => {
    const item = {
      title: 'Metadata Site',
      url: 'https://example.com',
      highlights: ['## ハイライト'],
      ogImage: 'https://example.com/og.jpg',
      socialLinks: ['https://x.com/sora'],
      twitterHandle: '@sora',
      pageType: 'article',
      site: 'Sora Web',
    };

    const projected = projectIntegratedSearchEvidenceItemV2(item, { variant: 'P3' });
    expect(projected.ogImage).toBeUndefined();
    expect(projected.socialLinks).toBeUndefined();
    expect(projected.twitterHandle).toBeUndefined();
    expect(projected.pageType).toBeUndefined();
    expect(projected.site).toBeUndefined();
    expect(projected.title).toBe('Metadata Site');
  });
});

describe('Evidence Atomizer (Arm A, Arm B, Arm C)', () => {
  const markdownSample = `
# 音楽情報

## 楽曲スペック

| 曲名 | 作詞 | 作曲 |
| :--- | :--- | :--- |
| ソライロ | 佐藤美咲 | 田中健一 |
| リナリア | 内山優花 | 高橋涼 |

## 注釈付きセクション

本作のリナリア[^1]は初披露となりました。

[^1]: 2024年秋フェスにて初披露。
`;

  it('Arm A creates section-level candidates', () => {
    const { candidates } = buildArmACandidates(markdownSample);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.kind === 'section')).toBe(true);
  });

  it('Arm B produces table row + header closure and footnote closure', () => {
    const { candidates } = buildArmBCandidates(markdownSample);

    // Table rows must contain header
    const tableCands = candidates.filter((c) => c.kind === 'table-row');
    expect(tableCands.length).toBe(2);
    expect(tableCands[0].body).toContain('| 曲名 | 作詞 | 作曲 |');
    expect(tableCands[0].body).toContain('ソライロ');
    expect(tableCands[1].body).toContain('| 曲名 | 作詞 | 作曲 |');
    expect(tableCands[1].body).toContain('リナリア');

    // Footnote closure: section mentioning [^1] must have definition appended
    const footnoteSection = candidates.find((c) => c.body.includes('リナリア[^1]'));
    expect(footnoteSection).toBeDefined();
    expect(footnoteSection?.body).toContain('[^1]: 2024年秋フェスにて初披露。');
  });

  it('Arm C splits into fine-grained sentence/table atoms and reconstructs', () => {
    const { candidates } = buildArmCCandidates(markdownSample);
    expect(candidates.some((c) => c.kind === 'sentence' || c.kind === 'table-row')).toBe(true);

    const reconstructed = reconstructArmCHighlights(candidates.slice(0, 3));
    expect(reconstructed.length).toBeGreaterThan(0);
  });

  it('splits sentences preserving offsets', () => {
    const text = '澄み渡る空へと。手を伸ばした瞬間に！超絶可愛い。';
    const sentences = splitSentencesWithOffsets(text, 10);
    expect(sentences.length).toBe(3);
    expect(sentences[0].text).toBe('澄み渡る空へと。');
    expect(sentences[0].span.start).toBe(10);
  });
});

describe('Benchmark Fixtures & Evaluator', () => {
  it('loads all fixtures without schema errors', () => {
    expect(PRECISION_FIXTURES.length).toBe(3);
    expect(STRUCTURAL_FIXTURES.length).toBe(5);
    expect(ADVERSARIAL_FIXTURES.length).toBe(3);
  });

  it('evaluates structural table closure under Arm B', () => {
    const tableCase = STRUCTURAL_FIXTURES.find((f) => f.id === 'structural-table-closure')!;
    const resB = evaluateTestCaseUnderArm(tableCase, 'ArmB');
    expect(resB.requiredEvidenceRecall).toBe(true);
    expect(resB.structuralClosure).toBe(true);
  });

  it('generates synthetic documents scaling from small to large', () => {
    const synthSmall = generateSyntheticMarkdown(2000);
    expect(Buffer.byteLength(synthSmall.markdown, 'utf8')).toBeGreaterThanOrEqual(2000);
    expect(synthSmall.markdown).toContain(synthSmall.targetAnswer);
  });
});
