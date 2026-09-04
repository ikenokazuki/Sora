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
