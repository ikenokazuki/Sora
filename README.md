# Sora (空)

> **日本のWebをAIエージェントから利用するための Self-hosted MCP / REST 統合サーバー**  
> *All-in-One, Zero-Middleware Web Scraping & Japanese Life Infrastructure Engine for AI Agents*

`Sora` は、LLM や AI エージェント（Claude Desktop, Cursor, Cline, OpenCodeInterpreter, Dify など）が **日本の Web 空間と日常インフラを自由かつ安全に探索・操作するための All-in-One MCP / REST サーバー** です。

外部 DB（Redis / PostgreSQL）やメッセージキューを一切必要とせず、**ヘッドレス Chromium と日本語 CJK フォントを内包した単一コンテナ / 単一バイナリ** だけで月800円の VPS から即座に稼働します。

```mermaid
flowchart LR
    subgraph Clients["AI Clients / Agents"]
        Claude["Claude Desktop / Cursor"]
        Agents["LangChain / AutoGen / Dify"]
    end

    subgraph Sora["Sora All-in-One (Distroless / Bun)"]
        direction TB
        MCP["MCP Server (Streamable HTTP / SSE)"]
        REST["Hono REST API (OpenAPI 3.0)"]
        Auth["Timing-Safe Auth & SSRF Guard"]
        LRU["True LRU In-Memory Cache"]
        
        subgraph Engine["Dual Scrape Engine"]
            Fast["Static Fetch + Readability + AI Chunker"]
            Browser["Stealth Chromium + Browser DSL (Tabs/Clicks)"]
        end

        subgraph JP["Japan Life Infrastructure"]
            JMA["気象庁 1,805自治体 天気予報"]
            Transit["Yahoo! 路線乗換・IC運賃"]
            Yahoo["Yahoo! リアルタイム(X)/知恵袋/ニュース/画像/動画"]
        end
    end

    subgraph Web["Public Internet"]
        Sites["Web Sites / PDFs / SPAs"]
        PublicData["気象庁 / Yahoo / X"]
    end

    Clients <-->|MCP / REST| Sora
    Fast --> Sites
    Browser --> Sites
    JP --> PublicData
```

---

## ⚡ 5秒で繋がる Quickstart (Claude Desktop / Cursor / Cline)

お使いの AI エージェントの設定ファイル（`claude_desktop_config.json` 等）に以下を追加するだけで、16種類の強力なツール群が即座に有効化されます。

### ① Remote MCP (HTTP / SSE) 接続
Sora コンテナを起動した状態で URL を指定します：

```json
{
  "mcpServers": {
    "sora": {
      "url": "http://localhost:3016/mcp"
    }
  }
}
```

### ② Docker / Podman での 1 コマンド起動
```bash
docker run -d -p 3016:8000 --name sora ghcr.io/ikenokazuki/sora:latest
```

---

## 🌟 主な特徴と強み (Why Sora?)

1. **🗾 日本の日常インフラ & Web 探索の完全網羅**:
   - 海外製ツール（Firecrawl / Tavily）では対応できない「Yahoo! 知恵袋」「X (Twitter) リアルタイム速報」「気象庁公式オープンデータ直結（全国 1,805 市区町村自動選定）」「電車乗換案内」を単一 MCP で提供。
2. **⚡ 圧倒的なミリ秒応答 & 超低消費メモリ**:
   - Bun ネイティブコンパイルにより、API 応答 **1.5ms**、常駐メモリ **JSヒープ ~32MB / 全体 ~140MB**。AI エージェントの待ち時間を極限まで短縮。
3. **📦 完全オールインワン & ゼロミドルウェア**:
   - Redis、PostgreSQL、外部ワーカーキュー等は一切不要。単一バイナリ / 単一コンテナだけで即座に完結。
4. **🛡️ Distroless（シェルなし）& 厳格なセキュリティ**:
   - ベースイメージに `gcr.io/distroless/cc-debian12` を採用。コンテナ内に `/bin/sh`, `bash`, `curl` 等が存在せず、RCE（任意コード実行）攻撃を無力化。
   - SSRF / DNS Rebinding 遮断、定数時間比較による Timing Attack 防止、ブラウザセッション所有権分離、DoS 防御（Body Limit 10MB）を標準装備。
5. **🕹️ ステートフルなブラウザ操作 DSL**:
   - `open` → `fill` → `click` → `screenshot` → `evaluate` の複数ターン対話型ブラウザセッションを API / MCP から直接制御。

---

### 📊 パフォーマンス & アーキテクチャ比較

| 項目 | Sora (本ツール) | Firecrawl (セルフホスト) | 一般的な Node/Python 製 MCP |
|---|---|---|---|
| **API / ヘルスチェック応答** | **1.5 ms** (`0.0015s`) | 20〜50 ms | 30〜100 ms |
| **起動時間 (コールドスタート)** | **< 10 ms** | 10〜30 秒 (複数サービス) | 1〜3 秒 |
| **常駐メモリ消費 (RSS)** | **約 140 MB** (JSヒープ ~32MB) | 2GB〜4GB+ | 250MB〜800MB |
| **イメージサイズ (Total)** | **約 1.18 GB** (Chromium+日本語フォント内包) | 4GB〜6GB+ (複数イメージ合計) | 800MB〜2.5GB |
| **必要なコンテナ構成** | **単一コンテナ (All-in-One)** | 5〜6 個 (Redis/PG/Workers) | 複数 MCP プロセスが乱立 |
| **セキュリティ設計** | **Distroless (シェルなし・非root)** | 通常 Debian/Alpine | 通常 Debian/Ubuntu |
| **日本のローカル情報** | **完全対応 (天気・乗換・知恵袋・X)** | 非対応 (Webのみ) | プラグイン個別導入が必要 |

---

### ⏱️ 各エンドポイントの実測応答速度 (Measured Latency: Cold vs Cached)

実機ローカルサーバーにおける「初回取得（非キャッシュ時）」と「キャッシュヒット時」の実測レイテンシ一覧です。AI エージェントが思考・生成する時間（1〜3秒）と比較して圧倒的に高速に応答します。

| エンドポイント | 初回取得 (非キャッシュ時) | キャッシュ時 (2回目以降) | 処理内容・技術特徴 |
|---|:---:|:---:|---|
| `GET /health` | **0.2 〜 1.8 ms** | — | API 死活監視・ヘルスチェック（Bun 最適化） |
| `GET /weather` (気象庁天気) | **約 38 ms** | **0.4 〜 0.7 ms** | 気象庁公式 CDN（`jma.go.jp`）直結パース＋1,805自治体自動選定 |
| `POST /scrape` (静的最速モード) | **約 79 ms** | **0.5 〜 1.0 ms** | Web ページの高速フェッチ＋Markdown 本文抽出 |
| `POST /scrape` (SPA自動昇格 / ブラウザ描画) | **約 1.2 〜 1.6 秒** | **0.5 〜 1.0 ms** | 静的取得で空白/Bot画面検知時に自動でStealth Chromiumへ昇格してMarkdown抽出 |
| `POST /transit/route` (乗換案内) | **約 390 ms** | **0.6 〜 7.0 ms** | Yahoo! 路線情報スクレイプ（最適経路・IC運賃計算） |
| `POST /search/realtime` (X速報) | **約 440 ms** | **0.6 ms** | Yahoo! リアルタイム検索（Xツイート＆画像抽出） |
| `POST /search/news` (ニュース) | **約 480 ms** | **0.6 ms** | Yahoo! ニュース最新記事検索 |
| `POST /search/image` / `video` | **450 〜 550 ms** | **0.6 ms** | Yahoo! 画像・動画検索 |
| `POST /search/chiebukuro` (知恵袋) | **420 〜 500 ms** | **0.6 ms** | Yahoo! 知恵袋 Q&A 検索 |
| `POST /search/suggest` (サジェスト) | **約 820 ms** | **0.5 ms** | Yahoo! オートコンプリート関連語補完 |
| `POST /browser/action` (初回実行) | **約 1.4 秒** | — | Stealth Chromium 起動＋描画＋クリック＋待機＋スクショ＋Markdown 抽出 |
| `POST /browser/action` (セッション継続) | **約 0.5 〜 0.8 秒** | — | 既存タブ（`sessionId`）上での追加アクション実行 |

#### ⚡ 内部エンリッチメント・AI最適化処理の実測速度 (In-Memory Latency)

外部 LLM API を介さず、すべて Bun ネイティブおよび最適化アルゴリズムにより **1ミリ秒未満（< 1ms）** で完結します。

| 処理・機能 | 処理時間 (1回あたり実測値) | 特徴・アルゴリズム |
|---|:---:|---|
| **読了時間・文字統計計算** (`calculateContentStats`) | **0.03 ms** (`31 µs`) | CJK/英単語の高速カウント＆推定読了時間算出 |
| **出典・引用リンク抽出** (`extractCitationsFromMarkdown`) | **0.06 ms** (`62 µs`) | 正規表現＋文脈コンテキストスライシング |
| **RAG セマンティック・チャンキング** (`chunkMarkdownContent`) | **0.13 ms** (`138 µs`) | 見出し・コードブロック境界を考慮したセマンティック分割 |
| **検索結果の重複・類似排除** (`dedupSearchResults`) | **0.33 ms** (`335 µs`) | 50件の N-gram Jaccard 類似度判定 |
| **PII 個人情報自動マスキング** (`maskPiiInText`) | **0.55 ms** (`557 µs`) | メール・電話・Luhn クレジットカード判定＆置換 |
| **超高速 抽出型自動要約 (TL;DR)** (`generateExtractiveSummary`) | **0.97 ms** (`970 µs`) | TF-IDF 類似の重要文抽出アルゴリズム |
| **検索語句 Markdown 強調ハイライト** (`highlightMatches`) | **9.1 ms** | 正規表現による構文安全な `<mark>` タグ挿入 |

---

## 🏛️ 設計思想 (Design Philosophy & Principles)

`Sora` は、以下の **4つのコア設計原則** に基づいて構築されています：

1. **✂️ オッカムの剃刀（Occam's Razor & Zero-Middleware）**:
   - *「必要が無いなら多くのものを定立してはならない。要件を満たす最も単純な構成が最良の構成である。」*
   - Redis、PostgreSQL、外部キュー、重厚なマイクロサービス群を一切排除。**「単一コンテナ・単一バイナリ」** だけで動作し、月800円の VPS や Raspberry Pi から数万リクエストのクラウドまで壊れずに常駐します。
2. **🛡️ ステルスと生還率のパレート最適（Stealth & Pareto Optimum）**:
   - 単に「0ms で機械的アクセス」をすれば、相手先サーバーの WAF や Cloudflare に即座に IP を BAN され、成功率は 0% に堕ちます。
   - 同一ドメインへの連続アクセス時に **150ms + Jitter（0〜100ms ゆらぎ）** を自動挿入し、タイピングにも **15〜40ms の人間的遅延** を付与。AI から見た体感速度を損なわずに **確実にデータを持ち帰る生還率** を最優先しています。
3. **🔒 ディストロレスによる堅牢なセキュリティ（Distroless by Design）**:
   - コンテナ内に `/bin/sh`, `bash`, `curl`, `apt` が存在しないため、万が一未知の脆弱性があっても攻撃者がシェルを奪取する余地（RCE: 任意コード実行）が原理的にありません。非 root 実行および厳格な SSRF 遮断を標準装備。
4. **🗾 公的オープンデータ直結・持続可能性（Sustainable & Autonomous）**:
   - 天気予報は気象庁公式オープンデータ CDN（`jma.go.jp`）へ直接アクセス。全国 1,805 市区町村名のゼロミリ秒自動解決と 30 分 LRU キャッシュにより、相手先サーバーへの負荷を最小限に抑えながら永久に自律稼働します。

---

## 1. クイックスタート

### 1.1 コンテナの起動 (Docker / Podman)

GitHub Container Registry (GHCR) から 1 コマンドで即座に起動できます:

```bash
docker run -d \
  --name sora \
  -p 3016:8000 \
  -e API_KEY="your-secret-api-key" \
  -e ENABLED_MODULES="all" \
  ghcr.io/ikenokazuki/sora:latest
```

### 1.2 MCP クライアント設定（Claude Desktop / Cursor / Cline / Windsurf 等）

#### Streamable HTTP 接続（推奨・標準）
設定ファイル（例: `claude_desktop_config.json` や Cursor の MCP 設定）に以下を追加します:

```json
{
  "mcpServers": {
    "sora": {
      "url": "http://localhost:3016/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-api-key"
      }
    }
  }
}
```

#### SSE 接続（レガシー SSE クライアント向け）
```json
{
  "mcpServers": {
    "sora": {
      "url": "http://localhost:3016/sse",
      "headers": {
        "Authorization": "Bearer your-secret-api-key"
      }
    }
  }
}
```
*(※ API キーが未設定の場合は `headers` を省略可能です)*

---

## 2. 提供 MCP ツール一覧 (全 16 ツール / 4つのモジュール)

Sora は、目的に応じて **4つの論理モジュール** で構成されています。環境変数 `ENABLED_MODULES`（デフォルト: `all`、または `web,browser,yahoo,life`）で有効化するカテゴリを自由にカスタマイズ可能です。

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Sora - Modular MCP                               │
├─────────────────┬───────────────────┬──────────────────┬─────────────────┤
│ 🌐 Core Web     │ 🤖 Browser Action │ 🇯🇵 Yahoo Services │ 🗾 Daily Life   │
│ (`web`)         │ (`browser`)       │ (`yahoo`)        │ (`life`)        │
│ ・search_web    │ ・browser_action  │ ・search_image   │ ・search_route  │
│ ・scrape        │   (クリック/入力/ │ ・search_video   │   (乗換案内)    │
│ ・scrape_batch  │    スクショ/JS実行│ ・search_news    │ ・get_weather   │
│ ・search_deep   │    セッション保持)│ ・search_chiebukuro│ (気象庁天気)  │
│ ・map_site      │                   │ ・search_realtime│                 │
│ ・crawl_site    │                   │ ・search_trend   │                 │
│                 │                   │ ・suggest_keywords│                │
└─────────────────┴───────────────────┴──────────────────┴─────────────────┘
```

### 🌐 Module 1: Core Web & Crawling (`ENABLED_MODULES=web`)
Web 検索と本文スクレイピング、一括並行取得、深層統合検索、サイトマップ解析、再帰クロール。

| ツール名 | 説明 | 識別プロパティ | 主要引数 |
|---|---|---|---|
| `search_web` | Web 検索を実行し、検索上位のタイトル・概要スニペット・URL を取得します。ドメイン絞り込み・除外・期間指定に対応。 | 各アイテムに `source: "web"` | - `query` (string, 必須): 検索キーワード<br>- `includeDomains` (string[], 任意): 絞り込むドメイン<br>- `excludeDomains` (string[], 任意): 除外するドメイン<br>- `updated` (string, 任意): 期間指定 (`"all"`, `"day"`, `"week"`, `"year"`) |
| `scrape` | 指定 URL の Web ページまたは PDF をスクレイピングし、本文を Markdown 形式で抽出します。SPA サイトや Bot 対策画面は自動で Chromium レンダリング。RAGチャンキング・出典抽出・読了時間・PII保護・テーブルJSON抽出・要約生成に対応。 | `source: "web"` | - `url` (string, 必須): 対象 URL / PDF<br>- `maxChars` (number, 任意): 最大文字数 (デフォルト: 10000)<br>- `mode` (string, 任意): `"auto"` (スマート自動判定, デフォルト), `"fast"` (静的最速), `"browser"` (Stealth Chromium)<br>- `formats` (string[], 任意): `["markdown", "html", "rawHtml", "links", "screenshot", "jsonLd", "images", "tables"]`<br>- `chunkMarkdown` (boolean, 任意): RAG用セマンティック・チャンキングを行うか<br>- `chunkSize` (number, 任意): チャンク文字数目安 (デフォルト: 1000)<br>- `extractCitations` (boolean, 任意): 出典・引用リンク一覧を抽出するか<br>- `validateLinks` (boolean, 任意): リンクの到達性・ステータスを並行検証するか<br>- `extractSummary` (boolean, 任意): 抽出型自動要約（TL;DR）を生成するか<br>- `maskPii` (boolean, 任意): メール・電話番号・クレカ等の個人情報を自動マスキングするか<br>- `formatAsPrompt` (boolean, 任意): LLM用標準XMLラッパー形式を生成するか<br>- `highlightMatches` (boolean, 任意): 検索一致語句をハイライトするか<br>- `webhookUrl` (string, 任意): 完了通知先 Webhook URL<br>- `onlyMainContent` (boolean, 任意): 記事本文のみ抽出するか (デフォルト: true)<br>- `selectors` (object, 任意): ピンポイント抽出用 CSS セレクタ連想配列<br>- `clipSelector` (string, 任意): 要素切り抜きスクショ用 CSS セレクタ<br>- `headers` / `cookies` (object/array, 任意): カスタムヘッダー / Cookie<br>- `removeSelectors` (string[], 任意): パージ対象ノイズセレクタ<br>- `retries` (number, 任意): リトライ回数 (0〜3)<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL |
| `scrape_batch` | 複数の Web ページ URL を指定し、ドメインスロットリングを維持しながら高速に並行スクレイピングして一括返却します。 | 各結果に `source: "web"` | - `urls` (string[], 必須): スクレイピング対象 URL 配列 (最大20件)<br>- `concurrency` (number, 任意): 並行ワーカー数 (デフォルト: 3, 最大: 5)<br>- (その他 `scrape` と同等の全オプションに対応) |
| `search_deep` | Firecrawl / Tavily 互換の統合深層検索。Web検索＋上位サイト本文自動スクレイプ＋リアルタイム検索を一度にまとめて取得します。 | Web結果に `source: "web"`<br>X結果に `source: "x"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 本文取得件数 (デフォルト: 5, 最大: 20)<br>- `scrapeContent` (boolean, 任意): 本文を含めるか (デフォルト: true)<br>- `includeRealtime` (boolean, 任意): リアルタイム検索も含めるか (デフォルト: true)<br>- `formats` (string[], 任意): `["markdown", "html", "rawHtml", "links", "screenshot"]`<br>- `onlyMainContent` (boolean, 任意): 記事本文のみ抽出するか (デフォルト: true)<br>- `extractHighlights` (boolean, 任意): 各ページからクエリ関連ハイライトを抽出するか (デフォルト: false)<br>- `includeDomains` / `excludeDomains` (string[], 任意)<br>- `updated` (string, 任意): 期間指定 (`"all"`, `"day"`, `"week"`, `"year"`)<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL |
| `map_site` | 指定した Web サイトの sitemap.xml や内部リンクを探索し、サイト内の全 URL 一覧（サイトマップ）を高速抽出します。 | - | - `url` (string, 必須): 対象のベース URL<br>- `limit` (number, 任意): 取得件数 (デフォルト: 200, 最大: 1000)<br>- `includeSubdomains` (boolean, 任意)<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL |
| `crawl_site` | 指定した URL 配下のページを再帰的にクロールし、複数ページの本文を一括収集します。 | 各結果に `source: "web"` | - `url` (string, 必須): クロール開始 URL<br>- `maxPages` (number, 任意): 最大取得ページ数 (デフォルト: 10, 最大: 50)<br>- `maxDepth` (number, 任意): 最大リンク深度 (デフォルト: 2)<br>- `formats` (string[], 任意): `["markdown", "html", "rawHtml", "links", "screenshot"]`<br>- `webhookUrl` (string, 任意): クロール完了時通知先 Webhook URL<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL |
---

### 💡 LLM / Agent 連携時のベストプラクティス & `limit` 調整ガイド

エージェントや RAG アプリケーションで Web 検索・スクレイピング・クロールを活用する際、取得件数（`limit`）の設定によってレイテンシや回答品質が大きく変化します。

#### 1. 取得件数を増やすメリット・デメリット

| 項目 | メリット | デメリット・リスク | 推奨設定 |
| :--- | :--- | :--- | :--- |
| **統合深層検索 (`/search`)** | より幅広いソースから情報を網羅できる。 | ・**レイテンシ増大**: 10〜20 サイトを並行取得すると応答時間が 5〜15 秒に遅延。<br>・**LLM コンテキスト肥大化**: 大量の全文を渡すとトークン消費が増大し、重要情報が埋もれる（*Lost in the Middle* 現象）。 | デフォルト `5`<br>(最大 `20`) |
| **サイト内クロール (`/crawl`)** | ドキュメント全体の網羅的なナレッジ収集が可能。 | ・**時間・リソース消費**: ページ数に比例して処理時間が増大。 | デフォルト `10`<br>(最大 `50`) |
| **サイトマップ探索 (`/map`)** | サイト全体の構造を瞬時に把握可能。 | ・テキスト処理のみのため負荷は極めて小さい。 | デフォルト `200`<br>(最大 `1000`) |

#### 2. 最も高精度な LLM 活用のベストプラクティス
> [!TIP]
> **より効果的なアプローチ**:
> 1. **スニペットと全文の使い分け**: 検索スニペット（`search_web`）自体は **10〜20 件** 返して概要を広く把握しつつ、全文スクレイプ対象（`search_deep` の `limit`）は **上位 3〜5 件に絞る** のが最も高速かつ高精度です。
> 2. **ハイライト抽出の併用**: `extractHighlights: true`（`query` 指定）を有効化すると、**Structure & Proximity-Aware BM25+ エンジン**（見出し文脈継承・フレーズ完全一致・近接度スコアリング・KWICスニペット生成）により、LLM は長いページ全体を読む代わりに**クエリに関連する最も重要な段落・センテンスのみを集中して読める**ため、ハルシネーションを防止しつつトークン消費を 70〜90% 削減できます（外部 LLM 不要、0.3ms でローカル動作）。
> 3. **全エンドポイント共通メタデータ (Firecrawl / Tavily 互換)**: `publishedTime`（公開日時/更新日時）、`author`（著者名）、`siteName`（サイト名）を OGP / JSON-LD / HTML メタタグから自動抽出し、Frontmatter および JSON レスポンスに付与。LLM が情報の鮮度（ファクトチェック）を瞬時に判定可能。
> 4. **GFM シンタックスハイライト言語の保持**: `<pre><code class="language-python">` 等からプログラミング言語名を正確に識別し、Markdown 出力時に ` ```python ` として再現。
> 5. **自動トークン圧縮 & ノイズ除去**: 空リンク、無効な JavaScript リンク、不要な重複空行を自動クレンジング（`cleanMarkdownTokens`）し、Cookie 同意バナー（OneTrust / Cookiebot 等）も完全パージするため、LLM コンテキストを常にクリーンに保ちます。
> 6. **robots.txt サイトマップ自動発見**: `/robots.txt` から変則配置された Sitemap URL を自動検出し、Sitemap Index を最大 1,000 件まで再帰走査。
> 7. **クロール時のストリーミング**: 多数のページを巡回する際は、`POST /crawl/stream`（SSE）を利用して 1 ページ取得完了ごとに逐次受信・処理することで、全体の完了を待たずに即座にユーザーや LLM へ中間応答を返せます。





#### 3. 実測ベンチマークとスケーラビリティ特性 (ローカル実測値)

| 処理 | 件数・ページ数 | 平均レイテンシ (ms) | スループット | 特性・備考 |
| :--- | :--- | :--- | :--- | :--- |
| **サイト内クロール** (`/crawl`) | `maxPages: 5` (旧デフォルト) | **358 ms** | 13.9 pages/sec | 3並行フェッチにより極めて高速 |
| | `maxPages: 10` (**新デフォルト**) | **341 ms** | **29.3 pages/sec** | 並行キューの効率化で旧デフォルトと同等の所要時間 |
| | `maxPages: 20` | **2,046 ms** | 9.8 pages/sec | 20ページの全文収集を約2秒で完了 |
| | `maxPages: 50` (**新上限**) | **4,685 ms** | 10.7 pages/sec | 50ページ巡回も 5秒未満で安定動作 |
| **サイトマップ探索** (`/map`) | `limit: 100` (旧デフォルト) | **826 ms** | - | XML/HTML パースのみで極めて軽量 |
| | `limit: 200` (**新デフォルト**) | **882 ms** | - | 100件時とほぼ変わらない応答速度 (+56ms) |
| | `limit: 1000` (**新上限**) | **808 ms** | - | 1,000件探索でもオーバーヘッドほぼゼロ |
| **統合深層検索** (`/search`) | `limit: 3` (旧デフォルト) | **約 1.4 秒** | - | Web検索 + 上位3件並行スクレイプ |
| | `limit: 5` (**新デフォルト**) | **約 2.0 〜 3.4 秒** | - | Web検索 + 上位5件並行スクレイプ |
| | `limit: 20` (**新上限**) | **約 4 〜 8 秒** | - | 幅広いソースのディープ調査用 |

---

### 🤖 Module 2: Browser Actions & Automation (`ENABLED_MODULES=browser`)
フォーム入力、ボタンクリック、画面スクロール、JavaScript 実行、スクリーンショット撮影、マルチターン対話セッション。

| ツール名 | 説明 | 識別プロパティ | 主要引数 |
|---|---|---|---|
| `browser_action` | Web ページを開き、指定された一連のアクションシーケンス（クリック・文字入力・キー押下・スクロール・待機・スクショ・JS実行・ページ遷移）を実行して最終画面の Markdown や Base64 スクリーンショットを返却。ボタンの「表示テキスト指定クリック」や `sessionId` によるマルチターン対話セッション維持に対応。 | `source: "browser"` | - `url` (string, 任意): 開始/遷移 URL<br>- `sessionId` (string, 任意): 既存セッションID<br>- `createSession` (boolean, 任意): セッションを作成・維持するか<br>- `closeSession` (boolean, 任意): セッションを終了するか<br>- `actions` (array, 任意): 実行アクション一覧 (`click`, `fill`, `press`, `select`, `scroll`, `wait`, `evaluate`, `navigate`)<br>- `extract` (object, 任意): `{ markdown: true, screenshot: true, html: false }`<br>- `timeout` (number, 任意): タイムアウト ms |

---

### 🇯🇵 Module 3: Yahoo! JAPAN Services (`ENABLED_MODULES=yahoo`)
日本のメディア・Q&A・トレンド・リアルタイム情報に完全特化した検索群。

| ツール名 | 説明 | 識別プロパティ | 主要引数 |
|---|---|---|---|
| `search_image` | Yahoo! JAPAN 画像検索を実行し、画像タイトル・画像URL・サムネイル・画像サイズ・ソース元ページを取得します。 | 各アイテムに `source: "image"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 20, 最大: 50) |
| `search_video` | Yahoo! JAPAN 動画検索を実行し、動画タイトル・動画URL・再生時間・配信元・サムネイルを取得します。 | 各アイテムに `source: "video"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 20, 最大: 50) |
| `search_news` | Yahoo!ニュース検索を実行し、最新ニュース記事のタイトル・概要・配信社・公開日時・記事URLを取得します。 | 各アイテムに `source: "news"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 10, 最大: 50) |
| `search_chiebukuro` | Yahoo!知恵袋 Q&A 検索を実行し、質問タイトル・回答数・解決ステータス・本文スニペットを取得します。 | 各アイテムに `source: "chiebukuro"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 10, 最大: 50) |
| `suggest_keywords` | Yahoo! JAPAN オートコンプリートサジェストを取得し、関連検索ワード・補完候補を返します。 | `source: "suggest"` | - `query` (string, 必須): 補完キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 10, 最大: 30) |
| `search_realtime` | Yahoo! リアルタイム検索を実行し、X (旧 Twitter) の最新ポスト（投稿者・本文・投稿日時・メディア・URL）を取得します。新着順 (`recent`) と 話題順 (`popular`) の切り替えに対応。 | 各アイテムに `source: "x"` | - `query` (string, 必須): 検索キーワード<br>- `sort` (string, 任意): `"recent"` (新着順, デフォルト) または `"popular"` (話題順)<br>- `limit` (number, 任意): 取得件数 (デフォルト: 20, 最大: 40)<br>- `page` (number, 任意): ページ番号 (デフォルト: 1) |
| `search_trend` | Yahoo リアルタイム検索の最新トレンド（急上昇キーワードランキング 20 件）を取得します。 | 各アイテムに `source: "x"` | - `limit` (number, 任意): 取得件数 (デフォルト: 20) |

---

### 🗾 Module 4: Japan Daily Life & Transit (`ENABLED_MODULES=life`)
日本の公共交通・気象庁公式オープンデータに直結した生活インフラ機能。

| ツール名 | 説明 | 識別プロパティ | 主要引数 |
|---|---|---|---|
| `search_route` | 日本国内の電車乗換案内。駅間の最適ルート・所要時間・乗換回数・IC/きっぷ運賃を探索。経由駅指定（最大3駅）、日時指定、特急/新幹線利用フラグに対応。 | `source: "transit"` | - `from` (string, 必須): 出発駅名 (例「東京」)<br>- `to` (string, 必須): 到着駅名 (例「新宿」)<br>- `via` (string[], 任意): 経由駅 (最大3駅)<br>- `timeType` (string, 任意): `"departure"`, `"arrival"`, `"first_train"`, `"last_train"`<br>- `ticket` (string, 任意): `"ic"`, `"cash"`<br>- `sortBy` (string, 任意): `"time"`, `"transfer"`, `"fare"` |
| `get_weather` | 気象庁公式オープンデータ直結による日本全国各地の今日・明日・明後日の天気予報、予想気温、降水確率、天気概況、風・波情報を取得。全国 1,805 市区町村名の自動解決に対応。 | `source: "weather"` | - `city` (string, 必須): 市区町村名 (例「天童市」「軽井沢」「箱根」「浦安」「東京」) または 地点ID (例「130010」)<br>- `days` (number, 任意): 予報日数 (1〜3日, デフォルト: 3) |

---

## 3. REST API 仕様

ベース URL: `http://localhost:3016` (またはデプロイ先のドメイン URL)

### 3.1 ヘルスチェック & メトリクス
#### `GET /health`
```json
{
  "status": "ok",
  "service": "sora",
  "cachedEntries": 0,
  "chromiumAvailable": true,
  "yahooMcpAvailable": true,
  "mcpConnected": true,
  "timestamp": "2026-08-21T05:54:26.782Z"
}
```

#### `GET /metrics` (運用統計・キャッシュヒット率・リソース使用量)
```json
{
  "status": "ok",
  "service": "sora",
  "uptimeSeconds": 1420,
  "cache": {
    "size": 42,
    "maxSize": 3000,
    "hits": 156,
    "misses": 48,
    "hitRatio": 0.7647
  },
  "activeSessions": 2,
  "chromium": {
    "available": true,
    "sharedConnected": true
  },
  "memory": {
    "rssMb": 86,
    "heapUsedMb": 34,
    "heapTotalMb": 58
  },
  "timestamp": "2026-08-22T04:20:00.000Z"
}
```

#### `GET /metrics?format=prometheus` または `Accept: text/plain` (Prometheus 監視用メトリクス)
Grafana / Prometheus 監視スタックにそのまま取り込める標準テキスト形式で出力します。
```text
# HELP sora_uptime_seconds Process uptime in seconds
# TYPE sora_uptime_seconds gauge
sora_uptime_seconds 1420
# HELP sora_memory_rss_bytes Resident set size in bytes
# TYPE sora_memory_rss_bytes gauge
sora_memory_rss_bytes 90177536
# HELP sora_cache_hits_total Total cache hits
# TYPE sora_cache_hits_total counter
sora_cache_hits_total 156
# HELP sora_cache_hit_rate Cache hit rate
# TYPE sora_cache_hit_rate gauge
sora_cache_hit_rate 0.7647
# HELP sora_active_browser_sessions Active browser sessions count
# TYPE sora_active_browser_sessions gauge
sora_active_browser_sessions 2
```

---

### 3.2 単一 URL / PDF スクレイプ (`POST /scrape`)
- **リクエスト**:
```json
{
  "url": "https://example.com/article",
  "maxChars": 30000,
  "mode": "auto",
  "formats": ["markdown", "jsonLd", "images", "links"],
  "onlyMainContent": true,
  "selectors": {
    "productName": "h1.product-title",
    "price": ".price-value",
    "buyLink": "a.btn-buy@href",
    "thumbnail": "img.main-photo@src"
  },
  "extractHighlights": true,
  "query": "新機能 リリース"
}
```
- **レスポンス例**:
```json
{
  "url": "https://example.com/article",
  "title": "最新アップデートのお知らせ",
  "content": "---\ntitle: \"最新アップデートのお知らせ\"\nurl: \"https://example.com/article\"\npublishedTime: \"2026-08-22T10:00:00Z\"\nauthor: \"開発チーム\"\nsiteName: \"Tech Blog\"\n---\n\n...",
  "isTruncated": false,
  "contentType": "text/html",
  "source": "web",
  "renderedWithBrowser": false,
  "publishedTime": "2026-08-22T10:00:00Z",
  "author": "開発チーム",
  "siteName": "Tech Blog",
  "extracted": {
    "productName": "Sora プレミアムキーボード",
    "price": "¥24,800",
    "buyLink": "https://example.com/cart/add?id=123",
    "thumbnail": "https://example.com/images/feature.png"
  },
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "最新アップデートのお知らせ"
    }
  ],
  "images": [
    {
      "url": "https://example.com/images/feature.png",
      "alt": "新機能の画面イメージ"
    }
  ],
  "highlights": [
    "本日より新機能の提供を開始いたします。"
  ]
}
```

> [!TIP]
> **🇯🇵 日本語レガシーサイト自動対応**: `Shift_JIS (CP932)` や `EUC-JP` の Web サイトも文字コードを自動判定してデコードします。文字化けの心配はありません。
> 
> **📄 PDF 抽出強化**: 複数ページの PDF ドキュメントは `<!-- Page 1 -->\n## Page 1` のようにページ番号区切りで構造化 Markdown 出力され、`totalPages` や作成者等のメタデータも自動抽出されます。
> 
> **✂️ 構文安全トリミング & トークン見積もり**: `maxChars` で文字数制限された場合でも、開いたコードブロック（` ``` `）やテーブルを自動的に安全に補正・閉鎖します。また、レスポンスには推定 LLM トークン数 `estimatedTokens` が付与されます。
> 
> **🧩 RAG 最適化セマンティック・チャンキング (`chunkMarkdown: true`)**: 見出し階層（H1〜H4）や段落・コードブロックを壊さず適切に分割された `chunks: [{ index, heading, content, estimatedTokens }]` を自動生成し、ベクトル検索や RAG へ即座に投入できます。
> 
> **🖼️ 画像メタデータ & キャプション抽出 (`formats: ["images"]`)**: 各画像について URL に加え、`<figcaption>` の説明文（`caption`）、`width`/`height`、およびアイキャッチ判定（`isMainImage`）を自動抽出します。
> 
> **🔗 ページ内リンクの健全性・到達性判定 (`validateLinks: true`)**: ページ内のリンクに対して軽量な並行検証を行い、HTTP ステータスと有効性 `linksWithStatus: [{ url, status, ok }]` を返却します。
> 
> **📚 出典・引用リンク構造化抽出 (`extractCitations: true`)**: 本文中の外部リンクや参考文献をコンテキスト文付きで `citations: [{ text, url, context }]` として自動抽出します。
> 
> **⏱️ 読了時間 & 文字・単語数統計**: 本文から `characterCount`、`wordCount`、および言語特性に応じた推定読了時間 `readingTimeMin`（分数）を自動算出して付与します。
> 
> **🔔 非同期 Webhook コールバック (`webhookUrl`)**: 長時間バッチ処理や大規模クロール完了時に、指定したエンドポイントへ非同期で結果ペイロードを HTTP POST 通知します。
> 
> **🛡️ PII 自動マスキング (`maskPii: true`)**: メールアドレス、日本の電話番号、クレジットカード番号（Luhn検証）などの機密情報を自動で `[EMAIL]`, `[PHONE]`, `[CREDIT_CARD]` に伏字化して LLM への送信を保護します。
> 
> **📡 進行状況リアルタイム SSE ストリーミング (`POST /scrape/stream`)**: `start` → `fetch` → `render` → `enrich` → `done` の各ステージ進行イベントをリアルタイムに Server-Sent Events で受信可能です。
> 
> **🎬 YouTube / 動画メディアメタデータ & チャプター抽出 (`media`)**: 動画ページから再生時間、サムネイル、チャプター一覧（タイムスタンプ付き目次）を自動構造化抽出します。
> 
> **🤖 LLM 最適化プロンプト XML 自動生成 (`formatAsPrompt: true`)**: Claude / GPT / Gemini が最も理解しやすい標準的な `<web_page url="..." title="...">...</web_page>` 形式のコンテキストラッパー `promptContext` を自動生成します。
> 
> **🖍️ 検索キーワードの本文自動強調 (`highlightMatches: true`)**: 指定した `query` のキーワードを本文 Markdown 内で `<mark>キーワード</mark>` として強調表示した `highlightedContent` を取得できます。
> 
> **📊 テーブル構造化 JSON 抽出 (`formats: ["tables"]`)**: ページ内の表（`<table>`）を `{ caption, headers, rows }` の構造化 JSON 配列としてダイレクトに取得可能です。
> 
> **⚡ 超高速 抽出型自動要約 (`extractSummary: true`)**: 外部 LLM API を呼ばず、内部アルゴリズムによりミリ秒単位で重要文（TL;DR 要約）`summary: string[]` を自動生成します。
> 
> **🎯 検索結果の重複排除 (`dedup: true`)**: ニュース検索やリアルタイム検索で、コピペ投稿や転載記事を類似度判定で自動排除し、ユニークな情報のみを厳選します。
> 
> **🔄 自動リトライポリシー (`retries` & `retryDelayMs`)**: 接続失敗や 429/503 エラー時に指数バックオフで自動再試行し、耐障害性を向上させます。
> 
> **📸 要素指定スクリーンショット (`clipSelector`)**: 特定の要素（例: `clipSelector: "#stock-chart"`）を指定することで、その要素のみを切り抜いた Base64 PNG を取得できます。
> 
> **🍪 カスタムヘッダー & Cookie 注入 (`headers` / `cookies`)**: 会員サイトや言語指定（`Accept-Language`）、年齢認証 Cookie などを透過的に送信可能です。
> 
> **🧹 ユーザー指定ノイズセレクタ除去 (`removeSelectors`)**: `removeSelectors: [".ad", ".comments", "#related-articles"]` を指定し、特定ブロックを Markdown 変換前に徹底パージできます。
> 
> **📖 対話型 API ドキュメント (`GET /docs`)**: ブラウザから `http://localhost:3016/docs` にアクセスすると、Swagger UI から全 API を直接テスト実行（Try it out）できます。

---

### 3.2.1 複数 URL 一括並行スクレイプ (`POST /scrape/batch`)

複数の Web ページ URL を指定し、ドメイン別スロットリングを維持しながら高速にサーバー側で並行フェッチして一括取得します。

- **リクエスト (POST)**:
```json
{
  "urls": [
    "https://example.com/page1",
    "https://example.com/page2",
    "https://example.com/page3"
  ],
  "concurrency": 3,
  "maxChars": 10000,
  "mode": "auto",
  "formats": ["markdown", "jsonLd"]
}
```
- **レスポンス例**:
```json
{
  "total": 3,
  "successful": 3,
  "failed": 0,
  "results": [
    {
      "url": "https://example.com/page1",
      "title": "Page 1 Title",
      "content": "...",
      "estimatedTokens": 450
    }
  ],
  "errors": []
}
```

---

### 3.3 対話型ブラウザ自動操作 (`POST /browser/action` または `POST /action`)

Web ページを開き、クリック・テキスト入力・スクロール・待機・スクリーンショット撮影などの一連のアクションを順次実行して最終結果を取得します。**ワンショット実行** と、チャットで対話しながら操作を進める **ステートフル・マルチターン対話セッション (`sessionId`)** の両方に対応しています。

#### ① ワンショット実行（1回完結）
- **リクエスト (POST)**:
```json
{
  "url": "https://example.com/search",
  "actions": [
    { "type": "fill", "selector": "input[name='q']", "text": "Sora" },
    { "type": "click", "text": "検索" },
    { "type": "wait", "selector": ".results-container", "ms": 5000 },
    { "type": "scroll", "direction": "down", "distance": 1000 }
  ],
  "extract": {
    "markdown": true,
    "screenshot": true,
    "html": false
  },
  "timeout": 30000
}
```

- **レスポンス例**:
```json
{
  "source": "browser",
  "url": "https://example.com/search?q=Sora",
  "title": "検索結果 - Sora",
  "content": "---\ntitle: \"検索結果 - Sora\"\nurl: \"https://example.com/search?q=Sora\"\n---\n\n# 検索結果\n...",
  "screenshot": "iVBORw0KGgoAAAANSUhEUgA...",
  "actionLogs": [
    { "step": 1, "type": "fill", "target": "input[name='q']", "success": true, "elapsedMs": 42 },
    { "step": 2, "type": "click", "target": "検索", "success": true, "elapsedMs": 115 },
    { "step": 3, "type": "wait", "target": ".results-container", "success": true, "elapsedMs": 620 },
    { "step": 4, "type": "scroll", "target": undefined, "success": true, "elapsedMs": 510 }
  ],
  "renderedWithBrowser": true
}
```

#### ② ステートフル・マルチターン対話セッション（対話型チャット向け）
- **Turn 1 (セッション作成 & 画面オープン)**:
```json
{
  "url": "https://example.com/login",
  "createSession": true,
  "actions": [
    { "type": "fill", "selector": "#username", "text": "myuser" }
  ],
  "extract": { "screenshot": true }
}
```
*(レスポンスで `"sessionId": "sess_a1b2c3d4"` が返却されます)*

- **Turn 2 (開いたままの画面で続けて操作)**:
```json
{
  "sessionId": "sess_a1b2c3d4",
  "actions": [
    { "type": "fill", "selector": "#password", "text": "mypassword" },
    { "type": "click", "text": "ログイン" },
    { "type": "wait", "selector": "#dashboard" }
  ],
  "extract": { "markdown": true }
}
```

- **Turn 3 (セッション終了 & クリーンアップ)**:
```json
{
  "sessionId": "sess_a1b2c3d4",
  "closeSession": true
}
```
*(※ 操作が 5 分間途切れた場合も自動タイムアウトで安全にメモリ解放されます)*

---

### 3.4 統合深層検索 (`POST /search`) & Web 検索 (`POST /search/web`)
- **深層検索リクエスト (`POST /search`)**:
```json
{
  "query": "2026年 AI 最新トレンド",
  "limit": 5,
  "scrapeContent": true,
  "includeRealtime": true,
  "updated": "week",
  "formats": ["markdown"]
}
```
- **HTML 形式で取得する場合**:
```json
{
  "query": "React 19 新機能",
  "formats": ["html"]
}
```
- **重要ハイライトのみ抽出する場合 (トークン節約モード)**:
```json
{
  "query": "React 19 新機能 変更点",
  "extractHighlights": true
}
```
- **Web 検索リクエスト (`POST /search/web`)**:

```json
{
  "query": "新商品 発売情報",
  "includeDomains": ["example.com", "news.example.org"],
  "excludeDomains": ["spam.example.com"],
  "updated": "week"
}
```

---

### 3.4.1 サイトマップ探索 (`POST /map`)
指定ドメインの `sitemap.xml` や内部リンクを探索し、サイト内の全 URL リストを抽出します。
- **リクエスト**:
```json
{
  "url": "https://example.com",
  "limit": 200,
  "includeSubdomains": false
}
```

---

### 3.4.2 サブページ再帰的クロール (`POST /crawl` & `POST /crawl/stream`)
指定 URL から配下ページを再帰的に巡回し、複数ページの Markdown/HTML/画像/構造化データを一括収集します。`includePatterns` / `excludePatterns` による Glob ワイルドカードフィルタリングに対応。
- **リクエスト (一括取得)**:
```json
{
  "url": "https://example.com/docs",
  "maxPages": 20,
  "maxDepth": 2,
  "includePatterns": ["/docs/**", "/guide/*"],
  "excludePatterns": ["/tag/**", "*.pdf"],
  "formats": ["markdown", "jsonLd", "images"]
}
```
- **SSE ストリーミング (`POST /crawl/stream`)**: ページが取得されるたびにリアルタイムで Server-Sent Events（`start` -> `page` -> `done`）を配信。

---

### 3.5 画像・動画・ニュース・知恵袋・サジェスト検索
- **画像検索 (`POST /search/image`)**: `{ "query": "富士山", "limit": 10 }`
- **動画検索 (`POST /search/video`)**: `{ "query": "簡単 レシピ", "limit": 10 }`
- **ニュース検索 (`POST /search/news`)**: `{ "query": "AI ロボット", "limit": 10 }`
- **知恵袋 Q&A (`POST /search/chiebukuro`)**: `{ "query": "プログラミング 初心者", "limit": 10, "status": "solved" }`
- **キーワード補完 (`POST /search/suggest`)**: `{ "query": "天気", "limit": 10 }`

---

### 3.6 電車乗換案内 (`POST /transit/route`)
- **リクエスト**:
```json
{
  "from": "東京",
  "to": "新宿",
  "sortBy": "time"
}
```
- **レスポンス例**:
```json
{
  "source": "transit",
  "from": "東京",
  "to": "新宿",
  "count": 3,
  "routes": [
    {
      "rank": 1,
      "summary": {
        "departureTime": "09:30",
        "arrivalTime": "09:44",
        "durationMinutes": 14,
        "transferCount": 0,
        "fare": {
          "ic": 209,
          "ticket": 210
        },
        "flags": {
          "isFastest": true,
          "isCheapest": true,
          "isEasiest": true
        }
      },
      "sections": [
        {
          "type": "move",
          "line": "ＪＲ中央線快速・高尾行",
          "from": "東京",
          "departureTime": "09:30",
          "to": "新宿",
          "arrivalTime": "09:44"
        }
      ]
    }
  ]
}
```

---

### 3.7 日本全国 天気予報 (`POST /weather` / `GET /weather` / `GET /weather/:city`)

気象庁公式オープンデータ API（および livedoor 天気互換形式）を直接解析し、日本全国の今日・明日・明後日の詳細な気象データを完全自律で取得します。

#### 本機能の利点 (Features & Advantages)
- **完全自律・公式直結（ゼロ依存）**: 気象庁の公式 CDN（`jma.go.jp`）から直接気象データを取得・パース。
- **全国 1,805 市区町村のスマート自動解決**: 気象庁公式のエリア定義（`area.json`）を内蔵。「天童市」「軽井沢」「箱根」「浦安」「別府」などの市区町村名・有名地名から、担当する気象台の地点 ID を 0ms で自動選定。県名なしの入力にも対応。
- **AI エージェントフレンドリーな構造化データ**: 3日間の天気テロップ、風・波、予想最高/最低気温（℃）、時間帯別降水確率（0-6時, 6-12時, 12-18時, 18-24時）、気象台発表の天気概況文（見出し・本文）をクリーンな JSON で一括取得。
- **LRU キャッシュによる超高速応答**: 30分間のインメモリ LRU キャッシュを標準搭載し、気象庁サーバーへの不要な重複アクセスを自動防止。

- **リクエスト (POST)**:
```json
{
  "city": "天童市",
  "days": 3
}
```
- **GET リクエスト**: `GET /weather?city=軽井沢&days=2` または `GET /weather/箱根`
- **レスポンス例**:
```json
{
  "source": "weather",
  "cityId": "060010",
  "title": "村山 の天気",
  "publishedTime": "2026-08-21T17:00:00+09:00",
  "publicTime": "2026-08-21T17:00:00+09:00",
  "publishingOffice": "山形地方気象台",
  "location": {
    "area": "東北",
    "prefecture": "山形県",
    "city": "天童市"
  },
  "overview": "前線が、日本海から東北地方を通って、日本の東にのびています。村山地方では、夜遅くにかけて雷を伴い激しい雨が降る所がある見込みです。",
  "description": {
    "headline": "",
    "body": "前線が、日本海から東北地方を通って、日本の東にのびています...",
    "text": "..."
  },
  "forecasts": [
    {
      "date": "2026-08-21",
      "dateLabel": "今日",
      "telop": "曇り",
      "detail": {
        "weather": "くもり　所により　夕方　雨　で　雷を伴い　激しく　降る",
        "wind": "北の風　後　南東の風",
        "wave": null
      },
      "temperature": {
        "min": "22℃",
        "max": "31℃"
      },
      "chanceOfRain": {
        "T00_06": "30%",
        "T06_12": "0%",
        "T12_18": "0%",
        "T18_24": "30%"
      },
      "image": "https://www.jma.go.jp/bosai/forecast/img/200.svg"
    }
  ]
}
```

---

### 3.8 Yahoo リアルタイム検索 & トレンド (`POST /search/realtime` / `POST /search/trend`)
- **リアルタイム検索 (`POST /search/realtime`)**: `{ "query": "イベント名", "sort": "popular", "limit": 20, "page": 1 }`
  - `sort`: `"recent"` (新着順, デフォルト) または `"popular"` (話題順 / エンゲージメント順)
  - 各ポストに `publishedTime` (ISO 8601 文字列), `author` (ユーザー名 + @アカウント名), `siteName: "X (Twitter)"` が統一フォーマットで自動付与されます。
- **急上昇トレンド (`POST /search/trend`)**: `{ "limit": 20 }`

---

### 3.9 サイトマップ & クロール (`POST /map` / `POST /crawl`)
- **サイトマップ (`POST /map`)**: `{ "url": "https://example.com", "limit": 200 }`
- **再帰クロール (`POST /crawl`)**: `{ "url": "https://example.com/docs", "maxPages": 10 }`


---

## 4. セキュリティ & アーキテクチャ

### 4.1 ディストロレス (Distroless) コンテナ設計
- **ベースイメージ**: `gcr.io/distroless/cc-debian12`
- **シェルなし・パッケージマネージャなし**: コンテナ内に `/bin/sh` や `apt`、`curl` は一切存在せず、攻撃者がシェルを奪取する余地がありません。
- **最小権限設計**: 非 root 実行に対応し、Docker / Podman / Kubernetes などの標準コンテナ環境で安全に隔離・実行可能。

### 4.2 セキュリティ & パフォーマンス機能
- **🛡️ 多重 SSRF & DNS Rebinding 防御**:
  - プライベート IP（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8` 等）、CGNAT（`100.64.0.0/10`）、IPv6 特殊アドレス、クラウドメタデータ IP（`169.254.169.254`）への内部アクセスを遮断。
  - `dns.promises.lookup` による事前名前解決を行い、ドメイン偽装による **DNS Rebinding 攻撃** も接続前に即時ブロック。
- **⚡ Single-Flight Cache (In-flight Deduplication)**:
  - 同一 URL への並行リクエスト発生時、Promise を共有して 1 回の外部通信に集約。Thundering Herd（キャッシュスタンピード）を防ぎ、外部サーバーとローカルリソースを保護。
- **🚦 ブラウザ同時実行制限 (Concurrency Control)**:
  - `SimpleSemaphore` により Chromium プロセスの同時実行数（`MAX_CONCURRENT_BROWSERS`、デフォルト 5）を安全に制御。サーバーの CPU/メモリ枯渇を防止。
- **🔒 Timing-Safe 認証 & Browser Session 所有権紐付け**:
  - API キー照合には `crypto.timingSafeEqual` + SHA-256（定数時間比較）を採用し、Timing Attack を防御。
  - Multi-turn ブラウザセッション（`sessionId`）を作成者トークンと暗号学的に紐付け、他者からのセッション乗っ取りを防止。
- **🛡️ 任意 JavaScript 実行の安全制御スイッチ (`ALLOW_BROWSER_EVALUATE`)**:
  - 環境変数 `ALLOW_BROWSER_EVALUATE=false` または `SAFE_BROWSER_MODE=true` により、`/browser/action` での `evaluate` スクリプト実行を即座に無効化・ロックダウン可能。
- **📐 共通 Zod スキーマ & OpenAPI 3.0 完全自動生成**:
  - REST / MCP 双方で Zod スキーマによる入力検証を統一。
  - `/openapi.json` はコード側の Zod スキーマから OpenAPI 3.0 仕様を **100% 動的自動生成** し、ドキュメントの乖離を完全防止。
  - エラーレスポンスは `{ "error": "...", "code": "SSRF_BLOCKED", "status": 403, "retryable": false }` のように AI エージェントが自己修復・自律判断しやすい構造を提供。
- **⏱️ Jitter スロットリング & 真の LRU キャッシュ**:
  - 同一ドメインへの過剰な連続アクセスを 150ms + Jitter（0〜100ms ゆらぎ）で自動抑制。
  - 15〜30分間の真の LRU（アクセス時最新化）キャッシュと 10分おきの定期 TTL スイープにより、メモリリークを完全防止。

---

## 5. 謝意・クレジット (Acknowledgments)

`Sora` は、以下の優れたオープンソースプロジェクト、公開サービス、公的オープンデータ、およびライブラリ作者の皆様の素晴らしい貢献に支えられています。心より感謝申し上げます。

### 🗾 データソース & 着想元 (Data Sources & Inspirations)
- **気象庁（JMA）オープンデータ**: [jma.go.jp](https://www.jma.go.jp/)
  - 日本全国の高精度な気象予報・防災データおよび全国 1,800 以上のエリア定義データのオープン公開に深く感謝いたします。
- **天気予報 API（livedoor 天気互換）設計着想**: [tsukumijima/weather-api](https://github.com/tsukumijima/weather-api) / [weather.tsukumijima.net](https://weather.tsukumijima.net/)
  - livedoor 天気互換フォーマットの分かりやすいスキーマ設計と長年のコミュニティ貢献に感謝いたします。
- **Yahoo Japan Search MCP**: [mouseos/Yahoo-Japan-Search-MCP](https://github.com/mouseos/Yahoo-Japan-Search-MCP)
  - Yahoo! JAPAN の画像・動画・ニュース・知恵袋・サジェスト検索の MCP 実装に感謝いたします。
- **norikae-mcp**: [tysonwu/norikae-mcp](https://github.com/tysonwu/norikae-mcp)
  - Yahoo! 路線情報スクレイピングによる乗換案内ロジックの設計・実装に感謝いたします。

### 🛠️ 基盤オープンソース・ライブラリ (Core Libraries & Ecosystem)
- **[Hono](https://hono.dev/)** ([@yusukebe](https://github.com/yusukebe)) — 超高速 Web API フレームワーク & MCP 統合
- **[Puppeteer](https://pptr.dev/)** (Google Chrome Team) — ヘッドレス Chromium 制御・ステルス操作
- **[Readability](https://github.com/mozilla/readability)** (Mozilla) — リーダーモード記事本文抽出エンジン
- **[Cheerio](https://cheerio.js.org/)** (cheeriojs team) — 高速 DOM 解析 & メタデータ抽出
- **[Turndown](https://github.com/mixmark-io/turndown)** ([Dom Christie](https://github.com/domchristie)) — HTML to Markdown コンバーター
- **[LinkeDOM](https://github.com/WebReflection/linkedom)** ([Andrea Giammarchi](https://github.com/WebReflection)) — 超軽量インメモリ DOM エンジン
- **[unpdf](https://github.com/unjs/unpdf)** (UnJS Team) — 高速・軽量 PDF テキスト抽出
- **[Model Context Protocol SDK](https://github.com/modelcontextprotocol)** (Anthropic / MCP Team) — 次世代 AI ツール接続規格

---

## 6. 免責事項 (Disclaimer)

- **非公式サードパーティ製ツール**:
  - 本ソフトウェアは、個人開発・学術研究・自社内利用を目的として開発された非公式（サードパーティ製）ツールです。
- **商標について**:
  - 「Yahoo!」「Yahoo! JAPAN」および各サービス名は、LINEヤフー株式会社の商標または登録商標です。本プロジェクトは LINEヤフー株式会社とは一切関係ありません。
- **利用規約・法令の遵守**:
  - 各外部サービス（Yahoo! JAPAN、気象庁等）へのアクセスにあたっては、相手先サービスの利用規約、ガイドライン、robots.txt、および適用法令を遵守し、過度な負荷をかけないよう利用者自身の責任においてご利用ください。
- **責任の限定**:
  - 本ソフトウェアの利用により生じたいかなる損害（相手先サービスからのアクセス制限、データの完全性・正確性・最新性等を含む）について、本プロジェクトの開発者は一切の責任を負いません。

---

## 7. ライセンス (License)

本ソフトウェアは **[Business Source License 1.1 (BSL 1.1 / BUSL-1.1)](LICENSE)** の下で公開されています。

- **自由・無料にご利用いただける用途**:
  - 個人開発、学術研究、非商用利用
  - 企業・組織内での自社システム向けセルフホスト利用（自社製品や社内ツールを支える内部バックエンドとして動作させること）
  - ソースコードの改変・フォーク・内部共有
- **禁止事項 (Restriction)**:
  - 本ソフトウェア（またはその派生物）を、第三者向けの「有料クラウドサービス」「有料スクレイピング / 検索 API サービス」「マネージドサービス」として提供・再販すること。
- **Change Date (オープンソース転換日)**:
  - **2030年8月1日**（またはそれ以前）に、自動的に完全な **MIT License** に転換されます。

詳細については [LICENSE](LICENSE) をご確認ください。

Copyright (c) 2026 ikeno
