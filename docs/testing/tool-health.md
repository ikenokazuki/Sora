# tool-health 運用手順

全ツールの本体処理と実外部取得をCIで判定する仕組み。設計は [修正計画](../superpowers/specs/2026-10-02-sora-reliability-live-ci-design.md)、実装手順は [実装指示書](../superpowers/plans/2026-10-02-sora-reliability-live-ci-implementation.md)。

## 構成

- 台帳: `scripts/tool-health/catalog.ts`（canonical 47＋hotel 1、REST対応表、tool live case、provider live case）
- 本体検査: `bun test`（`src/tool_contracts.test.ts`＝REST対応、`src/tool_transport_smoke.test.ts`＝実HTTP輸送＋F1、`scripts/tool-health/catalog.test.ts`＝登録集合照合）
- live runner: `scripts/tool-health/run.ts`（公開toolは候補コンテナの `/app/server.js` へHTTP、providerは同一checkoutの実取得器で確認）
- 報告: JSON＋Markdown＋JUnitを `tool-health-out/` へ。7日artifact保存。

## 実行

```bash
# 候補imageをbuildして通常lane
npm run test:tools:live
# hotel lane（SORA_RAKUTEN_TRAVEL_ENABLED=true の別実行）
bun --no-env-file run scripts/tool-health/run.ts --live --image sora-tool-health:candidate --out ./tool-health-out --enable-hotel
```

`--live` なし・`--image` なしでは開始せず exit 2。Secrets は `SORA_TOOL_HEALTH_CASES_JSON`（`{version:1, cases:{...}}`、case ID と key 名のみ検証、値の伏字は report 側で実施）と配送資格情報の環境変数（`UPS_*`、`FEDEX_*`、`DHL_*`）で渡す。CLI引数・ログ・reportに秘密値を出さない。

## 判定

`pass` / `pass_empty`（正常0件の証明あり）/ `fail` / `unavailable` / `blocked` / `unverified`（資格情報・test data不足）/ `not_applicable`（外部処理なし）。`fail`・`unavailable`・`blocked`・`unverified`・未登録が1件でもあれば exit 1。`unavailable` のみ1回再試行し、復旧時は `recovered=true` を記録する。

## 新tool追加時

1. `catalog.ts` の `CANONICAL_TOOLS`・`REST_MAP`・`TOOL_CASES` に追加（追加漏れは `catalog.test.ts` が失敗する）。
2. 依存先（carrier・platform・provider・feed・indicator）が増えたら対応する live case を追加。
3. 本体 `bun test`＋`typecheck`を通す。

## test data更新

配送番号に履歴がなくなった・SNS投稿が消えた場合は `SORA_TOOL_HEALTH_CASES_JSON` の該当caseを更新する。それまでは `unverified` で落とす（ダミー番号の `not_found` 期待に書き換えない）。

## 失敗時の診断

1. `tool-health-<lane>.md` の status 列で分類を確認する。
2. `blocked`（403・login画面）は取得先・通信環境の問題。GitHub runnerだけ403の場合は通常環境の同imageで比較実行する。
3. `unavailable`（5xx・timeout・429）は上流障害。`attempts` と所要時間を確認する。
4. `fail`（anchor不足・JSON形式変化）は外部仕様変更の疑い。該当adapterのparser条件を観測してから修正し、伏字fixture＋本体回帰testを通してlive再実行する。
5. `unverified` は test data・資格情報の不足。値を補充して再実行する。
6. 災害系providerが静穏日に0件で `unverified` になることがある。異常ではなくtriage対象として記録する。

## CI配線

- PR: `test.yml`（全test＋typecheck）。Secret不要。
- main push／tag: `docker-publish.yml`（本体検査→候補build→候補のままlive→同一image push）。別buildの差し替えなし。
- 定期（UTC 23:19）・手動: `live-tools.yml`（通常＋hotelの2lane）。
- 公開保留条件: liveの `fail`/`unavailable`/`blocked`/`unverified`/未登録。外部障害と本体退行をreportで分けて確認し、契約を弱めて通さない。

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
