import { describe, it, expect } from 'bun:test';
import {
  assignBlockProvenance,
  formatBlockAnchor,
  computeEvidenceDiagnostics,
} from './accessibility_compiler.js';
import type { HeadingBlock } from './hierarchical_bm25.js';

describe('Accessibility Compiler (Evidence-Preserving Data Plane)', () => {
  describe('assignBlockProvenance', () => {
    it('HeadingBlock 群に P1, P2... の連番と sourceId、ref を正しく付与すること', () => {
      const blocks: HeadingBlock[] = [
        {
          headingPath: ['会社概要'],
          nearestHeading: '会社概要',
          depth: 1,
          body: 'Sora は日本の Web 探索エンジンです。',
        },
        {
          headingPath: ['会社概要', '沿革'],
          nearestHeading: '沿革',
          depth: 2,
          body: '2026年に開発されました。',
        },
      ];

      const provenanced = assignBlockProvenance(blocks, 'S1', 'https://example.com/about', '2026-09-01T10:00:00Z');

      expect(provenanced).toHaveLength(2);
      expect(provenanced[0].blockId).toBe('P1');
      expect(provenanced[0].sourceId).toBe('S1');
      expect(provenanced[0].ref.url).toBe('https://example.com/about');
      expect(provenanced[0].ref.publishedTime).toBe('2026-09-01T10:00:00Z');
      expect(provenanced[0].ref.nearestHeading).toBe('会社概要');

      expect(provenanced[1].blockId).toBe('P2');
      expect(provenanced[1].ref.headingPath).toEqual(['会社概要', '沿革']);
    });

    it('formatBlockAnchor が正しい Markdown 引用アンカーを生成すること', () => {
      const anchorWithDate = formatBlockAnchor({
        sourceId: 'S1',
        blockId: 'P4',
        publishedTime: '2026-09-01T12:34:56Z',
      });
      expect(anchorWithDate).toBe('> [S1:P4 | 2026-09-01]');

      const anchorWithoutDate = formatBlockAnchor({
        sourceId: 'S2',
        blockId: 'P12',
      });
      expect(anchorWithoutDate).toBe('> [S2:P12]');
    });
  });

  describe('computeEvidenceDiagnostics', () => {
    it('十分な語句が一致する場合、高いカバレッジと weakEvidenceSignal: false を返すこと', () => {
      const content = 'Sora は Bun 最適化された Web スクレイピング サーバーです。';
      const query = 'Sora Bun スクレイピング';
      const diag = computeEvidenceDiagnostics(content, query, 3, 2.5);

      expect(diag.queryCoverage).toBeGreaterThanOrEqual(0.7);
      expect(diag.weakEvidenceSignal).toBe(false);
      expect(diag.candidateCount).toBe(3);
      expect(diag.topScore).toBe(2.5);
      expect(diag.matchedTerms).toContain('sora');
      expect(diag.matchedTerms).toContain('bun');
    });

    it('クエリ語句がほとんど含まれない場合、weakEvidenceSignal: true と客観的理由を返すこと', () => {
      const content = '本日の天気は晴天です。東京地方は南の風が吹くでしょう。';
      const query = '量子コンピュータ アルゴリズム QPU';
      const diag = computeEvidenceDiagnostics(content, query, 0, 0);

      expect(diag.queryCoverage).toBe(0);
      expect(diag.weakEvidenceSignal).toBe(true);
      expect(diag.reasons).toContain('no_matching_blocks');
      expect(diag.reasons).toContain('low_query_coverage');
    });

    it('空クエリの場合は安全にハンドリングされること', () => {
      const diag = computeEvidenceDiagnostics('本文', '');
      expect(diag.weakEvidenceSignal).toBe(true);
      expect(diag.reasons).toContain('empty_query');
    });
  });
});
