# YouTube の字幕・説明文を返すモジュール（youtube）の設計

日付: 2026-10-25

## 目的と要件

YouTube の動画 URL から、題名・投稿者・公開日・長さ・説明文・チャプターと、時刻つきの字幕を返す機能を足します。Gemini は YouTube の URL をそのまま読めますが、ほかの AI（Claude、LibreChat の各モデル、oshiframe の Muse など）は読めません。Sora が字幕を返せば、どの AI でも動画の内容の抽出・要約ができます。

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
- 入力: `url`（必須。URL か 11 文字の動画 ID）、`lang`（既定 `ja`）、`fromSec`（読み始める秒）、`maxChars`（1〜50,000、既定 30,000）、`noCache`。
- 受け付ける URL: `youtube.com`（`www.`・`m.`・`music.`）、`youtube-nocookie.com`、`youtu.be` の `/watch?v=`・`/shorts/`・`/live/`・`/embed/`・`/v/`。ホストは完全一致で判定します。`t`・`start`（`367`・`367s`・`6m7s`・`1h2m3s`）は `requestedStartSec` として返すだけで、範囲は変えません。全体を要約するか、その場面を見るかは AI が決め、必要なら `fromSec` を渡します。
- 出力: `found`、`videoId`、`url`、`title`、`channel`、`publishedAt`、`durationSec`、`isLiveNow`、`category`、`description`、`chapters`（`title`・`time`・`seconds`。`scrape` の `media.chapters` と同じ形）、`requestedStartSec`、`transcript`、`availableTracks`（`language`・`source`・`name`）。
  - `transcript`: `status`、`reason`、`message`、`source`（`manual` / `auto`）、`language`、`note`、`fromSec`、`toSec`、`text`、`chars`、`totalChars`、`truncated`、`nextFromSec`。
  - `found: false` のとき `reason` は `video-unavailable`（非公開・削除・年齢制限など）で、`message` に YouTube の理由文を入れます。

### 取得の順序（`src/services/youtube.ts`）

1. URL を解析し、キャッシュを引きます。キーは動画 ID と `lang` だけで、範囲の切り出しはキャッシュの後に行います。
2. player（ANDROID）と動画ページを並行して取得します。動画ページが取れなければ、公開日・カテゴリ・配信中かどうかを省き、結果は 60 秒だけキャッシュします。
3. player の応答は、再生できる（`OK`）と答えた、この動画（`videoDetails.videoId` が一致）のものだけを使います。player は、bot の確認のほか、古いクライアントへの拒否（「not available on this app」）や別の動画の応答を返すことがあります。そのときは動画ページに埋め込まれた応答で代用します（字幕の URL は PO トークン付きで空になり、`unavailable` になります）。
4. どちらも使えないとき、応答した側が再生できないと答えていれば `found: false`（動画ページの答えを先に見る）、bot の確認だけなら `login required (bot check)`、応答が無ければ `request failed` の例外です。
5. 字幕は、言語の候補（`lang`、元の音声の言語、英語）の順に、言語コードが完全に一致する手動 → 基本の言語が同じ手動 → 同じ順の自動字幕、で並べ、最後にほかの言語の手動 → 自動を並べて、上から試します。選んだ字幕が空なら次を試し、取得に失敗したらそこで止めます。取得先が timedtext の https でない字幕は除きます。元の音声の言語は、既定の音声トラックの ID（`audioTracks[defaultAudioTrackIndex].audioTrackId`、例 `ja.4`）から読み、無ければ自動字幕の言語を使います。AI 吹き替えの英語の音声にも自動字幕が付くため、自動字幕の言語だけでは元の言語を決められません（テスト対象の動画がこれでした）。英語の動画で、翻訳の字幕（`de` など）が一覧の先に来ても英語を選びます。
6. 字幕の URL は `www.youtube.com` の `/api/timedtext` だけを許可して取得します。
7. 本文と説明文は `cleanMarkdownTokens` を通します（間接プロンプトインジェクション対策）。
8. 改行だけの event を飛ばし、約 30 秒か 300 字ごとに段落にまとめ、先頭に `[m:ss]`（1 時間以上は `[h:mm:ss]`）を付けた 1 本の文字列にします。

### 字幕の状態

- `ok`: 本文を返します。自動字幕には `note`（音声認識による自動字幕で、聞き間違いを含み、固有名詞や句読点が正しくないことがある。引用するときは自動字幕と伝える）を付け、カテゴリが Music なら歌声の聞き取りで精度が低いことを足します。
- `none` / `no-captions`: 字幕がありません。公開から 48 時間以内なら、しばらくすると自動字幕が付くことがある、と足します。
- `none` / `live-now`: 配信中です。配信が終わると自動字幕が付くことがあります。
- `none` / `language-mismatch`: 題名にかなを含むのに、自動字幕が `ja` 以外しかありません（`lang` が `ja` のときだけ判定）。本文は返さず、その言語を `lang` に指定すると取得できると書きます。
- `unavailable` / `blocked`: YouTube が字幕の取得を拒否しました（bot 確認、空の応答）。`unavailable` / `request-failed`: 通信に失敗しました。どちらも時間をおいて再試行するよう書き、キャッシュしません。

### 長さの制御

`maxChars` を超えたら段落の境目で切り、`truncated: true` と `nextFromSec` を返します。AI は `nextFromSec` を `fromSec` に渡して続きを読みます。最初の段落は `maxChars` を超えても丸ごと返します（段落の途中で切ると、続きを読んだときにその残りが飛ぶため）。同じ秒のうちは段落を分けません（同じ開始秒の段落は、続きを読むときに長さ 0 として落ちるため）。

### チャプター

説明文の時刻行のうち、YouTube と同じく最初が 0:00 のときだけをチャプターとし、動画の長さを超えるものは捨てます。ライブ告知の「17:00 開場 / 17:30 開演」を拾わないためです。

### キャッシュとエラー

- `ok` は 30 分（`CACHE_TTL_DEFAULT`）、`none` は 60 秒（`CACHE_TTL_EMPTY`）キャッシュします。`unavailable` はキャッシュしません。同時の同じ問い合わせは 1 回にまとめます（`runWithSingleFlight`）。
- MCP: 例外は `isError` で `YouTube error: <理由>` を返します。bot 確認は `login required (bot check)` を含め、tool-health で `blocked` に分類されるようにします。
- REST: 入力の誤りは 400、例外は 502 `YOUTUBE_UPSTREAM_ERROR`（retryable）。動画が見つからない場合と字幕なしは 200 です。

## 実装後の確認（2026-10-25。worktree のサーバーをこのホストで起動）

- https://www.youtube.com/watch?v=5Jq35KcE8vI&t=367s: `found: true`。題名・投稿者・公開日（2026-10-23）・536 秒・People & Blogs・`requestedStartSec: 367` が返りました。字幕は `ja` の自動字幕で、17 段落・3,400 字（時刻と区切りを含む）、1 回目は 1.43 秒です。`fromSec: 367, toSec: 427` は、範囲に重なる 5:51・6:24・6:56 の 3 段落（615 字）をキャッシュから 0.002 秒で返しました（v2.46.0 での確認。`toSec` は v2.46.1 で入力から外しました）。この動画には AI 吹き替えらしい英語の音声トラック（`en-US.10`）があり、`en` の自動字幕はその音声のものでした。
- 日本語の自動字幕に句読点が付いていました。そこで `note` は「句読点が無い」と言い切らず、「固有名詞や句読点が正しくないことがある」としました。固有名詞の聞き間違い（説明文の「東名阪ツアー」が「透明ハンツア」になるなど）は実際にありました。
- 字幕なし（HTJEmwSRU60）は `none` / `no-captions`、日本語の MV に `id` の自動字幕だけ（iWu-1vjzvQ0）は `none` / `language-mismatch` でした。Me at the zoo（jNQXAC9IVRw、`de`・`en` の手動字幕）は `en` を選びました。存在しない ID は `found: false`（「この動画は再生できません」）、URL でない入力は 400 です。`maxChars: 1000` では 998 字で切り、`truncated: true`・`nextFromSec: 161` を返しました。
- MCP: 初期の一覧には出ず、`search_tools` の「YouTube 字幕」で見つかって有効になり、同じ結果を返しました。instructions にも載ります。
- 全件テスト（CI と同じ bun 1.4.2）: 2,212 件成功、失敗 0。

## 割り切り

- 範囲の終わり（`toSec`）は入力に持ちません。v2.46.0 では持っていましたが、本番で、省略できる引数に最小値を入れてくる呼び出し側が `toSec: 1` を送り、冒頭が待機画面（字幕は 0:43 から）の講義動画で本文が空になりました。0 秒から字幕がある動画でも、最初の段落だけが `truncated: false` で返り、全部読んだと誤解されます。一部だけ読む使い方は `fromSec` と `maxChars` で足りるので、v2.46.1 で入力から外しました（送られても入力の検証で取り除かれ、無視されます）。出力の `toSec`（返した本文の終わり）は残します。

- ANDROID クライアントの版（`20.10.38`）は定数で固定しています。YouTube に拒否されたら、youtube-transcript-api や yt-dlp の版に合わせて上げます。
- 長い配信の一部だけを質問に合わせて選ぶ機能（`query`）は持ちません。必要になったら、段落を見出しにして `extractWithEscalation` で選びます。

## 対象外

- 音声の取得と音声認識。字幕の無い動画は 30 本中 8 本ありましたが、音声のダウンロードは YouTube の bot 対策に触れるため、許可を得てから別の計画で、取得の可否と速度を試作で測って決めます。
- PO トークンの生成、Cookie の利用、bot 確認の回避。
- YouTube の機械翻訳、コメント、プレビュー画像、`scrape` と `search_deep` の挙動の変更。
