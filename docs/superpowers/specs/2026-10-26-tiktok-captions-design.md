# TikTok の動画を字幕で読む（scrape）の設計

日付: 2026-10-26

## 目的

YouTube と同じく、TikTok の動画の中身（話している内容）を、どの AI でも読めるようにする。ユーザーの判断で、入口は `scrape` にする（`search_deep` の検索語の URL・`scrape_batch`・`search_web` の `formats` も同じ経路を通る）。新しいツールは足さない。

## 調べたこと（2026-10-26、このサーバーから）

- 静的な取得では、動画のページは WAF の確認画面（1.4KB）になる。公式の oEmbed は、動画については埋め込みのタグ（iframe）しか返さない。
- Sora のブラウザ（`scrape` の通常の描画）では、ページを開ける。開けたページの埋め込みデータ（`__UNIVERSAL_DATA_FOR_REHYDRATION__` の `webapp.video-detail` → `itemInfo.itemStruct`）に、説明文（`desc`）・投稿者（`author`）・投稿日時（`createTime`）・長さ（`video.duration`）と、字幕の欄（`video.subtitleInfos`・`video.claInfo.captionInfos`）がある。本番では一度 403 になった（エラーの画面は v2.48.0 から `unavailable`）。
- 話している動画 6 本のうち 4 本に、日本語の自動字幕があった（`Source: ASR`・`isAutoGen: true`・`variant: whisper_lid`、WebVTT）。2 本は字幕が無かった（`noCaptionReason: 3`。天気の解説と、話している Vlog）。
- 字幕の URL（`v16-webapp.tiktok.com`）には、期限つきの署名がページの側で付いている。Cookie も Referer も無いふつうの取得で、HTTP 200 と WebVTT が返った（`Content-Type` は `video/mp4` と名乗る）。
- 1 本あたり約 10〜13 秒（ブラウザで開くため）。

## 設計

- `scrape` は、TikTok の動画の URL（`www.`・`m.`・ホストなしの `tiktok.com` の `/@ユーザー/video/動画 ID`）を、最初からブラウザで開く（静的な取得は確認画面しか返らない）。ページそのもの（`html`・`rawHtml`・`links`・`screenshot`）を求められたとき、`mode: "fast"` のとき、Chromium が無いときは、今までどおり。
- 開いたページの埋め込みデータから、YouTube と同じ形の本文を作る（`src/services/tiktok.ts`）。題名、投稿者・投稿日・長さ・URL、`## 説明文`、`## 字幕（TikTok の自動字幕。聞き間違いを含む）`。字幕は約 30 秒か 300 字ごとの段落にし（YouTube の `json3ToParagraphs` に WebVTT の文を渡す）、`### 1m23s` の見出しで分ける。
- 字幕は、元の言語の字幕（`isOriginalCaption`）を選ぶ。TikTok が訳した字幕は使わない。取得先は TikTok のホスト（`tiktok.com`・`tiktokcdn.com`）の https だけ。期限つきの URL なので、その場でだけ使い、保存しない。
- 字幕が無い動画は、説明文だけの本文にし（`metadata_only`）、「話している内容は推測で補わない」と書く。字幕を取得できなかったときも同じにして、そのことを書く。
- 403 のとき、埋め込みデータが無いとき（ページの作りが変わったときなど）は、ふつうのページとして読む（403 は `unavailable`）。
- ponytail: 長い字幕でも、検索語に関係する段落を選ばない（YouTube の長い字幕の扱いは入れない）。TikTok は短い動画が多く、16 分のニュース解説で約 7,300 字。`scrape` の `maxChars` で切る。

## 確認

- `src/tiktok_captions.test.ts`: URL の判定、WebVTT の読み取り、本文の作り方（字幕あり・なし・取得の失敗・TikTok 以外のホスト・データなし）、`scrape` が最初からブラウザで開くこと、403 が `unavailable` のままであること。
- 手元のサーバーで本物の TikTok（2026-10-26）: 共同通信の 16 分のニュース解説は自動字幕 33 段落・7,305 字（13 秒）、尾木ママの動画は 6 段落（11.5 秒）、字幕の無い天気の解説は `metadata_only`（9.8 秒）。`search_deep` に TikTok の URL を渡すと、字幕つきの 1 件だけを返した（11 秒）。

## 対象外

- `search_video` の `transcripts` で TikTok の字幕を付けること（1 本ごとにブラウザで約 12 秒かかる）。
- 短縮 URL（`vm.tiktok.com`）を転送先で判定すること。
