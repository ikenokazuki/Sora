# GhostFetch

> **Ultra-fast, Stealth Web Scraping & Deep Search Engine with MCP (Model Context Protocol)**  
> *(Firecrawl & Tavily Alternative / Distroless / Source-Available)*

`GhostFetch` は、Web ページや PDF の超高速スクレイピング（Markdown 変換・メタデータ抽出・SPA 自動 Chromium レンダリング・Bot 検知回避）、Yahoo Japan Web 検索（ドメイン絞り込み対応）、Yahoo Japan リアルタイム検索（X/Twitter ポスト・画像・トレンド取得）、サイトマップ探索 (`/map`)、サブページ再帰クロール (`/crawl`)、プロキシ連携、およびこれらを統合した深層検索を提供する All-in-One サービスです。

標準的な **REST API** および **MCP サーバー**（Streamable HTTP / SSE）としてセルフホストして利用できます。

すべての検索・スクレイピング結果には、情報ソースが Web ページ由来なのか X (Twitter) 由来なのかを即座に判別できる `source: "web" | "x"` プロパティが付与されます。

---

## 1. クイックスタート

### 1.1 コンテナの起動 (Docker / Podman)

GitHub Container Registry (GHCR) から 1 コマンドで即座に起動できます:

```bash
docker run -d \
  --name ghostfetch \
  -p 3016:8000 \
  -e API_KEY="your-secret-api-key" \
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

## 2. 提供 MCP ツール一覧 (全 14 ツール)

| ツール名 | 説明 | 識別プロパティ | 主要引数 |
|---|---|---|---|
| `scrape` | 指定 URL の Web ページまたは PDF をスクレイピングし、本文を Markdown 形式で抽出します。SPA サイトや Bot 対策画面（Cloudflare Turnstile 等）は自動で Chromium レンダリング。プロキシ対応。 | `source: "web"` | - `url` (string, 必須): 対象 URL / PDF<br>- `maxChars` (number, 任意): 最大文字数 (デフォルト: 30000)<br>- `mode` (string, 任意): `"auto"` (スマート自動判定, デフォルト), `"fast"` (静的最速), `"browser"` (Stealth Chromium)<br>- `proxyUrl` (string, 任意): 経由する HTTP/HTTPS/SOCKS5 プロキシ URL<br>- `extractHighlights` (boolean, 任意): 重要文を抽出するか<br>- `query` (string, 任意): ハイライト対象キーワード |
| `search_web` | Yahoo Japan Web 検索を実行し、検索上位のタイトル・概要スニペット・URL を取得します。ドメイン絞り込み・除外・期間指定に対応。 | 各アイテムに `source: "web"` | - `query` (string, 必須): 検索キーワード<br>- `includeDomains` (string[], 任意): 絞り込むドメイン<br>- `excludeDomains` (string[], 任意): 除外するドメイン<br>- `updated` (string, 任意): 期間指定 (`"all"`, `"day"`, `"week"`, `"year"`) |
| `search_image` | Yahoo! JAPAN 画像検索を実行し、画像タイトル・画像URL・サムネイル・画像サイズ・ソース元ページを取得します。 | 各アイテムに `source: "image"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 20, 最大: 20)<br>- `page` (number, 任意): ページ番号 |
| `search_video` | Yahoo! JAPAN 動画検索を実行し、動画タイトル・動画URL・再生時間・配信元・サムネイルを取得します。 | 各アイテムに `source: "video"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 20, 最大: 20)<br>- `page` (number, 任意): ページ番号 |
| `search_news` | Yahoo!ニュース検索を実行し、最新ニュース記事のタイトル・概要・配信社・公開日時・記事URL・サムネイルを取得します。 | 各アイテムに `source: "news"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 10, 最大: 60) |
| `search_chiebukuro` | Yahoo!知恵袋 Q&A 検索を実行し、質問タイトル・回答数・解決ステータス・投稿日時・カテゴリ・スニペットを取得します。 | 各アイテムに `source: "chiebukuro"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 10, 最大: 10)<br>- `page` (number, 任意): ページ番号<br>- `status` (string, 任意): `"all"`, `"open"`, `"vote"`, `"solved"` |
| `suggest_keywords` | Yahoo! JAPAN オートコンプリートサジェストを取得し、関連検索ワード・補完候補を返します。 | `source: "suggest"` | - `query` (string, 必須): 補完キーワード<br>- `limit` (number, 任意): 取得件数 (デフォルト: 10, 最大: 20) |
| `search_route` | 日本国内の電車乗換案内。駅間の最適ルート・所要時間・乗換回数・IC/きっぷ運賃を探索。経由駅指定（最大3駅）、日時指定、特急/新幹線利用フラグに対応。 | `source: "transit"` | - `from` (string, 必須): 出発駅名 (例「東京」)<br>- `to` (string, 必須): 到着駅名 (例「新宿」)<br>- `via` (string[], 任意): 経由駅 (最大3駅)<br>- `year` / `month` / `day` / `hour` / `minute` (number, 任意)<br>- `timeType` (string, 任意): `"departure"`, `"arrival"`, `"first_train"`, `"last_train"`<br>- `ticket` (string, 任意): `"ic"`, `"cash"`<br>- `sortBy` (string, 任意): `"time"`, `"transfer"`, `"fare"` |
| `get_weather` | 気象庁配信の日本全国各地の今日・明日・明後日の天気予報、予想気温、降水確率、天気概況、風・波情報を取得します。都市名または6桁の地点IDに対応。 | `source: "weather"` | - `city` (string, 必須): 都市名 (例「東京」「大阪」「福岡」) または 地点ID (例「130010」)<br>- `days` (number, 任意): 予報日数 (1〜3日, デフォルト: 3) |
| `search_realtime` | Yahoo Japan リアルタイム検索を実行し、X (旧 Twitter) の最新ツイートおよび画像 URL・投稿日時を取得します。 | 各アイテムに `source: "x"` | - `query` (string, 必須): 検索キーワード |
| `search_trend` | Yahoo リアルタイム検索の最新トレンド（急上昇キーワードランキング）を取得します。 | 各アイテムに `source: "x"` | - `limit` (number, 任意): 取得件数 (デフォルト: 20) |
| `search_deep` | Firecrawl / Tavily 互換の統合深層検索。Web検索＋上位サイト本文自動スクレイプ＋リアルタイム検索を一度にまとめて取得します。 | Web結果に `source: "web"`<br>X結果に `source: "x"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 本文取得件数 (デフォルト: 3, 最大: 10)<br>- `scrapeContent` (boolean, 任意): 本文を含めるか (デフォルト: true)<br>- `includeRealtime` (boolean, 任意): リアルタイム検索も含めるか (デフォルト: true)<br>- `includeDomains` / `excludeDomains` (string[], 任意)<br>- `updated` (string, 任意): 期間指定 (`"all"`, `"day"`, `"week"`, `"year"`)<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL<br>- `extractHighlights` (boolean, 任意) |
| `map_site` | 指定した Web サイトの sitemap.xml や内部リンクを探索し、サイト内の全 URL 一覧（サイトマップ）を高速抽出します。 | - | - `url` (string, 必須): 対象のベース URL<br>- `limit` (number, 任意): 取得件数 (デフォルト: 100)<br>- `includeSubdomains` (boolean, 任意)<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL |
| `crawl_site` | 指定した URL 配下のページを再帰的にクロールし、複数ページの Markdown 本文を一括収集します。 | 各結果に `source: "web"` | - `url` (string, 必須): クロール開始 URL<br>- `maxPages` (number, 任意): 最大取得ページ数 (デフォルト: 5)<br>- `maxDepth` (number, 任意): 最大リンク深度 (デフォルト: 2)<br>- `proxyUrl` (string, 任意): 経由するプロキシ URL |

---

## 3. REST API 仕様

ベース URL: `http://localhost:3016` (またはデプロイ先のドメイン URL)

### 3.1 ヘルスチェック (`GET /health`)
```json
{
  "status": "ok",
  "service": "ghostfetch",
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

### 3.3 Yahoo Web 検索 (`POST /search/web`)
- **リクエスト**:
```json
{
  "query": "新商品 発売情報",
  "includeDomains": ["example.com", "news.example.org"],
  "excludeDomains": ["spam.example.com"],
  "updated": "week"
}
```

---

### 3.4 画像・動画・ニュース・知恵袋・サジェスト検索
- **画像検索 (`POST /search/image`)**: `{ "query": "富士山", "limit": 10 }`
- **動画検索 (`POST /search/video`)**: `{ "query": "簡単 レシピ", "limit": 10 }`
- **ニュース検索 (`POST /search/news`)**: `{ "query": "AI ロボット", "limit": 10 }`
- **知恵袋 Q&A (`POST /search/chiebukuro`)**: `{ "query": "プログラミング 初心者", "limit": 10, "status": "solved" }`
- **サジェスト・キーワード補完 (`POST /search/suggest`)**: `{ "query": "乃木坂", "limit": 5 }`

---

### 3.5 電車乗換案内 (`POST /transit/route`)
- **リクエスト**:
```json
{
  "from": "東京",
  "to": "新宿",
  "via": ["秋葉原"],
  "ticket": "ic",
  "sortBy": "time"
}
```
- **レスポンス例**:
```json
{
  "source": "transit",
  "from": "東京",
  "to": "新宿",
  "via": ["秋葉原"],
  "routeCount": 3,
  "routes": [
    {
      "index": 1,
      "totalTime": "19:04発→19:17着13分（乗車13分）",
      "transfers": "乗換：0回",
      "fare": "IC優先：253円",
      "sections": [
        {
          "line": "ＪＲ中央線通勤快速"
        }
      ]
    }
  ]
}
```

---

### 3.6 日本全国 天気予報 (`POST /weather` / `GET /weather` / `GET /weather/:city`)
- **リクエスト (POST)**:
```json
{
  "city": "東京",
  "days": 3
}
```
- **GET リクエスト**: `GET /weather?city=大阪&days=2` または `GET /weather/福岡`
- **レスポンス例**:
```json
{
  "source": "weather",
  "cityId": "130010",
  "title": "東京都 東京 の天気",
  "publicTimeFormatted": "2026/08/21 17:00:00",
  "publishingOffice": "気象庁",
  "location": {
    "area": "関東",
    "prefecture": "東京都",
    "district": "東京地方",
    "city": "東京"
  },
  "description": {
    "headline": "東京地方では、２１日夜遅くまで急な強い雨や落雷に注意してください。",
    "body": "関東甲信地方は高気圧に覆われていますが、湿った空気や日射の影響を受けています...",
    "text": "..."
  },
  "forecasts": [
    {
      "date": "2026-08-21",
      "dateLabel": "今日",
      "telop": "曇り",
      "detail": {
        "weather": "くもり　所により　夜のはじめ頃　まで　雨　で　雷を伴い　激しく　降る",
        "wind": "南西の風",
        "wave": "０．５メートル"
      },
      "temperature": {
        "min": null,
        "max": null
      },
      "chanceOfRain": {
        "T00_06": "--%",
        "T06_12": "--%",
        "T12_18": "--%",
        "T18_24": "30%"
      },
      "image": "https://www.jma.go.jp/bosai/forecast/img/200.svg"
    }
  ]
}
```

---

### 3.7 Yahoo リアルタイム検索 & トレンド (`POST /search/realtime` / `POST /search/trend`)
- **リアルタイム検索 (`POST /search/realtime`)**: `{ "query": "イベント名" }`
- **急上昇トレンド (`POST /search/trend`)**: `{ "limit": 20 }`

---

### 3.8 サイトマップ & クロール (`POST /map` / `POST /crawl`)
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
- **LRU キャッシュ**: 15分間のメモリキャッシュにより同一リクエストを高速応答。

---

## 5. ライセンス (License)

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
