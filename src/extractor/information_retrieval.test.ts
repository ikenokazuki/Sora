import { describe, it, expect } from 'bun:test';
import {
  selectMaximalMarginalRelevance,
  computeJaccardSimilarity,
} from './information_retrieval.js';

describe('Information Retrieval (IR) & Advanced RAG Algorithms', () => {
  describe('selectMaximalMarginalRelevance (MMR 多様性最大化 & 重複排除)', () => {
    it('Jaccard類似度が同一文で1.0、無関係文で0.0になること', () => {
      const textA = '公式ストアでは先行販売を実施中。東京と大阪で店頭販売します。';
      const textB = '公式ストアでは先行販売を実施中。東京と大阪で店頭販売します。';
      const textC = '天気の概況をお知らせします。明日は全国的に雨でしょう。';

      expect(computeJaccardSimilarity(textA, textB)).toBe(1.0);
      expect(computeJaccardSimilarity(textA, textC)).toBeLessThan(0.2);
    });

    it('高スコアな類似言い換え文を排除し、異なるトピックの重要文を優先採択すること', () => {
      const candidates = [
        {
          id: 1,
          score: 10.0,
          text: '公式オンラインストアでは会員登録でグッズ先行販売に参加可能。東京と大阪で店頭販売を実施。',
        },
        {
          id: 2,
          score: 9.5, // ほぼ候補1の言い換え（高スコアだが冗長）
          text: '公式オンラインストアで会員登録するとグッズ先行販売に参加できます！東京と大阪の店舗で販売。',
        },
        {
          id: 3,
          score: 7.5, // スコアは少し低いが、全く異なる貴重な情報
          text: 'ファンクラブ会員限定のライブチケット先行抽選受付を開始。一般発売は各種プレイガイドで行われます。',
        },
        {
          id: 4,
          score: 2.0, // 無関係
          text: 'プライバシーポリシーと利用規約に同意の上ご利用ください。',
        },
      ];

      // limit: 2, lambda: 0.7 で選択
      const mmrSelected = selectMaximalMarginalRelevance(candidates, {
        getScore: (c) => c.score,
        getText: (c) => c.text,
        limit: 2,
        lambda: 0.7,
      });

      expect(mmrSelected.length).toBe(2);
      // 1件目は最高スコアの候補1
      expect(mmrSelected[0].id).toBe(1);
      // 2件目は候補2（言い換え重複）がペナルティを受け、異なる事実を持つ候補3が浮上すること！
      expect(mmrSelected[1].id).toBe(3);
    });

    it('lambda = 1.0 (多様性ペナルティなし) の場合は純粋なスコア順になること', () => {
      const candidates = [
        { id: 1, score: 10.0, text: '公式ストアでグッズ先行販売' },
        { id: 2, score: 9.5, text: '公式ストアでグッズの先行販売中' },
        { id: 3, score: 7.0, text: 'チケット抽選予約の案内' },
      ];

      const selected = selectMaximalMarginalRelevance(candidates, {
        getScore: (c) => c.score,
        getText: (c) => c.text,
        limit: 2,
        lambda: 1.0, // 類似度ペナルティ完全ゼロ
      });

      expect(selected.map((c) => c.id)).toEqual([1, 2]);
    });
  });

  describe('extractQueryHighlightDetails への統合 (MMR)', () => {
    it('同一内容の言い換え重複を MMR で排除すること', async () => {
      const { extractQueryHighlightDetails } = await import('../enrichment.js');

      const markdown = `
# 公式案内

## グッズ販売について
公式オンラインストアでは会員登録でグッズ先行販売に参加可能。東京と大阪で店頭販売を実施。

## グッズ購入方法の補足
公式オンラインストアで会員登録するとグッズ先行販売に参加できます！東京と大阪の店舗で販売。

## チケット先行予約
ファンクラブ会員限定のライブチケット先行抽選受付を開始。一般発売は各種プレイガイドで行われます。

## アクセス情報
会場周辺には駐車場がございません。公共交通機関をご利用ください。
      `;

      const details = extractQueryHighlightDetails(markdown, 'グッズ先行販売 チケット抽選', {
        maxHighlights: 3,
      });

      expect(details.highlightItems.length).toBeGreaterThanOrEqual(2);
      // MMR によって、1行目と2行目（ほぼ同一文）の重複採択が防がれ、チケット情報が含まれていること
      const texts = details.highlightItems.map((i: any) => i.text);
      const hasGoods = texts.some((t: string) => t.includes('グッズ先行販売'));
      const hasTicket = texts.some((t: string) => t.includes('チケット先行抽選'));
      expect(hasGoods).toBe(true);
      expect(hasTicket).toBe(true);
    });
  });
});
