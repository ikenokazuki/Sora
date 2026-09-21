# 🧭 Sora Release v2.26.0 (candidate)

### Country Intelligence v1 — evidence-backed country context

- New `POST /intelligence/country` + `GET /intelligence/context/:contextId`, and deferred MCP tool `research_country_context` (`intel` module, `search_tools` keyword `国地域`).
- Deterministic pipeline: conservative region resolution, isolated providers with timeout/retry/cache, normalized evidence, conservative event clustering, factual temporal/relation context, SQLite persistence.
- Report counts keep articles, event clusters, and independent sources separate; publisher country never leaks into event country; ambiguous regions stay low-confidence.
- Partial-report semantics: a single provider 429/timeout degrades coverage instead of failing the report.
- Explicitly no sentiment, hostility, anti-Japan, safety, or risk classifiers or scores.
- Persistence requires `SORA_DB_PATH=/data/sora.db` on a mounted `/data` volume (`VOLUME ["/data"]` declared in Dockerfile/Containerfile). Opt-in smoke: `bun run test:intel:live`.

# 🌤️ Sora Release v2.25.0

### MCP 遅延ツールの LibreChat 互換修正

- 再接続時の有効化状態保持に加え、有効化した遅延ツールの `default.` 付き互換名を公開。LibreChat が `default.search_trend` 等を完全一致で検索する場合も、再初期化後に定義取得・呼び出しできるよう対応。
- 初期公開は12ツールを維持。遅延ツール1件の有効化で正式名と互換名の2定義を追加（同じ引数検証・処理を使用）。無効モジュールは公開しない。
- キーワード検索のランキングを維持しつつ、明示的なカテゴリ検索では3件制限を適用せず、カテゴリ内の全ツールを有効化。
- 有効化状態の保持は同一プロセス内。プロセス再起動・別レプリカへの接続では再度 `search_tools` が必要。

伝票番号の形式衝突と投機競合（first-response-wins）を排除し、決定論的かつ高信頼な配送追跡を実現する **Tracking v2 アーキテクチャ** を導入したメジャー・マイナー機能リリースです。

> **原則: Detect locally. Verify narrowly. Never guess.**
> （推測するな。観測せよ。最速応答は勝者ではない。確実な配送エビデンスのみを採用する。）

### 🌟 主な機能と改善 (Highlights)

1. **Carrier Adapter & Registry 刷新 (8キャリア対応)**
   - 運送会社ごとの追跡・検証責任をアダプタへ完全分離。
   - 国内 5 大キャリア（ヤマト運輸、佐川急便、日本郵便、西濃運輸、福山通運）に加えて、国際配送（UPS、FedEx、DHL Express）の計 8 社へ正式対応。

2. **Ranked Local Detection (非推測・完全ローカル判定)**
   - ネットワーク通信を一切行わず、全キャリアアダプタの形式ルール・チェックディジット・正規表現に基づきスコアと強度を判定・順位付け。
   - **UPS 1Z Exclusive**: UPS 固有の `^1Z[0-9A-Z]{16}$` は他社候補を一切呼び出さず単一照会。
   - **UPU S10 国際郵便**: 公式重みベクトル `[8, 6, 4, 2, 3, 5, 9, 7]` によるチェックディジット検証と `postal` メタデータ付与。外国発行（US 等）の EMS 番号も日本郵便国際追跡へ安全にルーティング。

3. **Bounded Wave Verification (最大 4 回制限・段階的並行照会)**
   - 候補上位から最大 2 社ずつ並列照会（Wave 1: Top 2、Wave 2: Next 2）。
   - Wave 1 で確実なエビデンス（`strong`）が確認された時点で後続 Wave を即時中止（Short-circuit）。
   - ネットワーク照会は最大 4 回に厳格制限し、外部サービスへの不要な高負荷やレイテンシ遅延を防止。

4. **Verified Carrier Adoption (Fastest Is Not Winner)**
   - 最速で返ってきたこと自体を勝者決定の理由とせず、配送イベント履歴や詳細情報が存在する `verification.level === 'strong'` の結果のみを勝者として採用。
   - API クレデンシャル未設定時の Web URL 案内（URL-only）が auto winner になることを厳格に防止。

5. **Multiple Strong Conflict 判定**
   - 同一伝票番号で複数社が有効な配送実績を返した場合、単一キャリアを推測・偽装せず `ambiguous: true` / `status: 'unknown'` として安全に競合をユーザーへ通知。

6. **REST / MCP / OpenAPI 契約同期**
   - MCP `track_package` および REST `/tracking` において 8 社キャリアコード（`fedex`, `dhl` を含む）と `preferredCarriers`, `originCountry`, `destinationCountry` ヒントパラメータを完全サポート。
   - 初期 12 コアツール構成（Two-Tier Tool Architecture）とコンテキストトークン効率を維持。

---

# 🌤️ Sora Release v2.24.3

コアツール枠（厳格な初期 12 ツール構成）の復元と、遅延ツール動的有効化（Two-Tier Tool Architecture）の LLM 誘導プロンプトを強化した Hotfix リリースです。

- **初期コアツール枠の復元（12 ツール制限の厳格な遵守）**: `track_package` を初期 CORE ツールから元の遅延読み込み（`defaultEnabled: deferredDefault`）へ戻し、初期 `tools/list` のツール数を 12 ツール（11 コア + `search_tools`）に復元。コンテキストトークン効率を最優先とする設計原則を徹底。
- **動的有効化誘導プロンプトの強化**: `buildSoraMcpInstructions` 内の Tier 1 指示において、`track_package` が初期非表示の遅延ツール（DEFERRED）であることを明記し、利用前に必ず `search_tools(query: '荷物追跡')` を呼び出して動的有効化してから使用することを LLM に一意に指示・誘導。
- **コントラクトテストの整合性担保**: 初期 12 ツール構成および `track_package` の動的有効化フローに対するテストアサーションを同期（29 tests 全件 PASS）。

---

# 🌤️ Sora Release v2.24.1

v2.24.0 で導入した X long-form enrichment に対する Hotfix リリースです。

- **post-merge X long-form detail selection**: Yahoo official/public マージ後に全文取得候補を選定
- **Yahoo truncation gate**: Yahoo 本文が切断疑い（`text.length >= 240`）の投稿のみを Gate 通過
- **max two Fx detail calls**: 上位 5 件をローカル評価し、FxTwitter HTTP 呼び出しは最大 2 件に制限
- **query relevance selection**: original semantic query relevance に基づき Fx detail 候補を選択
- **canonical X text response**: `text` を唯一の canonical 本文に一本化
- **canonical author_name/author_handle response**: `author_name` + `author_handle` を canonical author 表現とし、`@` を除去
- **removal of redundant long-form response fields**: 通常レスポンスから `snippet`, `markdown`, `originalText`, `author`, `author_url`, `siteName` を完全に除外し、レスポンスサイズを大幅に削減（`verbose: true` のみ `detailDiagnostics` を付与）
- **URL normalization**: host-facing X URL から Yahoo トラッキングパラメータ（`utm_source`, `utm_medium`, `utm_campaign`）を自動除去
- **Yahoo/Fx fail-soft挙動の維持**: 外部 API エラーやタイムアウト時もエラーを発生させず安定フォールバック

---

# 🌤️ Sora Release v2.24.0

荷物追跡の信頼性・レイテンシを飛躍的に高める **Fail-fast Package Tracking** と、X (旧 Twitter) の長文投稿（Note Tweet 等）を正確かつ安全に補完する **Bounded X Long-form Enrichment** を統合したメジャー・マイナー機能リリースです。

各種 MCP ツールと REST API の全レイヤー（`search_deep` / `/search/deep`, `search_realtime` / `/realtime`, `scrape` / `/scrape`, `track_package` / `/tracking`）においてマルチサーフェスな動作整合性を完全担保しました。

---

## 🌟 v2.24.0 主なハイライト (Highlights)

### 1. 📦 荷物追跡の信頼性・レイテンシ改善 (Track B)
- **並行投機照会の Fail-fast 化**: 複数キャリアの並行探索において、確実な配送結果（`delivered`, `in_transit`, `registered`, `returned`）が確定した瞬間に即座に早期 return。遅延キャリアやタイムアウト待ちによるレイテンシを大幅に削減。
- **UPS フォールバックの適正化**: API 認証情報（`UPS_CLIENT_ID` / `UPS_CLIENT_SECRET`）が未設定の場合に従来の `status: 'registered'`（虚偽の追跡完了リスク）を廃止し、安全な `status: 'unknown'` と公式追跡 Web リンク案内へ是正。
- **伝票番号の候補推定適正化**: 汎用的な未知伝票番号から UPS を除外し、UPS 固有の形式（`^1Z[0-9A-Z]{16}$`）のみ候補として自動判定。

### 2. 𝕏 X 長文投稿 (Note Tweet) の適応的全文補完
- **Yahoo Realtime Discovery の維持**: 広範な即時検索・トレンド把握は Yahoo! リアルタイム検索の高速性を維持し、不要な外部 API コールを排除。
- **語彙観測に基づく Bounded Enrichment**: クエリ要求とスニペットの語彙照合（`tokenizeAndSelectTerms`）および省略記号（`…` や `...`）による切り捨て検知を行い、情報欠落の兆候がある上位候補のみ FxTwitter v2 API（最大 2 件、通常 0〜1 件）で全文補完。
- **Direct X Status URL への直結**: X ポスト URL（`/status/:id`）が指定された場合、Yahoo 検索を待たずに直接 FxTwitter detail を試行し、Note Tweet の完全な長文本文・正確な著者名・投稿日時を 1 回で抽出。
- **100% Fail-soft & プライバシー保護**: 外部 API のタイムアウト（1,500ms）・レート制限・HTTP エラー時もエラー落ちせず Yahoo スニペットを維持。FxTwitter へは numeric statusId のみ送信し、ユーザーの生クエリやセッション情報は一切非送信。5分 TTL キャッシュと single-flight 重複排除を内蔵。

### 3. 🔁 MCP & REST Multi-surface Parity
- **REST `/realtime` エイリアス**: クライアント互換性のため、`POST /search/realtime` に加えて `POST /realtime` も同一ハンドラでマウント。
- **Deep 統合検索・単一スクレイプ連携**: `search_deep`（MCP）および `/search/deep`（REST）の速報枠や Web 記事スクレイプ、`scrape`（MCP）および `/scrape`（REST）のすべてで X ポストの全文抽出がシームレスに機能。
- **包括的統合テストスイート**: REST と MCP の全サーフェスを検証する `src/services/mcp_rest_deep_realtime.test.ts` を追加し、全件グリーンを恒久保証。

---

# 🌤️ Sora Release v2.23.1

v2.23.0 で導入された各種機能と runtime 挙動を、MCP スキーマ・ツール説明・指示文（`SORA_MCP_INSTRUCTIONS`）・REST・OpenAPI・ドキュメント間で 100% 整合させる **LLM-facing Contract Synchronization & Discovery Refinement** リリースです。

検索・retrieval・ranking・ρSelect v2 の精度経路は変更せず、LLM が迷わず正確にツールを選択・発見・活用できるプロトコル契約を強化しました。

---

## 🌟 v2.23.1 主なハイライト (Highlights)

### 1. 🔁 `search_deep` スキーマの Single-Source 化 & 完全パリティ
- `src/mcp.ts` 内の手動インラインスキーマ定義を撤廃し、共有スキーマ `INTEGRATED_SEARCH_INPUT_SHAPE` に一本化。
- OpenAPI 生成における Zod 3.24+ の enum 欠落バグを修正し、REST / MCP / OpenAPI 間の全 enum・default・境界値の一致をテストで恒久保証。
- `search_web` の `limit` 説明文言をランタイム挙動（最大: 20。formats指定時: 5。未指定時: provider 既定件数維持）と完全同期。

### 2. 🧩 Module-Aware な MCP ガイダンス & 厳格な分離
- `buildSoraMcpInstructions(activeModules)` を導入し、有効なモジュールのみ Tier 1 ディレクティブおよびツールガイダンスを動的生成。
- `life` モジュールと `disaster` モジュールの instructions 定義を完全に分離し、片方のみ有効な構成でも他方のツール名が漏出しないよう適正化。
- `search_tools` の候補なしメッセージに表示される「利用可能なカテゴリ」も現在アクティブなモジュールのみ動的反映。

### 3. 🔍 段階的ツール発見 (Progressive Discovery) の品質向上
- `search_tools` の自然言語判定における逆包含処理を 2 文字以上（`[...kLower].length >= 2`）に限定。「歌手」で「歌」を含む `search_song` が誤活性化される 1 文字誤マッチを排除。
- `search_tools` の description から固定ツール名（`search_deep 等`）を削除し、モジュール無効構成でも矛盾しない client-neutral な案内に統一。
- 初期 12 コアツールの定義文字数を 19,963 文字、instructions を 6,102 文字に最適化（初期コンテキスト消費を全登録比約 70% 削減）。

### 4. ⚡ MCP Standard Streamable HTTP 通知の E2E 実証
- MCP SDK 標準の Streamable HTTP（GET SSE ストリーム）経由で、`search_tools` 実行時に `notifications/tools/list_changed` が確実にクライアントへ届き、同一セッション内で `tools/list` が動的リフレッシュされる E2E 通信を実証。

---

# 🌤️ Sora Release v2.23.0

MCP / REST の検索レスポンス整合性を保ちながら、必要なクライアントだけ返却量を大幅に削減できる **Evidence Response Mode**、`search_web` の共通 format 契約、Host-facing highlights 正規化、および検索診断の安全な拡張を統合したリリースです。

既存互換性を優先し、`search_deep` の `responseMode` は引き続き **`full` がデフォルト**です。`evidence` は明示 opt-in であり、取得・ρSelect v2・Deep Evidence Rerank の精度経路は変更しません。

---

## 🌟 v2.23.0 主なハイライト (Highlights)

### 1. 📦 `search_deep` Evidence Response Mode（明示 opt-in）
- `responseMode: "full" | "evidence"` を MCP / REST の双方で利用可能。
- `full` は従来互換のデフォルト。
- `evidence` は query-selected `highlights` を保持し、安全条件を満たす結果だけ重複する全文 `markdown` を省略。
- `markdown` を highlights で上書きせず、`highlights` も削除しません。
- `formats:["markdown"]` の明示指定、`extractHighlights:false`、highlights 不在、scrape fallback/error、X ソースでは全文 Markdown を保持します。
- 決定論的な real MCP + REST E2E fixture では、対象情報を保持したまま返却文字数を約 91% 削減しました（fixture 実測値であり、一般ワークロードの保証値ではありません）。

### 2. 🔁 MCP / REST の検索契約整合性
- `search_deep` の full / evidence で stable semantic surface の MCP / REST parity を実 E2E で検証。
- `search_web` に共通 `formats` 契約を導入し、MCP / REST の双方で `markdown`, `tables`, `links`, `jsonLd` 等を同一方針で取得可能。
- `formats` 未指定時の `search_web` は従来の軽量検索パスを維持し、追加スクレイプを行いません。
- requested format 以外の payload を漏らさない Host projection を追加。

### 3. 🎯 Host-facing highlights の正規化
- 外部向けの標準 surface を `highlights` に統一。
- 内部用 `highlightItems` は Deep Evidence Rerank まで保持し、通常レスポンスでは露出させません。
- `verbose` 時のみ診断用内部情報を維持します。

### 4. 🔎 安全な検索診断と実験機能
- verbose-only の query lineage / evidence diagnostics を追加。通常レスポンス・順位決定には影響しません。
- Web Query Union と X Source Isolation は引き続き **明示 opt-in / デフォルトOFF**。
- Study 2B の実験実装は production candidate から除外済みで、本リリースには含めません。

### 5. 🧪 回帰安全性
- ρSelect v2 canonical tests: 23 tests / 422 assertions。
- ρSelect v2 1,000-seed stress: 5 tests / 4,588 assertions。
- ソライロ / 季節外れのリナリア / SPARK の precision fixtures を release gate に固定。
- real MCP + REST Evidence E2E、real MCP + REST `search_web formats` E2E、build、version contract をリリース前に実行。
- main と release candidate の full test suite を同一隔離環境で比較し、candidate-only failure がないことを確認してからリリースします。

---

# 🌤️ Sora Release v2.22.0

気象庁公式オープンデータによる週間天気予報（最大7日先＝計8日間）の統合、および不要な個人ボランティアAPI（tsukumijima）フォールバックの完全撤廃アップデート（v2.22.0）です。

---

## 🌟 v2.22.0 主なハイライト (Highlights)

### 1. 🌦️ 気象庁公式 週間天気予報（7日先＝計8日分）の統合
- **日別マージエンジンの新設**:
  - 気象庁 API の短期予報（今日・明日・明後日）と週間予報（3日後〜7日後）を自動統合し、指定地域（例: 「山中湖」190020）において最大 8 日分（今日〜7日後）の日別予報（天気コード・日本語テロップ・降水確率・予想最高/最低気温・予報信頼度 A/B/C）をシームレスに取得可能になりました。
- **`days` パラメータ拡張**:
  - `days: 1〜8`（デフォルト: 7）へ拡張し、MCP ツール `get_weather` および `/weather` エンドポイントで週間予報をワンショット取得可能にしました。

### 2. 🛡️ OSS開発倫理・健全性の向上（個人APIフォールバックの完全撤廃）
- **一次ソース（気象庁公式 CDN）への一本化**:
  - 個人開発者がボランティア運用している外部サーバーへの自動フォールバック処理を完全削除しました。
  - 共倒れリスクと外部への不要な負荷集中を根絶し、Akamai CDN 等で高可用配信される気象庁公式データのみを直接参照する堅牢で倫理的なアーキテクチャに整理しました（オッカムの剃刀）。

---

# 🌤️ Sora Release v2.19.0

最新の数理最適化研究に基づく証拠選択エンジン **「ρSelect v2 (Canonical Engine)」** の完全導入および深層エビデンス駆動リランキング機能の搭載アップデート（v2.19.0）です。連続スコア $r_{it} \in [0, 1]$ に対する Graded Max-Evidence 則と座標単調効用関数 $\Phi(y)$、Safe Dominance 剪定、および Exact Observed-Rank DP / Adaptive Refinement 二段階ハイブリッドソルバーを実装しました。全クエリに対して数学的オプティマイザ証明書（`certificate`: $LB \le \rho^* \le UB$）を発行し、外部監査レポート（v0.35）の全指摘事項を是正するとともに、実クエリでの偽陽性を根絶する深層エビデンス駆動リランキングおよび Markdown リスト構造保護パースを導入しました。

---

## 🌟 v2.19.0 主なハイライト (Highlights)

### 1. 🎯 ρSelect v2: 数学的オプティマイザ証明書付き証拠選択エンジン
- **連続スコア評価と Graded Max-Evidence**:
  - 連続値 $r_{it} \in [0, 1]$ の適合スコアを直接扱う数理モデルへ刷新。
- **Canonical Unconstrained Mode（自律的疎性最適化）**:
  - ハード上限 $K$ を前提とせず、State-Witness Sparsity 定理（$|S^*| \le m$）と分数目的関数に基づき、必要最小限かつ情報密度の高い証拠集合を自律選出。
- **Safe Dominance 剪定による状態空間 22.7倍（95.59%）削減**:
  - パレート劣位候補を探索前に安全にパージ。実測において状態数を 1,678 → 74 へ劇的削減（レイテンシ約 52 倍 高速化）。
- **二段階ハイブリッド・ソルバー & 数学的証明書 (`certificate`)**:
  - Exact DP と Adaptive Refinement により大域的最適性を数学的に証明。各レスポンスに `certificate`（$LB \le \rho^* \le UB$）を添付。
- **1,000 Seeds ストレス回帰テストスイートの完走**:
  - 1,000 決定論的シード（4,588 assertions）による厳格な数学的性質（Exact vs Brute-force、AR Bounds、$\epsilon=0$ 収束、Dominance不変性、Ties、Fail-closed）を 100% 検証。

### 2. 🔍 深層エビデンス駆動リランキング (`rerankByDeepEvidence`)
- **スニペット段階での偽陽性の根絶**:
  - 検索エンジンの合成スニペットに別文脈の単語が含まれていた場合の誤1位判定を解消。
- **多層エビデンス順位補正**:
  - 深層スクレイピング完了後、本文およびハイライトのクエリ単語カバレッジ、意図キーフレーズ（末尾語・特異語）充足、および ρSelect v2 ハイライトスコアを総合評価し、真に回答根拠を含むページを 1 位へ自動浮上。

### 3. 📝 Markdown 空行区切りリスト構造保護パース
- **クレジット・定義リストの泣き別れ防止**:
  - `- 作詞者\n\n 内山優花` のような空行区切りインデントリストが空行で別セクションに分断されるのを防ぎ、同一セクションブロックに結合保持。

### 4. 📚 監査・仕様ドキュメントの最新化
- 理論解説: [`docs/rho_select.md`](docs/rho_select.md)
- LLM向けハンドオーバー仕様書: [`docs/rho_select_v2_llm_handover.md`](docs/rho_select_v2_llm_handover.md)
- 監査指摘是正・新機能実装報告書: [`docs/rho_select_v2_audit_response.md`](docs/rho_select_v2_audit_response.md)

---

# 🌤️ Sora Release v2.18.0

日本の主要運送会社および国際便の横断追跡機能（`/tracking`、`track_package` MCP ツール）の新規搭載、およびトークン効率的証拠選択エンジン「ρSelect」におけるボイラープレート・メタデータ自動排除とリスト内見出し階層認識の機能強化を含む大型アップデート（v2.18.0）です。

---

## 🌟 v2.18.0 主なハイライト (Highlights)

### 1. 📦 日本主要5社＋UPS 荷物追跡 API & MCP ツール (`POST /tracking`, `track_package`)
- **対応キャリア**:
  - ヤマト運輸（クロネコヤマト）
  - 佐川急便
  - 日本郵便（ゆうパック・書留）
  - 西濃運輸（カンガルー便）
  - 福山通運
  - UPS（United Parcel Service / 国際便）
- **高精度キャリア自動判別**:
  - 伝票番号の桁数（10/11/12/13/18桁等）やハイフン位置、Modulus 7 および Luhn チェックサムによる自動キャリア識別。
  - キャリア指定なし（`"carrier": "auto"`、または `GET /tracking/:number`）でも即座に対象キャリアを判定して追跡。
- **5分間インメモリ LRU キャッシュ**:
  - 同一伝票番号への重複問い合わせを防止し、外部サーバーへの負荷を抑制（キャッシュヒット時レイテンシ <0.5ms）。
- **REST & MCP 両対応**:
  - REST API: `POST /tracking`, `GET /tracking/:carrier/:number`, `GET /tracking/:number`
  - MCP ツール: `track_package`（Module 4: Japan Daily Life & Transit に統合）

### 2. ⚡ ρSelect: ボイラープレート・メタデータ自動排除 & リスト内見出し認識
- **Frontmatter & パンくずメタデータの自動排除**:
  - Markdown 先頭の YAML frontmatter（`--- publishedTime: ... ---`）やサイト共通ナビゲーション（`> 📍 **階層**: ...`）が候補セクションに混入してハイライト選択を歪める問題を根本解決。
- **リスト内見出し階層認識 (`- ### [記事見出し]`)**:
  - 朝日新聞トピックスや Yahoo!ニュース等のポータルサイトで頻出する、箇条書きリスト要素内に埋め込まれた Markdown 見出し記号を正確に境界認識。一覧記事の各トピックを独立した候補セクションとして精密に分離・スコアリング。
- **スニペットの Frontmatter クレンジング**:
  - 検索結果レスポンスの `snippet` および `description` に混入した YAML frontmatter やパンくず文字列を事前サニタイズ。

---

# 🌤️ Sora Release v2.16.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」の最新機能アップデート（v2.16.0）です。

本バージョンでは、現代の情報検索（Information Retrieval: IR）理論と最新 RAG 研究に基づく **3大 IR アルゴリズム（Lost in the Middle 対策 U字型リオーダリング、MMR 多様性選択、インメモリ PRF 適合性フィードバック）**、時間軸ハルシネーションを防止する **Temporal Context Anchor（相対日時の絶対タイムスタンプ自動解決）**、および大規模な表構造をインテリジェントに要約・圧縮する **Smart Table Minimizer** を新規実装しました。

すべてのアルゴリズムは **ゼロ・ミドルウェア（外部 LLM・外部ベクトル DB 不要、完全インメモリ <0.05ms）** で動作し、LLM コンテキスト窓の劇的な節約とエージェントの推論精度向上を両立します。

---

## 🌟 v2.16.0 主なハイライト (Highlights)

### 1. 🧠 情報検索 (IR) 理論に基づく 3 大アルゴリズム (Zero-Middleware IR Engine)

外部の重厚なベクトル検索エンジンや Re-ranking LLM を一切導入せず、スクレイピング・検索結果の本文チャンクに対して純粋な数理的インメモリ処理（純粋 TypeScript / Bun）で最高水準の検索精度を実現しました。

- **① Lost in the Middle 対策: U字型リオーダリング (`reorderUshaped: true`)**
  - **背景**: 大規模言語モデル（LLM）は、プロンプトの先頭（Primacy Bias）と末尾（Recency Bias）にある情報を強くアテンションし、中央部の情報を忘却・見落としやすい特性（Lost in the Middle 現象）を持ちます。
  - **解決策**: BM25 や検索スコア順に上位から並べる従来の直線的配置を刷新。最重要チャンク（Rank 1, 2）を先頭と末尾に配置し、中央部に向かってスコアが緩やかに低下する **U 字型順序（$R_1, R_3, \dots, R_4, R_2$）** へ自動再配置。LLM による中央部情報の見落としを数理的に防止します。
- **② Carbonell & Goldstein (1998) 準拠: MMR 多様性選択 (`useMmr: true`)**
  - **背景**: 単純な類似度・BM25 スコアのみで上位チャンクを抽出すると、ほぼ同一内容の文章（ヘッダー、重複した免責事項、定型句など）が連続して選択され、限られたコンテキスト窓を浪費します。
  - **解決策**: クエリとの関連性（$\text{Sim}_1$）と、すでに選択されたチャンク群との最大類似度（$\text{Sim}_2$）のトレードオフを数式 $\text{MMR} = \operatorname{argmax} \left[ \lambda \cdot \text{Sim}_1(d_i, q) - (1 - \lambda) \max_{d_j \in S} \text{Sim}_2(d_i, d_j) \right]$ に基づいて動的評価。$\lambda = 0.7$（デフォルト）により、関連性を維持しながら重複情報を強力に排除し、多様な情報源からチャンクを網羅採択します。
- **③ Rocchio 適合性フィードバック: インメモリ PRF (`usePrf: true`)**
  - **背景**: ユーザーの検索キーワードと Web ページの記述表現の揺らぎ（Vocabulary Mismatch）により、重要な本文が従来の単語一致検索から漏れる問題があります。
  - **解決策**: 一次検索で高スコアを獲得した上位チャンク（Top-K）のテキストから、TF-IDF + サブワード境界スコアリングによって特異的キーワードをインメモリで自動抽出。クエリ重みベクトルを $q_{\text{new}} = \alpha \cdot q + \beta \cdot \text{keywords}$ で自動拡張して再スコアリング。重い Embedding モデル不要で検索適合率を大幅に向上させます。

### 2. ⏳ Temporal Context Anchor（相対日時の絶対タイムスタンプ自動解決）
- **背景**: Web 記事やプレスリリース、ブログ、SNS では「明日」「来週」「3日前」「今週末」といった相対日時表現が多用されます。LLM はスクレイピング日時や記事執筆日時を知らないため、時間軸のハルシネーション（過去のイベントを未来と誤認するなど）を頻発させます。
- **解決策**:
  - 記事の公開日時（HTML メタタグ `article:published_time`、Schema.org JSON-LD `datePublished` 等）またはスクレイピング実行日時を「基準アンカー日時（Anchor Time）」として自動設定。
  - 本文中の相対日時表現を正規表現とカレンダー演算により動的検知し、インラインで絶対日時を付与（例: `来週水曜日 [2026-09-16 (水)] に開催予定`）。LLM が一切の推測なしに確定日時を認識できます。

### 3. 📊 Smart Table Minimizer（表トークンのインテリジェント圧縮）
- **背景**: 仕様表、比較表、運行スケジュール等の Markdown テーブルは、空セル（`-`, `N/A`, `なし`）や定型ヘッダー、重複列が多く、LLM のコンテキスト窓を極度に浪費します。
- **解決策**:
  - 表全体の空セル率が 50% を超えるスパースな表や、低情報密度の列・行を自動検出。
  - 重要なデータ行を維持しながら、コンパクトなキー・バリュー形式や省略フォーマットへ自動圧縮。表データの可読性と意味的完全性を保ちながら、トークン消費量を **最大 60% 削減** します。

### 4. ♿ Evidence-Preserving Accessibility Hints（根拠データプレーン）
- 画像リンク、アイコンボタン、装飾的ナビゲーションなど、テキストが少なくアクセシビリティ属性（`aria-label`, `alt`, `title`）にのみ意味情報が含まれる HTML 要素から、根拠テキストを自動抽出し Markdown 出力に統合。視覚情報・補助テキストの欠落を防ぎます。

### 5. ⚡ 圧倒的なパフォーマンス・ベンチマーク (Zero-Middleware)
- すべての処理を外部サービスや重厚なミドルウェアに依存せず、純粋な TypeScript / Bun インメモリ環境で完結。
- 実測レイテンシ：
  - **U-shaped Reordering**: **1.2 µs**
  - **MMR 多様性選択 (10チャンク)**: **28.4 µs**
  - **インメモリ PRF 適合性フィードバック**: **42.1 µs**
  - **Temporal Anchor (相対日時解決)**: **15.6 µs**
  - **Smart Table Minimizer**: **8.3 µs**
  - 合計オーバーヘッドは 0.1ms 未満であり、既存のスクレイピング・検索速度に一切影響を与えません。

### 6. 🧪 テスト・検証実績 (Testing & Verification)
- **自動テストスイート**: **全 292 テスト 100% PASS**（2,843 件の expect アサーション）
  - 新規 IR アルゴリズム、Temporal Anchor、Table Minimizer の単体・統合テストを完全網羅。
  - 既存の全 REST エンドポイント・MCP ツール仕様と 100% 完全互換。
- **本番環境**: NixOS rootless Podman (krun / Firecracker) コンテナ `web-fetcher` にて v2.16.0 稼働確認済み（`curl http://127.0.0.1:3016/health` → `200 OK`）。

---

# 🌤️ Sora Release v2.13.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」の最新機能アップデート（v2.13.0）です。

本バージョンでは、商用 LLM（Claude / ChatGPT 等）やローカル LLM（Llama / Qwen / Ollama 等）における**回答拒絶（Over-Specialization による過剰拒否）の完全根絶（Zero-Refusal Policy）**、**2層構造ツール決定フレームワーク (Two-Tier Tool Decision Framework)**、および Google（Passage Chunking）や Firecrawl のベストプラクティスに基づく**本文精読（Search → Scrape ループ）の義務化** を実装しました。

---

## 🌟 v2.13.0 主なハイライト (Highlights)

### 1. 🛡️ 回答拒絶の完全防止ポリシー (Zero-Refusal Policy)
- **過剰適合による回答拒絶の根本解決**:
  - LLM に多数の専門ツールを提供した際、「ライブ日程専用ツール」「営業時間専用ツール」「発売日専用ツール」等が存在しないことを理由に、LLM が「ツールがないためお答えできません」と勝手に決めつけて回答を拒絶する問題（Over-Specialization Bias）を根絶。
  - MCP 初期化ハンドシェイク（`initialize`）時に配布される `instructions` において、「専用ツールの不在を理由とした回答拒絶・推測放棄」を全面的に禁止。

### 2. 🗺️ 2層構造ツール決定フレームワーク (Two-Tier Tool Decision Framework)
- **Tier 1 (公式専門データ直結ツール・強制呼び出し)**:
  - 以下の 6 大ドメインについては、モデル自前の知識推測や一般 Web 検索を禁止し、必ず Sora の専用公式ツールを実行：
    1. **米国貿易・通関・規制判定**: `predict_hts_code`, `verify_hts_code`, `check_cpsc_certificate`, `check_fda_regulated`, `check_product_compliance`
    2. **日本法令・国会審議録**: `search_laws`, `get_law_text`, `search_diet_minutes`
    3. **気象庁防災・地震・道路交通**: `get_weather`, `search_disaster_warnings`, `search_earthquake`, `search_road_traffic`
    4. **国内路線乗換・フライト・標高**: `search_route`, `get_flight_status`, `get_elevation`
    5. **SNS速報・知恵袋・トレンド**: `search_realtime`, `search_trend`, `search_chiebukuro`, `suggest_keywords`
    6. **音楽メタデータ**: `search_song`, `search_artist`, `search_music`
- **Tier 2 (万能深層Web検索ツール・全実世界データ調査)**:
  - 上記以外のあらゆる最新事実・スケジュール・実世界データ（ライブ・公演・イベント日程、新製品・発売日、店舗営業時間、人物・企業動向、時事ニュース、技術ドキュメント等）は、**`search_deep`（推奨一次ツール）** を呼び出し、Clean Markdown 本文まで深く読み込んで包括的かつ根拠ある回答を構築。

### 3. 🔍 Google & Firecrawl 式の本文精読（Search → Scrape ループ）ルール
- **スニペットによる中途半端な推測の防止**:
  - 検索スニペット（1〜2行の抜粋）はメタ情報に過ぎず、開場時間やチケット発売日、詳細規約は本文（Main Content）にしか存在しません。
  - `search_web`（URL・概要スニペット探索）を使用した場合でも、スニペットだけで詳細が不確定な場合は推測で終わらせず、必ずヒットした公式 URL を `scrape` ツールで精読して本文を確認することを規約化。

### 4. 🏷️ 万能ツールの検索キーワード & Description 強化
- **動的ツール発見（`search_tools`）の精度向上**:
  - `search_deep`: 「【万能深層Web検索・最新事実/スケジュール/イベント調査】」を明記し、`['スケジュール', 'イベント', 'ライブ日程', '発売日', '営業時間', '最新情報']` をキーワードに追加。
  - `search_web`: 「【万能Web検索・候補探索】」を明記し、`['イベント検索', '告知検索', 'スケジュール']` をキーワードに追加。
  - `search_artist`: 「ライブ・公演日程や最新の出演スケジュール・最新活動情報は search_deep または search_realtime を使用してください」との相互誘導を明記。
  - `search_realtime`: アイドルのライブ出演・物販タイテ・緊急告知・イベント現地の生の声への最適性を明記。

### 5. ⚡ 次世代スクレイピング＆抽出エンジン（8大機能強化）
- **BrowserContext 軽量セッション分離**: 常駐 Chromium インスタンスに対し軽量な一時コンテキストをオンデマンド生成・即時破棄。プロセスの起動・終了待機ゼロとセッションごとの完全な Cookie / キャッシュ隔離を両立。
- **インテリジェント・アセット遮断**: 不要な画像バイナリ、メディア、Webフォント、3Dモデル、広告・解析トラッカーをネットワーク層（Request Interception）で即座に abort。CSS・JS を維持して正確な DOM レイアウトと不可視要素判定を保持しつつ、転送量 99% 削減とロード時間半減を達成。
- **DOM Quiescence（静止検知）SPA待機**: 固定スリープを廃止し、`MutationObserver` により 200ms の DOM 静止を動的検知して即座に完了。テスト実行時間を 106s から 90s へ大幅短縮。
- **イベント・スケジュール構造化抽出**: Schema.org `Event` / `MusicEvent` を自動解析し、構造化データ（JSON）および Markdown 冒頭コールアウトとして出力。
- **パンくずリスト（階層コンテキスト）抽出**: サイトの階層ナビゲーションを抽出し、ページの文脈パス（Breadcrumb）を Markdown に自動付加。
- **テーブル結合セル正規化**: `colspan` / `rowspan` を 2D マトリクスで自動補完・展開し、複雑な表構造の崩れを防止。
- **重要画像スコアリング**: フライヤー・タイテ・図表等の画像メタデータを検出し、不要アイコンと区別して優先抽出。
- **Clean Content Sanitizer & DNS Pinning**: プロンプトインジェクション用制御トークンや不可視ゼロ幅文字のサニタイズ、末尾ドット FQDN 表記による SSRF 回避の厳格な防御。

---

# 🌤️ Sora Release v2.12.0

### 1. 📋 MCP Instructions ＆ 専門ツール強制ディレクティブの導入
- MCP 初期化ハンドシェイク時に配布されるクライアント向けシステム指示書（`SORA_MCP_INSTRUCTIONS`）を整備。
- 各ツールの説明文に「【必須・推測回答厳禁】」「【公式直結】」等の強制ディレクティブを付与し、モデル自身の不確実な学習知識によるハルシネーションを防止。

### 2. 🪶 入力・出力の分離と軽量返却キー注記 (Return Annotations)
- 巨大な JSON 出力スキーマによるトークン爆発やローカル LLM の KV キャッシュ枯渇を防ぎつつ、各ツール説明文末尾に `返却: { status, overallStatus, ... }` の軽量アノテーションを付与してエージェントの戻り値認識性を最適化。

---

# 🌤️ Sora Release v2.11.0

### 1. 🛡️ 米国貿易コンプライアンスにおける多層防御（Dynamic Clarifying Questions）
- `check_product_compliance` や `predict_hts_code` において、主素材や対象年齢、飲食接触の有無などの重要パラメータが不足している場合、モデルが勝手に推測せず、AI エージェントがユーザーにヒアリングするための動的質問リスト（`clarifyingQuestions`）と `inputCompleteness: "partial"` を返却する多層防御機構を実装。

---

# 🌤️ Sora Release v2.10.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」の機能拡張アップデート（v2.10.0）です。

本バージョンでは、米国輸出通関・越境 EC 支援において極めて重要な**「商品情報からの HTS/HS コード推測エンジン（`predict_hts_code` / `POST /trade/hts-predict`）」**の新設、**2026 HTS Revision 18 & Chapter 99 特別追加関税リスク対応**、**2026年7月 CPSC 完全義務化 & ACE Disclaimer（免責申告コード）の反映**、および **FDA 実務 PGA フラグ（FD1〜FD4）判定ロジックの刷新** を実施しました。

---

## 🌟 v2.10.0 主なハイライト (Highlights)

### 1. 🎯 商品情報からの HTS/HS コード推測エンジン (`predict_hts_code` / `POST /trade/hts-predict`)
- **2段階ハイブリッド推測アルゴリズム**:
  - 米国通関申告に必須となる 10 桁統計細分コードを特定するため、商品名・説明文・素材・用途・対象年齢からセマンティックスコアリングでサブヘディング（6 桁）を高速に特定。
  - 米国国際貿易委員会（USITC）公式現行関税率表 API（`hts.usitc.gov`）とリアルタイム連携し、該当サブヘディング配下の全 10 桁統計細分コード、品目名、一般関税率を展開してセマンティック照合を実施。
- **実測精度**:
  - 玩具、陶磁器食器、化粧品、綿衣料、ヘルメット、食品（緑茶）、電子機器（急速充電器）等の代表品目において、**6 桁 HS コード特定率 100%、10 桁 HTS 完全一致 71%、上位 2 位以内特定率 100%** の高精度を実証。
- **PGA 規制判定とのシームレス連動**:
  - 推測された最有力 HTS コードに基づき、連動する CPSC 適合証明書要件（CCC/GCC・eFiling）および FDA 規制要件（FD1〜FD4 フラグ・Prior Notice・MoCRA）を自動で並行評価。

### 2. 📜 2026 HTS Revision 18 & Chapter 99 特別追加関税リスクのガイダンス追加
- **大統領布告・通商条約への即応**:
  - 2026年9月公開の 2026 HTS Revision 18（大統領布告 PP 11059/11055）や通商法 301 条（中国原産品追加関税等）に基づく **Chapter 99 特別追加関税** の適用リスクと通関士確認手順を判定レポートに追加。

### 3. 🛡️ CPSC 2026年7月8日 eFiling 完全義務化 & ACE Disclaimer（免責コード）対応
- **完全義務化ステータスの反映**:
  - 2026年7月8日より施行された米国税関（CBP）ACE システムへの電子申告（eFiling: フル PGA メッセージセット送信、または CPSC Product Registry 事前登録による参照送信）完全義務化（De Minimis 適用除外なし）を明記。
- **ACE 免責申告（Disclaimer）の案内**:
  - 規制対象外品目や類似コード品目に対して、通関保留エラー（P00/PU2）を防止するための **ACE Disclaimer コード（A: 非規制品、B: 適用規格免除等）** の申告ガイダンスを追加。

### 4. 🏥 FDA 実務 PGA フラグ（FD1〜FD4）判定ロジックの刷新
- **通関実務仕様への完全移行**:
  - 従来の粗い Chapter 2 桁判定から、CBP/FDA 実務で機械的に使用される PGA フラグ体系（FD1〜FD4）へ全面刷新：
    - **FD4**（食品必須）: 米国到着前の FDA 事前通知（Prior Notice / PNC 確認番号取得）絶対必須。
    - **FD2**（食品以外必須）: 化粧品（MoCRA / Cosmetics Direct 施設登録・製品リスティング）、医療機器（510(k) / Listing）、医薬品（NDC コード取得）。
    - **FD1**（用途により該当）: 食器・調理器具等の食品接触物質（FCS）。`foodContact` パラメータと連動し、食品接触用途なら FDA 安全基準適合要件、装飾用等の非接触用途なら ACE 免責（Disclaimer）申告を自動案内。

### 5. 🛠️ 全 38 MCP ツールへの拡張 & Gemini 100% 互換性維持
- 新規 MCP ツール `predict_hts_code` を含め、全 38 ツールの inputSchema が Gemini の Tool Calling 仕様（`exclusiveMinimum`、`const`、`array` 型禁止）に 100% 適合（1,412 項目検査パス）。

---

# 🌤️ Sora Release v2.9.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」のメジャーアップデート（v2.9.0）です。

本バージョンでは、LLM エージェント連携における**トークン消費量の大幅削減（Compact Response Mode & Base64 画像パージ）**、**SSRF 難読化 IP の数学的正規化によるセキュリティ完全防御**、**SPA 描画の適応型待機最適化**、**共有ブラウザ自動ローテーション & グレースフルシャットダウン**、および **REST ルーターのドメイン別モジュール分割（コードベース 91% スリム化）** を実施しました。

---

## 🌟 主なハイライト (Highlights)

### 1. 🪶 Compact Response Mode（LLM トークン消費量を 50% 以上削減）
- **デフォルト出力の軽量化**:
  - スクレイピング API (`/scrape`, `/scrape/stream`, `/search` 等) において、AI エージェントのコンテキスト窓を圧迫していた内部品質評価データ（`quality`, `completeness`, `qualityReasons`, `missingFields`, `evidence`, `renderedWithBrowser` 等）をデフォルトで自動除外。
  - レスポンスのペイロードサイズと LLM のトークン消費量を **50% 以上削減** し、高速かつ低コストなエージェント運用を実現。
- **オンデマンド詳細出力 (`verbose: true`)**:
  - 品質デバッグやハルシネーション検証で内部評価データが必要な場合は、リクエストに `"verbose": true`（または `/search?verbose=true`）を指定することで、完全な出処根拠（Provenance）やスコアを常時取得可能。

### 2. 🧹 Base64 インライン画像の自動パージ & 置換
- **コンテキスト窓の浪費防止**:
  - Web サイト内に埋め込まれた長大なインライン画像（`data:image/png;base64,...`）を自動検知し、Markdown 変換時に `![画像: alt属性]` へ自動置換してパージ。
- **画像保持オプション (`keepDataImages: true`)**:
  - Base64 データをそのまま保持したい場合は、`"keepDataImages": true` を指定することで置換をバイパス可能。

### 3. 🔒 SSRF 難読化 IP の 32bit 整数正規化 & IPv6 埋め込み完全遮断
- **バイパス攻撃の完全無力化**:
  - 8進数（`0177.0.0.1`）、16進数（`0x7f000001`）、32bit整数（`2130706433`）、省略記法（`127.1`）、および IPv4-mapped IPv6（`::ffff:127.0.0.1`）などの難読化されたプライベート IP 表現をすべて 32bit 符号なし整数へと数学的に正規化。
  - DNS 解決および HTTP リクエスト送信前に内部プライベート空間（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, CGNAT `100.64.0.0/10`）へのアクセスを確実に遮断。

### 4. ⚡ SPA 描画待機最適化 & Chromium 自動クリーンローテーション
- **動的適応待機（最大 850ms 短縮）**:
  - TimeTree や React/Next.js 等の SPA 描画時、本文要素の出現とローディングスピナーの消失をリアルタイム監視し、描画完了の瞬間に 350ms で即座に切り上げ。不要な固定待機（1,200ms）を排除。
- **共有 Chromium プロセスの自動ローテーション**:
  - 累積 200 回のブラウザレンダリング実行後、かつアクティブセッションが 0 のアイドル時に共有ブラウザを自動でクリーン再起動。長時間稼働に伴う Chromium のメモリリークやタブゾンビを根絶。

### 5. 🛑 グレースフルシャットダウン (Graceful Shutdown)
- **安全なリソース解放**:
  - `SIGTERM` / `SIGINT` シグナル受信時に、新規リクエストの受付停止、対話型ブラウザセッション（`closeAllBrowserSessions`）、共有 Chromium（`closeSharedBrowser`）、SQLite コネクション（`closeDatabase`）を安全にクローズしてクリーン終了。

### 6. 🏗️ REST ルーターのドメイン別モジュール分割
- **Fat Router の完全解消**:
  - `src/index.ts`（1,620 行）に集中していた 50 以上のエンドポイントを、Hono 標準の `app.route()` を用いて **9 つのドメイン別サブルーター**（`src/routes/`）へ分割・再構築：
    - `system.ts`: ヘルスチェック・メトリクス・OpenAPI・Docs・キャッシュクリア
    - `mcp_route.ts`: MCP Streamable HTTP / SSE プロトコル
    - `scrape.ts`: 単一・一括・ストリーミング・サイトマップ・クロール
    - `search.ts`: Web検索・リアルタイム速報・画像/動画/ニュース/知恵袋・乗換案内・音楽
    - `browser.ts`: ステルスブラウザ自動操作
    - `trade.ts`: 米国貿易コンプライアンス（HTS/FDA/CPSC/eFiling）
    - `public_data.ts`: 気象庁天気・警報・地震・道路交通・フライト・法令・国会会議録・標高
    - `watch.ts`: Web 差分監視
    - `media.ts`: マルチモーダル画像視覚入力
  - `src/index.ts` は 150 行のエントリポイントへと約 91% スリム化。

---

## 🧪 テスト・検証実績 (Testing & Verification)

- **自動テストスイート**: **全 209 テスト 100% PASS**（2,347 件の expect アサーション）
- **外部 API 互換性**: 既存の全 REST エンドポイント・MCP ツール仕様と 100% 完全互換
- **本番環境**: NixOS rootless Podman (krun / Firecracker) コンテナ `web-fetcher` にて v2.9.0 稼働確認済み

---

## 📦 アップグレード方法

### Docker / Podman
```bash
podman pull ghcr.io/ikenokazuki/sora:latest
# またはバージョン固定
podman pull ghcr.io/ikenokazuki/sora:2.9.0
```

### Claude Desktop / Cursor 設定 (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "sora": {
      "url": "http://localhost:3016/mcp"
    }
  }
}
```
