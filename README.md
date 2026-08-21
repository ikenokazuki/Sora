# web-fetcher

統合 Web スクレイピング・検索・MCP (Model Context Protocol) サービス

`web-fetcher` は、Web ページの高速スクレイピング（Markdown 変換・メタデータ抽出・SPA 自動 Chromium レンダリング）、Yahoo Japan Web 検索、Yahoo Japan リアルタイム検索（X/Twitter ポスト取得）、およびこれらを統合した深層検索（Firecrawl 互換）を提供する All-in-One サービスです。

専用ドメイン `https://fetcher.ikebun.jp` 経由で、標準的な **REST API** および **MCP サーバー**（Streamable HTTP / SSE）として利用できます。

すべての検索・スクレイピング結果には、情報ソースが Web ページ由来なのか X (Twitter) 由来なのかを即座に判別できる `source: "web" | "x"` プロパティが付与されます。

---

## 1. クイックスタート & MCP サーバー接続

### 1.1 MCP クライアント設定（Claude Desktop / Cursor / Cline / Windsurf 等）

#### Streamable HTTP 接続（推奨・標準）
設定ファイル（例: `claude_desktop_config.json` や Cursor の MCP 設定）に以下を追加します:

```json
{
  "mcpServers": {
    "web-fetcher": {
      "url": "https://fetcher.ikebun.jp/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_API_KEY>"
      }
    }
  }
}
```

#### SSE 接続（レガシー SSE クライアント向け）
```json
{
  "mcpServers": {
    "web-fetcher": {
      "url": "https://fetcher.ikebun.jp/sse",
      "headers": {
        "Authorization": "Bearer <YOUR_API_KEY>"
      }
    }
  }
}
```
*(※ API キーが未設定の場合は `headers` を省略可能です)*

---

## 2. 提供 MCP ツール一覧

| ツール名 | 説明 | 識別プロパティ | 主要引数 |
|---|---|---|---|
| `scrape` | 指定 URL の Web ページをスクレイピングし、本文を Markdown 形式で抽出します。SPA サイトの場合は自動で Chromium レンダリングへフォールバックします。 | `source: "web"` | - `url` (string, 必須): 対象 URL<br>- `maxChars` (number, 任意): 最大文字数 (デフォルト: 30000)<br>- `fastOnly` (boolean, 任意): 静的フェッチのみに限定するか |
| `search_web` | Yahoo Japan Web 検索を実行し、検索上位のタイトル・概要スニペット・URL を取得します。 | 各アイテムに `source: "web"` | - `query` (string, 必須): 検索キーワード |
| `search_realtime` | Yahoo Japan リアルタイム検索を実行し、X (旧 Twitter) の最新ツイートおよび画像 URL・投稿日時を取得します。 | 各アイテムに `source: "x"` | - `query` (string, 必須): 検索キーワード |
| `search_deep` | Firecrawl 互換の統合深層検索。Web検索＋上位サイト本文自動スクレイプ＋リアルタイム検索を一度にまとめて取得します。 | Web結果に `source: "web"`<br>X結果に `source: "x"` | - `query` (string, 必須): 検索キーワード<br>- `limit` (number, 任意): 本文取得件数 (デフォルト: 3, 最大: 10)<br>- `scrapeContent` (boolean, 任意): 本文を含めるか (デフォルト: true)<br>- `includeRealtime` (boolean, 任意): リアルタイム検索も含めるか (デフォルト: true)<br>- `maxChars` (number, 任意): 各ページ最大文字数 |

---

## 3. REST API 仕様

ベース URL: `https://fetcher.ikebun.jp` (ローカル内部アクセス: `http://127.0.0.1:3016`)

### 3.1 ヘルスチェック
- **エンドポイント**: `GET /health`
- **認証**: 不要
- **レスポンス例**:
```json
{
  "status": "ok",
  "service": "web-fetcher",
  "cachedEntries": 0,
  "chromiumAvailable": true,
  "yahooMcpAvailable": true,
  "mcpConnected": true,
  "timestamp": "2026-08-21T05:54:26.782Z"
}
```

---

### 3.2 単一 URL スクレイプ
- **エンドポイント**: `POST /scrape`
- **リクエスト**:
```json
{
  "url": "https://example.com/article",
  "maxChars": 30000,
  "fastOnly": false,
  "timeoutMs": 10000,
  "noCache": false
}
```
- **レスポンス例**:
```json
{
  "url": "https://example.com/article",
  "title": "Example Title",
  "content": "---\ntitle: \"Example Title\"\nurl: \"https://example.com/article\"\n---\n\n記事本文のMarkdownテキスト...",
  "isTruncated": false,
  "contentType": "text/html",
  "source": "web",
  "renderedWithBrowser": false,
  "ogImage": "https://example.com/ogp.jpg",
  "description": "記事の概要..."
}
```

---

### 3.3 Yahoo Web 検索
- **エンドポイント**: `POST /search/web`
- **リクエスト**:
```json
{
  "query": "東京タワー 営業時間",
  "noCache": false
}
```
- **レスポンス例**:
```json
{
  "query": "東京タワー 営業時間",
  "source": "web",
  "type": "web",
  "data": {
    "count": 6,
    "source": "web",
    "items": [
      {
        "source": "web",
        "title": "営業時間・料金 | 東京タワー",
        "url": "https://www.tokyotower.co.jp/...",
        "description": "メインデッキ 9:00～22:30...",
        "rank": 1
      }
    ]
  }
}
```

---

### 3.4 Yahoo リアルタイム検索 (X ツイート取得)
- **エンドポイント**: `POST /search/realtime`
- **リクエスト**:
```json
{
  "query": "推しグループ名",
  "noCache": false
}
```
- **レスポンス例**:
```json
{
  "query": "推しグループ名",
  "source": "x",
  "type": "realtime",
  "data": {
    "count": 20,
    "source": "x",
    "items": [
      {
        "source": "x",
        "id": "189...",
        "author": "user_id",
        "text": "最新のライブ告知ツイート本文...",
        "createdAt": "2026-08-21T14:30:00Z",
        "media": ["https://pbs.twimg.com/media/...jpg"]
      }
    ]
  }
}
```

---

### 3.5 統合深層検索 (Firecrawl 互換)
- **エンドポイント**: `POST /search`
- **リクエスト**:
```json
{
  "query": "最新アイドルフェス 2026",
  "limit": 3,
  "scrapeContent": true,
  "includeRealtime": true,
  "maxChars": 30000
}
```
- **レスポンス例**:
```json
{
  "query": "最新アイドルフェス 2026",
  "source": "integrated",
  "count": 3,
  "results": [
    {
      "source": "web",
      "title": "フェス公式サイト",
      "url": "https://example.com/fes2026",
      "description": "開催概要...",
      "markdown": "---\ntitle: \"フェス公式サイト\"...\n\nタイムテーブルや出演者情報..."
    }
  ],
  "realtime": {
    "source": "x",
    "count": 20,
    "items": [
      {
        "source": "x",
        "id": "189...",
        "author": "user_id",
        "text": "ツイート本文..."
      }
    ]
  }
}
```

---

## 4. 認証（API キー）とセキュリティ

### 4.1 認証方法
外部からのリクエストには、以下のいずれかのヘッダーを付与します:
- `Authorization: Bearer <API_KEY>`
- `X-API-Key: <API_KEY>`

### 4.2 設定方法
サーバーの環境変数 `WEB_FETCHER_API_KEY`（または `API_KEY`）に設定した文字列が認証トークンとなります。
- 未設定時: 外部アクセスも許可（オープン）状態。
- 設定時: キーが一致しない外部リクエストは `401 Unauthorized` で拒否されます。
- `GET /health` および内部ループバック（`127.0.0.1` 直接アクセス）は自動的にバイパスされます。

### 4.3 セキュリティ機能
- **SSRF 防御**: プライベート IP（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8` 等）や内部ドメインへのリクエストは自動遮断されます。
- **ドメイン別スロットリング**: 同一ドメインへの過剰な連続リクエストを防ぐため、ランダムな Jitter（ゆらぎ）付きスロットリングを行います。
- **LRU キャッシュ**: 15分間のインメモリキャッシュにより同一リクエストを高速応答します。

---

## 5. 開発 & テスト

```bash
# 依存関係のインストール
bun install

# 単体・統合テストの実行
bun test

# 開発サーバー起動
bun run dev

# スタンドアロンバイナリのコンパイル
bun run build
```
