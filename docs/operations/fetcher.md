# fetcher.ikebun.jp operations memo

Read this first on every update. No repeat checks.

## Target

- Host: fetcher.ikebun.jp (162.43.91.12)
- Health: http://fetcher.ikebun.jp:8000/health (check version field)
- Image: ghcr.io/ikenokazuki/sora, pinned tag per release
- Registry rule: latest moves on main-branch builds only, never on tag builds
- No SSH from here (port 22 refused as of 2026-10-03). Work on the fetcher host.

## Update (on the fetcher host)

1. Confirm the release tag exists in ghcr.
2. Pull: docker pull ghcr.io/ikenokazuki/sora:<version>
3. Recreate with the existing launch method (record it here on first update).
4. Confirm /health version matches the new release.

## Notes

- A red live gate leaves old registry tags in place. Judge the running version by /health.
- Launch command not yet recorded: transcribe Env, Volume, Port, restart policy from docker inspect on first update.
