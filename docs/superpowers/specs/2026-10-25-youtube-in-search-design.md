# 検索で YouTube の字幕を使う（scrape・search_video・search_deep）の設計

日付: 2026-10-25

## 目的と要件

YouTube の字幕（`get_youtube_transcript`、v2.46.0）を、検索の側からも使えるようにします。

- 「テーマについて YouTube で何が語られているか」を複数の動画から集める使い方と、「動画を探して中身を読む」使い方の両方に使えること。1 回の呼び出しで、上位の YouTube 動画それぞれから検索語に関係する部分を時刻つきで返し、全文は `get_youtube_transcript` で読みます。
- `search_deep` でも使えること。
- 使わない呼び出しに負担をかけないこと。動画の検索は指定したときだけ行います（既定 0）。

## 調べたこと（2026-10-25、本番で計測）

- Yahoo の動画検索（`search_video`）の結果は、YouTube 以外も混ざります。「君と見るそら ライブ」は 10 件中 5 件が YouTube（残りは X・Instagram・TikTok）、「線形代数 講義 特異値分解」は 10 件中 9 件でした。URL は `watch?v=` の形です。1 回 0.6〜0.9 秒です。
- 今の `scrape` は、YouTube の動画 URL を読むのに 10.6 秒かかり、本文はおすすめ動画の一覧（別の動画の題名）でした。チャプターも 2 件しか拾えていません。`search_deep` の Web 検索の結果に YouTube が混ざると、この一覧を根拠として読んでいました。
- `search_deep`（キャッシュなし）は 7.9〜13.4 秒でした。動画の側（動画検索と上位 3 本の字幕を並行して取得）は 0.6〜2.3 秒で、Web のページを読む間に終わります。動画を足しても待ち時間はほとんど増えません。増えるのは、Yahoo の検索 1 回（client-app と枠を分け合い、429 が出ている）と、YouTube への問い合わせ最大 9 回です。このため、既定では動画を検索しません（ユーザーの判断）。

## 設計

### scrape（YouTube の動画 URL）

- `scrapeUrl` の中で、X の投稿の差し替えと同じ場所で、YouTube の動画 URL を `getYoutubePage`（`src/services/youtube.ts`）で本文にします。段落の選び方（rho-select）、`maxChars`、キャッシュは、ほかのページと同じように効きます。`scrape_batch`・`search_web` の `formats`・`search_deep` も同じ経路を通ります。
- 本文は、題名・チャンネル・公開日・長さ・URL、説明文、字幕です。字幕の段落は `### 1m23s` の見出しで分け、段落ごとに選べるようにします。`[1:23]` のような時刻の書き方は、「何時」の答えを探す採点（`src/retrieval/answerability.ts` の `TIME_PATTERN`）に時刻と誤認されるので使いません。長さも「秒」で書きます（「時間」の「時」も同じ採点に当たるため）。
- `contentStatus` は、字幕があれば `body`、無ければ `metadata_only`、取得できなければ `unavailable` です。`search_deep` は後の 2 つを使えないページとして扱い、次の候補を読みます。YouTube に拒否されても例外にせず `unavailable` のページを返し、`scrape` の再試行で問い合わせを重ねません。
- ページそのもの（`html`・`rawHtml`・`links`・`screenshot`）やブラウザでの描画（`mode: "browser"`・`renderJs`）を求められたとき、youtube モジュールが無効なときは、今までどおりページを読みます。

### search_video の transcripts

- `transcripts`（0〜5、既定 0）と `transcriptChars`（500〜10,000、既定 2,000）を足しました。上位の YouTube 動画の指定した本数に、`transcript`（`status`・`excerpt`・`text`・`chars`・`totalChars` など）を付けます。YouTube 以外の結果は変えません。1 本が失敗しても、ほかの結果は返します。
- 段落の選び方は、検索語を語と 2 語のつながり（`extractTermsWithBigrams`）に分け、段落ごとの BM25（`bm25BodyScore`）で点数の高い順に `transcriptChars` まで選び、時刻順に並べます。どの段落にも検索語が無ければ、先頭から返します（`excerpt: "head"`）。

### search_deep の videos

- `videos`（0〜5、既定 0）を足しました。Web 検索と並行して Yahoo の動画検索を行い、上位の YouTube 動画（動画 ID で重複を除く）を `scrapeUrl` で読みます。Web のページと同じく、検索語に関係する部分が選ばれます。
- 動画は `results` の Web のページの後に `source: "youtube"` で足します。根拠だけを返す形（`responseMode: "evidence"`）、全体の文字数の上限（`maxTotalChars`）、十分さの判定（`contextSufficiency`）、キャッシュは、そのまま効きます。同じ動画が Web の結果にあれば足しません。取得できなかった動画は足しません（字幕の無い動画は、説明文だけの結果として足します）。
- 締切（`scrapeDeadlineMs`）があれば、そこまでだけ待ちます。間に合わなかったときは動画を足さず、その応答はキャッシュしません。

### 既定値

省略できる引数には、すべて既定値を持たせます。v2.46.1 で分かった「既定値の無い引数に最小値を入れてくる呼び出し側」でも、意図しない動作にならないようにするためです。

## 確認

- `src/youtube_search.test.ts`（本文の作り方、字幕なし・拒否、`scrapeUrl`、`search_deep` の `videos`、締切、指定しないときは動画を検索しないこと）と、`src/services/youtube.test.ts`（段落の選び方、検索結果への付け方）。
- `search_deep` は最初から公開しているツールなので、説明文と引数の文字数に余裕がありません。`videos` の説明は引数の側に短く書き、既定の一覧は 24,861 字（上限 25,000 字）、全ツールは 62,284 字（上限 62,500 字）に収めました。

## 対象外

- `get_youtube_transcript` に検索語で部分を選ぶ機能（`query`）を足すこと。今は `search_video` と `search_deep` の側だけで選びます。
- instructions への案内の追加（文字数の余裕が 94 字しかないため。引数の説明で案内します）。
- 字幕の無い動画の音声認識（[YouTube の字幕の設計](2026-10-25-youtube-transcript-design.md) の対象外を参照）。
