# 検索語の URL と、読めないページの扱いの設計

日付: 2026-10-26

## 経緯

LibreChat の Agent が「この動画を要約して」に対し、`search_deep` を `query: "https://www.youtube.com/watch?v=5Jq35KcE8vI"`・`limit: 5`・`videos: 3` で呼んだ。結果は 3 件だった。

- 1 件目は指定の動画。Yahoo の Web 検索がこのページを返したので、字幕で読めた。ただし題名は Yahoo の検索結果のもので、英語に訳されていた（"Chatting and doing my makeup, plus my latest dilemma"）。
- 2・3 件目は関係ない動画（科学映像館の「窓ひらく」「あかり」）。Yahoo の動画検索に、URL そのものを検索語として渡したため。

検索語に URL が来るのは YouTube に限らない（X・TikTok・Instagram・画像・PDF など）。そこで、URL の種類に関係なく、検索語の URL はその URL を読む形にする（ユーザーの判断）。

## 調べたこと（2026-10-26、本番）

`search_deep` は検索語の URL を自分では読まない。URL の文字列を検索語にして、Web・X・動画を検索する。Yahoo に載っていない URL（X の投稿、画像、新しい動画など）は何も読めない。

`scrape` の読み方（URL の種類ごと）:

- YouTube の動画: 字幕と説明文（v2.47.0）。
- X の投稿: 本文と投稿者（0.3 秒）。
- ニコニコ動画: 題名と説明文（10.7 秒）。コメントと字幕は無い。
- Threads: 投稿の本文。Instagram: 題名が「Instagram」になり、画像の説明文などが本文になる。
- TikTok: Chrome の 403 のエラー画面（"You don't have authorization to view this page"）を、本文として返していた。
- 画像ファイル（jpg）: 画像のデータを文字として 1,500 字返し、本文として扱っていた。

TikTok は、このサーバーからは字幕も説明文も取れない。

- 動画のページは WAF の確認画面（1.4KB）になり、ブラウザで開くと HTTP 403 になる。
- 公式の oEmbed は、動画については埋め込みのタグ（iframe）しか返さない。題名・投稿者も無い。プロフィールの oEmbed は返る。
- 埋め込みのプレーヤーのページ（`/player/v1/<動画 ID>`）は開ける（39KB）が、中身は空の枠である。動画のデータは、開いたあとに JavaScript が TikTok のボット対策の署名（mssdk・argus）を付けて取りに行く。
- このため、TikTok の字幕は今回扱わない。試すなら、YouTube の音声認識と同じく、許可を得てから別の計画にする。

## 設計

### search_deep: 検索語の URL を読む

- 検索語に http(s) の URL があれば、検索をせずに、その URL を（最大 `limit` 件、検索語の順に）`scrape` と同じ方法で読む。YouTube は字幕、X は投稿、PDF は本文、ほかはページになる。
- Web 検索・X の検索（`includeRealtime`）・動画の検索（`videos`）・PRF・並べ替えはしない。URL を検索語にすると、どれも関係ない結果になるため。
- URL 以外の語は、読んだページから関係する部分（ハイライト）を選ぶのと、十分さの判定（`contextSufficiency`）に使う。URL だけなら、ハイライトは付けずに本文を返す。
- 題名は、読んだページの題名にする。

### search_video: 検索語が URL なら検索しない

- Yahoo の動画検索に URL を渡すと関係ない動画が返るので、検索しない。`items: []` と、`message`（「URL の動画は get_youtube_transcript（YouTube）か scrape で読む」）を返す。

### search_deep の YouTube の題名

- Web 検索の結果が YouTube の動画なら、題名を YouTube の題名（字幕を取るときに得たもの）にする。Yahoo は YouTube の題名を英語に訳して返すことがある。

### scrape: 画像・音声・動画のファイル

- `Content-Type` が `image/`・`audio/`・`video/` なら、中身を読まない。種類と大きさだけを返し、「Sora は中身を読めない」と書く（`contentStatus: "metadata_only"`）。

### scrape: エラーのページ

- HTTP の状態が 400 以上のページは、`contentStatus` を `unavailable` にし、本文の先頭に HTTP の状態を書く。静的な取得とブラウザの両方で行う。ブラウザでは、本文のドキュメントの応答の状態を記録する。
- TikTok（ブラウザで 403）は、これで「読めない」になる。`search_deep` は `unavailable` のページを根拠に数えず、次の候補を読む。
- 既知の限界: 404 を返しつつ JavaScript で本文を出すページ（SPA の 404 フォールバック）も `unavailable` になる。

### 十分さの判定

- `contextSufficiency` は、`metadata_only`・`unavailable` のページを証拠に数えない（取得失敗と同じ）。画像や TikTok だけを読んだときは `no-usable-content` になる。

## 対象外

- TikTok の字幕（上記）。
- 短縮 URL（t.co など）を転送先の URL で判定すること。今は t.co 経由の YouTube を字幕で読まない。
- Instagram などの投稿を `fetch_social_post` の仕組みで読むこと。
- 検索語に URL と語の両方があるときに、語で検索も行うこと。

## 確認

- `src/url_in_query.test.ts`: `search_deep` が検索語の URL を読み、Web・X・動画を検索しないこと、題名、ハイライトに語を使うこと、十分さの判定、YouTube の題名、`search_video` の `message`、画像のファイル、エラーのページ（静的な取得とブラウザ）。
