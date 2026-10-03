# fetcher.ikebun.jp operations memo

Read this first on every update. Also read the server's authoritative runbook:
[agent-ops.md](/home/ikeno/app/oshiframe/docs/superpowers/ops/agent-ops.md).

## Target (confirmed 2026-10-03)

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
- Current local image: `localhost/sora:2.34.4-geocoding-20261003`
  (image ID `3fcd5202d2fe`, deployed 2026-10-03). Package/health version: `2.34.4`.
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

## Last update (2026-10-03)

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
