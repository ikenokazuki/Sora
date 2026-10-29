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
- `search_deep`（キャッシュなし）は 7.9〜13.4 秒でした。動画の側（動画検索と上位 3 本の字幕を並行して取得）は 0.6〜2.3 秒で、Web のページを読む間に終わります。動画を足しても待ち時間はほとんど増えません。増えるのは、Yahoo の検索 1 回（同じ回線のほかの利用と枠を分け合い、429 が出ている）と、YouTube への問い合わせ最大 9 回です。このため、既定では動画を検索しません（ユーザーの判断）。

## 設計

### scrape（YouTube の動画 URL）

- `scrapeUrl` の中で、X の投稿の差し替えと同じ場所で、YouTube の動画 URL を `getYoutubePage`（`src/services/youtube.ts`）で本文にします。段落の選び方（rho-select）、`maxChars`、キャッシュは、ほかのページと同じように効きます。`scrape_batch`・`search_web` の `formats`・`search_deep` も同じ経路を通ります。
- 本文は、題名・チャンネル・公開日・長さ・URL、説明文、字幕です。字幕の段落は `### 1m23s` の見出しで分け、段落ごとに選べるようにします。`[1:23]` のような時刻の書き方は、「何時」の答えを探す採点（`src/retrieval/answerability.ts` の `TIME_PATTERN`）に時刻と誤認されるので使いません。長さも「秒」で書きます（「時間」の「時」も同じ採点に当たるため）。
- チャプターがある動画では、字幕の段落をチャプターの見出しの下に並べ（`### 2h02m02s〜 主成分分析 | …` の下に `#### 2h02m15s`）、説明文からはチャプターの行を外します（チャプターは `media.chapters` にあります）。v2.47.0 では、説明文の目次の行が検索語にぴったり一致し、段落の選び方（rho-select v2）が字幕の段落ではなく説明文の節を選んでいました（v2.47.1）。
- 字幕が `maxChars` に収まらないときは、切る前に、検索語（`query`）に関係する段落を BM25 で選び、時刻順に載せます（検索語を含む段落が無ければ先頭から）。`scrape` は `maxChars` で切ってから段落を選ぶため、そのままでは長い講義の後半が選ぶ対象になりませんでした（v2.47.1）。どちらの場合も、載せ方と全体の文字数を本文に書き添えます。キャッシュのキーには `query` と `maxChars` が入っているので、本文が検索語で変わっても混ざりません。
- `contentStatus` は、字幕があれば `body`、無ければ `metadata_only`、取得できなければ `unavailable` です。`search_deep` は後の 2 つを使えないページとして扱い、次の候補を読みます。YouTube に拒否されても例外にせず `unavailable` のページを返し、`scrape` の再試行で問い合わせを重ねません。
- ページそのもの（`html`・`rawHtml`・`links`・`screenshot`）やブラウザでの描画（`mode: "browser"`・`renderJs`）を求められたとき、youtube モジュールが無効なときは、今までどおりページを読みます。

### search_video の transcripts

- `transcripts`（0〜5、既定 0）と `transcriptChars`（500〜10,000、既定 2,000）を足しました。上位の YouTube 動画の指定した本数に、`transcript`（`status`・`excerpt`・`text`・`chars`・`totalChars` など）を付けます。YouTube 以外の結果は変えません。1 本が失敗しても、ほかの結果は返します。
- 段落の選び方は、検索語を語と 2 語のつながり（`extractTermsWithBigrams`）に分け、見出しの階層ボーナス付き BM25（`scorePassage`。段落が入るチャプターの名前を見出しとして加点する）で点数の高い順に `transcriptChars` まで選び、時刻順に並べます。長い字幕のふるい（`scrape`）も同じ関数です。どの段落にも検索語が無ければ、先頭から返します（`excerpt: "head"`）。

### search_deep の videos

- `videos`（0〜5、既定 0）を足しました。Web 検索と並行して Yahoo の動画検索を行い、上位の YouTube 動画（動画 ID で重複を除く）を `scrapeUrl` で読みます。Web のページと同じく、検索語に関係する部分が選ばれます。
- 動画は `results` の Web のページの後に `source: "youtube"` で足します。根拠だけを返す形（`responseMode: "evidence"`）、全体の文字数の上限（`maxTotalChars`）、十分さの判定（`contextSufficiency`）、キャッシュは、そのまま効きます。同じ動画が Web の結果にあれば足しません。取得できなかった動画は足しません（字幕の無い動画は、説明文だけの結果として足します）。
- 締切（`scrapeDeadlineMs`）があれば、そこまでだけ待ちます。間に合わなかったときは動画を足さず、その応答はキャッシュしません。

### 既定値と案内

省略できる引数には、すべて既定値を持たせます。v2.46.1 で分かった「既定値の無い引数に最小値を入れてくる呼び出し側」でも、意図しない動作にならないようにするためです。

既定は 0 なので、AI が指定しないと動画は使われません。instructions の YouTube の項目（10 番）を短く書き直し、「動画を探すなら `search_video` の `transcripts:3`、調べものなら `search_deep` に `videos:2`」を足しました（v2.47.1、8,706 → 8,750 字。上限 8,800 字の中）。yahoo・web のモジュールを外した設定では、そのツールの案内を出しません。

## 選び方の比較（v2.47.1、2 時間 18 分の講義、チャプター 54 件）

チャプター名で検索し、選んだ段落がそのチャプターの時間に入っていた割合を、6 つのチャプターで平均しました（括弧内は v2.47.0 の構成）。

- rho-select v2（`search_deep`・`scrape` の最後の選び方）: 100%（17%。説明文の目次を選んでいた）。選ぶのは 1 段落。
- 見出しの階層ボーナス付き BM25（`search_video` の抜き出し）: 84%（素の BM25 で 44%）。1 本あたり約 9 段落（2,000 字）。
- BM25＋MMR（`extractQueryHighlightDetails`）: 83%（46%）。5 件。

BM25 と MMR は同程度なので、文字数まで詰められる BM25 を抜き出しに使います。rho-select は少数の根拠を選ぶ作りなので、`search_deep` の最後の絞り込みに使います（ほかのページと同じ）。

## 確認

- `src/youtube_search.test.ts`（本文の作り方、字幕なし・拒否、`scrapeUrl`、`search_deep` の `videos`、締切、指定しないときは動画を検索しないこと）と、`src/services/youtube.test.ts`（段落の選び方、検索結果への付け方）。
- `search_deep` は最初から公開しているツールなので、説明文と引数の文字数に余裕がありません。`videos` の説明は引数の側に短く書き、既定の一覧は 24,861 字（上限 25,000 字）、全ツールは 62,284 字（上限 62,500 字）に収めました。

## 対象外

- `get_youtube_transcript` に検索語で部分を選ぶ機能（`query`）を足すこと。今は `search_video` と `search_deep` の側だけで選びます。
- 字幕の無い動画の音声認識（[YouTube の字幕の設計](2026-10-25-youtube-transcript-design.md) の対象外を参照）。
