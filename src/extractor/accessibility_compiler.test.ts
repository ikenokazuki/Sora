import { describe, it, expect } from 'bun:test';
import {
  assignBlockProvenance,
  formatBlockAnchor,
  computeEvidenceDiagnostics,
  detectDiscrepancies,
  normalizeSafeNumeric,
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

  describe('detectDiscrepancies', () => {
    it('複数ソース・同一文書で異なる日付が存在する場合、CandidateDiscrepancy として対比提示すること', () => {
      const items = [
        {
          text: '一次情報によると、新製品の発売日は 2026年09月15日 と予定されています。',
          sourceId: 'S1',
          blockId: 'P1',
        },
        {
          text: '別ソースでは、発売日は 2026-09-20 に延期されたとの情報があります。',
          sourceId: 'S2',
          blockId: 'P3',
        },
      ];

      const discrepancies = detectDiscrepancies(items);
      expect(discrepancies.length).toBeGreaterThanOrEqual(1);

      const dateDiscrepancy = discrepancies.find((d) => d.kind === 'date');
      expect(dateDiscrepancy).toBeDefined();
      expect(dateDiscrepancy!.status).toBe('needs_agent_resolution');
      expect(dateDiscrepancy!.values.length).toBe(2);
      expect(dateDiscrepancy!.values.map((v) => v.normalized)).toContain('2026-09-15');
      expect(dateDiscrepancy!.values.map((v) => v.normalized)).toContain('2026-09-20');
    });

    it('異なる金額が存在する場合、money 不一致候補として提示すること', () => {
      const items = [
        { text: '通常価格は 1,200円 です。', sourceId: 'S1', blockId: 'P2' },
        { text: '特別セール価格は 980円 です。', sourceId: 'S1', blockId: 'P5' },
      ];

      const discrepancies = detectDiscrepancies(items);
      const moneyDiscrepancy = discrepancies.find((d) => d.kind === 'money');
      expect(moneyDiscrepancy).toBeDefined();
      expect(moneyDiscrepancy!.values.map((v) => v.normalized)).toContain('1200円');
      expect(moneyDiscrepancy!.values.map((v) => v.normalized)).toContain('980円');
    });

    it('値が1種類しかない場合は誤発火しないこと', () => {
      const items = [
        { text: 'イベント日は 2026-10-01 です。', sourceId: 'S1', blockId: 'P1' },
        { text: '開催日は 2026年10月01日 に決定しました。', sourceId: 'S2', blockId: 'P1' },
      ];

      const discrepancies = detectDiscrepancies(items);
      expect(discrepancies.find((d) => d.kind === 'date')).toBeUndefined();
    });
  });

  describe('normalizeSafeNumeric', () => {
    it('全角数字を半角数字に変換し DerivationTrace を生成すること', () => {
      const result = normalizeSafeNumeric('価格は ３５００ 円です。');
      expect(result.normalizedText).toContain('3500');
      expect(result.derivations.some((d) => d.operation === 'fullwidth_digits_to_halfwidth')).toBe(true);
    });

    it('漢数字の「万」「億」を決定論的に数値展開すること', () => {
      const result = normalizeSafeNumeric('予算は 3万5000 円、会員数は 120万 人です。');
      expect(result.normalizedText).toContain('35000');
      expect(result.normalizedText).toContain('1200000');
      expect(result.derivations.some((d) => d.operation === 'kanji_man_to_digits')).toBe(true);
    });

    it('物理単位 km/ms を固定規則で正規化すること (外部推測が必要な為替等は変換しない)', () => {
      const result = normalizeSafeNumeric('距離は 2.5 km、レイテンシは 400 ms、為替は 150 ドルです。');
      expect(result.normalizedText).toContain('2500 m');
      expect(result.normalizedText).toContain('0.4 s');
      // 為替（150 ドル）は変換されずそのまま保持されること
      expect(result.normalizedText).toContain('150 ドル');
      expect(result.derivations.some((d) => d.operation === 'km_to_m')).toBe(true);
      expect(result.derivations.some((d) => d.operation === 'ms_to_s')).toBe(true);
    });
  });
});
