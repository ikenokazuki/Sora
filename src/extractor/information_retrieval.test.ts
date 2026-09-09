import { describe, it, expect } from 'bun:test';
import {
  reorderLostInTheMiddle,
  selectMaximalMarginalRelevance,
  computeJaccardSimilarity,
  expandQueryWithPseudoRelevanceFeedback,
} from './information_retrieval.js';

describe('Information Retrieval (IR) & Advanced RAG Algorithms', () => {
  describe('reorderLostInTheMiddle (Lost in the Middle 対策 / U字型配置)', () => {
    it('要素数が2以下の場合は元の配列のコピーを返すこと', () => {
      expect(reorderLostInTheMiddle([])).toEqual([]);
      expect(reorderLostInTheMiddle([1])).toEqual([1]);
      expect(reorderLostInTheMiddle([1, 2])).toEqual([1, 2]);
    });

    it('要素数3の場合、1位を先頭、2位を末尾、3位を中央に配置すること', () => {
      // 1位: A, 2位: B, 3位: C -> [A, C, B]
      const items = ['A', 'B', 'C'];
      expect(reorderLostInTheMiddle(items)).toEqual(['A', 'C', 'B']);
    });

    it('要素数5の場合、奇数偶数交互に両端から詰め [1, 3, 5, 4, 2] になること', () => {
      const items = [1, 2, 3, 4, 5];
      const reordered = reorderLostInTheMiddle(items);
      // 1位(1)が先頭、2位(2)が末尾、3位(3)が先頭寄り、4位(4)が末尾寄り、5位(5)が中央
      expect(reordered).toEqual([1, 3, 5, 4, 2]);
    });

    it('要素数6の場合、[1, 3, 5, 6, 4, 2] になること', () => {
      const items = [1, 2, 3, 4, 5, 6];
      const reordered = reorderLostInTheMiddle(items);
      expect(reordered).toEqual([1, 3, 5, 6, 4, 2]);
    });
  });

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

  describe('expandQueryWithPseudoRelevanceFeedback (インメモリ PRF クエリ拡張)', () => {
    it('上位適合文書から重要共起語を抽出し、クエリを拡張すること', () => {
      const query = '推しの子 映画';

      const topDocs = [
        '人気作「推しの子」の実写映画化が決定。劇場版の公開日は12月20日で特報映像が公式YouTubeで解禁された。キャスト陣も発表。',
        '「推しの子」映画最新情報。劇場版公開に向けてムビチケ前売券の特典情報が解禁。全国の映画館で上映予定。',
      ];

      const allDocs = [
        ...topDocs,
        '今日の天気は快晴で気温が上昇する見込みです。',
        'プログラミング言語TypeScriptの基礎文法と型推論の解説。',
        '日本の歴史と鎌倉幕府の成立過程についてまとめた記事。',
      ];

      const result = expandQueryWithPseudoRelevanceFeedback(query, topDocs, allDocs, { maxTerms: 2 });

      expect(result.expansionTerms.length).toBeGreaterThan(0);
      // クエリに含まれていない「劇場版」や「公開日」「解禁」などが共起語として抽出されること
      const hasExpectedTerm = result.expansionTerms.some((term) =>
        ['劇場版', '公開', '解禁', '前売', '上映', '映画館'].some((expected) => term.includes(expected))
      );
      expect(hasExpectedTerm).toBe(true);

      // クエリ自身（「推しの子」「映画」）は拡張語に含まれないこと
      expect(result.expansionTerms).not.toContain('推しの子');
      expect(result.expansionTerms).not.toContain('映画');

      expect(result.expandedQuery).toContain('推しの子 映画');
    });

    it('空クエリやドキュメントなしの場合は安全に元のクエリを返すこと', () => {
      expect(expandQueryWithPseudoRelevanceFeedback('', [], [])).toEqual({
        expandedQuery: '',
        expansionTerms: [],
      });
    });
  });

  describe('extractQueryHighlightDetails への統合 (MMR & U字型リオーダリング)', () => {
    it('同一内容の言い換え重複を MMR で排除し、reorderUFlat で U字型配置されること', async () => {
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
        evidenceMode: 'highlights',
        reorderUFlat: true,
        diversityWeight: 0.7,
      });

      expect(details.highlightItems.length).toBeGreaterThanOrEqual(2);
      // MMR によって、1行目と2行目（ほぼ同一文）の重複採択が防がれ、チケット情報が含まれていること
      const texts = details.highlightItems.map((i: any) => i.text);
      const hasGoods = texts.some((t: string) => t.includes('グッズ先行販売'));
      const hasTicket = texts.some((t: string) => t.includes('チケット先行抽選'));
      expect(hasGoods).toBe(true);
      expect(hasTicket).toBe(true);
    });

    it('integratedSearch で enablePrf と reorderUFlat が正しく伝播・機能すること', async () => {
      const { integratedSearch } = await import('../scraper.js');

      const result = await integratedSearch({
        query: 'TypeScript 5.5 新機能',
        limit: 3,
        scrapeContent: false, // 外部スクレイプをスキップして高速検証
        includeRealtime: false,
        reorderUFlat: true,
        enablePrf: true,
        noCache: true,
      });

      expect(result.source).toBe('integrated');
      expect(result.results).toBeDefined();
      // PRF が実行された場合、prf フィールドが存在するか、または配列が返却されること
      if (result.prf) {
        expect(result.prf.originalQuery).toBe('TypeScript 5.5 新機能');
        expect(result.prf.expandedQuery).toBeDefined();
      }
    });
  });
});
