# ρSelect v2 実装監査 v0.35 是正対応・新機能実装報告書 (LLM共有用)

> **対象**: 監査担当LLM / 外部レビュアー / システム設計者  
> **文書種別**: 監査レポート指摘是正・新機能実装・実機検証完了報告書  
> **対象リポジトリ**: Sora Web Fetcher (`ghcr.io/ikenokazuki/sora:latest`)  
> **参照監査レポート**: 『ρSelect v2 Sora実装監査 v0.35』(`media_1789026092732.md`)  
> **参照ハンドオーバー仕様書**: [docs/rho_select_v2_llm_handover.md](file:///home/ikeno/app/web-fetcher/docs/rho_select_v2_llm_handover.md)  
> **作成日**: 2026-09-10

---

## 1. 総合結論 & 是正サマリー

監査レポート v0.35 において提示された **判定: CONDITIONAL PASS** に対し、指摘された **全 Blocking 5項目および Major 6項目を完全是正** しました。  
さらに、実クエリ検証において判明した検索結果の偽陽性（スニペットのみの合致で本文に根拠がない記事が1位になる現象）を解消するため、**「深層エビデンス駆動リランキング（Evidence-Aware Final Reranking）」** および **「Markdown 空行区切りリスト構造保護パース」** を追加実装しました。

全 374 件の単体テスト（9,828 expect calls）および **1,000 決定論的シードによるストレス回帰テストスイート（4,588 expect calls）** がすべてエラーゼロで完走し、本番環境（ルートレス Podman コンテナ）への再デプロイと実機クエリ検証を完了しています。

---

## 2. 監査指摘事項（v0.35）への個別是正内容

### 2.1 Blocking 指摘の完全是正（5/5 完了）

| # | 指摘項目 | 是正前の問題表現 | 是正後の正確な技術記述・実装 | 該当ファイル |
| :---: | :--- | :--- | :--- | :--- |
| **B1** | **Legacy ρSelect の比較記述** | 「最適性保証なし」「ヒューリスティック走査」「全探索」 | **「二値化された feature-mask 表現と $|S| \le K$ 制約の下で Exact DP により大域最適化する手法」** と明確に位置づけ。新 v2 は連続的な max-evidence state と hard $K$ を必須としない Canonical Objective に対する大域最適化であると対比。 | `docs/rho_select_v2_llm_handover.md`<br>`docs/rho_select.md` |
| **B2** | **$K=3$ の制約解釈** | 「K=3 充足のため長文を抱き合わせる」「3件選ばせる制約」 | **「候補集合の上限制約 $|S| \le K$」** に是正。旧実装では $|S| \le K$ に制約されるため $K$ より多い補完証拠を必要とするクエリを表現できない場合があり、新 v2 はハード上限を前提とせず分数目的関数の性質から最適サイズが自然導出されると記述。 | `docs/rho_select_v2_llm_handover.md`<br>`docs/rho_select.md` |
| **B3** | **状態圧縮と高速化の数値混同** | 「状態数を最大 1/52 に圧縮」 | 数値を厳密に分離：<br>・**状態数圧縮**: $1,678 \to 74$ states（**約 22.68 倍 削減、95.59% 削減**、残存率 4.41%）<br>・**レイテンシ高速化**: $28.63 \text{ ms} \to 0.55 \text{ ms}$（**約 52.05 倍 高速化**） | `docs/rho_select_v2_llm_handover.md`<br>`docs/rho_select.md` |
| **B4** | **Certificate の保証範囲** | 「LLMは最も情報密度が高い部分集合であると確信して推論に用いることができる」 | **「指定された evidence score・utility・cost の下で、返却集合の objective value が大域最適値に対して証明された範囲内にあることのみを保証する。意味的妥当性、事実性（Factuality）、回答正しさ、情報十分性は一切保証しない」** と明記。 | `docs/rho_select_v2_llm_handover.md`<br>`docs/rho_select.md` |
| **B5** | **ライセンス表記の不一致** | `Released under the MIT License.` | リポジトリの [LICENSE](file:///home/ikeno/app/web-fetcher/LICENSE) に厳密に整合させ、**`Licensed under Business Source License 1.1. Change License: MIT on 2030-08-01.`** に修正。 | `docs/rho_select_v2_llm_handover.md`<br>`docs/rho_select.md` |

---

### 2.2 Major 指摘への対応（6/6 完了）

| # | 指摘項目 | 対応方針と実装内容 |
| :---: | :--- | :--- |
| **M6** | **`exactSubsetThreshold = 20,000` の位置づけ** | **Sora production guard / dispatch policy の変更であり、Canonical Theory や目的関数の変更ではない** ことを文書に明記。閾値 50,000（Exact）と 20,000（AR）で AR の証明書許容誤差（$\epsilon = 0.05$）以内で解が整合することをテストで確認。 |
| **M7** | **検証シード数の不足 (50 seeds)** | **研究・公開グレードの 1,000 決定論的シード（Mulberry32 PRNG）ストレス回帰テスト** [src/rho_select_v2_stress.test.ts](file:///home/ikeno/app/web-fetcher/src/rho_select_v2_stress.test.ts) を新規作成。<br>12項目（Exact vs Brute-force、AR Bounds、$\epsilon=0$ 収束、Dominance不変性、Ties、重複候補、極端な $\tau$、Grouped-min、Fail-closed、NaN拒否等）を網羅し、**全 4,588 assertions を 229ms で完走（Pass率 100%）**。`package.json` に `test:rho-v2-stress` を追加。 |
| **M8** | **Sora Scorer と研究用 Scorer の混同** | Sora の BM25+ 局所スコア（$k_1=1.2, \delta=0.5, w_{\text{heading}}=1.5, w_{\text{body}}=1.0$）は **Sora Operational Scorer** であり、論文実験（MuSiQue/HotpotQA）のスコアパイプラインとは別物である旨を明記。Optimizer Engine 自体は完全に Score-Agnostic（スコア不可知）であることを明文化。 |
| **M9** | **$\tau = 96$ の一般化** | $\tau$ は普遍的な最適定数ではなく、Sora の Web 検索・スクレイピングにおける **実務的なデフォルト設定（Sora operational default）** である旨を明記。 |
| **M10** | **ベンチマークの一般化** | 単一ニュース記事の実測値（1.89ms, 33.8% トークン削減）は **Illustrative Example** として位置づけ、ハードウェア（Linux x86_64）、ランタイム（Bun v1.3）、測定条件を明記。 |
| **M11** | **Legacy 廃止の判断主体** | Legacy の完全廃止は **Sora Product Decision** であることを明記。内部的には後方互換パス（`highlightAlgorithm: 'rho-select'`）を残し、回帰比較や旧動作の再現性を維持。 |

---

## 3. 実クエリ運用で追加実装した重要改善（新機能）

### 3.1 深層エビデンス駆動リランキング (Evidence-Aware Deep Reranking)

> **【位置づけの明確化（評価プロトコル v0.1 準拠）】**  
> 本機能は ρSelect のオプティマイザ本体（Optimizer Core）ではなく、実運用環境における **「Production Retrieval-Verification Layer（検索検証レイヤー）」** として動作します。

#### 【課題: スニペット段階での偽陽性】
- **発生事例**: クエリ `君と見るそら 季節外れのリナリア 作詞者`
- **問題点**: 検索エンジン（Yahoo等）のインデックスが合成したスニペットに、たまたま別文脈の単語（別アーティストの紹介文で「ほとんどの曲の作詞を手がけ…」）が含まれていたため、**本文中に「作詞者」の記載が一切存在しない記事（THE MAGAZINE）が 1 位に誤評価** されていた。
- **原因**: スニペットの BM25+ で仮順位を決めた後、深層スクレイピングで本文とハイライトを抽出しても、そのエビデンス充足度が最終順位にフィードバックされていなかった。

#### 【評価プロトコル v0.1 準拠のリファクタリング ([src/enrichment.ts](file:///home/ikeno/app/web-fetcher/src/enrichment.ts))】
評価プロトコル v0.1 第4節「必須コード修正」に基づき、脆弱性を完全解消：
1. **第4.1項 堅牢なターム分解（日本語無空白クエリ対応）**:
   - `query.split(/[\s　]+/)` 単独依存を廃止し、`extractTermsWithBigrams(query)` を統合。形態素・複合語・Bigram を抽出し、空白のないクエリ（例: `君と見るそら季節外れのリナリア作詞者`）でも正確にターム分解。
2. **第4.2項 Intent Anchor の自動選定（lastWord 固定の廃止）**:
   - 末尾語固定を全廃。属性語辞書（`INTENT_ATTRIBUTE_TERMS`: 作詞者、作曲者、発売日、料金等）への最長一致判定、および非該当時の候補群中での最低ドキュメント頻度（低DF稀少語）からアンカーを自動同定。ハイライトに含まれる場合 +6 点、本文に含まれる場合 +4 点、非充足時は -8 点のペナルティ。
3. **第4.3項 有界な Rank Prior の正規化**:
   - 候補数 $N$ 依存で肥大化していた `(N-index)*0.5` を廃止し、有界な減衰関数 $\text{rankPrior} = \frac{2.0}{\sqrt{\text{rank}}}$（最大2.0点）へ正規化。
4. **第4.4項 校正済み ρSelect エビデンス（実運用スケール対応 & Ablation）**:
   - ハイライト存在基礎点（+3.0）と、候補群中の最大ハイライトスコアに対する相対正規化（$\frac{\text{topScore}}{\text{maxScore}} \times 3.0$）を採用し、実運用スケール（0.005〜0.02）の差異を安定吸収。`enableRhoFeature: boolean` によるアブレーション実験を完全サポート。
5. **欠陥減点**:
   - `scrapeError`（-10 点）、スニペットフォールバック（-5 点）

---

### 3.2 Markdown 空行区切りリスト構造の保護パース ([src/rho_select.ts](file:///home/ikeno/app/web-fetcher/src/rho_select.ts))

#### 【課題: ラベルと値の泣き別れ】
音楽クレジットや仕様表では、以下の形式で Markdown が生成されるケースが多発：
```markdown
-   作詞者

    内山優花
```
従来の段落分割では空行（`\n\n`）を無条件にセクション境界としていたため、「- 作詞者」と「内山優花」が別段落に分断され、ラベルのみ（または値のみ）が抽出される欠陥がありました。

#### 【解決策】
リストヘッダー行に続くインデントブロックを検知し、空行があっても同一のセクションブロックとして結合・保持する処理を追加。これによりクレジット情報が不可分の証拠として抽出されるようになりました。

---

## 4. 検証結果 & エビデンスログ

### 4.1 自動テスト結果
```text
$ nix run nixpkgs#typescript -- --noEmit -p tsconfig.json
-> Exit code 0 (型エラーゼロ)

$ bun test
-> 374 pass, 0 fail, 9,828 expect() calls (所要時間 35.29s)

$ bun run test:rho-v2-stress
-> 5 pass, 0 fail, 4,588 expect() calls (所要時間 229ms)
  ✓ Stress 1: Exact vs Brute-force with/without dominance (300 seeds)
  ✓ Stress 2: AR bound correctness LB <= opt <= UB (300 seeds)
  ✓ Stress 3: AR with epsilon=0 exact convergence (150 seeds)
  ✓ Stress 4: Robustness under ties, duplicates, extreme tau (150 seeds)
  ✓ Stress 5: Fail-closed, resource limits, NaN/Infinity rejection (100 seeds)
```

### 4.2 本番エンドポイント実機クエリ検証
- **エンドポイント**: `POST https://fetcher.ikebun.jp/search`
- **リクエスト**:
  ```json
  {
    "query": "君と見るそら 季節外れのリナリア 作詞者",
    "formats": ["markdown"],
    "extractHighlights": true,
    "noCache": true
  }
  ```

#### 【検証出力ログ】
```text
[1位] rank=1 (スコア最上位・1位浮上)
  タイトル: 季節外れのリナリア by 君と見るそら | TuneCore Japan
  URL: https://linkco.re/PNzUz6Bm
  ハイライト:
    - "## [君と見るそら](...) > トラックリスト > 作詞者\n\n内山優花"

[2位] rank=2 (リスト保護パースにより完全結合・2位浮上)
  タイトル: 歌詞 | 季節外れのリナリア by 君と見るそら | TuneCore Japan
  URL: https://linkco.re/PNzUz6Bm/songs/5340374/lyrics
  ハイライト:
    - "- 作詞者\n\n内山優花"
    - "- ボーカル\n\n君と見るそら"

[3位] rank=3 (本文に作詞者の記載がないため 3位へ降格)
  タイトル: 君と見るそら、「季節外れのリナリア」を配信開始
  URL: https://www.tunecore.co.jp/the-magazine/newreleases/1017822
  ハイライト:
    - "## 1：季節外れのリナリア\n\n君と見るそら\n\nジャンル：アイドル(女性)"
```

---

### 3.3 親文脈継承と局所IDF適正化 (短文バイアス＆スニペット共食い解消)

#### 【課題: コール表・一覧記事における短文バイアスとスニペットカニバリゼーション】
- **発生事例**: クエリ `君と見るそら 好きって コール`
- **問題点**: Note の全13曲コールまとめ記事において、本命の「好きって。」のコール本文ではなく、検索エンジンのスニペット（補完証拠）が抽出されてしまっていた。
- **原因の数理的分析**:
  1. H1見出しのないまとめ記事で、`parseMarkdownSections` がパンくず階層を消去していたため、本文に「コール」や「君と見るそら」の語句が存在しない各曲セクションのスコアが低迷（文脈消失）。
  2. 助詞「って」でクエリ語が細分化され、全曲共通の「君と見るそら」「コール」と「って」を満たす短い別曲セクション（15〜27トークン）が、分母の小ささだけで $\rho = \frac{\text{Utility}}{\text{Cost} + \tau}$ を高くしてしまう分数計画の「短文バイアス」が発生。
  3. 本文候補が存在するにもかかわらず、スニペット（補完証拠: 64トークン）が同一プールで対等に競争していたため、低コストによるカニバリゼーション（共食い）が発生。

#### 【解決策】
1. **パンくず・記事タイトルの親文脈継承 (`src/rho_select.ts`)**:
   - `> 📍 **階層**: ...` から記事タイトルを抽出し、H1見出しがないドキュメントの場合に各セクションの見出しパス（`【親タイトル】 > 【セクション名】`）として継承。
2. **クエリの多粒度フレーズ保持 (`src/rho_select.ts`)**:
   - 空白区切りフレーズ（例: `好きって`）を優先保持し、助詞「って」による細分化誤爆を防止。
3. **補完証拠のフォールバック化 (`src/rho_select_v2_adapter.ts`)**:
   - 本文候補にクエリ用語のマッチが存在する場合、スニペットをプールから除外（本文優先）。
4. **局所IDF（Local IDF）の適正化 (`src/rho_select_v2_adapter.ts`)**:
   - `Math.max(0.1, Math.log(1 + (n - df + 0.5) / (df + 0.5)))` により、全セクション共通語の重みを自然に低減させ、識別語（曲名等）の比重を最大化。

---

## 5. 本番反映構成 & 再現環境
- **OS**: NixOS 24.11
- **コンテナランタイム**: Rootless Podman + Distroless (`gcr.io/distroless/cc-debian12`) + krun (Firecracker VM)
- **ビルドコマンド**:
  ```bash
  bun run build
  podman build -t ghcr.io/ikenokazuki/sora:latest -f Containerfile .
  systemctl restart user@1001.service
  ```
- **ライセンス**: Business Source License 1.1 (Change License: MIT on 2030-08-01)
