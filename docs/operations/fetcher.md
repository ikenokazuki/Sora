# fetcher.ikebun.jp operations memo

Read this first on every update. Also read the server's authoritative runbook:
[agent-ops.md](/home/ikeno/app/oshiframe/docs/superpowers/ops/agent-ops.md).

## Target (confirmed 2026-10-06)

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
- Current image: `ghcr.io/ikenokazuki/sora:2.34.6`
  (image ID `64bbacfbb7b1`, deployed 2026-10-06). Package/health version: `2.34.6`.
- Released images: ghcr.io/ikenokazuki/sora, pinned tag per release. Registry rule:
  latest moves on main-branch builds only, never on tag builds.
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
