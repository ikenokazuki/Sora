# fetcher.ikebun.jp operations memo

Read this first on every update. Also read the server's authoritative runbook:
[agent-ops.md](/home/ikeno/app/oshiframe/docs/superpowers/ops/agent-ops.md).

## Target (confirmed 2026-10-07)

- Host: fetcher.ikebun.jp (162.43.91.12) IS this machine (/home/ikeno host).
- Sora runs as the `apps` user (uid 1001), podman container name `web-fetcher`.
- ikeno can manage apps' containers with the explicitly permitted command:
  `sudo -n -u apps /run/current-system/sw/bin/podman`. Run it from `/tmp`.
  `sudo -u apps id` is NOT an equivalent permission check and requires a password.
  Direct access to apps' Podman socket is also denied; use the permitted sudo command.
- The container is managed by apps' systemd Quadlet `web-fetcher.service`.
  Do not replace it with a manual `podman run`.
- Port: container 8000 -> host 127.0.0.1:3016. Public path is Caddy https only:
  https://fetcher.ikebun.jp/health (direct :8000 is firewalled, never use it).
- Current image: `ghcr.io/ikenokazuki/sora:2.36.1`
  (image ID `be7ac85b5114`, digest `sha256:0332895083bfbe598f05f9a231a58d9bdf6863a19054434afe4b6ee9c8d81a9e`,
  deployed 2026-10-09). Package/health version: `2.36.1`.
  X realtime search: `focus` (`official` / `public`, inferred from words such as 評判・炎上・口コミ),
  a cap on returned posts (`limit` / `realtimeLimit`, default 20, `omittedCount`), a re-check when only one post
  matches every term, and X profile pages built from the account's own posts. MCP `search_deep` /
  `search_realtime` return compact JSON (`verbose` keeps indentation). `tini` remains PID 1.
- `SORA_DEFER_TOOLS=false`: MCP exposes 47 canonical definitions. Initial model context
  is limited to 14 by the saved LibreChat Agent's native deferred loading.
- Released images: ghcr.io/ikenokazuki/sora, pinned tag per release.
  `latest` can move on main and release-tag builds; use the pinned release tag
  and verify its image ID against the corresponding release CI.
- ikeno and apps have SEPARATE podman storage. Pulling as ikeno does NOT
  make the image visible to apps. Always pull AS apps.
- Persistent DB: `SORA_DB_PATH=/data/sora.db`, named volume `web-fetcher-data:/data:U`.
  Preserve this volume on every update.

## Update (ikeno invokes the permitted apps commands)

1. Inspect only image, mounts and ports; never dump all environment variables:
   `sudo -n -u apps /run/current-system/sw/bin/podman inspect web-fetcher --format 'Image={{.ImageName}} Mounts={{json .Mounts}} Ports={{json .NetworkSettings.Ports}}'`
2. Pull a pinned release into apps' image store. For local unreleased changes,
   copy the current source to a readable build context under `/tmp` and build AS apps
   with an explicit local tag. `git archive HEAD` would omit uncommitted changes.
3. Test a candidate container using a different loopback port and a separate DB:
   health, scrape, search, MCP and the changed feature. Stop the candidate afterwards.
4. Back up the live SQLite DB using Bun SQLite `Database.serialize()` in the running
   container. Save under `/data` with mode 0600; do not print DB contents.
5. Record the target image in `/home/ikeno/app/modules/rootless-containers.nix`.
   Apply only web-fetcher via the standard Quadlet drop-in
   `/home/apps/.config/containers/systemd/web-fetcher.container.d/20-release.conf`.
   Preserve allowed hosts/origins. For a local image use `Pull=never`.
6. Reload apps' user systemd, verify the generated ExecStart image, then restart
   only `web-fetcher.service`. Use the measured command form below.
7. Verify the public health endpoint, actual changed API results, running image ID
   and unchanged `web-fetcher-data` volume. An unreleased local build retains the
   package version; health version alone does not identify its source changes.

```sh
cd /tmp
sudo -n -u apps /run/current-system/sw/bin/podman unshare \
  /run/current-system/sw/bin/env \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  /run/current-system/sw/bin/systemctl --user daemon-reload
# Same command form, replacing daemon-reload with:
#   show web-fetcher.service --property=ExecStart
#   restart web-fetcher.service
```

## Notes

- A red live gate leaves old registry tags in place. Judge the running version by /health.
- Preserve the prior image and drop-in for rollback; normal image rollback does not
  restore the DB backup or discard newer data.
- Do not run a whole NixOS rebuild for this update: the infrastructure repository
  may contain other work. Keep the Nix declaration and the targeted drop-in aligned.

## LibreChat接続の修正（2026-10-06）

以下は最初の暫定修正と検証。現在は次節の保存済みAgent構成を使用する。

- Sora 2.34.6のイメージ・DB・設定は変更していない。今回の「MCP server temporarily unavailable」はLibreChatの定義不足による代替応答だった。
- LibreChatを通知対応のv0.8.8ベースへ更新し、Soraのsearch_tools後に同じ接続の一覧を会話実行へ反映するホスト修正を追加した。初期MCP一覧14個を維持し、POI検索時はMCP一覧16個、モデル側は重複別名を除いて15個になる。
- LibreChatのSora設定でserverInstructionsを有効化し、初期・追加後・後続会話の実モデル送信本文と、実際の施設検索を隔離環境で検証した。
- `search_tools`、有効化フェーズ、default.*別名はSora独自。tools/list、tools/call、list_changed、initializeのinstructionsフィールドは標準。接続内の要求で一覧を変える方式は2026-07-28仕様への移行時に見直す。
- 詳細：[LibreChat運用記録](/home/ikeno/app/docs/operations/librechat.md)、[MCP標準との比較](/home/ikeno/app/docs/operations/sora-librechat-mcp-audit-20261006.md)。
- 続く汎用化検証では、既存の`SORA_DEFER_TOOLS=false`によりMCP一覧が正式名47個で固定され、別名・検索後の一覧変更がなくなることを確認した。無改修の公式LibreChat v0.8.8の保存済みAgentで13コア＋標準Tool Searchの初期14個、検索後15個、実施設検索、同じ会話の保持、新しい会話の14個へ戻る動作が成功。通常チャットには同じ遅延設定経路がないため、利用形態の選択待ち。本番Soraの設定は未変更。
- 作業ツリーのinstructionsを、モデルにある定義の直接利用・ホストのツール検索の優先・旧有効化時のスキーマ読込待ちへ修正した。配送・国地域ツールの無条件の有効化指示も削除。関連45テストと型チェックが成功。イメージへの組み込みと本番反映は未実施。

## 標準Agent構成への切り替え（2026-10-06〜07）

- ユーザーが保存済みAgentへの切り替えを承認。10月6日にSora・LibreChatのサービスを切り替え、10月7日にAgent登録と最終照合を完了した。
- Soraイメージは`localhost/sora:2.34.6-native-mcp-20261006`、ID `d565df77d3e7b34d3d003d4c93a33d36f9d9a98a0822a7ff1b2e732e9cff5dd5`。2.34.6の固定digestをベースに、同じBun 1.4.2で現在のsrcをbundleし、server.jsのみ更新。bundle SHA-256は`4702797e47ebc868209b39b25f82871314164c0d7d9403e699d55a1561726a6f`。説明文修正を本番へ反映した。公開リリースのタグは変更していない。
- `SORA_DEFER_TOOLS=false`で正式名47個を公開。検索後も一覧が変化せず、`default.*`別名と一覧変更通知は0。LibreChatは無改修の公式v0.8.8へ戻し、専用パッチを撤去した。
- 保存済み`Sora (Muse)` Agentは13即時＋34遅延。ホストが追加するTool Search込みで初期モデル定義14個。通常チャットのSora選択は公式設定`chatMenu=false`で非表示。Agent一覧・所有者専用のACL・保存済みの遅延設定を照合した。
- 候補でhealth、47正式名、新instructions、実scrape/Web検索、実施設検索を確認。無改修LibreChatの隔離会話で14→15→同じ会話15→新しい会話14が成功。実Museモデルも3要求で検索から最終回答まで成功。公開MCPの施設検索2件と最終会話試験も成功。
- SQLiteバックアップは`/data/backups/sora-before-native-mcp-20261006.db`（0600、quick_check=ok）。既存web-fetcher-dataを維持。Nix宣言とappsのQuadlet drop-inを揃え、Pull=never、全公開設定を追加。Sora/LibreChatのみを再起動した。
- 復旧は保護された`/home/ikeno/.local/state/librechat-deploy/20261006T143749Z-native-agent/sora-release.before`をSora drop-inへ戻し、旧LibreChatの設定・イメージも揃えてdaemon-reload・対象再起動する。Sora復旧先は公式2.34.6（ID `64bbacfbb7b1`）。DBを自動復元しない。
- [LibreChat運用記録](/home/ikeno/app/docs/operations/librechat.md)と[MCP監査](/home/ikeno/app/docs/operations/sora-librechat-mcp-audit-20261006.md)も参照する。

## Previous update (2026-10-03)

- Built the current working tree, including the geocoding.jp implementation, AS apps.
- Candidate and public endpoint checks passed: health, OpenAPI/MCP definitions,
  actual scrape, Yahoo web search, Harajuku elevation and POI search via MCP/REST.
- Live DB backup: `/data/backups/sora-before-geocoding-2026-10-03T07-09-28-735Z.db`
  (0600; SQLite quick_check: ok). The same volume remains mounted after restart.
- Previous image: `ghcr.io/ikenokazuki/sora:2.34.4`, ID `b97952398af8`.
- Previous drop-in saved alongside the current file as
  `20-release.conf.before-geocoding-20261003`. To roll back, restore this file to
  `20-release.conf`, daemon-reload, restart web-fetcher, and align the Nix image
  declaration with the restored release. The candidate container was removed.

## 前回更新（2026-10-06、v2.34.5）

- 公開リリース [v2.34.5](https://github.com/ikenokazuki/Sora/releases/tag/v2.34.5) のイメージをappsとしてpullし、Quadletでweb-fetcher.serviceだけを更新した。
- 稼働イメージ: ghcr.io/ikenokazuki/sora:2.34.5。イメージID: 97f5dafdba1cda8adf39fcb8f031e437e272a0cc9b1b9f334df96dcfd5ef0f8e。レジストリdigest: sha256:8a2753bb7a6257e19cd0a5fbe806febfff539d07d3010d437c44bbb317bb95fb。リリースCIが検証したイメージと一致する。
- 別ポート3017・独立DBの候補と公開URLで、health、OpenAPI、MCP定義、実スクレイピング、Web検索、標高・駅・住所・施設検索、RESTのscrape/searchを確認した。各11項目が成功。候補コンテナは削除済み。
- 本番DBバックアップ: /data/backups/sora-before-2.34.5-20261006T040039Z.db（0600、1,380,352バイト、SQLite quick_check: ok）。web-fetcher-data:/data:Uと既存ポートを維持。他の稼働コンテナのIDも変化なし。
- NixのSoraイメージと永続drop-inを揃え、Pull=newerに戻した。NixOS全体の再構築は行っていない。
- 復旧先: localhost/sora:2.34.4-geocoding-20261003（ID 3fcd5202d2fe）。旧イメージは保持。同じdrop-inディレクトリの20-release.conf.before-v2.34.5-20261006T040039Zを20-release.confに戻し、上記apps用コマンドでdaemon-reload後、web-fetcherだけをrestartする。NixのSoraイメージも旧版へ戻し、pull = "never";を再設定する。通常のイメージ復旧ではDBを復元しない。
- 作業前の設定と検証結果: /home/ikeno/.local/state/sora-deploy/20261006T040039Z/。

## 最新更新（2026-10-06、v2.34.6）

- 公開リリース [v2.34.6](https://github.com/ikenokazuki/Sora/releases/tag/v2.34.6) を本番に反映した。対象コミットは9a9803ea861232c5f8a76318a1e3de45cb269e6d。日本語リリースノートを公開済み。
- 稼働イメージはghcr.io/ikenokazuki/sora:2.34.6。IDは64bbacfbb7b1156581da8ab012c6bce7d348f441cdfb6df77e77744d5ef095f8、pull後のdigestはsha256:aea903af0f2d69f2c3d48740f3515319615e8176e2a265b8473d13a5708a6fbf。CIの候補成果物と両実APIレーン、本番イメージのIDが一致する。
- 公開ゲートの再実行で全体テストと両実APIレーンが成功した。標準レーンはpass=90、pass_empty=1、fail=0、unavailable=0、blocked=1、unverified=12。ホテルレーンはpass=93、pass_empty=1、fail=0、unavailable=0、blocked=1、unverified=10。未設定の配送実番号、外部403等は既存のsoft-holdルールで許容される未確認項目として記録している。全項目成功とは扱わない。
- 初回の公開ゲートは標高取得の外部タイムアウトで停止。再実行では既存UPS自動判別テストの15秒上限が不足したため、同じUPSブラウザ取得テストに合わせ110秒へ修正した。実装・検査内容は変更していない。実ブラウザを使った対象テストと型チェックも成功した。
- 別ポート3017・独立DBの候補と公開URLで、health、OpenAPI、MCP定義、実スクレイピング、Web検索、標高・駅・住所・施設検索、RESTのscrape/searchを確認した。各11項目が成功。
- 候補と公開URLの実ブラウザで、実CDNからScalar 1.68.0を読み込み、2択と4択のenumをValues枠内の横並びチップで表示することと、POIのTest Request初期値5000m・10件・noCache=falseを確認した。GET/POSTの入力定義一致、trackingのauto、ドキュメントのno-cacheヘッダーも確認済み。
- 本番DBバックアップ: /data/backups/sora-before-2.34.6-20261006T045150Z.db（0600、1,380,352バイト、SQLite quick_check: ok）。既存のweb-fetcher-data:/data:Uとポートを維持した。web-fetcherだけを再起動し、他の稼働コンテナのIDは変化なし。候補コンテナは削除済み。
- Nix宣言と永続Quadlet drop-inをv2.34.6で揃え、Pull=newerを維持した。daemon-reload後のExecStartを確認してからweb-fetcher.serviceだけをrestartした。NixOS全体は再構築していない。
- 復旧先はghcr.io/ikenokazuki/sora:2.34.5（ID 97f5dafdba1c）。旧イメージは保持。同じdrop-inディレクトリの20-release.conf.before-v2.34.6-20261006T045150Zを20-release.confに戻し、上記apps用コマンドでdaemon-reload、web-fetcherだけをrestartする。Nix宣言も2.34.5に戻す。Pull=newerは維持する。通常のイメージ復旧ではDBを復元しない。
- 設定控え、CI診断、候補・本番検証結果と画面: /home/ikeno/.local/state/sora-deploy/20261006T045150Z-2.34.6/。

## ブラウザ待機とTimeTree公開予定の修正（2026-10-07）

- コミット `6cc65d7` をmainへ反映した。既存の未コミットMCP instructions・契約テスト・運用記録を保持し、稼働中のMCP構成も含めてbundleした。公開リリースやGitHubへのpushは行っていない。
- 稼働イメージは `localhost/sora:2.34.6-timetree-20261007`、ID `b227fb7971ea19b7812c56601c12b26a1d6af0fd9c818ea9c6f509cd4e102f30`。旧ローカルイメージをベースに、同じBun 1.4.2でserver.jsだけを更新した。bundle SHA-256は `1a0c25deaa7c69a359e2a6088a17ee5b65d2f61af19a28e8d5dae809f75784f5`。
- Web本文取得を独立したX検索と並行化した。空本文の再ナビゲーションを、同じページでの期限付き待機へ置き換えた。非表示要素の判定はDOMのコピーで行い、Shadow DOMのコピーは更新する。scrape・統合検索のキャッシュ名前空間をv2へ変更し、旧失敗結果の再利用を防いだ。
- TimeTree公開ページ自身のpublic_eventsレスポンスを回収し、予定名・日付・説明・会場・URL・画像を本文とEventデータへ保持する。追加API通信やLLM呼び出しはない。公開ページが読み込んだ予定が対象で、全月巡回は行わない。responseModeの既定値はfullのまま。
- ブラウザを含む関連37テスト、追加バッチ回収修正後の対象10テスト、main統合後のMCP契約など52テスト、型チェックが成功した。コードレビューの重要指摘はすべて解消した。
- 旧版・候補のキャッシュを揃えたdeep検索3回で、中央値20.031秒→13.685秒（約32%短縮）、最大41.368秒→13.728秒。TimeTree単体は7.733秒→3.611秒（約53%短縮）、予定0件→17件。URL集合の固定比較や競合に対する速度保証ではない。条件・限界は[検証記録](../evaluations/browser-readiness-timetree-20261007.md)を参照する。
- 最終候補と公開URLでhealth、OpenAPI、TimeTreeの実REST/MCP scrape、既定fullと明示的evidenceのdeep検索、47正式ツールを確認した。本番の単発計測はREST scrape 4.408秒、deep full 14.908秒、MCP scrape 3.319秒。全経路で予定17件、10月7日のライブ15:00〜15:20・特典会15:35〜16:35、検索ではX結果24件を確認した。
- SQLiteバックアップは `/data/backups/sora-before-timetree-20261007T093624Z.db`（0600、1,683,456バイト、quick_check=ok）。Nix宣言とappsのQuadlet drop-inを揃え、Pull=never・既存Host/Origin・SORA_DEFER_TOOLS=false・web-fetcher-data:/data:Uを維持した。web-fetcher.serviceだけを再起動し、他の本番コンテナIDは変化なし。検証用2コンテナは削除した。
- 復旧先は `localhost/sora:2.34.6-native-mcp-20261006`（ID `d565df77d3e7`）。drop-inの `20-release.conf.before-timetree-20261007T093624Z` を `20-release.conf` に戻し、上記apps用コマンドでdaemon-reload、web-fetcherだけをrestartする。Nix宣言のSoraイメージも旧タグへ戻す。通常のイメージ復旧でDBを復元しない。
- 設定控え・bundle・公開ページの取得結果・再実行スクリプト: `/home/ikeno/.local/state/sora-deploy/20261007T093624Z-timetree/`。

## 汎用スクレイピングへの修正（2026-10-07）

- ユーザーの意図は汎用スクレイピングの強化によるTimeTree取得だったため、前節の専用API補完を削除した。ソースのコミットは `49358b7`。WebとXの並列処理、同じページでの描画待機、非表示DOMのコピー上での剪定、Shadow DOM更新、表・grid本文の救済は維持している。
- 現在のイメージは `localhost/sora:2.34.6-generic-scrape-20261007`、ID `be990c125b6d22781d3151430bf1292791c51514fbc2eb39eb0cd4a1a70e02ff`。前節と同じBun・Chromium・依存パッケージを使用し、server.jsだけを交換した。既存のホスト非依存MCP instructionsも維持した。稼働中bundleのSHA-256は `52a970dd40d5a0aea0d131d45f4c9d48481b80fdb4b96677248ee68755779371`。bundleにもTimeTreeのホスト名・`public_events`処理は存在しない。
- 全テストは1,297成功、22スキップ、失敗0件。Chromiumを使う隔離コンテナの関連26テスト、main統合後の契約・本文抽出関連62テストと型チェックも成功した。本文保存テストはTimeTreeではなくexample.comのURLで検証している。
- 候補と公開URLでhealth、OpenAPI、REST scrape、deep検索の既定full／明示的evidence、MCPの47正式ツール、MCP scrapeが成功した。本番のREST scrapeは4.862秒、MCP scrapeは3.471秒、deep検索fullは14.650秒でX結果24件を保持した。単発計測で、前版とは取得範囲が異なるため厳密な速度比較には使わない。
- TimeTreeの取得範囲は通常画面の予定名17件、Markdown478文字、`contentStatus: body`。予定APIを本文・Event構造化データへ変換していないため、前節の説明全文・会場・出演時刻・17件のevents配列は返さない。詳細を手動で開いた観測ではこれらがDOMに表示されるが、自動展開は追加していない。responseModeの既定値はfullのまま、scrape／deepキャッシュの名前空間はv3に変更した。
- DBバックアップは `/data/backups/sora-before-generic-20261007T101508Z.db`（0600、quick_check=ok）。`web-fetcher-data:/data:U`を維持し、Nix宣言とQuadlet drop-inのSoraイメージだけを変更してweb-fetcherを再起動した。
- 復旧先は直前の `localhost/sora:2.34.6-timetree-20261007`（ID `b227fb7971ea`）。`20-release.conf.before-generic-20261007T101508Z`を戻し、Nix宣言も同じイメージへ戻してdaemon-reload・web-fetcherだけを再起動する。この復旧先は専用API補完を含む旧版であり、通常のイメージ復旧ではDBを復元しない。
- 設定控え・bundle・取得結果・試験ログ・再実行スクリプト: `/home/ikeno/.local/state/sora-deploy/20261007T101508Z-generic-scrape/`。取得範囲の違いは[検証記録](../evaluations/generic-calendar-extraction-20261007.md)を参照する。

## 日本のWebへの接続機能としてTimeTree補完を採用（2026-10-07）

- ユーザーが、専用API実装に意義があるなら採用してよいと指定。日本のWebをAIエージェントから利用するSelf-hosted MCP / REST統合サーバーとして、公開予定情報への接続範囲を増やす意義を評価した。MCP・RESTの共通scrape経路にTimeTree補完を復帰した。公開ツール・引数を増やさず、他サイトの汎用抽出と共通の高速化を維持した。
- ソースは `617ce2f`。カレンダー予定ボタン保持の汎用テストはexample.comのまま。追加LLM・APIリクエスト・認証・別サービスは不要。対象の公開カレンダーが受信した予定APIレスポンスだけを使用し、データなし・不正形式では描画済みDOMを維持する。ページ内APIの形式変更への追従が必要で、開発者向け公式APIの安定性を保証するものではない。
- 現在のイメージは `localhost/sora:2.34.6-calendar-adapter-20261007`、ID `fc8e545aaee2e927868b0831681744cd3f910ec83d6faa303650076a60d9a3f0`。同じBun・Chromium・依存パッケージを使い、既存のホスト非依存MCP instructionsを含むserver.jsだけを交換した。稼働中bundleのSHA-256は `d07672cf87568cd158b3772f3d6847b158bfff5734ce0cdc3ae85394f9dace77`。
- 全テスト1,302成功、22スキップ、失敗0件。隔離Chromiumの関連26テスト、main統合後の契約・抽出関連67テスト、型チェックも成功した。通常記事・商品・表・Cookie・localStorage・Shadow DOM・遅延描画と、API補完なしのフォールバックを検証した。
- 候補・公開URLのhealth、OpenAPI、REST scrape、deep検索の既定full／明示的evidence、MCP正式47ツール、MCP scrapeが成功した。本番REST scrapeは4.921秒、MCP scrapeは4.236秒、deep検索fullは14.571秒。TimeTreeは本文あり・予定17件と説明、会場、ライブ15:00〜15:20・特典会15:35〜16:35を保持し、deep検索はX結果24件も保持した。単発の外部応答計測であり、他版・競合との速度保証には使わない。
- responseModeの既定値はfullのまま。scrape・deepキャッシュの名前空間をv4へ変更し、前版の予定名だけの結果を再利用しない。DBバックアップは `/data/backups/sora-before-calendar-adapter-20261007T105234Z.db`（0600、quick_check=ok）。`web-fetcher-data:/data:U`を維持し、Nix宣言・Quadlet drop-inのSoraイメージだけを変更してweb-fetcherを再起動した。
- 復旧先は直前の `localhost/sora:2.34.6-generic-scrape-20261007`（ID `be990c125b6d`）。`20-release.conf.before-calendar-adapter-20261007T105234Z`を戻し、Nix宣言も同じイメージに戻してdaemon-reload・web-fetcherだけを再起動する。復旧先ではTimeTreeの詳細補完を行わず、通常表示の予定名だけを取得する。通常の復旧ではDBを復元しない。
- 成果物: `/home/ikeno/.local/state/sora-deploy/20261007T105234Z-calendar-adapter/`。[採用判断](../evaluations/calendar-adapter-decision-20261007.md)に目的・対応範囲・保守負担を記録した。

## v2.34.7の公開とCI確認（2026-10-07）

- 高速化・公開予定補完・本番で使用しているMCP説明文をGitHubのmainへ反映し、コミット`b7563698c53f30b687d31fe6ec95bf30e6ec2514`に`v2.34.7`を付けた。[日本語リリースノート](https://github.com/ikenokazuki/Sora/releases/tag/v2.34.7)を公開した。
- ローカルの全テストは1,303成功、22スキップ、失敗0件。型チェックも成功した。[タグの公開CI](https://github.com/ikenokazuki/Sora/actions/runs/37612028554)ではChromiumを含む全テストが1,308成功、17スキップ、失敗0件で、候補ビルド・両実APIレーン・公開処理が成功した。
- タグCIの標準レーンはpass=91、pass_empty=1、fail=0、unavailable=0、blocked=1、unverified=11。ホテルレーンはpass=92、pass_empty=1、fail=0、unavailable=0、blocked=1、unverified=11。未確認項目は既存のsoft-holdルールで記録しており、全項目成功とは扱わない。
- 公開イメージは`ghcr.io/ikenokazuki/sora:2.34.7`、IDは`e15f8b1ea8e4f10d9c64f8b8ce8883a1b5a68ee9e8df8d6839573666c5e61293`、digestは`sha256:2c3c9214231efaadfb8d2f7d28f8a67591689a29ad90ede3b39e78008e79e988`。appsとしてpullし、タグCIが検証した候補と一致することを確認した。
- 同時実行された[最初のmain公開CI](https://github.com/ikenokazuki/Sora/actions/runs/37612031688)では、Facebook投稿の期待情報欠落が両レーンで発生し、ホテルレーンではGDELTのHTTP 404も発生した。失敗を許容するゲート変更は行っていない。Facebook専用取得とGDELT HTTP取得は今回のTimeTree補完・汎用DOM抽出変更を呼び出さない。Facebookの同じ公開投稿は旧本番と正式候補で本文を取得できた。
- GitHub連携にはActions再実行権限がなく403で拒否されたため、この運用記録をmainへpushして同じ実装のCIを再検証した。再検証では全テスト・候補ビルド・両実APIレーン・公開処理が成功した。本番は候補のREST・MCP・実ブラウザ確認後に切り替えた。
- 検証結果・診断成果物・設定控えは`/home/ikeno/.local/state/sora-deploy/20261007T110654Z-2.34.7/`に保存する。
- 検証結果・診断成果物・設定控えは`/home/ikeno/.local/state/sora-deploy/20261007T110654Z-2.34.7/`に保存する。

## v2.36.1の公開と本番反映（2026-10-09）

- X検索の誤りの修正と応答の削減。主な変更：Xプロフィールページ（`x.com/アカウント名`）の本文を、そのアカウント本人の投稿から作る（タイトル整形の正規表現が「＝LOVE_official」を「＝LOVE_off」に切り、別人の「LOVE off vocal」の投稿を本文にしていた）、1件だけ全語に一致する投稿があると「網羅できた」として別名検索に進まなかった問題の修正（全語を含む投稿が半数未満で6件以上なら固有名詞を確かめる。語が1つだけのクエリも別名で検索）、優先する発信者`focus`（`search_realtime`の`focus`・`search_deep`の`realtimeFocus`。クエリの評判系の語から自動判定、`public`では評判・口コミを検索語から外し公式枠を後ろに最大2件）、返すX投稿の上限（既定20、`omittedCount`、上限内に無いクエリ語を含む投稿は最大5件超過して残す）、自動で見つけた公式アカウントは表示名か投稿にクエリの語がある場合だけ公式扱い、MCPの`search_deep`・`search_realtime`を整形なしJSONに、0の反応数・`isOfficial:false`を省略、同じハイライトを`highlightsSameAs`へ、キャッシュ名前空間をv7へ更新。`search_deep`の`realtime.intent`は`focus`に置き換えて廃止。詳細は`RELEASE_NOTES.md`。
- リリースコミットは`0a52c4b`（`release: v2.36.1`）、タグ`v2.36.1`。`main`とタグを`--atomic`でpushした。公開前の全テストはリリース候補のツリーで1,423件が成功（スキップ17、失敗0）。
- 注意：タグ側パイプラインの実API検査の標準レーンが1回失敗し、公開がスキップされた（ホテルレーンと`main`側パイプラインの両レーンは同じコミットで成功）。ログは認証なしでは取得できないため原因は特定できなかったが、タグと同じソースから手元でイメージを作って標準レーンを実行し、失敗0・利用不可0（pass 91、blocked 2、unverified 10。CIでは通過扱いの終了コード3）だったため一時的な失敗と判断した。ゲートは緩めず、利用者が失敗したジョブだけを再実行して全ジョブが成功し（試行2回目）、`2.36.1`・`2.36`・`latest`・`sha-0a52c4b`が同一digest`sha256:0332895083bf…`で公開され、[日本語リリース](https://github.com/ikenokazuki/Sora/releases/tag/v2.36.1)も作成された。再実行の前には、`main`側パイプラインが別ビルドの`latest`・`sha-0a52c4b`（digest `sha256:323932b4fc90…`）を先に公開していたが、再実行で上書きされた。
- apps側のpull結果のイメージIDは`be7ac85b5114a1edccf9b5d85279aa61356786aa73f05b8aaa85d3ad13e1da1f`、ENTRYPOINTは`/usr/bin/tini -- /usr/local/bin/bun /app/server.js`。
- 正式イメージを別ポート3117・使い捨てDB・本番と同じkrun/`SORA_DEFER_TOOLS=false`で検証（候補のみ`BROWSER_IDLE_TTL_MS=15000`）。31項目すべて成功：health 2.36.1、OpenAPIの`focus`・`realtimeFocus`・`realtimeLimit`・`omittedCount`、別名検索（`=LOVE`単独・`ライブ 予定 =LOVE`・`≠ME`）、「内山優花 評判」で`focus: public`・投稿者15人・検索語は「内山優花」だけ、compact応答で0の反応数・`isOfficial:false`を省略、不正な`focus`・`realtimeLimit`の400、Xプロフィールのscrapeが本人の投稿（著者＝LOVE_official）、MCP 47ツール（`outputSchema`なし）・MCPの応答が整形なしJSON、実ブラウザ描画。アイドル解放後もtiniの配下はbunだけ。
- DBバックアップは`/data/backups/sora-before-2.36.1-20261009T075850Z.db`（0600、3,960,832バイト、quick_check=ok）。Nix宣言とappsのQuadlet drop-inを同じ固定タグで揃え、Pull=newerを維持。既存のSORA_DEFER_TOOLS=false、Host/Origin、web-fetcher-data:/data:U、127.0.0.1:3016、krunを維持した。drop-inの変更前は`20-release.conf.before-v2.36.1-20261009T075850Z`に保存した。
- 生成されたExecStartを確認し、`web-fetcher.service`だけを再起動した（16:59:16、約4秒でhealth ok）。他の本番コンテナ18個のIDは変化なし。NixOS全体は再構築していない。検証用の候補コンテナは削除済み。
- 公開URLでの確認：候補と同じスモーク31項目がすべて成功。元の「=LOVE ライブ　予定」の深層検索リクエスト（`maxTotalChars: 1000`）で、X投稿は25件すべて`=LOVE`か別名を含み（公式5件を含む）、5件目のx.comは本人の投稿になり、応答は整形なし換算で54,097字→36,483字。本番の既定TTL（5分）でアイドル解放後にtiniの配下はbunだけ（ゾンビ0）、bunのRSS 208MB。再起動後のログにエラーなし。
- 復旧先は直前の`ghcr.io/ikenokazuki/sora:2.36.0`（ID `a29c58e96203`）。drop-inの`20-release.conf.before-v2.36.1-20261009T075850Z`を戻し、Nix宣言も2.36.0へ戻してdaemon-reload、web-fetcherだけをrestartする。通常のイメージ復旧ではDBを復元しない。
- 本番・候補の取得結果、イメージID、digest、設定控え、DBバックアップの確認結果は`/home/ikeno/.local/state/sora-deploy/20261009T065807Z-2.36.1/`に保存した。

## v2.36.0の公開と本番反映（2026-10-09）

- X検索のノイズ削減。主な変更：緩和の再検索で固有名詞を落とさない（Webタイトルと総ヒット数で判定、語順を問わない）、Yahooが記号を無視する固有名詞は公式Xアカウントのハッシュタグから別名を検出して検索し無関係な投稿を除く、`search_deep`の公式枠も固有名詞の公式にそろえる、`missingTerms`・`aliasTerms`を通常応答に追加、網羅判定のNFKC化、空の`includeDomains`/`excludeDomains`で0件になる不具合の修正、テスト後の共有Chromiumの後始末、キャッシュ名前空間をv6へ更新。詳細は`RELEASE_NOTES.md`。
- v2.35.0のアイドル解放で、共有Chromiumを閉じるたびに補助プロセス（zygote・crashpad）がゾンビとして残る不具合を見つけて修正した（コンテナでbunがPID 1のため回収されない）。反映前の本番は約15時間で24個（chrome_crashpad 12・chromium 12）。2.35.0イメージの使い捨てコンテナで再現し、`--init`付きでは残らないことを確かめたうえで、イメージにtini（Debian bookwormの`tini-static`）を入れてPID 1にした。起動コマンド・ポート・環境変数は変わらない。
- リリースコミットは`24aa03e`（`release: v2.36.0`）、タグ`v2.36.0`。`main`とタグを`--atomic`でpushした。公開CI（全テスト・候補ビルド・両実APIレーン）が通り、`2.36.0`・`2.36`が同一digest`sha256:7a8c0c8aaa4f…`で公開された。[日本語リリース](https://github.com/ikenokazuki/Sora/releases/tag/v2.36.0)も作成済み。ゲート緩和なし。公開前の全テストはリリース候補のツリーで1,381成功、17スキップ、失敗0件。
- 注意：`main`へのpushとタグのpushでパイプラインが別々にイメージを作るため、後から終わった`main`側の別ビルドが`latest`と`sha-24aa03e`を`sha256:696b8b022aa0…`で上書きした（同じコミット、どちらも全ゲート通過）。本番は`2.36.0`に固定しているため影響なし。
- apps側のpull結果のイメージIDは`a29c58e96203b2afb637c0cb005ec19b0c04e2945a7661f51bc895d71faa38db`、ENTRYPOINTは`/usr/bin/tini -- /usr/local/bin/bun /app/server.js`。
- 正式イメージを別ポート3117・使い捨てDB・本番と同じkrun/`SORA_DEFER_TOOLS=false`で検証（候補のみ`BROWSER_IDLE_TTL_MS=15000`）。16項目すべて成功：health 2.36.0、OpenAPIの`missingTerms`/`aliasTerms`、「ライブ 予定 =LOVE」で別名`イコラブ`・39件すべて固有名詞か別名を含む、verboseの`anchorTerm`/`anchorFiltered`と固有名詞を落とす再検索が無いこと、空のドメイン指定で0件にならない、deep searchの公式枠が`Equal_LOVE_12`、MCP 47ツール（`outputSchema`なし）と`search_realtime`の別名`ノイミー`、実ブラウザ描画。アイドル解放を2回繰り返してもtiniの配下はbunだけ（同条件の2.35.0では4個残った）。
- DBバックアップは`/data/backups/sora-before-2.36.0-20261009T025150Z.db`（0600、3,960,832バイト、quick_check=ok）。Nix宣言とappsのQuadlet drop-inを同じ固定タグで揃え、Pull=newerを維持。既存のSORA_DEFER_TOOLS=false、Host/Origin、web-fetcher-data:/data:U、127.0.0.1:3016、krunを維持した。drop-inの変更前は`20-release.conf.before-v2.36.0-20261009T025150Z`に保存した。
- 生成されたExecStartを確認し、`web-fetcher.service`だけを再起動した（11:52:28、約5秒でhealth ok）。他の本番コンテナ18個のIDは変化なし。NixOS全体は再構築していない。検証用の候補コンテナは削除済み。
- 公開URLでの確認：候補と同じスモーク16項目がすべて成功。本番の既定TTL（5分）で、最終利用の約5分後に`sharedConnected: false`、tiniの配下はbunだけ（ゾンビ0）、bunのRSS 175MB。再起動後のログにエラーなし。
- 復旧先は直前の`ghcr.io/ikenokazuki/sora:2.35.0`（ID `ec8d5574b7ea`）。drop-inの`20-release.conf.before-v2.36.0-20261009T025150Z`を戻し、Nix宣言も2.35.0へ戻してdaemon-reload、web-fetcherだけをrestartする。通常のイメージ復旧ではDBを復元しない（2.35.0へ戻すとゾンビの蓄積も戻る）。
- 本番・候補の取得結果、イメージID、digest、設定控え、DBバックアップの確認結果は`/home/ikeno/.local/state/sora-deploy/20261009T022217Z-2.36.0/`に保存した。

## v2.35.0の公開と本番反映（2026-10-08）

- 検索の待ち時間とLLMに渡る量の削減、Chromiumのメモリ解放。主な変更：`tools/list`から`outputSchema`を既定で除外（47ツールで約245KB→約80KB、バイト換算の実測）、`search_deep`に`maxTotalChars`と`scrapeDeadlineMs`（既定は無効）を追加、応答に`contextSufficiency`を追加、ブラウザ描画の静止待ちを本文ベースにして`networkidle`の待ちを5秒で打ち切り、共有Chromiumを無操作5分で解放、`MAX_CONCURRENT_BROWSERS`の既定をメモリから自動算出（本番コンテナはホストの約12GBが見えるため5で変化なし）、回答値判定の先読み2文、キャッシュ名前空間をv5へ更新。詳細は`RELEASE_NOTES.md`。
- リリースコミットは`038eee5`（`release: v2.35.0`）、タグ`v2.35.0`。`main`とタグを`--atomic`でpushした。公開CI（全テスト・候補ビルド・両実APIレーン）が通り、`2.35.0`・`2.35`・`latest`・`sha-038eee5`が同一digest`sha256:8ecf168e1b15…`で公開された。[日本語リリース](https://github.com/ikenokazuki/Sora/releases/tag/v2.35.0)も作成済み。ゲート緩和なし。公開前に全テストを複数回通した（リリース候補のツリーで1,348成功、17スキップ、失敗0件。mainの基準は1,308成功）。
- apps側のpull結果のイメージIDは`ec8d5574b7ea70ac02f55f97db2c47dd0f271b9074432700cbad1e997bc23a7f`。レジストリ上の4タグのdigestがすべて一致することを確認した（CIの候補イメージIDそのものは認証なしでは取得できないため、digestの一致で代える）。
- 正式イメージを別ポート3117・使い捨てDB・本番と同じkrun/`SORA_DEFER_TOOLS=false`で検証（候補のみ`BROWSER_IDLE_TTL_MS=15000`）。21項目すべて成功：health 2.35.0、OpenAPIの新しい要求/応答項目、`maxTotalChars`の上限（3575字→2760字、切り詰め1件）、`contextSufficiency`、不正値の400、MCP 47ツール（`outputSchema`なし・`default.*`なし、応答は約54,000文字≒約80KB）、instructions、実ブラウザ描画、アイドル解放と再起動後の描画。
- DBバックアップは`/data/backups/sora-before-2.35.0-20261008T103129Z.db`（0600、3,960,832バイト、quick_check=ok）。Nix宣言（作業ツリー、未コミット）とappsのQuadlet drop-inを同じ固定タグで揃え、Pull=newerを維持。既存のSORA_DEFER_TOOLS=false、Host/Origin、web-fetcher-data:/data:U、127.0.0.1:3016、krunを維持した。drop-inの更新は許可済みの`podman unshare`経由で行い、変更前は`20-release.conf.before-v2.35.0-20261008T103129Z`に保存した。
- 生成されたExecStartを確認し、`web-fetcher.service`だけを再起動した（19:31:59、約4秒でhealth ok）。他の本番コンテナ18個のIDは変化なし。NixOS全体は再構築していない。検証用候補コンテナは削除済み。
- 公開URLでの確認：候補と同じスモークがすべて成功（アイドル解放の1項目は候補用の短いTTLを前提にした確認のため本番では対象外。本番は既定の5分で別途確認し、最終利用の約5分後に`sharedConnected: false`、bunのRSS 188MB、コンテナ使用量は約143MB）。公式MCP SDKクライアントでも47ツール・`outputSchema`なし・約54,000文字（約80KB）を確認した。再起動時のログにエラーなし。
- 復旧先は直前の`ghcr.io/ikenokazuki/sora:2.34.8`（ID `e4ed20bfb8d6`）。drop-inの`20-release.conf.before-v2.35.0-20261008T103129Z`を戻し、Nix宣言も2.34.8へ戻してdaemon-reload、web-fetcherだけをrestartする。通常のイメージ復旧ではDBを復元しない。
- 注意：テストの全体実行が共有Chromiumを残して（親が終了した孤児）ホストのメモリを圧迫した。孤児プロセスは終了済み。残る一時プロファイル`/tmp/puppeteer_dev_chrome_profile-*`は未削除。
- 本番・候補の取得結果、イメージID、digest、設定控え、DBバックアップの確認結果は`/home/ikeno/.local/state/sora-deploy/20261008T102909Z-2.35.0/`に保存した。

## v2.34.8の公開と本番反映（2026-10-08）

- 旧ハイライト選択アルゴリズムrho-bm25の廃止（`highlightAlgorithm`から`rho-bm25`を削除、指定時は400）。ソースの変更は別作業の`54ee78f`とリリース`69f6bf9`で確定済み。本作業ではコード変更なし。
- タグ`v2.34.8`の初回公開CIはホテルレーンのfrance24フィード404で失敗、再走した2回目はGDELTのHTTP 404で失敗。いずれも今回の変更と無関係の上流一過性（再確認時は両方とも正常応答）。ゲート緩和なし。3回目の再走で全工程成功：全テスト・候補ビルド・両実APIレーン・公開処理。[成功ラン](https://github.com/ikenokazuki/Sora/actions/runs/37727615573)。[日本語リリース](https://github.com/ikenokazuki/Sora/releases/tag/v2.34.8)を公開した。
- 公開イメージは`ghcr.io/ikenokazuki/sora:2.34.8`、IDは`e4ed20bfb8d6dd41bf531978cd5a63da95b531fc67523ab918c9efee304d7eca`。CIが検証した候補と一致することをapps側のpull結果で確認した。
- 正式イメージを別ポート3017・別DBで検証：health 2.34.8、実scrape、Web検索、rho-bm25指定の400拒否、OpenAPIのenumからrho-bm25消去と版数2.34.8、MCP 2.34.8を確認。
- 公開URLでも同じ確認がすべて成功：health 2.34.8 ok、scrape 3.004秒、rho-bm25は400、OpenAPI版数2.34.8。稼働イメージIDはCI候補と一致。
- DBバックアップは`/data/backups/sora-before-2.34.8-20261008T045621Z.db`（0600、1,683,456バイト、quick_check=ok）。Nix宣言とappsのQuadlet drop-inを同じ固定タグで揃え、Pull=newerを維持。既存のSORA_DEFER_TOOLS=false、Host/Origin、web-fetcher-data:/data:U、127.0.0.1:3016を維持した。
- 生成されたExecStartを確認してweb-fetcher.serviceだけを再起動した。他の本番コンテナ25個のIDはすべて変化なし。NixOS全体は再構築していない。検証用候補コンテナは削除済み。
- 復旧先は直前の`ghcr.io/ikenokazuki/sora:2.34.7`（ID `e15f8b1ea8e4`）。drop-inの`20-release.conf.before-v2.34.8-20261008T045621Z`を戻し、Nix宣言も2.34.7へ戻してdaemon-reload、web-fetcherだけをrestartする。通常のイメージ復旧ではDBを復元しない。
- 本番・候補の取得結果、イメージID、設定控え、DBバックアップの確認結果は`/home/ikeno/.local/state/sora-deploy/20261008T040519Z-2.34.8/`に保存した。

## v2.34.7の本番反映（2026-10-07）

- 正式公開イメージ`ghcr.io/ikenokazuki/sora:2.34.7`へ切り替えた。本番・pull結果・タグCIの両実APIレーンが検証したイメージIDはすべて`e15f8b1ea8e4f10d9c64f8b8ce8883a1b5a68ee9e8df8d6839573666c5e61293`で一致する。health・OpenAPI・MCPの版数も2.34.7を確認した。
- 正式イメージを別ポート3017・別DBで検証した。REST/MCP scrape、deep検索の既定fullと明示的evidence、47正式ツール、ホスト側ツール検索を優先するinstructionsが成功した。実ブラウザを使う関連26テストも成功、失敗0件。TimeTreeは予定17件と詳細時刻を保持した。候補確認時はブラウザテストとAPI確認を同時に実行したため、候補の取得時間を性能比較には使用しない。
- 公開URLでも同じ確認がすべて成功した。TimeTreeはREST scrape 4.541秒、MCP scrape 3.480秒、deep検索の既定fullは14.997秒で、予定17件とライブ・特典会の時刻、X結果25件を保持した。別の明示的evidence計測ではnoCache=true・maxChars=30017を指定し、12.270秒、予定17件・X結果25件を確認した。子ページの本文キャッシュも同じ条件で再利用されない長さを指定した単発計測であり、固定URL集合や競合との速度保証ではない。
- 初回main CIで失敗したFacebookの同じ投稿は旧本番と正式候補で本文を取得できた。GDELTの同じprovider検証も411件を取得できた。CIの結果を隠したり検査条件を緩和したりせず、運用記録のコミット`4c2a1b5`で[main公開CIを再検証](https://github.com/ikenokazuki/Sora/actions/runs/37615401193)し、全工程が成功した。全テストは1,308成功、17スキップ、失敗0件。標準レーンはpass=91、pass_empty=1、fail=0、unavailable=0、blocked=1、unverified=11。ホテルレーンはpass=92、pass_empty=1、fail=0、unavailable=0、blocked=1、unverified=11。両レーンでFacebook本文取得とGDELT取得344件が成功した。
- mainの再ビルド候補IDは`b89a5042de0a259b46e1225c26f0e9b2953444f025bbe469e21ded87c5950525`。ソースの変更は運用記録だけで、本番はタグCIで検証した正式2.34.7のID`e15f8b1ea8e4`を使用する。初回Facebook失敗時の上流応答本体はCI診断に残っていないため、詳細な拒否・応答変動の原因までは断定しない。同じ実装と検査条件で再取得・再検証できたことを確認結果として記録する。
- DBバックアップは`/data/backups/sora-before-2.34.7-20261007T113851Z.db`（0600、1,683,456バイト、quick_check=ok）。Nix宣言とappsのQuadlet drop-inを同じ固定タグで揃え、Pull=newerに戻した。既存のSORA_DEFER_TOOLS=false、Host/Origin、web-fetcher-data:/data:U、127.0.0.1:3016を維持した。
- 生成されたExecStartを確認してweb-fetcher.serviceだけを再起動した。他の本番コンテナのIDはすべて変化なし。NixOS全体は再構築していない。検証用候補コンテナは削除済み。
- 復旧先は直前の`localhost/sora:2.34.6-calendar-adapter-20261007`（ID `fc8e545aaee2`）。drop-inの`20-release.conf.before-v2.34.7-20261007T113851Z`を戻し、Nix宣言も同じ旧イメージ・pull = "never"へ戻してdaemon-reload、web-fetcherだけをrestartする。通常のイメージ復旧ではDBを復元しない。
- 本番・候補の取得結果、ブラウザテスト、イメージID、設定控え、DBバックアップの確認結果は`/home/ikeno/.local/state/sora-deploy/20261007T110654Z-2.34.7/`に保存した。
