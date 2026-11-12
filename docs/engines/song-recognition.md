# 音から曲を特定して外れを見分ける

音声・動画ファイルの音から、流れている曲を特定し、iTunes の曲とつなぐエンジンです。**楽曲認識は任意のモジュール `shazam` で、`SORA_MODULES` に `shazam` を名前で挙げたときだけ有効になります。`all` には含まれません。** 公開された API ではない窓口を使うため、自己責任の機能です。

認識サービスは、聞き取れなくても、似た別の曲を返すことがあります。その返事をそのまま答えにすると、別の曲名を自信をもって答えてしまいます。Sora は、返事の「ずれ」を測って確かでない当たりを見分け、別の窓で確かめます。それでも確かでなければ、確かでないと印を付けて返します。

## 使うツール

- MCP `recognize_song`（モジュール `shazam`。遅延ツールなので `search_tools` で有効化します）。引数は `url`（音声・動画ファイルの URL）、`offsetSec`、`country`（既定 `jp`）、`noCache` です。
- REST `POST /music/recognize`。JSON の `url`、または multipart/form-data の `file`（アップロード）を受け取ります。
- REST `POST /music/recognize/signature`。端末で作った指紋を受け取ります。MCP のツールはありません。
- モジュールが無効なら、MCP のツールは登録されず、REST は 404 `MODULE_DISABLED` です。

## 手元のデータと外への問い合わせ

- 手元に曲のデータはありません。持っているのは、音から指紋を作る処理です。指紋は、音の周波数の特徴を並べた短いデータです。この処理は、MIT ライセンスの shazam-scraper の移植で、`packages/audio-signature` に入っています。
- 音の変換には、同梱の Chromium の Web Audio を使います。起動時の処理・常駐タイマー・事前取得はありません。
- 外に出るのは、呼ばれたときの 3 か所です。
  1. 音声ファイルの URL を読みます（20 MB まで、30 秒の制限。取得時の安全確認は他の取得と同じです）。
  2. 認識サービスに指紋を送ります。音そのものは送りません。20 秒で時間切れとし、再試行はしません。
  3. iTunes の Lookup・Search API で曲を引きます（8 秒で時間切れ）。
- 結果は、音の SHA-256 ハッシュ・`offsetSec`・`country` ごとにキャッシュします。確かな当たりは 30 分です（iTunes への問い合わせが失敗したときを除きます）。外れ・確かでない当たり・変換できない音・短すぎる音は 1 分です。URL を読めなかったときは保存しません。指紋の経路はキャッシュしません。

## 決め方

1. **入力を確かめる**。`country` は 2 文字の国コード、`url` は http(s) だけです。URL は読み込み、HTML が返ったら音ではないとして断ります。
2. **音を変換する**。ファイル全体を Web Audio で 16 kHz のモノラルにして、長さを得ます。読めなければ `not-audio`、3 秒未満なら `too-short` です。
3. **窓を選ぶ**（`pickWindows`）。窓は、指紋を作る 12 秒の区間です。`offsetSec` があれば、その位置の 1 つだけです。なければ、36 秒を超える音は真ん中を先頭に置き、続けて音の先頭から 12 秒ずつ、合わせて最大 3 つです。
4. **指紋を作って送る**。窓を順に、当たるまで試します。3 秒に満たない窓や、静かすぎる窓は飛ばします。
5. **当たりを検査する**。返事の時間のずれ（`timeSkew`）と周波数のずれ（`frequencySkew`）のどちらかの絶対値が 0.002 を超える当たりは、「確かでない」（`uncertain`）とします。しきい値は、2026-10-27 の実測で決めました。正しい当たりは 0.00012 以下で、別の曲を返した当たりは周波数のずれが 0.0051 でした。
   - 確かな当たりが出れば、そこで止めます。
   - 確かでない当たりは覚えておき、次の窓で確かめます。最後まで確かな当たりが無ければ、最初に覚えた確かでない当たりを `match.uncertain: true` と注意の `message` つきで返します。
6. **iTunes とつなぐ**。認識サービスが返す Apple の曲 ID で Lookup します（`itunesMatch: "apple-id"`）。ID が無い、または見つからなければ、題名とアーティストで検索し（最大 10 件）、両方が全角半角・大小文字・空白を無視して一致する結果を採ります（`"title-artist"`）。どちらも無ければ `itunes: null` です。
7. **返す**。曲（`shazam`）、曲の何秒目か（`match.songOffsetSec`）、窓ごとの記録（`attempts`）、音の長さ（`audio`）を付けます。

端末で指紋を作る `POST /music/recognize/signature` は、4〜6 を 1 窓だけで行います。指紋の形と長さを確かめてから送り、合わなければ送りません。窓が 1 つなので、確かでない当たりは、そのまま `uncertain: true` で返します。

## 決められないとき

特定できなくても、HTTP 200 で `found: false` と `reason` と `message` を返します。`message` には、曲名を推測で答えないよう LLM への指示が入ります。

| `reason` | 意味 |
|---|---|
| `no-match` | 試したすべての窓で当たらなかった。`attempts` に試した位置が残る |
| `not-audio` | 動画のページの URL、またはデコードできないデータ |
| `too-short` | 音が 3 秒未満、または静かすぎる。`offsetSec` が音の長さを超えているときも |
| `too-large` | URL の先が 20 MB を超える |
| `download-failed` | URL を読めない、HTTP エラー、読み切れない |

例（URL は架空です）。

```
入力: {"url": "https://example.test/talk.mp3"}
答え: {"found": false, "reason": "no-match",
       "message": "…曲名を推測で答えないでください。",
       "attempts": [{"offsetSec": 24, "durationSec": 12, "matched": false}, …]}
```

確かでない当たりは `found: true` のまま、`match.uncertain: true` と「別の曲のことがあります」という注意を付けて返します。呼び出し側は、確かな曲として扱わないでください。

入力の誤りは 400 `INVALID_INPUT`、認識サービスの拒否・制限・障害・時間切れは 502 `SONG_RECOGNITION_UPSTREAM_ERROR`（`retryable: true`。キャッシュしません）です。指紋の経路では、当たっても iTunes への問い合わせが失敗したら 502 にします。`itunes: null` は、つなげる曲が無かったときだけにするためです。

## 限界

- 公開された API ではない窓口に頼ります。予告なく変わったり止まったりすることがあります。
- 認識できるのは、認識サービスが知っている曲だけです。
- 動画のページ（YouTube など）からは音を取りません。音声・動画ファイルの URL か、アップロード（10 MB まで）が必要です。
- 窓は最大 3 つです。曲がその窓に入っていなければ当たりません。`offsetSec` で位置を変えて試してください。
- ずれのしきい値 0.002 は、少数の実測から決めた値です。確かでない当たりを確かと誤る可能性も、確かな当たりを確かでないとする可能性も、無くなりません。
- iTunes とのつなぎは、Apple の曲 ID か、題名とアーティストの完全一致だけです。表記が違うと `itunes: null` になります。
- 音の変換には Chromium が要ります。無い環境では変換できず、エラーになります（REST では 502）。
- 1 つの音に複数の曲が入っていても、返すのは最初に確かな当たりが出た 1 曲です。

歌詞の取得は別のモジュールです。[歌詞の取得元を順にたどって同じ曲を選ぶ](lyrics-selection.md)を見てください。

## 実装とテスト

- 実装: `src/services/song_recognition.ts`（窓の選び方・ずれの検査・iTunes とのつなぎ・キャッシュ）、`audio_decode.ts`（音の変換）、`shazam_signature.ts`、`packages/audio-signature/src/index.ts`（指紋）、`music.ts`（iTunes の整形）。入口は `src/mcp/tools_shazam.ts` と `src/routes/song_recognition.ts` です。
- テスト: `src/services/song_recognition.test.ts`、`shazam_signature.test.ts`、`audio_decode.test.ts`、`src/shazam_module.test.ts`、`packages/audio-signature/test/index.test.ts`。

[判断エンジンの一覧に戻る](README.md)
