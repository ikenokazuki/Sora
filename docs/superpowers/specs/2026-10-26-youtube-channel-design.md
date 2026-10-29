# YouTube チャンネルの最新動画の設計

日付: 2026-10-26

## 目的

利用側のアプリが、YouTube チャンネルの最近の動画（題名・公開日・説明文）を見つけ、その字幕（`get_youtube_transcript`）を読んで、要約や分析の材料にする。

`get_youtube_transcript` は動画 1 本の字幕を読めるが、チャンネルから動画を見つける窓口が Sora に無かった。`search_video` は Yahoo の動画検索（ほかの利用と分け合う細い経路）で、投稿者を指定できない。チャンネルの最新動画の一覧を、Yahoo を使わずに返す `get_youtube_channel`（`POST /youtube/channel`）を足す。

## 調べたこと（2026-10-26）

- YouTube のチャンネルは、公開の Atom フィード `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` で最新の動画を最大 15 件返す。API キー・ブラウザ・PO トークンは要らない。
- チャンネル ID（`UC` + 22 文字）は `@ハンドル`・`/c/名前`・`/user/名前` からは分からない。チャンネルのページ（`https://www.youtube.com/@ハンドル`）の HTML から読む。

**実機未確認**: この設計を書いた環境からは YouTube に届かなかった（プロキシが CONNECT を 403 で拒否）。次の形式は、公開されているフィードとページの形からの想定で、テストは合成したフィクスチャで書いている。最初に本番へ載せたときに、`curl` で実物を確かめる（確認の手順は末尾）。

- フィード: `<feed>` の下に `<title>`（チャンネル名）と `<entry>` が並ぶ。`<entry>` は `<yt:videoId>`・`<title>`・`<link rel="alternate" href>`・`<published>`・`<updated>`・`<media:group>`（`<media:title>`・`<media:description>`・`<media:community><media:statistics views="N"/>`）を持つ。フィードの `<yt:channelId>` は `UC` が付かない 22 文字なので、チャンネル ID は入力か解決の段階の値を使う。新しい順。
- チャンネルのページ: `<link rel="alternate" type="application/rss+xml" href="…/feeds/videos.xml?channel_id=UC…">`、`<link rel="canonical" href="…/channel/UC…">`、`<meta itemprop="identifier" content="UC…">`、埋め込みデータの `"externalId":"UC…"` のどれかに ID がある。
- EU などでは、ページが同意の画面（`consent.youtube.com`）に飛ぶことがある。その HTML に ID は無い。
- 既存の部品: URL を読む `parseYouTubeUrl`（`src/html_parser.ts`）、Chrome の TLS で読む `fetchWithSafeRedirects`、本文の上限つき読み取り `readBodyWithLimit`、`fast-xml-parser`（依存に入っている）、注入できる `YoutubeDeps`。

## 設計

- 新しいツール `get_youtube_channel`（モジュール `youtube`。MCP は既定で遅延、REST は `POST /youtube/channel`）。入力は `url`（チャンネルの URL・`@ハンドル`・`UC…` の ID）、`limit`（1〜15、既定 10）、`noCache`。
- 入力の読み方（`parseYouTubeChannelRef`）: `/@ハンドル`・`/channel/UC…`・`/c/名前`・`/user/名前`・`@ハンドル`・`UC…` を受ける。ホストは完全一致（`youtube.com`・`www.youtube.com`・`m.youtube.com`）。`/@ハンドル/videos` のように後ろが付いていても、最初の部分だけを使う。動画の URL は対象外（`get_youtube_transcript` を使う）。入力した URL そのものは取りに行かず、検証した部品から URL を組み立てる。日本語のハンドルは % エンコードの形も、そのままの形も受ける。
- ID の解決: `UC…` ならそのまま。ほかはチャンネルのページ（`fetchWithSafeRedirects`）から、RSS の alternate リンク → canonical → `itemprop` → `externalId` の順に読む。ハンドルと ID の対応は 24 時間覚える（ページは 1〜2MB あるため）。
- フィードの取得: `deps.fetchFn`（ふつうの fetch。リダイレクトはエラー、8 秒、2MB まで）。ブラウザ用のセッション（Cookie の保存）は通さない。
- 結果: `found`、`channelId`、`title`、`url`、`videos[{ videoId, url, title, publishedAt, updatedAt, description（先頭 500 字）, views }]`。題名と説明は `cleanMarkdownTokens` を通す（投稿者が書く文なので、そのまま信用しない）。
- 見つからないとき（ページもフィードも 404）は `found: false`・`reason: 'channel-not-found'` を 200 で返す。同意の画面・ブロック・429/5xx・読めない応答は、`found: false` にせず例外にする（`YouTube request failed: …`。REST は 502 `YOUTUBE_UPSTREAM_ERROR`）。例外はキャッシュしない。
- キャッシュ: フィード 15 件を 30 分（`CACHE_TTL_DEFAULT`）、`found: false` と動画 0 件は 1 分（`CACHE_TTL_EMPTY`）。同じキーの同時の要求は 1 つにまとめる。`limit` は読み出した後に切る。
- 字幕は付けない。動画を選んだ後に `get_youtube_transcript` を呼ぶ（検索語に関係する段落の選択が要るなら、`search_video` の `transcripts`）。
- 全ツールの一覧の文字数が増えるため、`context_budget.test.ts` の上限を意識して上げる。

## 割り切り

- フィードは最大 15 件。それより古い動画は返せない。
- ショート動画もフィードに入る。区別はしない。
- 視聴回数は、フィードに載っているときだけ（古い値のことがある）。

## 対象外

- TikTok（プロフィールの動画一覧には公開の窓口が無い）、再生リスト、ライブの一覧、コメント、チャンネルの紹介文・登録者数。
- `get_youtube_transcript` の変更。

## 確認

- `src/services/youtube_channel.test.ts`: 入力の読み方、ID の取り出し 4 通り、フィードの読み取り（1 件だけの `<entry>`・数字だけの題名・長い説明）、キャッシュ（同じキー・`noCache`・ID だけ 24 時間）、404 と例外（同意の画面・429・読めない応答）、結果のスキーマ。
- `src/html_parser.test.ts`: `parseYouTubeChannelRef`（受ける形・拒む形）。
- `src/youtube_module.test.ts`: REST の検証とエラーの対応、MCP の登録と呼び出し、OpenAPI と `GET /`。
- 本番で最初にする確認（実機）:
  - `curl -s -X POST localhost:3016/youtube/channel -H 'content-type: application/json' -d '{"url":"https://www.youtube.com/@YouTube","limit":3}'` で `found: true` と動画 3 件が返る。
  - 同じ呼び出しを `UCBR8-60-B28hp2BmDPdntcQ`（ID）でも行い、同じ動画が返る。
  - 日本語のハンドルのチャンネルでも `found: true` になる。
  - 失敗したときは `YouTube request failed: …` のあとの理由（`consent`・`channel id not found`・`feed HTTP …`）で、同意の画面かページの形の変化かを見分ける。
