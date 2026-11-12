#!/usr/bin/env bash
# ビルドしたイメージの中で、静的取得の native とブラウザの整合を確かめる。
# .github/workflows/containerfile-check.yml（Containerfile などを変える PR）と、wreq-native-update.yml（上流の新しい rev の試しビルド）が使う。
#   1. wreq-js の native が、Containerfile で置き換えたものを読めている（scripts/image-smoke.ts）
#   2. ブラウザ（イメージの Chromium）と静的取得（自前の native）が、同じ ClientHello を送る（scripts/tls-fingerprint/run.ts。docs/browser-alignment.md）
# 使い方: scripts/verify-image.sh <イメージ>（どちらかが失敗すれば、終了コードは 0 でない）
# src と scripts を /app に置くのは、bare の import を、イメージの /app/node_modules（本番依存と自前の native）から解決させるため。
set -euo pipefail
cd "$(dirname "$0")/.."
image="${1:?イメージを渡す}"

docker run --rm \
  -v "$PWD/scripts/image-smoke.ts:/app/image-smoke.ts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/image-smoke.ts

docker run --rm \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/tls-fingerprint/run.ts
