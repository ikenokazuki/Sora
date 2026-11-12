# 隔離の設計（2026-11-12）の実測に使ったスクリプト

設計書 `../2026-11-12-isolation-design.md` の「実測」の再現用。本番のコードではない（試作）。

## 実行のしかた

公開イメージの中（Bun と Debian の Chromium が入っている）で、リポジトリの `src` と、このディレクトリを重ねて動かす。

```bash
IMG=ghcr.io/ikenokazuki/sora:latest   # 実測は sha-dd656db（Bun 1.4.4・Debian の Chromium 156.0.8078.79）
EXP=docs/superpowers/specs/isolation-experiments

# E1: ページからループバックへ。NODE_ENV=test と SORA_DB_PATH は、src を読み込むため
podman run --rm --http-proxy=false -e NODE_ENV=test -e SORA_DB_PATH=':memory:' \
  -v "$PWD/src:/app/src:ro" -v "$PWD/$EXP:/app/exp:ro" \
  --entrypoint /usr/local/bin/bun "$IMG" /app/exp/e1_page_to_loopback.ts

# E2: Chromium のサンドボックス（root は拒否される。非 root は、既定の seccomp で動く）
podman run --rm --http-proxy=false --entrypoint /usr/lib/chromium/chromium "$IMG" \
  --headless=new --disable-gpu --user-data-dir=/tmp/ud --dump-dom about:blank
podman run --rm --http-proxy=false --user 65532:65532 --entrypoint /usr/lib/chromium/chromium "$IMG" \
  --headless=new --disable-gpu --user-data-dir=/tmp/ud --dump-dom about:blank

# E3a: root から別 uid の子プロセス・パイプ接続 / E3b: 非 root・サンドボックス有効
podman run --rm --http-proxy=false -v "$PWD/$EXP:/app/exp:ro" \
  --entrypoint /usr/local/bin/bun "$IMG" /app/exp/e3_spawn_uid_and_pipe.ts
podman run --rm --http-proxy=false --user 65532:65532 -e HOME=/tmp -v "$PWD/$EXP:/app/exp:ro" \
  --entrypoint /usr/local/bin/bun "$IMG" /app/exp/e3_sandbox_nonroot.ts

# E5: 出口プロキシの試作（外のネットワークに出られる環境で）
podman run --rm --http-proxy=false -v "$PWD/$EXP:/app/exp:ro" \
  --entrypoint /usr/local/bin/bun "$IMG" /app/exp/e5_egress_proxy.ts
# E6: Bun の fetch が、実行中に設定した HTTP(S)_PROXY・NO_PROXY と proxy オプションを守るか
podman run --rm --http-proxy=false -v "$PWD/$EXP:/app/exp:ro" \
  --entrypoint /usr/local/bin/bun "$IMG" /app/exp/e6_bun_env_proxy.ts
```

`--http-proxy=false` は、ホストの `HTTP(S)_PROXY` を Podman がコンテナへ渡し、Chromium の通信が変わるのを避けるため（付けないと、E1 の遷移が失敗した）。
