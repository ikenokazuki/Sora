# 歌詞全文取得モジュール（lyrics）の設計

日付: 2026-10-21

## 目的と要件

歌手／グループ名と曲名から、歌詞全文を取得する機能を足します。

- API キー不要であること。
- TuneCore の歌詞ページ URL（`linkco.re/<8桁ID>/songs/<曲ID>/lyrics`）は名前から導けず、MCP／REST で指定しづらいので、歌手・曲名で引けること。
- 個人利用・自己責任の機能なので、有効化するモジュールを既存と分け、名前を挙げたときだけ使えること。
- 主流の曲に加えて、地下アイドル（例: 君と見るそら）の曲も引けること。

## 取得元の調査（2026-10-21 実測。歌詞本文は出力せず、件数だけで確認）

### 君と見るそら（TuneCore Japan 配信。iTunes に載る 18 曲）

- LRCLIB: 0 曲。歌ネット: 0 曲（検索が 404）。
- TuneCore（LinkCore）: 名前だけで 18 曲すべてのトラックを特定し、歌詞は 10 曲で取得できました。残る 8 曲はリリースページに歌詞ボタンがなく、TuneCore に歌詞が登録されていません（未登録、または著作権管理団体の管理曲）。

### 主流の曲

- LRCLIB: 代表的な 26 曲のうち 21 曲（4 曲は一時的な 503、1 曲は未登録）。やや難しい 16 曲（演歌・アイドル・ボカロ・インディーズ）で 12 曲。応答は中央値 0.5 秒、最大約 2 秒。同じ曲が重複登録されており、本文が 1〜4 通りに分かれます。
- 歌ネット: 同じ 16 曲で 13 曲（差は演歌 1 曲）。サイト表示は約 38.2 万曲。利用規約（2023-08-23 改訂）が無断のスクレイピングを明示的に禁止しているため採用しません。

### LRCLIB の利用条件（公式ドキュメント）

- 認証不要。`User-Agent` に名前・版・URL（またはメール）を入れる。
- 識別済みで約 90 回/分/IP。429 と 503 は `Retry-After` を守り、揺らぎを足して待つ。
- `/api/search` は最大 20 件、ページ送りなし。`q` を渡すと構造化パラメータより優先される。
- 応答には `lyricsfile`（歌詞全文を含む YAML）など、使わないフィールドが入る。返さない。

### TuneCore（LinkCore）の構造

- 歌詞は歌詞ページの `<div class=lyric_text>` の中に、1 行 1 つの `<p>` で入っています。HTML は属性値に引用符のない圧縮形式です。
- リリースページ（`linkco.re/<リリースID>`）は、同じアーティストの他のリリースへのリンクを 4 件ほど載せます。これをたどると全リリースに届きました（18/18）。トラック名は `.list_song_title`、歌詞ボタンは `.lyrics_btn a` です。
- 名前から最初のリリース ID を得る入口は、`site:linkco.re` の Web 検索です。サイト内の検索経路（`/artist/list/search`）は robots.txt で禁止されています。アーティストの公開ページを持つのは一部で、君と見るそらは持ちません。
- 利用規約（`/terms/person`）、プライバシーポリシー、LinkCore のページを確認した範囲では、公開ページの自動取得を禁じる条項は見つかりませんでした（LinkCore 専用の利用条件は見当たらず、全文は精査していません）。

## 設計

### モジュールの分離（自己責任の明示オプトイン）

- `SoraModule` に `lyrics` を追加し、`isModuleActive`（`src/mcp/registry.ts`）に「明示指定のみ」の一覧を設けました。`ENABLED_MODULES` が未設定／`all`／`*`、またはプログラム側の `['all']` では有効になりません。`ENABLED_MODULES=all,lyrics` のように名前を挙げたときだけ有効です。
- 無効のとき、MCP ツールは登録されず、REST は 404 `MODULE_DISABLED` を返し、OpenAPI・`GET /` の一覧・MCP instructions・`search_tools` の案内にも出ません。起動時の処理・常駐タイマー・取得は一切ありません。

### インターフェース

- MCP: `get_lyrics`（カテゴリ `lyrics`、遅延公開。`search_tools` のキーワードは 歌詞・歌詞全文・リリック・lyrics）。
- REST: `POST /lyrics`。入力は `title`（必須）、`artist`、`noCache`。`artist` は主流の曲なら省略できますが、TuneCore 経由では必須です。
- 出力: `found`、`track`、`lyrics`、`source`（`lrclib` / `tunecore`）、`sourceUrl`、`reason`、`candidates`、`notice`。
  - `found: false` のとき `reason` は `no-match`、`no-lyrics-registered`（曲は特定できたが TuneCore に歌詞が無い）、`search-unavailable`（取得元が使えず判断できない）のいずれか。
  - `candidates` は、LRCLIB では別曲（最大 5 件）、TuneCore では同じ歌手の曲名（最大 10 件）。
  - 取得元に失敗した結果（`search-unavailable`）はキャッシュしません。

### 取得の順序（`src/services/lyrics.ts`）

1. LRCLIB を引く。見つかればそれを返す。2 回失敗しても、次へ進む。
2. 見つからず `artist` があれば、TuneCore（LinkCore）を引く。
3. どちらも見つからなければ `found: false`。LRCLIB が使えなかった場合は `no-match` ではなく `search-unavailable` にする。

LRCLIB は `track_name` + `artist_name` で検索し、0 件のときだけ `q=<歌手> <曲名>` で再検索します。曲名を正規化（NFKC・大小文字・空白と記号の除去）して完全一致、前方一致の順に選び、歌手は包含一致で絞ります。同じ曲の本文が複数あれば、最も多く登録された本文を採ります。

TuneCore（`src/services/lyrics_linkcore.ts`）は、`searchYahooWeb` で `site:linkco.re` の検索をして起点のリリース ID を得ます（結果の題名 `… by <歌手> | TuneCore Japan` の歌手が合うもの）。リリースページを幅優先でたどり（最大 30 件、予算 20 秒）、曲名が合う最初のトラックで止まります。歌詞ボタンがあれば歌詞ページを取得し、なければ `no-lyrics-registered` です。解析結果（題名・トラック・歌詞ページ URL・他リリース ID）は 24 時間キャッシュし、歌詞本文は入れません。

## 実装後の確認（君と見るそら、`ENABLED_MODULES=all,lyrics`）

- 「等身大のアイラブミー」: TuneCore から 64 行を取得（3.6 秒）。「ふわり、初恋。」は 40 行（5.6 秒）。
- 「月から金まで」: `no-lyrics-registered`（5.5 秒）。存在しない曲名: `no-match` と同じグループの曲名 10 件の `candidates`（6.7 秒）。
- 同じ曲の 2 回目はキャッシュから 1 ミリ秒。主流の曲（米津玄師 / Lemon）は LRCLIB から 0.3 秒。
- 環境変数なしの起動では、`POST /lyrics` が 404 `MODULE_DISABLED`、OpenAPI と `GET /` にも出ない。

## 割り切り

- 表記ゆれ（ローマ字とカナ、別名義）は吸収しません。`candidates` で呼び出し側が選び直します。
- LRCLIB の本文の選別は多数決だけです。誤登録が多数派の曲では誤ります。
- TuneCore の入口は検索エンジン頼みです。検索の索引に無いアーティストは見つかりません。外れが多ければ、TuneCore の公開アーティストページ（`/artists?keyword=` → `/artists/<path>`。リリースの LinkCore URL が直接載る）を第二の入口に足します。調査したサンプル 14 組中 3 組が公開ページを持ちます。
- 曲名が合った最初のトラックで巡回を止めます。別のリリースに歌詞付きの同名曲があっても探しません。
- LinkCore の HTML が変わると取れなくなります。合成 HTML のテストと実機確認で気づける形にしています。

## 対象外

歌ネットの取得元（規約）、同期歌詞（LRC）、翻訳・ローマ字、歌詞の断片からの検索、歌詞の永続保存（キャッシュ以外）、複数曲の一括取得。
