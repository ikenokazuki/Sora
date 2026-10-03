# fetcher.ikebun.jp operations memo

Read this first on every update. No repeat checks.

## Target (confirmed 2026-10-03)

- Host: fetcher.ikebun.jp (162.43.91.12) IS this machine (/home/ikeno host).
- Sora runs as the `apps` user (uid 1001), podman container name `web-fetcher`.
- ikeno canNOT manage it: no su/sudo/SSH to apps. All container work runs AS apps.
- Port: container 8000 -> host 127.0.0.1:3016. Public path is Caddy https only:
  https://fetcher.ikebun.jp/health (direct :8000 is firewalled, never use it).
- Image: ghcr.io/ikenokazuki/sora, pinned tag per release. Registry rule:
  latest moves on main-branch builds only, never on tag builds.
- ikeno and apps have SEPARATE podman storage. Pulling as ikeno does NOT
  make the image visible to apps. Always pull AS apps.

## Update (as the apps user on this host)

1. Dump current config FIRST (Env/Volume/Port must be replicated):
   podman inspect web-fetcher
2. Pull: podman pull ghcr.io/ikenokazuki/sora:<version>
3. Recreate: podman stop web-fetcher; podman rm web-fetcher; then the same
   podman run with the new tag (previous pattern: -p 3016:8000 -e ENABLED_MODULES=all;
   confirm against the inspect output, especially API keys and volumes).
4. Confirm https://fetcher.ikebun.jp/health version matches the new release.

## Notes

- A red live gate leaves old registry tags in place. Judge the running version by /health.
- DB note: previous launches had no volume mount (DB ephemeral in container).
  If persistence is wanted, add a volume deliberately, not by accident.
