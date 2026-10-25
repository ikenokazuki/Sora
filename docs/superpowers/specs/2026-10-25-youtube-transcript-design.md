# YouTube の字幕・説明文を返すモジュール（youtube）の設計

日付: 2026-10-25

## 目的と要件

YouTube の動画 URL から、題名・投稿者・公開日・長さ・説明文・チャプターと、時刻つきの字幕を返す機能を足します。Gemini は YouTube の URL をそのまま読めますが、ほかの AI（Claude、LibreChat の各モデル、client-app の Muse など）は読めません。Sora が字幕を返せば、どの AI でも動画の内容の抽出・要約ができます。

- 要約は呼び出し側の AI が書きます。Sora は今どおり LLM を持たず、材料だけを返します。
- 手動の字幕を優先し、無ければ YouTube の自動字幕を返します。自動字幕であることは結果に明記します。
- 字幕（自動字幕も）が無い動画は「字幕なし」と理由を返し、AI が話の中身を推測で作らないようにします。音声認識は今回は扱いません（後述の「対象外」）。
- API キー不要であること。呼ばれたときだけ YouTube に問い合わせ、起動時の処理・常駐タイマー・事前取得は持ちません。

## 取得元の調査（2026-10-25 実測。字幕本文は出力せず、件数と文字数だけで確認）

### 取得経路

- Android アプリと同じ innertube の player（`POST https://www.youtube.com/youtubei/v1/player`、`clientName: ANDROID`）は、字幕の一覧（`captions.playerCaptionsTracklistRenderer.captionTracks`）と、題名・投稿者・長さ・説明文（`videoDetails`）を返します。字幕の URL（`/api/timedtext`）に `fmt=json3` を付けると本文が取れます。試した 11 本すべてで取得でき、1 本あたり 0.2〜1.2 秒でした。
- 動画ページ（`/watch?v=`）に埋め込まれた字幕の URL は、本文が 0 バイトでした。URL に `exp=xpe` が付き、PO トークンが必須になっています。yt-dlp の PO Token Guide（2026-07-12 版）でも、字幕に PO トークンが要るのは web クライアントだけとされています。
- `ANDROID_VR` は、このサーバーの IP からだと `LOGIN_REQUIRED`（「ログインして bot ではないことを確認してください」）でした。
- 公開日（`publishDate`）とカテゴリは、ANDROID の応答には無く、動画ページの `microformat` にあります。
- YouTube の機械翻訳（`tlang`）は空の応答でした。
- この経路は YouTube の公開 API ではありません。YouTube の変更で止まることがあります（youtube-transcript-api の issue #592 など）。

### 字幕の有無（30 本。アイドルの MV・ライブ映像・配信アーカイブ・自己紹介・ショートと、ニュース）

- 手動の字幕あり 1 本、自動字幕だけ 21 本、字幕なし 8 本。字幕なしの 8 本は、動画ページでも字幕がありませんでした（MV・ライブ映像 3、ショート 2、24 時間配信のアーカイブ 1、配信中 1、4 時間のまとめ 1）。
- 言語が外れた自動字幕が 2 本ありました。日本語の MV に `id` の自動字幕だけ、日本語のショートに `en` の自動字幕だけ、です。
- 日本語の動画に、`ja` の自動字幕と並んで `en` の自動字幕が付いていることがあります。

### 長さ

- 15 分前後で 3,700〜6,800 字、30 分で 1.25 万字、2.5 時間の配信で 4.1 万字、5 時間で 8.8 万字（json3 は 4.8 MB、取得 1.0 秒）。

### json3 の構造

- 自動字幕: 単語ごとの `segs`（`utf8`・`tOffsetMs`・`acAsrConf`、話者交代の `isSpeakerChange`）を持つ event と、改行だけの event（`aAppend: 1`）が交互に来ます。表示窓は重なりますが、文字は重複しません。
- 手動字幕: 1 event に 1 seg で、文中に `\n` を含むことがあります。

### キー不要の外部 API

字幕の無い動画を文字起こしできる、キー不要の外部 API は見つかりませんでした。Whisper の有料 API（deAPI など）は登録とキーが必要です。Hugging Face の公開デモは、未登録だと GPU 枠が 1 日 2 分ほどで、音声も自分で用意する必要があります。字幕を中継するサービス（Invidious など）は YouTube の字幕を返すだけです。

## 設計

### モジュール

- `SoraModule` に `youtube` を追加します。`all` に含め、既定で有効です（lyrics のような明示指定のみにはしません）。
- MCP のツールは遅延公開です（`search_tools` で有効化）。REST は、ほかの既定モジュールと同じく常に応答します。

### インターフェース

- MCP: `get_youtube_transcript`（カテゴリ `youtube`）。
- REST: `POST /youtube/transcript`。
- 入力: `url`（必須。URL か 11 文字の動画 ID）、`lang`（既定 `ja`）、`fromSec`・`toSec`（秒）、`maxChars`（1〜50,000、既定 30,000）、`noCache`。
- 受け付ける URL: `youtube.com`（`www.`・`m.`・`music.`）、`youtube-nocookie.com`、`youtu.be` の `/watch?v=`・`/shorts/`・`/live/`・`/embed/`・`/v/`。ホストは完全一致で判定します。`t`・`start`（`367`・`367s`・`6m7s`・`1h2m3s`）は `requestedStartSec` として返すだけで、範囲は変えません。全体を要約するか、その場面を見るかは AI が決め、必要なら `fromSec` を渡します。
- 出力: `found`、`videoId`、`url`、`title`、`channel`、`publishedAt`、`durationSec`、`isLiveNow`、`category`、`description`、`chapters`（`startSec`・`time`・`title`）、`requestedStartSec`、`transcript`、`availableTracks`（`language`・`source`・`name`）。
  - `transcript`: `status`、`reason`、`message`、`source`（`manual` / `auto`）、`language`、`note`、`fromSec`、`toSec`、`text`、`chars`、`totalChars`、`truncated`、`nextFromSec`。
  - `found: false` のとき `reason` は `video-unavailable`（非公開・削除・年齢制限など）で、`message` に YouTube の理由文を入れます。

### 取得の順序（`src/services/youtube.ts`）

1. URL を解析し、キャッシュを引きます。キーは動画 ID と `lang` だけで、範囲の切り出しはキャッシュの後に行います。
2. player（ANDROID）と動画ページを並行して取得します。動画ページが取れなければ、公開日・カテゴリ・配信中かどうかを省きます。
3. 再生できない動画は `found: false` を返します。
4. 字幕の一覧は player のものを使い、player が拒否されたときは動画ページの一覧で代用します。
5. 字幕は、`lang` の手動 → `lang` の自動 → ほかの言語の手動 → ほかの言語の自動、の順に選びます。
6. 字幕の URL は `www.youtube.com` の `/api/timedtext` だけを許可して取得します。
7. 本文と説明文は `cleanMarkdownTokens` を通します（間接プロンプトインジェクション対策）。
8. 改行だけの event を飛ばし、約 30 秒か 300 字ごとに段落にまとめ、先頭に `[m:ss]`（1 時間以上は `[h:mm:ss]`）を付けた 1 本の文字列にします。

### 字幕の状態

- `ok`: 本文を返します。自動字幕には `note`（音声認識による自動字幕で、句読点が無く誤りを含む。引用するときは自動字幕と伝える）を付け、カテゴリが Music なら歌声の聞き取りで精度が低いことを足します。
- `none` / `no-captions`: 字幕がありません。公開から 48 時間以内なら、しばらくすると自動字幕が付くことがある、と足します。
- `none` / `live-now`: 配信中です。配信が終わると自動字幕が付くことがあります。
- `none` / `language-mismatch`: 題名にかなを含むのに、自動字幕が `ja` 以外しかありません（`lang` が `ja` のときだけ判定）。本文は返さず、その言語を `lang` に指定すると取得できると書きます。
- `unavailable` / `blocked`: YouTube が字幕の取得を拒否しました（bot 確認、空の応答）。時間をおいて再試行するよう書き、キャッシュしません。

### 長さの制御

`maxChars` を超えたら段落の境目で切り、`truncated: true` と `nextFromSec` を返します。AI は `nextFromSec` を `fromSec` に渡して続きを読みます。

### キャッシュとエラー

- `ok` は 30 分（`CACHE_TTL_DEFAULT`）、`none` は 60 秒（`CACHE_TTL_EMPTY`）キャッシュします。`unavailable` はキャッシュしません。同時の同じ問い合わせは 1 回にまとめます（`runWithSingleFlight`）。
- MCP: 例外は `isError` で `YouTube error: <理由>` を返します。bot 確認は `login required (bot check)` を含め、tool-health で `blocked` に分類されるようにします。
- REST: 入力の誤りは 400、例外は 502 `YOUTUBE_UPSTREAM_ERROR`（retryable）。動画が見つからない場合と字幕なしは 200 です。

## 実装後の確認

https://www.youtube.com/watch?v=5Jq35KcE8vI&t=367s（536 秒、2026-10-23 公開、`ja` と `en` の自動字幕）で確認します。`ja` の自動字幕は 3,281 字、6:07〜7:07 は 385 字です。あわせて、字幕なし・言語外れ・不正な ID・存在しない ID の動画も確認します。

## 割り切り

- ANDROID クライアントの版（`20.10.38`）は定数で固定しています。YouTube に拒否されたら、youtube-transcript-api や yt-dlp の版に合わせて上げます。
- 長い配信の一部だけを質問に合わせて選ぶ機能（`query`）は持ちません。必要になったら、段落を見出しにして `extractWithEscalation` で選びます。

## 対象外

- 音声の取得と音声認識。字幕の無い動画は 30 本中 8 本ありましたが、音声のダウンロードは YouTube の bot 対策に触れるため、許可を得てから別の計画で、取得の可否と速度を試作で測って決めます。
- PO トークンの生成、Cookie の利用、bot 確認の回避。
- YouTube の機械翻訳、コメント、プレビュー画像、`scrape` と `search_deep` の挙動の変更。
