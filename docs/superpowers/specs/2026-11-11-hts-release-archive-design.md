# HTS の版の保存モジュール（hts-archive）の設計

日付: 2026-11-11

## 目的と要件

米国 USITC の HTS（関税率表）は、年に 20〜30 回改訂されます。改訂の前後を比べるには、版ごとの全件の JSON が要ります。USITC の API は現行版の全件しか返さず（`exportList`）、過去の版は類ごとの PDF でしか取れません。そこで、版が出るたびに全件の JSON を保存する機能を足します。

- 使わない人に負担をかけないこと。運用者が有効にしたときだけ動き、既定では取得もタイマーも増やさない。
- 版が変わったかどうかは、全件の JSON そのもので判断すること。版の一覧（`releaseList`）は、データの更新と同時に書き換わるとは限らない（例: Revision 22 は一覧の日付が 10/26、適用の開始が 10/30）。
- 保存した版は消さない。
- 保存した版の一覧と、1 つの版の中身を REST で取り出せること。
- 2 つの版の差分を返す機能は、この版では作らない（保存した版から呼び出し側が作れる）。
- HTS の推測（`predict_hts_code`）の応答に版の名前を出す変更は、別の変更で扱う。

## 取得元（2026-11-10 実測）

- `https://hts.usitc.gov/reststop/releaseList`: 版の一覧。2018 年からの 185 版が新しい順に並び、`status` が `current` の版は 1 つ（ほかは `archive`）。1 行は `{name, description, date, title, status, ...}` で、例は `{"name": "2026HTSRev22", "description": "2026 HTS Revision 22", "date": "10/26/2026", "title": "Revision 22 (2026)", "status": "current"}`。
- 版の名前は英数字と `_` だけでできています（例 `2018HTSARevision4_1`、`Chapter99`）。
- `exportList`（HTS の推測が使うのと同じ URL）は現行版の全件を返します。約 12.6MB の JSON（35,805 行）で、gzip で約 640KB になります。転送は `Content-Encoding: gzip` です。
- `exportList` を 20 秒あけて 2 回取ると、バイト列が同じでした（SHA-256 が一致）。2026-11-10 11:50 UTC に取った Revision 22 とも、行の中身が全部同じでした。
- `exportList` の応答には `ETag` も `Last-Modified` も無く（`Cache-Control: no-cache, no-store`）、条件付きの要求では変化を知れません。中身を取って比べます。

## 設計

### モジュールの分離

- `SoraModule` に `hts-archive` を足し、`all` では有効にならない一覧（`EXPLICIT_ONLY_MODULES`）に入れます。`ENABLED_MODULES=all,hts-archive` のように名前を挙げたときだけ有効です。`all` は既定の設定なので、`all` に含めると全員にタイマーが増えます。
- MCP のツールは作りません（REST だけ）。
- 無効のとき、起動時の処理・タイマー・取得は無く、REST は 404 `MODULE_DISABLED` を返し、OpenAPI と `GET /` の一覧にも出ません。

### 確認の流れ（`src/services/hts_archive.ts`）

起動から 1 分後に 1 回、そのあと 24 時間ごとに確かめます（`setInterval` は `unref` して、終了を妨げない）。同時に 2 回は走らせません。

1. `exportList` を取る。応答の本文はそのまま持つ（`JSON.parse` は形の確認だけに使う。配列で 100 行以上）。
2. 中身の SHA-256（保存の形の `sha256`）が、最後に保存した版と同じなら、確認の時刻だけ記録して終える（版の一覧は見ない）。
3. 違えば（または 1 つも保存していなければ）、`releaseList` を取り、`status` が `current` の版の名前・title・公開日を、保存する版の見出しにする。
4. 版のファイルを書き（一時ファイルに書いてから名前を変える）、一覧を書き換える。

変わったかどうかは中身だけで決め、版の一覧は名前を付けるのにだけ使います。一覧がデータより先に次の版を current にしていても、中身が変わるまでは保存しません。一覧がデータより遅れて、前の版の名前のまま中身が変わったときは、同じ名前に取得の時刻を付けた別の版として保存します（保存の形の `id`）。

失敗は一覧の `lastError` と `console.warn` に残し、次の確認（24 時間後）で取り直します。`releaseList` が取れないときも保存せず、次の確認で取り直します。ほかの機能には影響しません。取得の時間切れは、`releaseList` が 30 秒、`exportList` が 90 秒です。

### 保存の形

保存先は `SORA_HTS_DIR`（HTS の全件データと同じ。既定は `SORA_DB_PATH` のあるディレクトリの下の `hts`）の `releases/` です。`SORA_DB_PATH` が `:memory:` で `SORA_HTS_DIR` も無いときは保存先が無いので、警告を出して確認を始めません。

- `id`: 保存した版の名前。ふつうは版の名前（例 `2026HTSRev22`）そのままです。同じ名前の版がもう保存されていて中身が違うときは、取得の時刻を付けます（例 `2026HTSRev22-20261112T0412Z`）。
- `releases/<id>.json.gz`: `{"id", "release", "title", "description", "date", "fetchedAt", "records"}` の JSON を gzip したもの。`records` は `exportList` の応答の本文を、文字列のまま差し込みます（USITC が返したバイト列と同じ）。`release` は取得したときに一覧で current だった版の名前、`date` は一覧の `date`（`MM/DD/YYYY`）のままです。
- `releases/index.json`: `{"checkedAt", "lastError", "releases": [...]}`。`releases` の各行は `{id, release, title, description, date, fetchedAt, sha256, rowCount, bytes}` で、新しく保存したものが先頭です。`sha256` は `records` を決まった形に直した JSON の SHA-256 で（下の段落）、変化の判定に使います。`bytes` は保存した gzip のファイルの大きさです。

保存した版は消しません。1 版あたり約 640KB で、年に 20〜30 版なら年に約 20MB です。確認の通信は、1 日に gzip で約 640KB（`exportList`）と、中身が変わった日だけ `releaseList` が 1 回です。

2 回の取得では同じバイト列でしたが、USITC が中身を変えずにキーの順や空白だけを変えることもありえます。そのとき同じ中身を別の版として保存しないよう、`sha256` は応答の本文そのものではなく、`records` を決まった形（どの深さでもキーを並べ替え、空白を入れない JSON）に直してから取ります。保存するのは応答の本文のままです。

### 出口（REST）

- `GET /trade/hts/releases`: `index.json` の中身を返します（`{releases, checkedAt, lastError}`）。まだ 1 度も確かめていなければ `{releases: [], checkedAt: null, lastError: null}`。
- `GET /trade/hts/releases/:id`: 1 つの版の JSON を返します。要求の `Accept-Encoding` に `gzip` があれば、保存した gzip をそのまま `Content-Encoding: gzip` で返し、無ければ展開して返します。`id` が `^[0-9A-Za-z_-]{1,80}$` に合わなければ 400、保存されていなければ 404 です。
- 無効のときは、どちらも 404 `MODULE_DISABLED`。

### テスト（`src/services/hts_archive.test.ts`）

`fetch` を差し替えて、次を確かめます。

- 無効のとき、起動の関数がタイマーを作らず、REST が 404 `MODULE_DISABLED` を返す。`all` だけでは有効にならない。
- 最初の確認で現行版を保存し、`records` が応答の本文と同じで、`sha256`・`rowCount` が合う。
- キーの順と空白だけが違う応答は、同じ中身として保存しない。
- 中身が同じなら、一覧が次の版を current にしていても保存せず、`releaseList` も取らない。
- 中身が変わり、一覧の版の名前が新しければ、その名前で保存する。
- 中身が変わったのに一覧の版の名前が保存済みと同じなら、時刻を付けた `id` で別に保存する。
- `releaseList` が取れなければ保存しない。
- 一覧と 1 つの版の REST（gzip あり・なし、名前の検査、無い版の 404）。

### 文書

README のモジュールの節と環境変数の表、`docs/engines/hts-prediction.md` に、有効にする方法と保存の形を書きます。
