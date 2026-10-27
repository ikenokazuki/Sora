# 音から曲を特定する（recognize_song）の設計

日付: 2026-10-27

## 目的

音声・動画ファイルの音から、流れている曲を Shazam で特定し、iTunes の曲の情報（trackId・ジャケット・試聴 URL など）とつないで返す。もとにするのは [omkarcloud/shazam-scraper](https://github.com/omkarcloud/shazam-scraper)（MIT、Python）の楽曲認識の部分で、Bun（TypeScript）に移植する。

ユーザーの判断（2026-10-27）:

- 音の入口は、音声・動画ファイルの URL と、REST へのアップロード。YouTube などの動画のページからは音を取らない。
- モジュール `shazam` は、歌詞と同じく `ENABLED_MODULES` に名前を挙げたときだけ有効にする（`all` では有効にならない）。公開された API ではなく、Shazam の iPhone アプリと同じ窓口を、アプリを名乗って使うため（元のコードも同じ）。
- 16 kHz への変換は、本番のイメージにある Chromium（Web Audio）で行う。イメージに ffmpeg は足さない。
- tool-health の実 API の検査に 1 件入れる（毎日 1 回、iTunes の試聴音源で送る）。

## 調べたこと（2026-10-27、このサーバーから）

- shazam-scraper は 25 個の API を持つ Python のサーバー。楽曲の認識は次の流れになっている。
  1. ffmpeg で 16 kHz・モノラルの PCM にする。
  2. 12 秒の窓から指紋（`sigx.py`）を作る。2048 点の Hanning 窓の FFT を 128 サンプルごとに取り、3 つの帯（250〜520 Hz、520〜1450 Hz、1450〜3500 Hz）のピークを、magic `0xCAFE2580`・CRC-32・帯ごとの TLV の 2 進の形に詰める。
  3. その指紋を `amp.shazam.com/discovery/v5/{言語}/{国}/iphone/-/tag/{UUID}/{UUID}` に POST する。
  4. 窓は、指定が無ければ最大 3 つ（長い音は真ん中から、続けて先頭から）を試し、最初に当たった窓の結果を返す。
- Apple の曲 ID は、応答の `track.trackadamid` にある。無ければ、`hub.actions` の `applemusicplay` か、`hub.options` の Apple Music の URL の末尾から取る。
- 本番のイメージ（ghcr.io/ikenokazuki/sora:2.50.0、Chromium 156）の `OfflineAudioContext(…, 16000).decodeAudioData` で、iTunes の試聴音源（m4a・AAC）と、それを変換した mp3・webm（Opus）・ogg（Vorbis）・wav・flac・mp4（H.264 と AAC の動画）を、すべて 16 kHz に変換できた。30 秒の音で、変換は 160〜250 ms、ページとのやりとりを含めて 230〜910 ms。ffmpeg で変換した同じ 12 秒との相関は、m4a・wav・flac が 0.9993、mp3 が 0.9953、ogg が 0.9939、webm が 0.9846、動画の mp4 が 0.9554（AAC の作り直しで 372 サンプルずれる）。
- 元の Python の指紋の関数を手元で動かして答え合わせの指紋を作ろうとしたが、自動モードの分類器に止められた（ダウンロードしたコードの実行）。元のコードは動かさず、移植した指紋で Shazam が実際に曲を当てるかどうかで確かめる。

## 設計

### 入口

- MCP `recognize_song`（モジュール `shazam`、遅延ツール、`EXPLICIT_ONLY_MODULES` に足す）。引数は次のとおり。
  - `url`: 音声・動画ファイルの URL（必須）
  - `offsetSec`: 聞き始める位置（秒、0 以上の整数、省略可）
  - `country`: iTunes の国（既定 `jp`）
  - `noCache`
- 範囲の終わりの引数は持たない（省略可能な数値に最小値を入れる呼び出し側がいる。YouTube の字幕の `toSec` の教訓）。`offsetSec: 0` は先頭から聞くだけなので、入っても壊れない。
- REST `POST /music/recognize`: JSON の `{ url, offsetSec?, country?, noCache? }`、または multipart の `file` を受け取る（multipart のとき、ほかの引数は同じ名前のフォームの欄）。アップロードは Sora 全体の上限の 10 MB まで（超えると今までどおり 413）。モジュールが無効なら 404 `MODULE_DISABLED`（`/lyrics` と同じ）。

### 返す内容

```
{
  found: boolean,
  reason?: 'no-match' | 'not-audio' | 'too-short' | 'too-large',
  message?: string,
  itunes: MusicItem | null,          // search_song の items と同じ形（id は trackId）
  itunesMatch: 'apple-id' | 'title-artist' | null,
  shazam?: { key, title, artist, isrc, appleMusicId, album, label, genre, releaseDate, url, artwork },
  match?: { songOffsetSec, clipOffsetSec },
  attempts: [{ offsetSec, durationSec, matched }],
  audio: { bytes, durationSec, contentType },
  ...キャッシュの情報（cached など）
}
```

- 当たらなかったときは `found: false`・`reason: 'no-match'`。`message` には「Shazam で曲を特定できなかった。別の位置（offsetSec）や、はっきり録れた音で試す。曲名を推測で答えない」と書く。
- iTunes とのつなぎ方:
  1. Shazam の Apple の曲 ID で、iTunes の lookup（`https://itunes.apple.com/lookup?id=…&country=…&entity=song`）を引く。`itunesMatch: 'apple-id'`。
  2. ID が無いとき、その国に曲が無いときは、iTunes の検索（曲名 + アーティスト）で、曲名とアーティストが（大文字小文字・全角半角・空白を揃えて）一致する最初の 1 件だけを使う。`itunesMatch: 'title-artist'`。
  3. それでも無ければ `itunes: null`・`itunesMatch: null` にして、Shazam の結果だけを返す。
- iTunes の項目の作り方は、`src/services/music.ts` の検索の変換を関数に切り出して共用する（lookup と検索で同じ形になる）。

### 中の流れ（`src/services/song_recognition.ts`）

1. 音を受け取る。URL は `fetchWithSafeRedirects` と `readBodyWithLimit`（20 MB）で読む（SSRF の防御は今の取得と同じ）。応答が HTML のときは `not-audio` にし、「動画のページではなく、音声・動画ファイルの URL を渡す」と書く。20 MB を超えたら `too-large`。
2. 変換する。ブラウザの枠（`browserSemaphore`）を取り、共有の Chromium（`getBrowser`）の空のページで `decodeAudioData` を行う。チャンネルの平均でモノラルにし、使う窓だけを Int16 にして Bun に返す。読めない形式は `not-audio`、3 秒未満は `too-short`。使い終わったページは閉じ、`recordBrowserUsage` を呼ぶ。
3. 窓を選ぶ（元のコードと同じ）。`offsetSec` があれば、そこから 12 秒の 1 回だけ。無ければ、36 秒を超える音は真ん中の 12 秒から、続けて先頭から 12 秒ずつ、合わせて最大 3 回。当たった時点で止める。
4. 指紋を作る（`src/services/shazam_signature.ts`）。`sigx.py` を TypeScript に移植する。FFT は 2048 点の実数 FFT を自前で書き、依存は足さない。CRC-32 は Bun の組み込みを使う。ファイルの先頭に、元の MIT のライセンス表示を残す。
5. Shazam に送る。元のコードと同じ窓口・クエリ・ヘッダー（`X-Shazam-Platform: IPHONE`、Shazam の iOS アプリの `User-Agent`）で、言語と国は `country` から決め（jp なら `ja`・`JP`）、タイムゾーンは `Asia/Tokyo`。ふつうの `fetch` を使い、TLS の偽装はしない。403・429 はブロックされたエラー、5xx・通信の失敗・時間切れはエラーにする。どちらも再試行しない（Shazam に連続で送らない）。
6. iTunes につなぐ（上のとおり）。iTunes の失敗は、曲の特定の結果を消さない（`itunes: null` にする）。
7. キャッシュする。鍵は、音のバイト列の SHA-256・`offsetSec`・`country`。当たりは 30 分（`CACHE_TTL_DEFAULT`）、外れは 60 秒（`CACHE_TTL_EMPTY`）残し、エラーは残さない。同じ音の同時の問い合わせは `runWithSingleFlight` で 1 本にまとめる。

### エラーの返し方

- MCP: 結果は `toolJson`。例外は `isError` で `Song recognition error: <理由>`（tool-health の分類に合わせ、ブロックは `blocked`、通信の失敗は `request failed`・`timeout` を含める）。
- REST: 400 `INVALID_JSON` / `INVALID_INPUT`、例外は 502 `SONG_RECOGNITION_UPSTREAM_ERROR`（再試行可）。当たらない・音でない・短すぎる・大きすぎるは 200 で `found: false` と `reason`。

### そのほか

- MCP の指示文（instructions）には足さない（上限の 8,800 字の近くまで使っている）。使い方と、`found: false` のときに推測しないことは、ツールの説明文に書く。
- tool-health の台帳に `recognize_song` と `POST /music/recognize` を載せ、実 API の検査に 1 件入れる（iTunes の試聴音源の URL を渡し、`found: true` で Apple の曲 ID が一致することを見る）。GitHub の実行環境から Shazam が拒否されたら、ブロックとして扱う（soft hold）。
- ツール数・操作数・`context_budget` などを固定しているテストは、モジュールが既定で無効なので変わらない見込み。変わるものは直す。

## 確認

- 単体（合成のデータだけ。実在の曲の音は使わない）:
  - 指紋: 正弦波・和音で、ピークの帯と周波数、ヘッダーの magic・CRC・長さ・サンプル数、帯ごとの TLV の形と 4 バイト境界。
  - 窓の選び方: 短い音・長い音・`offsetSec`。
  - Shazam の応答の読み取り: 当たり・外れ、Apple の曲 ID の 3 か所。
  - iTunes のつなぎ方: ID で当たる、その国に無く検索で一致する、一致しない、iTunes の失敗。
  - 変換: Chromium のページの処理を差し替えて、窓の切り出しとエラーの分類。
  - REST: 404・400・200・502。MCP: 名前を挙げたときだけ出る、search_tools で見つかる。
- 実機（手元のサーバー、別ポート・一時の DB）:
  - iTunes の試聴音源（YOASOBI「アイドル」、君と見るそら「遠回りがいいっ!」ほか数曲）の 12 秒を送り、同じ trackId に戻ること。形式は m4a・mp3・webm・mp4。
  - 雑音を足した音（スマホの録音に近いもの）でも試す。
  - HTML のページの URL は `not-audio`、2 秒の音は `too-short`。
  - Shazam が通らない（このサーバーの IP で拒否など）、または送信が自動モードに止められたら、そこで止めてユーザーに相談する。
- 曲の音や歌詞を出力しない。見るのは曲名・ID・件数・時間だけ。

## 対象外

- 元の残りの 24 個の API（曲の詳細・歌詞・チャート・コンサートなど）。
- shazam.com から Apple Music の開発者の鍵を取り出して使う部分、住宅回線を経由してボット対策を避ける部分、TLS の偽装。
- YouTube・TikTok などの動画のページからの音の取得（YouTube の音声の取得は 2026-10-25 に自動モードに止められた）。
- マイクで録る画面（client-app などの呼び出し側で作る）。
- 20 MB を超える長いファイルの途中だけを読むこと（Chromium はファイルをまるごと変換する）。
