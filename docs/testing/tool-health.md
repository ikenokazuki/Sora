# tool-health 運用手順

全ツールの本体処理と実外部取得をCIで判定する仕組み。設計は [修正計画](../superpowers/specs/2026-10-02-sora-reliability-live-ci-design.md)、実装手順は [実装指示書](../superpowers/plans/2026-10-02-sora-reliability-live-ci-implementation.md)。

## 構成

- 台帳: `scripts/tool-health/catalog.ts`（canonical 50、REST対応表、tool live case、provider live case）
- 本体検査: `bun test`（`src/tool_contracts.test.ts`＝REST対応、`src/tool_transport_smoke.test.ts`＝実HTTP輸送＋F1、`scripts/tool-health/catalog.test.ts`＝登録集合照合）
- live runner: `scripts/tool-health/run.ts`（公開toolは候補コンテナの `/app/server.js` へHTTP、providerは同一checkoutの実取得器で確認）
- 報告: JSON＋Markdown＋JUnitを `tool-health-out/` へ。7日artifact保存。

## 実行

```bash
# 候補imageをbuildして通常lane
npm run test:tools:live
```

`--live` なし・`--image` なしでは開始せず exit 2。Secrets は `SORA_TOOL_HEALTH_CASES_JSON`（`{version:1, cases:{...}}`、case ID と key 名のみ検証、値の伏字は report 側で実施）と配送資格情報の環境変数（`UPS_*`、`FEDEX_*`、`DHL_*`）で渡す。CLI引数・ログ・reportに秘密値を出さない。

## 判定

`pass` / `pass_empty`（正常0件の証明あり）/ `fail` / `unavailable` / `blocked` / `unverified`（資格情報・test data不足）/ `not_applicable`（外部処理なし）。`fail`・未登録が1件でもある、または `unavailable` が全体の 25% を超えれば exit 1。`unavailable`・`blocked`・`unverified` だけなら exit 3（soft hold。下の「公開gate」を参照）。

再試行: ツールの `unavailable`・`unverified` と provider の `unavailable` は2秒空けて1回取り直し、復旧時は `recovered=true` を記録する。普段は必ず中身がある取得元の0件（`LiveEmpty`。`fail` の一種）は、5秒・15秒空けて最大2回取り直す。空振りが続けば構造変化として `fail` のまま。一時的な空振りで公開を止めないための取り直しで、基準は緩めない。

## 新tool追加時

1. `catalog.ts` の `CANONICAL_TOOLS`・`REST_MAP`・`TOOL_CASES` に追加（追加漏れは `catalog.test.ts` が失敗する）。
2. 依存先（carrier・platform・provider・feed・indicator）が増えたら対応する live case を追加。
3. 本体 `bun test`＋`typecheck`を通す。

## test data更新

配送番号に履歴がなくなった・SNS投稿が消えた場合は `SORA_TOOL_HEALTH_CASES_JSON` の該当caseを更新する。それまでは `unverified` で落とす（ダミー番号の `not_found` 期待に書き換えない）。

## 住所系のケース（ABR・日本郵便）

`geo.postal_code`・`geo.normalize_address`・`geo.reverse_geocode` は、MCP と REST の両方を同じ検査にかける。候補コンテナの最初の呼び出しは、取得元（ABR の CDN・日本郵便）からデータを取ってくるので、外部に依存するケースとして1回再試行する。

- 入力と期待値（実データで確認済み）:
  - 郵便番号 `100-0014` → 千代田区永田町（全国地方公共団体コード 131016）の候補がある。
  - 住所 `東京都千代田区永田町1-5-1` → `level: 8`、`numberSource: "rsdt"`、`東京都千代田区永田町一丁目5-1`、結合キーの市区町村コード、座標が永田町の範囲内、郵便番号 `1000014`。
  - 座標 `35.673766, 139.746379`（上の住所の点）→ 同じ永田町一丁目の住居表示の番地が 50m 以内で返る（`level: 8`、`numberSource: "rsdt"`）。
  - 国会議事堂の `永田町1-7-1` は ABR に住居番号が無く、町字（level 3）止まりになるので、番地まで届くことの検査には使わない。ABR のデータが変わって上の住所が届かなくなったら、実データで届く住所に差し替える。
- 追加のケース（`normalize_address`）:
  - `geo.normalize_address.mlit`: `港区芝大門1-10-18-3F` が国土交通省の街区データで補われ、`numberSource: "mlit"`、`level: 8`、`東京都港区芝大門一丁目10`、`other` が `18-3F`、`point.level: 7`、国土交通省の出典が付く。
  - `geo.normalize_address.zipcode`: 市区町村の無い `千駄ヶ谷2-34-8テラス外苑204` と `zipcode: 1510051` で、`東京都渋谷区千駄ヶ谷二丁目34-8`（level 8）に解決され、`checks.zipcode.status` が `match`。
  - `geo.normalize_address.parcel_point`: ABR の地番に座標が無い `山形県天童市大字山口4559-4` が地番で照合され（`numberSource: "chiban"`）、点が町字の代表点でなく街区の点（`point.level: 7`、`pointSource: "mlit"`、国土交通省の出典）になる。ABR が座標を足して番地の点（`point.level: 8`）になっても合格。
- 分類: 応答の `incomplete`（データが揃う前の答え）は、内容を検査せずに分ける。`pending` だけなら `unverified`、`unavailable` に 403・国外 IP の拒否があれば `blocked`、そのほかの取得失敗は `unavailable`。出典（`attribution` に「アドレス・ベース・レジストリ」）が無い応答は、incomplete でも `fail`。
- エラー応答の分類: MCP のエラー文（取得中は `unverified`、403・国外 IP は `blocked`、取得失敗・構築の時間切れは `unavailable`）と、REST のエラーコード（`ADDRESS_DATA_PENDING` は `unverified`、`ADDRESS_DATA_UNAVAILABLE` で `retryable: false` は `blocked`、そのほかの 502 は `unavailable`）で分ける。`ADDRESS_DISABLED` や入力の誤りは、こちら側の契約違反として `fail`。
- GitHub Actions などの国外 IP では、ABR の CDN が接続を拒否するため `blocked` になる。国内の環境で同じ image を比較実行する。

## 失敗時の診断

1. `tool-health-<lane>.md` の status 列で分類を確認する。
2. `blocked`（403・login画面）は取得先・通信環境の問題。GitHub runnerだけ403の場合は通常環境の同imageで比較実行する。
3. `unavailable`（5xx・timeout・429）は上流障害。`attempts` と所要時間を確認する。
4. `fail`（anchor不足・JSON形式変化）は外部仕様変更の疑い。ただし、取得先が「読めなかった」と自分で返している場合（SNS の `status` が `ok` でない、ツールのエラー文が timeout・request failed など）は `fail` にせず、`unavailable`/`blocked` と理由つきで分ける（`classifySocialFetch`・`mcpJson`）。時刻名のファイルを取る provider（GDELT）は、最新が CDN に無い404のとき数スロット前のファイルに戻る。該当adapterのparser条件を観測してから修正し、伏字fixture＋本体回帰testを通してlive再実行する。
5. `unverified` は test data・資格情報の不足。値を補充して再実行する。
6. 災害系providerが静穏日に0件で `unverified` になることがある。異常ではなくtriage対象として記録する。

## CI配線

- PR: `test.yml`（全test＋typecheck）。Secret不要。
- main push／tag: `docker-publish.yml`（本体検査→候補build→候補のままlive→同一image push）。別buildの差し替えなし。
- 定期（UTC 23:19）・手動: `live-tools.yml`（standard のみ。ホテルレーンは廃止した）。
- 公開保留条件: liveの `fail`/未登録、または `unavailable` が全体の 25% 超（exit 1）。`unavailable`/`blocked`/`unverified` だけなら soft hold（exit 3）で公開は進む。外部障害と本体退行をreportで分けて確認し、契約を弱めて通さない。

## 環境依存の既知事項（2026-10-02 実測）

- `baidu_hot`・`bluesky` は実行ホストから 403 を受けることがある（当日は自宅回線で 403）。GitHub Actions 等の別通信環境で比較し、`blocked` と取得不能を区別して記録すること。
- `inspect_image` の live 参照画像は `https://www.w3.org/Icons/valid-xhtml10`（Google ロゴ直リンクは 404 化のため不使用）。
- `browser_action` の `evaluate` は server policy で無効。live は click の実行証拠（actionOutputs/result + renderedWithBrowser）で確認する。

## 配送test data（資格情報なし運用）

## 配送test data（資格情報なし運用）

- 8社とも資格情報なしで検証できる。国内5社はスクレイピング、米3社（ups/fedex/dhl）はステルスブラウザ取得（資格情報があれば公式API優先）。
- 正の取得には実番号が必要。bogus番号のnegative case（ups/fedexは`not_found`、dhlは有効status）がbrowser取得経路を通すことを毎回確認する。
- いずれの社も取得不可時は公式URL案内へフォールバックする（`unknown`）。

## 追跡liveの注意

- 国際3社のbrowser取得は先方のWAF都合で変動する。同一IPから短時間に大量取得した後はchallengeで `unknown`/`blocked` になることがある。CI（fresh IP）での結果を優先し、再実行で復旧するか見ること。
- `track.*.negative`（bogus番号）は `unknown` を失敗にせず `unverified` とする。`blocked`（bot check検出）は別分類で記録する。

## 公開gate（soft hold）

- runner exit 0＝全green、exit 3＝soft hold（`fail`/`unavailable`/未登録なし。`unverified`/`blocked` のみ残存）、exit 1＝hard fail、exit 2＝設定異常。
- CI公開は 0 と 3 で進行する。3 の場合は summary と report に hold 範囲を記録し、輸送不能・契約違反（1）は必ず止める。
- hold は「壊れていない証拠がない」状態であり「壊れていない証拠」ではない。未検証の輸送業者・provider は test data が揃い次第 green 化すること。
