/**
 * Sora Evidence Compiler Research — Benchmark Fixtures
 *
 * NOTE: This is a research-only module.
 * Provides precision, structural, adversarial, and synthetic evaluation corpora.
 */

export interface BenchmarkTestCase {
  id: string;
  category: 'precision' | 'structural' | 'adversarial' | 'synthetic';
  title: string;
  query: string;
  markdown: string;
  supplementalEvidence?: string[];
  /** Substrings that MUST appear in the selected evidence to count as recall success */
  requiredKeywords: string[];
  /** Substrings that represent misleading/irrelevant distractor context */
  distractorKeywords?: string[];
  /** Does this case test structural closure (e.g. table header present if row selected)? */
  requiresStructuralClosure?: {
    type: 'table' | 'footnote' | 'heading-path';
    closureAssertion: (highlights: string[]) => boolean;
  };
}

// -----------------------------------------------------------------------------
// 1. Existing Precision Fixtures
// Real-world Sora idol/event evaluation targets
// -----------------------------------------------------------------------------

export const PRECISION_FIXTURES: BenchmarkTestCase[] = [
  {
    id: 'precision-solairo-call',
    category: 'precision',
    title: '君と見るそら ソライロ コール',
    query: '君と見るそら ソライロ コール',
    markdown: `
# 君と見るそら 楽曲コール表

アイドルグループ「君と見るそら」の代表曲コールガイドです。

## ソライロ

イントロ: (あー！ジャージャー！バリバリ！タイガー！ファイヤー！)
澄み渡る空へと 手を伸ばした瞬間に (超絶可愛い！優花！)

Aメロ:
いつも通りの帰り道 (オー！フッフー！)
君の笑顔が揺れていた

サビ:
ソライロの風に乗って どこまでも飛べるよ
(イエッタイガー！)

## 青空ダイアリー

イントロ: スタンダードMIX
サビでのコールはクラップ中心となります。
`,
    requiredKeywords: ['ソライロ', '超絶可愛い！優花！', 'イエッタイガー！'],
    distractorKeywords: ['青空ダイアリー', 'スタンダードMIX'],
  },
  {
    id: 'precision-linaria-lyricist',
    category: 'precision',
    title: '君と見るそら 季節外れのリナリア 作詞者',
    query: '君と見るそら 季節外れのリナリア 作詞者',
    markdown: `
# 君と見るそら ディスコグラフィー

## シングル一覧

### 1st Single: ソライロ
- 発売日: 2024年4月1日
- 作詞: 佐藤美咲
- 作曲: 田中健一

### 2nd Single: 季節外れのリナリア
- 発売日: 2024年10月15日
- 作詞者

内山優花

- 作曲者: 高橋涼
- 編曲: 鈴木大輔

初冬の切ない恋心を歌ったミディアムバラード。内山優花が初めて単独で作詞を手掛けた意欲作。

### 3rd Single: 冬空のプロミス
- 発売日: 2025年1月20日
- 作詞: 中村葵
- 作曲: 田中健一
`,
    requiredKeywords: ['季節外れのリナリア', '作詞者', '内山優花'],
    distractorKeywords: ['佐藤美咲', '中村葵', '冬空のプロミス'],
  },
  {
    id: 'precision-spark-appearance-time',
    category: 'precision',
    title: '君と見るそら 山中湖 spark 出演時間',
    query: '君と見るそら 山中湖 spark 出演時間',
    markdown: `
# SPARK 2024 in YAMANAKAKO タイムテーブル

山中湖交流プラザ きららにて開催される大型アイドルフェス「SPARK 2024」のステージ詳細です。

## 7月13日(土) SPARK STAGE
- 10:00 - 10:20 オープニングアクト
- 10:30 - 11:00 虹色の飛行少女
- 11:15 - 11:45 Appare!

## 7月14日(日) BOTAN STAGE
- 12:00 - 12:25 パラディーク
- 12:40 - 13:05 君と見るそら (出演時間 12:40〜13:05 特典会 13:30〜14:30)
- 13:20 - 13:45 手羽先センセーション

## 7月15日(月祝) KIKU STAGE
- 15:00 - 15:30 真夏のシンフォニー
`,
    requiredKeywords: ['君と見るそら', '12:40', '13:05', 'BOTAN STAGE'],
    distractorKeywords: ['7月13日', '虹色の飛行少女', 'KIKU STAGE'],
  },
];

// -----------------------------------------------------------------------------
// 2. Structural Fixtures
// Tables, Footnotes, Repeated Headings, Label-Values, Blank-line Lists
// -----------------------------------------------------------------------------

export const STRUCTURAL_FIXTURES: BenchmarkTestCase[] = [
  {
    id: 'structural-table-closure',
    category: 'structural',
    title: 'テーブル行＋ヘッダーの構造閉包',
    query: '有明アリーナ 収容人数 キャパシティ',
    markdown: `
# 関東主要アリーナ会場一覧

イベントやコンサートで使用される主要大型施設のキャパシティ比較表です。

| 会場名 | 所在地 | 最大収容人数 | 開業年 |
| :--- | :--- | :--- | :--- |
| 横浜アリーナ | 神奈川県横浜市 | 17,000人 | 1989年 |
| さいたまスーパーアリーナ | 埼玉県さいたま市 | 37,000人 | 2000年 |
| 有明アリーナ | 東京都江東区 | 15,000人 | 2020年 |
| 日本武道館 | 東京都千代田区 | 14,471人 | 1964年 |
| 国立代々木競技場第一体育館 | 東京都渋谷区 | 13,291人 | 1964年 |

各会場の予約状況や利用料金は公式サイトをご確認ください。
`,
    requiredKeywords: ['有明アリーナ', '15,000人'],
    requiresStructuralClosure: {
      type: 'table',
      closureAssertion: (highlights) => {
        return highlights.some((h) => h.includes('会場名') && h.includes('最大収容人数') && h.includes('有明アリーナ'));
      },
    },
  },
  {
    id: 'structural-footnote-closure',
    category: 'structural',
    title: '脚注定義との構造閉包',
    query: 'プロジェクトS 最終予算 特例措置',
    markdown: `
# 2025年度 第3四半期 事業報告

## プロジェクトS 推進状況

当期において、プロジェクトSの研究開発費は当初計画の1.5倍に拡大しました。
ただしこれらは技術革新のための戦略的投資であり、最終予算[^1]の執行には政府の特例措置[^2]が適用されています。
次世代半導体の量産化に向けたロードマップは極めて順調です。

## その他のプロジェクト

プロジェクトMおよびプロジェクトKについては計画通りの進捗を示しています。

---
[^1]: 最終予算額は監査前暫定値で約450億円。
[^2]: 先端半導体振興法に基づく第4条特例減税措置。
`,
    requiredKeywords: ['プロジェクトS', '特例措置', '先端半導体振興法に基づく第4条特例減税措置'],
    requiresStructuralClosure: {
      type: 'footnote',
      closureAssertion: (highlights) => {
        return highlights.some((h) => h.includes('[^2]') && h.includes('先端半導体振興法に基づく第4条特例減税措置'));
      },
    },
  },
  {
    id: 'structural-repeated-leaf-heading',
    category: 'structural',
    title: '同名リーフ見出しの階層アドレス保持',
    query: 'Type-C モデル スペック 充電速度',
    markdown: `
# 新型モバイルバッテリー製品仕様

## Pro Edition (Type-A/Type-C)

### スペック
- バッテリー容量: 20,000mAh
- 充電速度: 最大65W 急速充電 (PD 3.0)
- 重量: 380g

## Lite Edition (Micro-USB)

### スペック
- バッテリー容量: 5,000mAh
- 充電速度: 最大10W 通常充電
- 重量: 120g
`,
    requiredKeywords: ['Pro Edition', 'スペック', '最大65W'],
    distractorKeywords: ['5,000mAh', '最大10W'],
    requiresStructuralClosure: {
      type: 'heading-path',
      closureAssertion: (highlights) => {
        return highlights.some((h) => h.includes('Pro Edition') && h.includes('スペック'));
      },
    },
  },
  {
    id: 'structural-label-value-split',
    category: 'structural',
    title: '空行区切りラベル値リストの分断防止',
    query: '技術開発本部 責任者 部長 氏名',
    markdown: `
# 会社組織体制一覧

## 技術開発本部

次世代プラットフォームの研究開発を統括する基幹部門です。

- 部門責任者

鈴木 一朗

- 主な研究領域:
  分散型データストレージおよびエッジAI推論基盤。
`,
    requiredKeywords: ['技術開発本部', '部門責任者', '鈴木 一朗'],
  },
  {
    id: 'structural-code-block',
    category: 'structural',
    title: 'コードブロックの保護と閉包',
    query: 'computeTokenBudget typescript 実装コード',
    markdown: `
# トークン割り当てアルゴリズム

## 実装概要

以下の関数でトークンバジェットを動的に計算します。

\`\`\`typescript
export function computeTokenBudget(contextWindow: number, reserveRatio: number = 0.2): number {
  if (contextWindow <= 0) return 0;
  const reserved = Math.floor(contextWindow * reserveRatio);
  return contextWindow - reserved;
}
\`\`\`

この計算はすべてのリクエスト開始時に同期実行されます。
`,
    requiredKeywords: ['computeTokenBudget', 'reserveRatio', 'contextWindow - reserved'],
  },
];

// -----------------------------------------------------------------------------
// 3. Adversarial Fixtures
// Irrelevant tables, small target in long page, conflicting dates, supplemental snippet
// -----------------------------------------------------------------------------

export const ADVERSARIAL_FIXTURES: BenchmarkTestCase[] = [
  {
    id: 'adversarial-irrelevant-huge-table',
    category: 'adversarial',
    title: '無関係な巨大テーブルの妨害排除',
    query: 'サイバーセキュリティ方針 責任役員 CISO',
    markdown: `
# 企業統治およびセキュリティ管理

## 全社セキュリティ管理体制

当社のサイバーセキュリティ方針における最高責任者は、CISOである常務取締役の神田英樹です。すべてのインシデント報告は神田CISOの直轄チームに集約されます。

## 参考資料: 過去5年間の全国IT機器出荷統計

| 年 | パソコン (千台) | スマートフォン (千台) | サーバー (千台) | その他ネットワーク機器 (千台) | セキュリティアプライアンス (千台) | 前年比 (%) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 2020 | 15,200 | 32,500 | 540 | 1,200 | 310 | +4.2 |
| 2021 | 14,800 | 33,100 | 560 | 1,250 | 330 | +2.8 |
| 2022 | 13,900 | 31,400 | 580 | 1,310 | 360 | -1.5 |
| 2023 | 14,200 | 32,000 | 610 | 1,380 | 390 | +1.9 |
| 2024 | 14,500 | 32,800 | 640 | 1,420 | 420 | +2.4 |
| 2025 | 14,900 | 33,400 | 670 | 1,460 | 450 | +2.1 |
`,
    requiredKeywords: ['CISO', '神田英樹'],
    distractorKeywords: ['パソコン (千台)', 'スマートフォン (千台)', '15,200', '32,500'],
  },
  {
    id: 'adversarial-conflicting-dates',
    category: 'adversarial',
    title: '延期・変更された複数日付の最新真実選定',
    query: '新社屋移転日 正式 確定日 2026年',
    markdown: `
# 本社移転プロジェクト進捗状況

## 移転スケジュールの変遷

- 当初予定: 2025年11月1日を予定していましたが、内装工事の遅れにより延期となりました。
- 第2案: 2026年1月15日への変更を検討しましたが、基幹ネットワーク敷設の都合上再調整を行いました。
- 最終確定: 取締役会で正式決定された確定移転日は **2026年3月22日(日)** です。業務開始は3月23日(月)となります。
`,
    requiredKeywords: ['正式決定された確定移転日', '2026年3月22日'],
  },
  {
    id: 'adversarial-supplemental-snippet-only',
    category: 'adversarial',
    title: '本文に答えがなく補完スニペットのみに正解があるケース',
    query: 'ソラカフェ 営業時間 定休日',
    markdown: `
# ソラカフェ 公式ホームページへようこそ

こだわりの自家焙煎珈琲と手作りスイーツをお届けする街角の小さなカフェです。
現在、新メニュー「季節のフルーツタルト」の準備を進めています。
皆様のご来店を心よりお待ちしております。
`,
    supplementalEvidence: [
      '【公式】ソラカフェ - 営業時間: 10:00〜19:00（L.O. 18:30） 定休日: 毎週火曜日・第3水曜日。駐車場4台完備。',
    ],
    requiredKeywords: ['営業時間: 10:00〜19:00', '定休日: 毎週火曜日'],
  },
];

// -----------------------------------------------------------------------------
// 4. Synthetic Documents Generator
// Small (~2KB), Medium (~20KB), Large (~100KB), XLarge (~500KB)
// -----------------------------------------------------------------------------

export function generateSyntheticMarkdown(targetBytes: number): {
  markdown: string;
  targetQuery: string;
  targetAnswer: string;
} {
  const targetAnswer = `確定識別キー: SORA-RESEARCH-UUID-98214`;
  const targetQuery = 'SORA-RESEARCH-UUID-98214 確定識別キー';

  let current = `# 合成ドキュメント (目標サイズ: ${targetBytes} bytes)\n\n`;
  current += `このドキュメントは、Evidence Compiler の性能・メモリ・計算量を測定するための合成データです。\n\n`;

  // Place target answer near the middle
  const targetInsertionRatio = 0.5;
  let targetInserted = false;

  let sectionCounter = 1;

  while (Buffer.byteLength(current, 'utf8') < targetBytes) {
    const currentBytes = Buffer.byteLength(current, 'utf8');

    if (!targetInserted && currentBytes >= targetBytes * targetInsertionRatio) {
      current += `## セクション ${sectionCounter}: 重要インデックスデータ\n\n`;
      current += `ここに厳密な正解データが配置されています。\n`;
      current += `- 識別情報: ${targetAnswer}\n`;
      current += `- 登録日時: 2026-09-18T12:00:00Z\n\n`;
      targetInserted = true;
      sectionCounter++;
      continue;
    }

    const mode = sectionCounter % 3;
    if (mode === 0) {
      // Paragraph section
      current += `## セクション ${sectionCounter}: 業務ログと一般的な運用手順\n\n`;
      current += `システムモニタリングの定期巡回を実施しました。各ノードのCPU使用率は平穏に推移しており、異常なトラフィックバーストは検知されていません。\n`;
      current += `定期的なキャッシュクリーンアップおよびデータベースの統計情報更新を推奨します。運用チームは週次レビューを実施してください。\n\n`;
    } else if (mode === 1) {
      // Table section
      current += `## セクション ${sectionCounter}: リソースメトリクス一覧\n\n`;
      current += `| ノード番号 | ホスト名 | CPU負荷 (%) | メモリ使用率 (%) | ネットワーク帯域 (Gbps) |\n`;
      current += `| :--- | :--- | :--- | :--- | :--- |\n`;
      for (let r = 1; r <= 5; r++) {
        current += `| node-${sectionCounter}-${r} | app-worker-${r}.internal | ${20 + r * 3} | ${45 + r * 2} | ${1.2 + r * 0.1} |\n`;
      }
      current += `\n`;
    } else {
      // List section
      current += `## セクション ${sectionCounter}: 運用チェックリスト項目\n\n`;
      for (let l = 1; l <= 6; l++) {
        current += `- 項目 ${sectionCounter}.${l}: セキュリティパッチの適用状況確認 (ホスト #${l})\n`;
      }
      current += `\n`;
    }
    sectionCounter++;
  }

  if (!targetInserted) {
    current += `## 最終セクション: 重要インデックスデータ\n\n`;
    current += `- 識別情報: ${targetAnswer}\n\n`;
  }

  return { markdown: current, targetQuery, targetAnswer };
}

export function getAllBenchmarkTestCases(): BenchmarkTestCase[] {
  return [
    ...PRECISION_FIXTURES,
    ...STRUCTURAL_FIXTURES,
    ...ADVERSARIAL_FIXTURES,
  ];
}
