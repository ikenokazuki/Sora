# GhostFetch

> **Ultra-fast, Stealth Web Scraping & Deep Search Engine with MCP (Model Context Protocol)**  
> *(Firecrawl & Tavily Alternative / Distroless / Source-Available)*

`GhostFetch` は、Web ページや PDF の超高速スクレイピング（Markdown 変換・メタデータ抽出・SPA 自動 Chromium レンダリング・Bot 検知回避）、Web 検索（ドメイン絞り込み対応）、Yahoo Japan リアルタイム検索（X/Twitter ポスト・画像・トレンド取得）、サイトマップ探索 (`/map`)、サブページ再帰クロール (`/crawl`)、電車乗換案内、日本全国天気予報（気象庁オープンデータ直結・1,805 自治体自動解決）、およびこれらを統合した深層検索を提供する All-in-One サービスです。

標準的な **REST API** および **MCP サーバー**（Streamable HTTP / SSE）としてセルフホストして利用できます。

すべての検索・スクレイピング結果には、情報ソースが Web ページ由来なのか X (Twitter) 由来なのかを即座に判別できる `source: "web" | "x" | "image" | "video" | "news" | "chiebukuro" | "suggest" | "transit" | "weather"` プロパティが付与されます。

---

## 🌟 主な特徴と強み (Core Selling Points)

1. **⚡ 圧倒的なミリ秒応答 & 超低消費メモリ**:
   - Bun ネイティブコンパイルバイナリにより、API 応答 **1.5ms**、常駐メモリわずか **~56MB** を達成。AI エージェントの応答待ち時間を極限まで短縮。
2. **📦 完全オールインワン & ゼロミドルウェア**:
   - Redis、PostgreSQL、外部ワーカーキュー等は一切不要。**ヘッドレス Chromium と日本語 CJK フォントを内包した単一コンテナ** だけで、月800円の極小 VPS でもフル稼働。
3. **🛡️ Distroless（シェルなし）による強固なセキュリティ**:
   - ベースイメージに `gcr.io/distroless/cc-debian12` を採用。コンテナ内に `/bin/sh`、`bash`、`apt`、`curl` が存在せず、未知の脆弱性によるシェル奪取・RCE（任意コード実行）攻撃を原理的に無力化。
4. **🗾 日本の日常インフラ & Web 探索の完全網羅**:
   - 海外製ツール（Firecrawl / Tavily）では不可能な「Yahoo! 知恵袋」「X (Twitter) リアルタイム速報」「気象庁公式データ直結・全国 1,805 自治体の天気」「電車乗換案内」を単一 MCP で提供。

---

### 📊 パフォーマンス & アーキテクチャ比較

| 項目 | GhostFetch (本ツール) | Firecrawl (セルフホスト) | 一般的な Node/Python 製 MCP |
|---|---|---|---|
| **API / ヘルスチェック応答** | **1.5 ms** (`0.0015s`) | 20〜50 ms | 30〜100 ms |
| **起動時間 (コールドスタート)** | **< 10 ms** | 10〜30 秒 (複数サービス) | 1〜3 秒 |
| **常駐メモリ消費 (RSS)** | **約 56 MB** (単体バイナリ) | 2GB〜4GB+ | 250MB〜800MB |
| **イメージサイズ (Total)** | **約 1.18 GB** (Chromium+日本語フォント内包) | 4GB〜6GB+ (複数イメージ合計) | 800MB〜2.5GB |
| **必要なコンテナ構成** | **単一コンテナ (All-in-One)** | 5〜6 個 (Redis/PG/Workers) | 複数 MCP プロセスが乱立 |
| **セキュリティ設計** | **Distroless (シェルなし・非root)** | 通常 Debian/Alpine | 通常 Debian/Ubuntu |
| **日本のローカル情報** | **完全対応 (天気・乗換・知恵袋・X)** | 非対応 (Webのみ) | プラグイン個別導入が必要 |

---

## 1. クイックスタート

### 1.1 コンテナの起動 (Docker / Podman)

GitHub Container Registry (GHCR) から 1 コマンドで即座に起動できます:

```bash
docker run -d \
  --name ghostfetch \
  -p 3016:8000 \
  -e API_KEY="your-secret-api-key" \
  -e ENABLED_MODULES="all" \
  ghcr.io/ikenokazuki/ghostfetch:latest
```

### 1.2 MCP クライアント設定（Claude Desktop / Cursor / Cline / Windsurf 等）

#### Streamable HTTP 接続（推奨・標準）
設定ファイル（例: `claude_desktop_config.json` や Cursor の MCP 設定）に以下を追加します:

```json
{
  "mcpServers": {
    "ghostfetch": {
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
    "ghostfetch": {
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

## 2. 提供 MCP ツール一覧 (全 15 ツール / 4つのモジュール)

GhostFetch は、目的に応じて **4つの論理モジュール** で構成されています。環境変数 `ENABLED_MODULES`（デフォルト: `all`、または `web,browser,yahoo,life`）で有効化するカテゴリを自由にカスタマイズ可能です。

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      GhostFetch - Modular MCP                            │
├─────────────────┬───────────────────┬──────────────────┬─────────────────┤
│ 🌐 Core Web     │ 🤖 Browser Action │ 🇯🇵 Yahoo Services │ 🗾 Daily Life   │
│ (`web`)         │ (`browser`)       │ (`yahoo`)        │ (`life`)        │
│ ・search_web    │ ・browser_action  │ ・search_image   │ ・search_route  │
│ ・scrape        │   (クリック/入力/ │ ・search_video   │   (乗換案内)    │
│ ・search_deep   │    スクショ/JS実行│ ・search_news    │ ・get_weather   │
│ ・map_site      │                   │ ・search_chiebukuro│ (気象庁天気)  │
│ ・crawl_site    │                   │ ・search_realtime│                 │
│                 │                   │ ・search_trend   │                 │
│                 │                   │ ・suggest_keywords│                │
└─────────────────┴───────────────────┴──────────────────┴─────────────────┘
```

### 🌐 Module 1: Core Web & Crawling (`ENABLED_MODULES=web`)
Web 検索と本文スクレイピング、深層統合検索、サイトマップ解析、再帰クロール。

| ツール名 | 説明 | 識別プロパティ | 主要引数 |
|---|---|---|---|
| `search_web` | Web 検索を実行し、検索上位のタイトル・概要スニペット・URL を取得します。ドメイン絞り込み・除外・期間指定に対応。 | 各アイテムに `source: "web"` | - `query` (string, 必須): 検索キーワード<br>- `includeDomains` (string[], 任意): 絞り込むドメイン<br>- `excludeDomains` (string[], 任意): 除外するドメイン<br>- `updated` (string, 任意): 期間指定 (`"all"`, `"day"`, `"week"`, `"year"`) |
| `scrape` | 指定 URL の Web ページまたは PDF をスクレイピングし、本文を Markdown 形式で抽出します。SPA サイトや Bot 対策画面（Cloudflare Turnstile 等）は自動で Chromium レンダリング。プロキシ対応。 | `source: "web"` | - `url` (string, 必須): 対象 URL / PDF<br>- `maxChars` (number, 任意): 最大文字数 (デフォルト: 30000)<br>- `mode` (string, 任意): `"auto"` (スマート自動判定, デフォルト), `"fast"` (静的最速), `"browser"` (Stealth Chromium)<br>- `proxyUrl` (string, 任意): 経由する HTTP/HTTPS/SOCKS5 プロキシ URL<br>- `extractHighlights` (boolean, 任意): 重要文を抽出するか<br>- `query` (string, 任意): ハイライト対象キーワード |
| `search_deep` | Firecrawl / Tavily 互換の統合深層検索。Web検索＋上位サイト本文自動スクレイプ＋リアルタイム検索を一度にまとめて取得します。 | Web結果に `source: "web"`<br>X結果に `source: "x"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 本文取得件数 (デフォルト: 3, 最大: 10)<br>- `scrapeContent` (boolean, 任意): 本文を含めるか (デフォルト: true)<br>- `includeRealtime` (boolean, 任意): リアルタイム検索も含めるか (デフォルト: true)<br>- `includeDomains` / `excludeDomains` (string[], 任意)<br>- `updated` (string, 任意): 期間指定 (`"all"`, `"day"`, `"week"`, `"year"`)<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL<br>- `extractHighlights` (boolean, 任意) |
| `map_site` | 指定した Web サイトの sitemap.xml や内部リンクを探索し、サイト内の全 URL 一覧（サイトマップ）を高速抽出します。 | - | - `url` (string, 必須): 対象のベース URL<br>- `limit` (number, 任意): 取得件数 (デフォルト: 100)<br>- `includeSubdomains` (boolean, 任意)<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL |
| `crawl_site` | 指定した URL 配下のページを再帰的にクロールし、複数ページの Markdown 本文を一括収集します。 | 各結果に `source: "web"` | - `url` (string, 必須): クロール開始 URL<br>- `maxPages` (number, 任意): 最大取得ページ数 (デフォルト: 5)<br>- `maxDepth` (number, 任意): 最大リンク深度 (デフォルト: 2)<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL |

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
| `search_realtime` | Yahoo Japan リアルタイム検索を実行し、X (旧 Twitter) の最新ツイートおよび画像 URL・投稿日時を取得します。 | 各アイテムに `source: "x"` | - `query` (string, 必須): 検索キーワード |
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

### 3.1 ヘルスチェック (`GET /health`)
```json
{
  "status": "ok",
  "service": "ghostfetch",
  "version": "2.0.0",
  "cachedEntries": 0,
  "chromiumAvailable": true,
  "yahooMcpAvailable": true,
  "mcpConnected": true,
  "timestamp": "2026-08-21T05:54:26.782Z"
}
```

---

### 3.2 単一 URL / PDF スクレイプ (`POST /scrape`)
- **リクエスト**:
```json
{
  "url": "https://example.com/press-release.pdf",
  "maxChars": 30000,
  "mode": "auto",
  "proxyUrl": "http://user:pass@proxy.example.com:8080",
  "extractHighlights": true,
  "query": "新商品 発売日"
}
```
- **レスポンス例**:
```json
{
  "url": "https://example.com/press-release.pdf",
  "title": "2026年新商品プレスリリース",
  "content": "---\ntitle: \"2026年新商品プレスリリース\"\nurl: \"https://example.com/press-release.pdf\"\ntotalPages: 3\ncontentType: \"application/pdf\"\n---\n\n...",
  "isTruncated": false,
  "contentType": "application/pdf",
  "source": "web",
  "renderedWithBrowser": false,
  "highlights": [
    "2026年9月1日より全国で新商品の一般発売を開始いたします。"
  ]
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
    { "type": "fill", "selector": "input[name='q']", "text": "GhostFetch" },
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
  "url": "https://example.com/search?q=GhostFetch",
  "title": "検索結果 - GhostFetch",
  "content": "---\ntitle: \"検索結果 - GhostFetch\"\nurl: \"https://example.com/search?q=GhostFetch\"\n---\n\n# 検索結果\n...",
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
  "limit": 3,
  "scrapeContent": true,
  "includeRealtime": true,
  "updated": "week"
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
  "publicTimeFormatted": "2026/08/21 17:00:00",
  "publishingOffice": "山形地方気象台",
  "location": {
    "area": "東北",
    "prefecture": "山形県",
    "district": "村山地方",
    "city": "天童市"
  },
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
- **リアルタイム検索 (`POST /search/realtime`)**: `{ "query": "イベント名" }`
- **急上昇トレンド (`POST /search/trend`)**: `{ "limit": 20 }`

---

### 3.9 サイトマップ & クロール (`POST /map` / `POST /crawl`)
- **サイトマップ (`POST /map`)**: `{ "url": "https://example.com", "limit": 100 }`
- **再帰クロール (`POST /crawl`)**: `{ "url": "https://example.com/docs", "maxPages": 5 }`

---

## 4. セキュリティ & アーキテクチャ

### 4.1 ディストロレス (Distroless) コンテナ設計
- **ベースイメージ**: `gcr.io/distroless/cc-debian12`
- **シェルなし・パッケージマネージャなし**: コンテナ内に `/bin/sh` や `apt`、`curl` は一切存在せず、攻撃者がシェルを奪取する余地がありません。
- **最小権限設計**: 非 root 実行に対応し、Docker / Podman / Kubernetes などの標準コンテナ環境で安全に隔離・実行可能。

### 4.2 セキュリティ & パフォーマンス機能
- **プロキシ連携**: HTTP, HTTPS, SOCKS5 プロキシに対応し、IP ローテーションや地域制限回避が可能。
- **SSRF 防御**: プライベート IP（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8` 等）への内部攻撃を遮断。
- **Jitter スロットリング**: 同一ドメインへの過剰な連続アクセスを自動抑制。
- **LRU キャッシュ**: 15〜30分間のメモリキャッシュにより同一リクエストを高速応答。

---

## 5. 謝意・クレジット (Acknowledgments)

`GhostFetch` の各検索・データ連携機能は、以下の優れたオープンソースプロジェクトおよび公開サービス・公的オープンデータに支えられています。開発者・関係者の皆様に心より感謝申し上げます。

- **気象庁（JMA）オープンデータ**: [jma.go.jp](https://www.jma.go.jp/)
  - 日本全国の高精度な気象予報・防災データおよび全国エリア定義データのオープン公開に深く感謝いたします。
- **天気予報 API（livedoor 天気互換）の設計着想**: [tsukumijima/weather-api](https://github.com/tsukumijima/weather-api) / [weather.tsukumijima.net](https://weather.tsukumijima.net/)
  - livedoor 天気互換フォーマットの分かりやすいスキーマ設計と長年のコミュニティ貢献に感謝いたします。
- **Yahoo Japan Search MCP**: [mouseos/Yahoo-Japan-Search-MCP](https://github.com/mouseos/Yahoo-Japan-Search-MCP)
  - Yahoo! JAPAN の画像・動画・ニュース・知恵袋・サジェスト検索の MCP 実装に感謝いたします。
- **norikae-mcp**: [tysonwu/norikae-mcp](https://github.com/tysonwu/norikae-mcp)
  - Yahoo! 路線情報スクレイピングによる乗換案内ロジックの設計・実装に感謝いたします。

---

## 6. ライセンス (License)

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
