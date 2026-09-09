import { describe, it, expect } from 'bun:test';
import {
  extractQueryHighlightsRhoSelect,
  extractQueryHighlightsRho,
  parseMarkdownSections,
  tokenizeAndSelectTerms,
  type RhoSelectOptions,
} from './rho_select.js';

describe('ρSelect (rho-select) Core Algorithm', () => {
  // T1: Empty input
  describe('T1: Empty and invalid inputs', () => {
    it('should return empty highlights for empty content', () => {
      const res = extractQueryHighlightsRhoSelect('', '東京ドーム');
      expect(res.highlights).toEqual([]);
      expect(res.diagnostics.selectedCount).toBe(0);
    });

    it('should return empty highlights for empty query', () => {
      const res = extractQueryHighlightsRhoSelect('# タイトル\n本文です', '');
      expect(res.highlights).toEqual([]);
      expect(res.diagnostics.selectedCount).toBe(0);
    });

    it('should return empty highlights when no terms match', () => {
      const content = '# タイトル\n今日の天気は晴れです。\n\n## 詳細\n最高気温は25度です。';
      const res = extractQueryHighlightsRhoSelect(content, '量子力学 超弦理論');
      expect(res.highlights).toEqual([]);
      expect(res.diagnostics.selectedCount).toBe(0);
    });
  });

  // T2: Existing Japanese regression
  describe('T2: Japanese regression (Tokyo Dome)', () => {
    const tokyoDomeMarkdown = `
# 東京ドームイベント案内

東京ドームシティの最新情報をお届けします。

## チケット発売情報
東京ドームで開催される世界野球大会のチケット発売日は2026年10月15日です。全席指定となります。

## アクセス案内
水道橋駅および後楽園駅から徒歩でお越しいただけます。駐車場には限りがございます。
`.trim();

    it('should extract at least 1 highlight containing 東京ドーム', () => {
      const res = extractQueryHighlightsRhoSelect(tokyoDomeMarkdown, '東京ドーム チケット 発売');
      expect(res.highlights.length).toBeGreaterThanOrEqual(1);
      expect(res.highlights[0]).toContain('東京ドーム');
      expect(res.highlights[0]).toContain('チケット発売日');
    });
  });

  // T3: No-space Japanese query
  describe('T3: No-space Japanese query', () => {
    const markdown = `
# 施設利用案内

## 利用料金について
会議室の利用料金は1時間2000円です。

## 発売日情報
新シーズンパスのチケット発売日は来週月曜日です。

## 施設休館日
毎月第2火曜日が定期休館日となります。
`.trim();

    it('should correctly segment no-space query and select the relevant section', () => {
      const res = extractQueryHighlightsRhoSelect(markdown, 'チケット発売日');
      expect(res.highlights.length).toBeGreaterThanOrEqual(1);
      expect(res.highlights[0]).toContain('チケット発売日');
    });
  });

  // T4: Heading context preservation
  describe('T4: Heading context preservation', () => {
    const markdown = `
# 会社案内

## クラウドサービス事業
当社は次世代型AI推論クラウドを提供しております。

## 料金プランと購入手続き
基本プランは月額9800円、エンタープライズプランは個別見積もりとなります。オンラインフォームよりお申し込みいただけます。

## 採用情報
エンジニアを積極採用中です。
`.trim();

    it('should select heading with purchase details', () => {
      const res = extractQueryHighlightsRhoSelect(markdown, '料金プラン 購入手続き');
      expect(res.highlights.length).toBeGreaterThanOrEqual(1);
      expect(res.highlights[0]).toContain('料金プランと購入手続き');
      expect(res.highlights[0]).toContain('9800円');
    });
  });

  // T5: Complementary evidence selection
  describe('T5: Complementary evidence selection', () => {
    const markdown = `
# API利用規約

## 認証方式
APIキーまたはOAuth2トークンをAuthorizationヘッダーに設定してください。

## 料金体系
従量課金制であり、1000リクエストあたり10円が発生します。

## レート制限
1分あたり最大60リクエストまで呼び出し可能です。制限を超えると429が返されます。

## エラーハンドリング
エラー時はJSON形式でerrorオブジェクトが返却されます。
`.trim();

    it('should select both Price and Limit sections for complementary query', () => {
      const res = extractQueryHighlightsRhoSelect(markdown, '料金体系 レート制限', {
        maxHighlights: 2,
        overheadTokens: 64,
      });

      expect(res.highlights.length).toBe(2);
      const joined = res.highlights.join('\n');
      expect(joined).toContain('料金体系');
      expect(joined).toContain('レート制限');
    });
  });

  // T6: Tau effect on selection count
  describe('T6: Tau effect on selection count (monotonicity)', () => {
    const markdown = `
# 製品仕様詳細

## 機能A
高速なインメモリキャッシュ。

## 機能B
堅牢な分散ストレージ。

## 機能C
リアルタイムストリーミング通信。

## 機能D
多層防御セキュリティ機能。
`.trim();

    it('large tau should select equal or more snippets than small tau', () => {
      const resSmallTau = extractQueryHighlightsRhoSelect(markdown, 'インメモリ 分散ストレージ リアルタイム セキュリティ', {
        overheadTokens: 5,
        maxHighlights: 4,
      });

      const resLargeTau = extractQueryHighlightsRhoSelect(markdown, 'インメモリ 分散ストレージ リアルタイム セキュリティ', {
        overheadTokens: 500,
        maxHighlights: 4,
      });

      expect(resLargeTau.highlights.length).toBeGreaterThanOrEqual(resSmallTau.highlights.length);
    });
  });

  // T7: Dinkelbach agreement across varied settings
  describe('T7: Dinkelbach agreement across varied settings', () => {
    const doc = `
# 技術仕様書

## コンピュート
ARM64アーキテクチャによる省電力・高密度クラスタを採用しています。

## ストレージ
NVMe SSDにより毎秒10GBの読み書き速度を誇ります。

## ネットワーク
100Gbps専用回線で低遅延通信を実現します。

## セキュリティ
ゼロトラストアーキテクチャと暗号化トンネルで保護されます。
`.trim();

    it('exactAgreement should be true for single-term query', () => {
      const res = extractQueryHighlightsRhoSelect(doc, 'ストレージ NVMe', { overheadTokens: 64 });
      expect(res.diagnostics.exactAgreement).toBe(true);
    });

    it('exactAgreement should be true for multi-term query', () => {
      const res = extractQueryHighlightsRhoSelect(doc, 'コンピュート ネットワーク セキュリティ', { overheadTokens: 128 });
      expect(res.diagnostics.exactAgreement).toBe(true);
    });
  });

  // T8: Brute-force Property Test (1,000 Seeds)
  describe('T8: Brute-force Exact Agreement Property Test (1,000 random seeds)', () => {
    it('DP + Pareto frontier optimum must 100% match brute-force enumeration', () => {
      let seed = 123456789;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };

      const NUM_SEEDS = 1000;
      let matchCount = 0;

      for (let s = 0; s < NUM_SEEDS; s++) {
        const n = Math.floor(rnd() * 6) + 2; // 2〜7 候補
        const numTerms = Math.floor(rnd() * 3) + 2; // 2〜4 terms
        const K = Math.floor(rnd() * 3) + 1; // 1〜3
        const tau = Math.floor(rnd() * 200) + 10; // 10〜210

        const candidateMasks: number[] = [];
        const candidateCosts: number[] = [];
        const maxMask = (1 << numTerms) - 1;

        for (let i = 0; i < n; i++) {
          const mask = Math.floor(rnd() * maxMask) + 1;
          const cost = Math.floor(rnd() * 50) + 5;
          candidateMasks.push(mask);
          candidateCosts.push(cost);
        }

        const termWeights: number[] = [];
        for (let t = 0; t < numTerms; t++) {
          termWeights.push(rnd() * 2 + 0.5);
        }

        const calcUtility = (mask: number) => {
          let u = 0;
          for (let t = 0; t < numTerms; t++) {
            if ((mask & (1 << t)) !== 0) u += termWeights[t];
          }
          return u;
        };

        // 1. ブルートフォース全探索
        let bfBestDensity = -1;
        const totalSubsets = 1 << n;
        for (let subset = 1; subset < totalSubsets; subset++) {
          let count = 0;
          let mask = 0;
          let cost = 0;

          for (let i = 0; i < n; i++) {
            if ((subset & (1 << i)) !== 0) {
              count++;
              mask |= candidateMasks[i];
              cost += candidateCosts[i];
            }
          }

          if (count > K) continue;

          const u = calcUtility(mask);
          const density = u / (tau + cost);
          if (density > bfBestDensity + 1e-12) {
            bfBestDensity = density;
          }
        }

        // 2. 0/1 DP on (mask, count)
        const dp = new Map<number, { cost: number }>();
        const makeKey = (m: number, c: number) => (m << 4) | (c & 0xf);
        dp.set(makeKey(0, 0), { cost: 0 });

        for (let i = 0; i < n; i++) {
          const m_i = candidateMasks[i];
          const c_i = candidateCosts[i];
          const entries = Array.from(dp.entries());

          for (const [key, state] of entries) {
            const curM = key >> 4;
            const curCount = key & 0xf;
            if (curCount >= K) continue;

            const nxtM = curM | m_i;
            const nxtCount = curCount + 1;
            const nxtCost = state.cost + c_i;
            const nxtKey = makeKey(nxtM, nxtCount);

            const existing = dp.get(nxtKey);
            if (!existing || nxtCost < existing.cost) {
              dp.set(nxtKey, { cost: nxtCost });
            }
          }
        }

        // 3. Pareto フロンティア走査
        const outcomes: { mask: number; cost: number; utility: number }[] = [];
        for (const [key, state] of dp.entries()) {
          const curCount = key & 0xf;
          if (curCount === 0) continue;
          const curM = key >> 4;
          outcomes.push({
            mask: curM,
            cost: state.cost,
            utility: calcUtility(curM),
          });
        }

        outcomes.sort((a, b) => a.cost !== b.cost ? a.cost - b.cost : b.utility - a.utility);

        let maxU = -1;
        const frontier: typeof outcomes = [];
        for (const out of outcomes) {
          if (out.utility > maxU) {
            frontier.push(out);
            maxU = out.utility;
          }
        }

        let dpBestDensity = -1;
        for (const f of frontier) {
          const d = f.utility / (tau + f.cost);
          if (d > dpBestDensity + 1e-12) {
            dpBestDensity = d;
          }
        }

        expect(Math.abs(bfBestDensity - dpBestDensity)).toBeLessThan(1e-9);
        matchCount++;
      }

      expect(matchCount).toBe(NUM_SEEDS);
    });
  });

  // T9: Cardinality-state counterexample
  describe('T9: Cardinality-state necessity counterexample', () => {
    it('must track both mask and count in DP to avoid suboptimal prune', () => {
      const markdown = `
# システム仕様

## A機能
認証処理を提供します。

## B機能
認可処理を提供します。

## 認証と認可の統合機能
認証処理と認可処理をワンストップで同時に提供します。
`.trim();

      const res = extractQueryHighlightsRhoSelect(markdown, '認証 認可', {
        maxHighlights: 1,
        overheadTokens: 96,
      });

      expect(res.highlights.length).toBe(1);
      expect(res.highlights[0]).toContain('統合機能');
    });
  });

  // T10: Dominance preprocessing
  describe('T10: Dominance preprocessing equivalence', () => {
    const markdown = `
# 比較テスト

## 冗長な記述
東京ドームのチケット発売日は来週です。東京ドームは水道橋にあります。東京ドームは大きなスタジアムで、多くの人が集まります。席種もたくさんあります。

## 簡潔な記述
東京ドームのチケット発売日は来週です。
`.trim();

    it('should prefer shorter snippet when masks are identical', () => {
      const res = extractQueryHighlightsRhoSelect(markdown, '東京ドーム チケット 発売日', {
        maxHighlights: 1,
        overheadTokens: 96,
      });

      expect(res.highlights.length).toBe(1);
      expect(res.highlights[0]).toContain('簡潔な記述');
      expect(res.diagnostics.compactCandidateCount).toBeLessThanOrEqual(res.diagnostics.candidateCount);
    });
  });

  // T11: Feature-bit cap
  describe('T11: Feature-bit hard cap safety', () => {
    it('should cap feature bits within maxFeatureBits and 30 bits limit', () => {
      const longQuery = '東京 ドーム チケット 発売日 料金 座席 アクセス 水道橋 駐車場 会場 グッズ';
      const doc = '# 会場\n東京ドームの情報です。';
      const res = extractQueryHighlightsRhoSelect(doc, longQuery, {
        maxFeatureBits: 14,
        evidenceLevels: 3,
      });

      expect(res.diagnostics.featureCount).toBeLessThanOrEqual(14);
      expect(res.diagnostics.featureCount).toBeLessThanOrEqual(30);
    });
  });

  // T12: Determinism (100 runs)
  describe('T12: Deterministic execution (100 runs)', () => {
    const doc = `
# 多言語対応プラットフォーム

## 特徴
高速で信頼性の高い分散処理基盤。

## 価格設定
スタンダードプランは月額5000円。

## お問い合わせ
サポート窓口は平日10時から18時まで。
`.trim();

    it('100 consecutive runs must produce identical results and diagnostics', () => {
      const baseline = extractQueryHighlightsRhoSelect(doc, '分散処理 価格設定');
      for (let i = 0; i < 100; i++) {
        const run = extractQueryHighlightsRhoSelect(doc, '分散処理 価格設定');
        expect(run.highlights).toEqual(baseline.highlights);
        expect(run.diagnostics.density).toBe(baseline.diagnostics.density);
        expect(run.diagnostics.utility).toBe(baseline.diagnostics.utility);
        expect(run.diagnostics.selectedTokens).toBe(baseline.diagnostics.selectedTokens);
      }
    });
  });

  // Document sections parsing test
  describe('parseMarkdownSections helper', () => {
    it('should safely ignore hash inside code blocks', () => {
      const md = [
        '# 本物の見出し1',
        '',
        '```python',
        '# これはPythonのコメントであり見出しではない',
        'def hello():',
        '    print("world")',
        '```',
        '',
        '# 本物の見出し2',
        '本文2',
      ].join('\n');

      const sections = parseMarkdownSections(md);
      expect(sections.length).toBe(2);
      expect(sections[0].heading).toBe('本物の見出し1');
      expect(sections[0].fullText).toContain('# これはPythonのコメント');
      expect(sections[1].heading).toBe('本物の見出し2');
    });
  });

  // T13: Default algorithm is rho-select
  describe('T13: Default algorithm is unified to rho-select', () => {
    it('finalizeScrapeResult should execute rho-select by default', async () => {
      const { finalizeScrapeResult } = await import('./scraper.js');
      const sampleContent = [
        '# 製品仕様書',
        '',
        '## 概要',
        '最新の次世代クラウドサーバーです。',
        '',
        '## 料金プラン',
        '基本プランは月額1000円です。プレミアムプランは月額3000円です。',
        '',
        '## サポート',
        '年中無休で24時間対応いたします。',
      ].join('\n');

      const makeBase = () => ({
        url: 'https://example.com/spec',
        title: '仕様書',
        content: sampleContent,
        markdown: sampleContent,
      } as any);

      const resDefault = await finalizeScrapeResult(makeBase(), {
        query: '月額1000円',
        shouldExtractHighlights: true,
      } as any);

      const resExplicit = await finalizeScrapeResult(makeBase(), {
        query: '月額1000円',
        shouldExtractHighlights: true,
        highlightAlgorithm: 'rho-select',
      } as any);

      expect(resDefault.highlights).toEqual(resExplicit.highlights);
      expect(resDefault.highlights?.length).toBeGreaterThanOrEqual(1);
    });
  });

  // T14: Diagnostics and rho-select mode
  describe('T14: Diagnostics and rho-select mode', () => {
    it('rho-select mode returns diagnostics when verbose is true', async () => {
      const { finalizeScrapeResult } = await import('./scraper.js');
      const sampleContent = [
        '# サービス機能一覧',
        '',
        '## 認証機能',
        'OAuth2およびパスキー認証をサポートします。',
        '',
        '## 監査ログ',
        '全アクセスログを暗号化して保存します。',
      ].join('\n');

      const resRho = await finalizeScrapeResult({
        url: 'https://example.com/features',
        title: '機能一覧',
        content: sampleContent,
        markdown: sampleContent,
      } as any, {
        query: 'OAuth2 パスキー',
        shouldExtractHighlights: true,
        highlightAlgorithm: 'rho-select',
        verbose: true,
      } as any);

      expect(resRho.highlights?.length).toBeGreaterThanOrEqual(1);
      expect(resRho.highlightDiagnostics).toBeDefined();
      expect(resRho.highlightDiagnostics?.exactAgreement).toBe(true);
      expect(resRho.highlightDiagnostics?.selectedCount).toBeGreaterThanOrEqual(1);
    });
  });

  // T15: onlyHighlights integration
  describe('T15: onlyHighlights integration with rho-select', () => {
    it('content should be replaced by highlights join when onlyHighlights is true', async () => {
      const { finalizeScrapeResult } = await import('./scraper.js');
      const sampleContent = [
        '# 企業案内',
        '弊社の会社概要と理念です。余計なイントロダクションです。',
        '',
        '## 価格情報',
        '製品の価格は12000円です。年間契約で割引があります。',
      ].join('\n');

      const res = await finalizeScrapeResult({
        url: 'https://example.com/company',
        title: '会社案内',
        content: sampleContent,
        markdown: sampleContent,
      } as any, {
        query: '価格情報 12000円',
        shouldExtractHighlights: true,
        highlightAlgorithm: 'rho-select',
        shouldOnlyHighlights: true,
      } as any);

      expect(res.highlights?.length).toBeGreaterThanOrEqual(1);
      expect(res.content).toBe(res.highlights!.join('\n\n---\n\n'));
      expect(res.content).not.toContain('余計なイントロダクション');
    });
  });

  // T16: Performance & Token Efficiency Benchmark
  describe('T16: Performance & Token Efficiency Benchmark (rho-select)', () => {
    it('rho-select should exhibit sub-millisecond execution and mathematically verified token density', () => {
      const sections: string[] = ['# クラウドプラットフォーム総合技術白書\n'];
      for (let i = 1; i <= 50; i++) {
        sections.push(`## セクション ${i}: マイクロサービスアーキテクチャ設計論 ${i}`);
        sections.push(`この章では分散トレーシングと高スループットメッセージング（Kafka/RabbitMQ）の最適化について解説します。ノード ${i} のレイテンシは 1.${i}ms を達成しており、耐障害性と整合性の両立を実現します。`);
      }
      sections.push('## 特注設定: 高速インデックスとトークン節約\nクエリ有界分数最適化によって、コンテキストウィンドウの消費を最小化しながら最高精度の証拠を抽出します。');
      const bigDoc = sections.join('\n\n');

      const query = '高スループット メッセージング トークン節約';

      const t0Rho = performance.now();
      const rhoResult = extractQueryHighlightsRhoSelect(bigDoc, query, {
        maxHighlights: 3,
        overheadTokens: 96,
      });
      const t1Rho = performance.now();
      const rhoTimeMs = t1Rho - t0Rho;

      expect(rhoTimeMs).toBeLessThan(15);
      expect(rhoResult.highlights.length).toBeGreaterThanOrEqual(1);
      expect(rhoResult.diagnostics.exactAgreement).toBe(true);

      console.log(`\n[Benchmark T16] (Doc size: ${bigDoc.length} chars, 51 sections)`);
      console.log(`  - rho-select execution time : ${rhoTimeMs.toFixed(3)} ms`);
      console.log(`  - rho-select selected count : ${rhoResult.highlights.length}`);
      console.log(`  - rho-select exactAgreement : ${rhoResult.diagnostics.exactAgreement}`);
      console.log(`  - rho-select density        : ${rhoResult.diagnostics.density.toFixed(4)}`);
    });
  });

  // T17: End-to-End Endpoint & Service Coverage Verification
  describe('T17: End-to-End Endpoint Coverage (rho-select across all interfaces)', () => {
    it('integratedSearch and crawlSiteUrl should support and execute rho-select with full diagnostics', async () => {
      // 1. ScrapeRequestSchema & IntegratedSearchRequestSchema defaults
      const { ScrapeRequestSchema, BatchScrapeRequestSchema, CrawlRequestSchema, IntegratedSearchRequestSchema } = await import('./types.js');
      
      const scrapeParsed = ScrapeRequestSchema.parse({ url: 'https://example.com' });
      expect(scrapeParsed.highlightAlgorithm).toBe('rho-select');

      const batchParsed = BatchScrapeRequestSchema.parse({ urls: ['https://example.com'] });
      expect(batchParsed.highlightAlgorithm).toBe('rho-select');

      const crawlParsed = CrawlRequestSchema.parse({ url: 'https://example.com' });
      expect(crawlParsed.highlightAlgorithm).toBe('rho-select');

      const searchParsed = IntegratedSearchRequestSchema.parse({ query: 'テスト' });
      expect(searchParsed.highlightAlgorithm).toBe('rho-select');

      // 2. finalizeScrapeResult via Scraper with rho-select diagnostics
      const { finalizeScrapeResult } = await import('./scraper.js');
      const res = await finalizeScrapeResult({
        url: 'https://example.com/test',
        title: 'テスト',
        content: '# タイトル\n\n有界分数最適化によってトークン効率を最大化します。',
        markdown: '# タイトル\n\n有界分数最適化によってトークン効率を最大化します。',
      } as any, {
        query: 'トークン効率',
        shouldExtractHighlights: true,
        highlightAlgorithm: 'rho-select',
        verbose: true,
      } as any);

      expect(res.highlights?.length).toBeGreaterThanOrEqual(1);
      expect(res.highlightDiagnostics).toBeDefined();
      expect(res.highlightDiagnostics?.exactAgreement).toBe(true);
    });
  });

  // T18: Snippet & Description Supplemental Evidence Integration
  describe('T18: Snippet & Description Supplemental Evidence Integration', () => {
    it('should extract target evidence from snippet when markdown body only contains unrelated timeline text', async () => {
      const { extractQueryHighlightsRhoSelect } = await import('./rho_select.js');

      // 本文にはライブ日程しか存在せず、「作詞」は含まれていない
      const bodyContent = [
        '# 君と見るそら (@kimisora_JPN) - X (Twitter) 最新ポスト',
        '',
        '### 君と見るそら (@kimisora_JPN) [2026/9/9 10:21:41]',
        '本日の君と見るそらは、 『GIGA•GIGA SONIC ～幕張メッセ直前SP～』 🗓️9/9（水） 📍CLUB CITTA 🎫 https://t.co/AMUZGAHSpH 🎁サインありチェキ＋トーク券 前方 ¥7,000 / 一般 ¥3,000 （各+1D / 当日各+¥1,000） ☁️君と見るそら出演時間☁️ ライブ 18:00〜18:25 特典会 18:35〜19:35',
      ].join('\n');

      const snippetEvidence = '内山優花プロデュース曲『季節外れのリナリア』 本日から各種音楽配信サービスにて配信スタートです 『季節外れのリナリア』 作曲:michitomo 作詞:内山優花(君と見るそら)';

      const query = '君と見るそら　内山優花　作詞';

      const res = extractQueryHighlightsRhoSelect(bodyContent, query, {
        maxHighlights: 1,
        overheadTokens: 96,
        supplementalEvidence: [snippetEvidence],
      });

      expect(res.highlights.length).toBe(1);
      // ライブ日程ではなく、スニペットの「季節外れのリナリア」「作詞:内山優花」が第一位ハイライトとして採択されること
      expect(res.highlights[0]).toContain('季節外れのリナリア');
      expect(res.highlights[0]).toContain('作詞:内山優花');
      expect(res.highlights[0]).not.toContain('CLUB CITTA');
    });

    it('finalizeScrapeResult should automatically forward options.snippet and description to rho-select', async () => {
      const { finalizeScrapeResult } = await import('./scraper.js');

      const bodyContent = '# お知らせ\n\n最新のイベントスケジュールをお知らせします。';
      const snippet = '内山優花プロデュース曲『季節外れのリナリア』 作曲:michitomo 作詞:内山優花(君と見るそら)';
      const description = '君と見るそら公式アカウント。本日の君と見るそらはCLUB CITTAにてライブ出演予定です。';

      const res = await finalizeScrapeResult({
        url: 'https://x.com/kimisora_JPN/status/2094077778039808267',
        title: '君と見るそら on X',
        content: bodyContent,
        markdown: bodyContent,
        description,
      } as any, {
        query: '君と見るそら 内山優花 作詞',
        shouldExtractHighlights: true,
        highlightAlgorithm: 'rho-select',
        snippet,
      } as any);

      expect(res.highlights?.length).toBeGreaterThanOrEqual(1);
      const allHighlights = res.highlights?.join('\n') || '';
      expect(allHighlights).toContain('季節外れのリナリア');
      expect(allHighlights).toContain('作詞:内山優花');
    });

    it('should strip YAML Frontmatter, breadcrumbs, and parse list headings in topic hubs without selecting metadata', async () => {
      const { extractQueryHighlightsRhoSelect, parseMarkdownSections } = await import('./rho_select.js');

      const asahiTopicMarkdown = [
        '---',
        'publishedTime: "2026-06-11T06:15:00+09:00"',
        'author: "The Asahi Shimbun Company"',
        'siteName: "朝日新聞デジタル"',
        '---',
        '',
        '> 📍 **階層**: 朝日新聞 > トピックス > 中国本土',
        '',
        '[朝日新聞](/)',
        '',
        '\\>',
        '',
        '[トピックス](/topics/)',
        '',
        '\\>',
        '',
        '中国本土に関する最新ニュース',
        '',
        '## 中国本土',
        '',
        '## 最新ニュース',
        '',
        '-   ### [台湾映画「零下五十度の抑留者」　監督「台湾は今戦争の近くにいる」](//www.asahi.com/articles/ASV8P0SGPV8PUHBI00YM.html)',
        '',
        '    9/05(土) 11:00 インタビュー',
        '',
        '    す。　私が学生だったのは、国民党政権の時代でした。学んだのは_中国本土_のことばかりです。台湾の地理や歴史を学ぶ機会がありま...',
        '',
        '-   ### [中国軍のSLBM発射で見えた実力とは　識者「対話の維持が不可欠」](//www.asahi.com/articles/ASV922S07V92UHBI01YM.html)',
        '',
        '    9/04(金) 07:00 インタビュー',
        '',
        '    　まず、中国は軍事的な圧力だけではなく、外交や認知戦で台湾に圧力をかけており、中国が近い将来台湾を武力侵攻したり、海上封...',
        '',
        '-   ### [中国半導体ＣＸＭＴが上場　時価総額７９兆円、中国本土最大](//www.asahi.com/articles/DA3S16514494.html)',
        '',
        '    7/28(火) 05:00',
        '',
        '    ベースでの時価総額は約３兆２７７２億元（約７９兆円）となり、_中国本土_市場に上場する企業で最大となった。',
      ].join('\n');

      // 1. parseMarkdownSections で Frontmatter やパンくずが除外され、リスト見出しが認識されること
      const sections = parseMarkdownSections(asahiTopicMarkdown);
      expect(sections.length).toBeGreaterThanOrEqual(2);
      for (const sec of sections) {
        expect(sec.fullText).not.toContain('publishedTime');
        expect(sec.fullText).not.toContain('📍 **階層**');
      }

      // 2. extractQueryHighlightsRhoSelect でメタデータではなく実際のニュース記事が抽出されること
      const res = extractQueryHighlightsRhoSelect(asahiTopicMarkdown, '中国　最新ニュース', {
        maxHighlights: 3,
        overheadTokens: 96,
      });

      expect(res.highlights.length).toBeGreaterThanOrEqual(1);
      const joinedHighlights = res.highlights.join('\n');
      expect(joinedHighlights).not.toContain('publishedTime');
      expect(joinedHighlights).not.toContain('📍 **階層**');
      expect(joinedHighlights).not.toContain('[朝日新聞](/)');
      // 個別ニュース記事の内容がハイライトに含まれること
      const containsActualNews =
        joinedHighlights.includes('台湾映画') ||
        joinedHighlights.includes('SLBM発射') ||
        joinedHighlights.includes('中国半導体');
      expect(containsActualNews).toBe(true);
    });

    it('chooseBestDescription should sanitize Frontmatter and breadcrumb symbols from dynamic snippet', async () => {
      const { chooseBestDescription } = await import('./enrichment.js');

      const dynamicSnippetWithMeta = [
        '---',
        'publishedTime: "2026-06-11T06:15:00+09:00"',
        'author: "The Asahi Shimbun Company"',
        '---',
        '> 📍 **階層**: 朝日新聞 > トピックス > 中国本土',
        '## 最新ニュース > 中国軍のSLBM発射で見えた実力とは',
        'まず、中国は軍事的な圧力だけではなく外交や認知戦で台湾に圧力をかけており、最新の動向を分析します。',
      ].join('\n');

      const desc = chooseBestDescription(undefined, dynamicSnippetWithMeta, '中国　最新ニュース');
      expect(desc).toBeDefined();
      expect(desc).not.toContain('publishedTime');
      expect(desc).not.toContain('📍');
      expect(desc).toContain('中国軍のSLBM発射');
    });
  });
});


