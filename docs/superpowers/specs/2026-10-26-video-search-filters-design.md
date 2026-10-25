# 動画検索の期間と動画サイトの指定の設計

日付: 2026-10-26

## 目的

X の検索（`search_realtime`）のように、動画の検索（`search_video` と `search_deep` の `videos`）でも条件を指定できるようにする。ユーザーが選んだのは、投稿日の期間と動画サイト（プラットフォーム）の 2 つ。アカウントと長さは今回は足さない。

## 調べたこと（2026-10-26）

- Sora の動画検索は、同梱の Yahoo の MCP（`yahoo_video_search`）を使っている。受け付けるのは検索語・件数・ページだけ。
- Yahoo の動画検索のページ（`https://search.yahoo.co.jp/video/search`）には、絞り込みが 4 つある。URL の指定は、ページの JavaScript から読み取った。
  - 投稿日 `pd`: `0`=1 時間以内、`1`=24 時間以内、`2`=1 週間以内、`3`=1 か月以内、`4`=1 年以内
  - 長さ `dr`: `0`=4 分未満、`1`=4〜20 分、`2`=20 分以上
  - 動画サイト `st`: `youtube`・`niconico`・`dailymotion`（ほかに成人向けの `dmm`）
  - 高画質 `hq=1`
- 実測: `pd=2&dr=0&st=youtube` で、20 件すべてが YouTube の、2〜6 日前に投稿された 20 秒以下の動画になった。検索語に `site:tiktok.com` を足すと、20 件すべてが TikTok になった。
- ページ送りは `b`（何件目から。1 ページ 20 件）。`b=21` の結果は、1 ページ目と 3 件しか重ならなかった（1 ページ目を 2 回取ると 17 件が重なる）。
- 結果はページの `__NEXT_DATA__`（`props.initialState.domainState.videoAlgo.items`）にある。項目は `title`・`refererUrl`（動画の URL）・`duration`・`summary`・`thumbnail.url`・`uploadDate`・`uploader`・`source`（「YouTube」「TikTok」「X」など）。同梱の MCP の結果は、これと同じ項目を `url`・`upload_date` などの名前で返していた。
- Yahoo には、アカウント・タグ・並べ替えの絞り込みは無い。

## 設計

- `search_video`（MCP と REST の `/search/video`）に、次の 2 つを足す。どちらも既定は `all` で、指定しなければ今までどおり同梱の MCP で検索する。
  - `updated`: `all`・`hour`・`day`・`week`・`month`・`year`（Yahoo の `pd`）
  - `platform`: `all`・`youtube`・`tiktok`・`x`・`instagram`・`niconico`・`dailymotion`。YouTube・ニコニコ・Dailymotion は Yahoo の `st` で、TikTok・X・Instagram は検索語に `site:` を足して絞る。
- どちらかを指定したときは、Sora が Yahoo の動画検索のページを直接読む（Web 検索の直接取得と同じ `fetchWithSafeRedirects`）。結果は同梱の MCP と同じ形にそろえる。Yahoo が拒否したとき（429 など）は、絞り込みの無い結果で代わりにせず、エラーにする。
- 同梱の MCP の経路と同じく、Yahoo への間隔を守り（`gateYahooCall`）、ブレーカーが開いている間は送らず、429 でブレーカーを開く（`tripYahooBreaker`）。`search_deep` の `videos` は毎回この経路を通るので、client-app と分け合う Yahoo の枠を守るため。
- 0 件のページは `videoAlgo.items: []` で返る（2026-10-26 に確認）。`__NEXT_DATA__` が無いページ（ブロックの画面など）はエラーにする。`site:x.com` でも 20 件すべてが X になった。
- `search_deep` の `videos` は、字幕を読めるのが YouTube だけなので YouTube に絞って探し、期間は `search_deep` の `updated`（Web 検索と同じ）を使う。`search_deep` に引数は足さない（最初から公開しているツールで、説明の文字数に余裕が無い）。
- 全ツールの一覧の文字数は 62,284 から 62,556 になった。`search_video` の説明文の重複（返す項目を本文と「返却」の両方に書いていた）を削ったうえで、上限を 62,500 から 63,000 に上げた。

## 対象外

- アカウント（投稿者）での絞り込み、長さ、高画質、タグ。タグは検索語に「#タグ」を入れれば、題名や説明に含む動画が出る。

## 確認

- `src/video_search_filters.test.ts`: URL の組み立て（期間・動画サイト・ページ）、ページの読み取り（同梱の MCP と同じ形）、直接の取得とエラー、`search_deep`・REST・MCP からの受け渡し。
