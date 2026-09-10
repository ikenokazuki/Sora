# ρSelect v2 (Canonical Engine) — LLMハンドオーバー仕様書 & 実運用レポート

> **対象読者**: LLMエージェント、プロンプト設計者、RAG基盤開発者、監査担当者  
> **目的**: SoraのWebハイライト選択エンジン「ρSelect v2」の数学的保証、実装差異、ベンチマーク実測値、深層エビデンス駆動リランキング、およびAPI入出力仕様を完全把握し、実運用での意思決定に活用すること。  
> **改定履歴**:  
> - v1.0 (2026-09-10): Canonical ρSelect v2 初期実装と実運用測定結果  
> - v1.1 (2026-09-10): 外部監査レポート（v0.35）指摘に基づく理論・数値・ライセンス表記の完全是正、1,000 seeds ストレス回帰テストの導入、深層エビデンス駆動リランキング（Evidence-Aware Final Reranking）およびリスト構造保護パースの追加

---

## 1. エグゼクティブ・サマリー (Why ρSelect v2?)

Soraは、Webスクレイピングおよび検索結果からLLMに必要な証拠パッセージを抽出するエンジンとして、従来の **Legacy ρSelect (`rho-select`)** から、最新の **Canonical ρSelect v2 (`rho-select-v2`)** への移行を実施しました。

### 正確な技術比較

| 評価指標 | 旧 Legacy ρSelect | 新 ρSelect v2 (Canonical) | 実運用におけるメリット |
| :--- | :--- | :--- | :--- |
| **問題設定と最適性** | 二値化 feature-mask 表現と $|S| \le K$ 制約の下で **Exact DP により大域最適化** | 連続的な max-evidence state と hard $K$ を必須としない **Canonical Objective に対して Exact または AR で大域最適化** | 局所スコアの階調情報を保ちつつ、任意要件数・制約なしで大域最適解を導出 |
| **証拠表現** | 0/1 の二値特徴マスク | **連続値 $r_{it} \in [0, 1]$** | 微細な適合度の差異やキーワード含有率を正確に評価 |
| **基数制約** | 候補集合の上限制約 $|S| \le K$（デフォルト $K=3$） | **Canonical Unconstrained**（ハード上限なし） | 単一セクションで十分なら1件のみ、多面的情報なら必要最小件数を自然選出 |
| **実測レイテンシ** | 9.61 ms（代表記事） | **1.89 ms（約 5.1 倍 高速、代表記事）** | 検索・スクレイピングAPIのトータル応答速度が劇的に向上 |
| **トークン効率** | $|S| \le K$ 制約下での選択 | **真の最高密度部分集合のみ選出** | LLMの入力トークンを **約 33.8% 削減**（代表例実測） |
| **最適性証明書** | なし（内部ベリファイアのみ） | **数学的証明書 (`certificate`)** | 各クエリごとに下界・上界・相対ギャップ（$LB \le \rho^* \le UB$）を明示返却 |
| **探索空間の圧縮** | 全状態展開 | **Safe Dominance 剪定** | 劣後候補を事前パージし、状態数を約 **22.7 倍削減 (95.59% 削減)** |

> [!NOTE]
> **基数制約に関する補足**:  
> 旧 Legacy の $K=3$ は「3件選ばせる制約」ではなく上限制約（$|S| \le 3$）です。ただし、旧実装では最適解の候補集合が $|S| \le K$ に制約されるため、$K$ より多い補完的証拠を必要とする問い合わせを表現できない場合がありました。一方、新 v2 Canonical Mode は hard cardinality cap を前提とせず、分数目的関数の性質から自然に最適部分集合サイズが決定されます。

---

## 2. 外部監査指摘（v0.35）に基づく設計差異・設定の完全開示

本実装は、公式仕様書 **『Sora向け ρSelect v2 — Gemini実装指示書 v1.0』** および外部監査レポート **『ρSelect v2 Sora実装監査 v0.35』** に厳密に準拠し、以下の通り理論と運用設定を明確に分離して設計・実装されています。

### ① `exactSubsetThreshold = 20,000` は Sora Operational Guard
- **指示書デフォルト**: `50,000`
- **Sora 本番デフォルト**: `20,000`
- **位置づけ**: **Sora production guard / dispatch policy の変更であり、Canonical Theory や目的関数の変更ではない**。
- **理由**: Web サーバーの高並行リクエスト環境下において、CPU スパイクおよび過剰メモリ消費を未然に防止するためのプロダクト防御設定です。
- **整合性検証**: 同一クエリに対して threshold を 50,000（Exact）とした場合と 20,000（AR）とした場合で、AR の証明書許容誤差（$\epsilon = 0.05$）以内で解が整合することをプロパティテストで確認済みです。

### ② 1,000 Seeds ストレス回帰テストスイートの導入
- **二層テスト構成**:
  1. `bun test`: 日常の開発・CI用の高速単体テスト（50 seeds, 所要時間約 150ms）
  2. `bun run test:rho-v2-stress`: 研究・公開グレードの決定論的 1,000 seeds ストレス回帰テスト（所要時間約 200ms）
- **1,000 seeds テストの検証項目**:
  1. **Exact vs Brute-force**: 300 seeds で全探索と完全一致（$N \le 9, M \le 3$）
  2. **AR Bounds**: 300 seeds で $LB \le \text{optimum} \le UB$ および $\text{relativeGap} \le \epsilon$ を確認
  3. **Exact Convergence**: 150 seeds で $\epsilon = 0$ 時に真の最適値へ完全収束
  4. **Dominance 不変性**: 剪定有効/無効で目的関数値 $\rho^*$ が完全一致
  5. **Edge Cases**: 150 seeds で同点候補（Ties）、完全重複候補、極端な $\tau$（$0.01$ および $10,000$）での安定性確認
  6. **Fail-Closed & リソースガード**: 100 seeds で全ゼロ証拠、NaN/Infinity 入力拒否、リソース超過時の偽証明書不発行（valid=false / 即時例外）を網羅

### ③ Sora Operational Scorer と研究用 Scorer の分離
- **Sora 実装の局所スコア**:
  - BM25+ 式: $k_1 = 1.2, \delta = 0.5, w_{\text{heading}} = 1.5, w_{\text{body}} = 1.0$
  - 要件ごとの最大値正規化: $r_{it} = \frac{\text{rawScore}_{it}}{\max_k \text{rawScore}_{kt}}$
- **位置づけ**: これは **Sora Operational Scorer** であり、論文実験（MuSiQue fielded scorer $0.75 \times \text{title+body} + 0.25 \times \text{title}$ や HotpotQA）のスコアパイプラインとは区別されます。Optimizer Engine 自体は完全にスコア不可知（Score-Agnostic）です。

### ④ `tau = 96` は Sora Operational Default
- **位置づけ**: $\tau$ は効用とトークンコストのトレードオフを制御する正のハイパーパラメータであり、普遍的な定数ではありません。Sora の Web 検索・スクレイピングにおける実務的なデフォルト値として $\tau = 96$ を採用しています。

### ⑤ 状態圧縮比率とレイテンシ高速化の数値分離
- **状態数削減比率**: Dominance 剪定により、$n=80, m=2$ Dense 問題において状態数が 1,678 states から 74 states へ減少。これは **22.68 倍の状態数削減（95.59% 削減、残存状態率 4.41%）** です。
- **レイテンシ高速化**: 同一問題における実行時間が 28.63 ms から 0.55 ms へ短縮（**約 52.05 倍 高速化**）。

### ⑥ 証明書（Certificate）の厳密な解釈と非保証範囲
> [!IMPORTANT]
> **証明書が保証する範囲と非保証範囲**:  
> `certificate.valid = true` は、**「与えられたスコア行列 $R$、効用関数 $\Phi$、トークンコスト $C$、およびパラメータ $\tau$ の下で、採択された部分集合 $S$ の目的関数値 $\rho_\tau(S)$ が大域最適値に対して証明された範囲内にあること」** のみを数学的に証明します。  
> 実世界の情報量、事実性（Factuality）、回答の正しさ、情報の十分性は**一切保証しません**。

### ⑦ `highlightMaxCount`（ハード K）指定時の安全なポストトランケーション
- 既存クライアントの後方互換性のため、`highlightMaxCount` が指定された場合も例外でクラッシュさせず、まず Canonical Unconstrained Mode で大域最適解 $S^*$ を算出します。
- $|S^*| > \text{highlightMaxCount}$ の場合のみ、スコア上位件数へ安全にスライスします。
- **虚偽証明書の排除**: 指示書 第17条の禁止事項（「truncateしたのに同じ証明書を返す」）に厳格に準拠し、スライスが行われた場合は `certificate.postProcessed = true` を設定し、`warning` を付与します。

### ⑧ ライセンス表記の整合
- **ライセンス**: **Business Source License 1.1 (BUSL-1.1)**
- **Change License**: MIT on 2030-08-01.

---

## 3. 実運用における重要改善: 深層エビデンス駆動リランキング & パース保護

実クエリ（例: `君と見るそら 季節外れのリナリア 作詞者`）の運用検証において発見された課題を解決するため、以下の 2 つの重要な基盤強化を実施しました。

### 3.1 深層エビデンス駆動リランキング (Evidence-Aware Final Reranking)

#### 【発生していた課題（偽陽性の問題）】
従来の統合検索（`integratedSearch`）では、外部検索エンジン（Yahoo等）から返された短文スニペットに対して BM25+ リランキングを行っていました。  
しかし、検索エンジンが合成したスニペットにたまたま別文脈の単語（例: 別アーティストの紹介文で「ほとんどの曲の作詞を手がけ…」という文脈）が含まれていた場合、**本文中には「作詞者」が一切存在しない記事（THE MAGAZINE）が 1 位に評価されてしまう偽陽性（False Positive）** が発生していました。  
深層スクレイピングによって本文とハイライトを取得した後も、最終順位にその証拠性がフィードバックされていませんでした。

#### 【解決策とアルゴリズム】
スクレイピング完了後、各候補の本文（`markdown`）および ρSelect v2 ハイライト（`highlights` / `highlightItems`）を解析し、以下の多層エビデンス信号で最終順位を再評価・適正化する `rerankByDeepEvidence` を導入しました：

1. **クエリ単語カバレッジ（Coverage）**:
   - クエリを構成する重要単語群が、本文およびハイライトにどれだけ含まれているか（網羅率）。
   - 全単語が完全充足（100% カバレッジ）されている候補に大きなボーナス（+12.0 / +8.0 点）。
2. **意図キーフレーズ（末尾語・特異語）の検証**:
   - クエリの末尾語（例: `作詞者`）など、ユーザーの具体的意図を示す重要語が本文またはハイライトに存在するかを検証。存在しない場合はペナルティ（-8.0 点）。
3. **ρSelect v2 ハイライトスコアの統合**:
   - ハイライト最上位スコア（`highlightItems[0]?.score`）を加算し、本文内にクエリと密接な証拠段落が存在するドキュメントを優遇。
4. **欠陥・エラーペナルティ**:
   - スクレイピング失敗（`scrapeError`）やスニペットフォールバックのドキュメントを適切に減点。

#### 【実クエリでの検証結果】
- **クエリ**: `{"query": "君と見るそら 季節外れのリナリア 作詞者", "extractHighlights": true}`
- **改善前**: 1位が THE MAGAZINE（作詞者の記載なし）、2位が LinkCore（作詞者：内山優花 の記載あり）
- **改善後**: 
  - **1位**: LinkCore（`linkco.re/PNzUz6Bm`）— 本文・ハイライトに「作詞者 内山優花」が完全に存在し、ハイライトスコア 0.98 で 1 位に正しく浮上。
  - **2位**: 歌詞・クレジット掲載ページ
  - **下位**: THE MAGAZINE（作詞者が本文に存在しないため降格）

---

### 3.2 Markdown リスト構造保護パース

#### 【発生していた課題】
歌詞ページや音楽配信サイトでは、クレジット情報が以下のような空行区切りインデントリストで記述されるケースが多発します：
```markdown
-   作詞者

    内山優花
```
従来の段落分割（`parseMarkdownSections`）では、空行（`\n\n`）を無条件にセクション境界として扱っていたため、「- 作詞者」という見出しラベルと「内山優花」という値が別々の段落に分断され、ρSelect がラベルのみ（または値のみ）を抽出してしまう問題がありました。

#### 【解決策】
`parseMarkdownSections` において、リストアイテムの開始行（`-   ...`）に続く空行後のインデント行（`    ...`）を検出し、同一のリスト項目として 1 つのセクションブロックに結合・保持する処理を追加しました。これにより、メタデータクレジットや定義リストの情報が不可分な証拠として完全に保持されます。

---

## 4. 数学的理論と目的関数

### 問題の定式化

候補セクション集合 $V = \{1, \dots, n\}$、各候補の正のトークンコスト $c_i > 0$、各要件に対する適合スコア $r_i \in [0, 1]^m$。  
採択集合 $S \subseteq V$ に対する要件 $t$ の実現証拠レベル：
$$y_t(S) = \max_{i \in S} r_{it}$$

効用関数 $\Phi(y)$（weighted-sum または grouped-min）に対し、オーバーヘッドトークン $\tau > 0$（Sora default: 96）を含む分数目的関数：
$$\max_{S \subseteq V} \rho_\tau(S) = \frac{\Phi(y(S))}{\tau + \sum_{i \in S} c_i}$$

### 最適性証明書（Certificate）の仕様
- **Exact DP**: $\text{lowerBound} = \text{upperBound} = \rho^*, \text{relativeGap} = 0.00\%$
- **Adaptive Refinement (AR)**: $\text{lowerBound} \le \rho^* \le \text{upperBound}, \text{relativeGap} \le \epsilon$
- **証明書のスコープ**: `score_defined_objective_only`

---

## 5. ベンチマーク実測値 (Linux x86_64, Bun v1.3)

> [!NOTE]
> 以下の数値は、指定された合成コーパスおよびニュース記事に対する **Illustrative Benchmark** です。

### 合成問題ベンチマーク ($n$: 候補数, $m$: 要件数)

| $n$ | $m$ | 疎密 | Dominance | ソルバー | 実行時間 (ms) | 状態数 | ギャップ | 採択数 |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 20 | 2 | Sparse | **ON** | Exact | **2.06** | 18 | **0.00%** | 2 |
| 20 | 2 | Dense | **ON** | Exact | **0.60** | 7 | **0.00%** | 1 |
| 20 | 4 | Sparse | **ON** | Exact | **0.24** | 24 | **0.00%** | 3 |
| 20 | 4 | Dense | **ON** | Exact | **1.75** | 310 | **0.00%** | 2 |
| 80 | 2 | Dense | **OFF** | Exact | **28.63** | 1,678 | **0.00%** | 1 |
| 80 | 2 | Dense | **ON** | Exact | **0.55** | 74 | **0.00%** | 1 |
| 80 | 4 | Dense | **ON** | AR | **85.80** | 771 | **1.43%** | 2 |
| 200 | 4 | Sparse | **ON** | AR | **16.86** | 177 | **4.51%** | 2 |

---

## 6. API 呼び出し & LLM向け診断情報活用ガイド

### API リクエスト例 (POST /search)

```json
{
  "query": "君と見るそら 季節外れのリナリア 作詞者",
  "formats": ["markdown"],
  "extractHighlights": true,
  "verbose": true
}
```

### レスポンス例 (`highlightDiagnostics`)

```json
{
  "engine": "rho-select-v2",
  "solver": "exact",
  "stateCount": 14,
  "selectedCount": 1,
  "selectedTokens": 18,
  "relativeGap": 0,
  "certificate": {
    "scope": "score_defined_objective_only",
    "valid": true,
    "solver": "exact",
    "lowerBound": 0.00859,
    "upperBound": 0.00859,
    "relativeGap": 0,
    "epsilon": 0.05,
    "exact": true,
    "iterations": 1,
    "postProcessed": false
  }
}
```

### LLM側での診断情報活用方法
1. **`certificate.valid === true` かつ `certificate.exact === true`**:
   - 与えられたスコア行列に対して厳密な大域最適解が選択されています。
2. **`certificate.postProcessed === true`**:
   - `highlightMaxCount` などにより事後スライスが行われたことを示します。
3. **`relativeGap <= 0.05`**:
   - AR ソルバーにより、大域最適値との誤差が高々 5% 以内であることが数学的に保証されています。

---

*Licensed under Business Source License 1.1. Change License: MIT on 2030-08-01.*
