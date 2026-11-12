#!/usr/bin/env bash
# ビルドしたイメージの中で、静的取得の native とブラウザの整合を確かめる。
# .github/workflows/containerfile-check.yml（Containerfile などを変える PR）と、wreq-native-update.yml（上流の新しい rev の試しビルド）が使う。
#   1. wreq-js の native が、Containerfile で置き換えたものを読めている（scripts/image-smoke.ts）
#   2. ブラウザ（イメージの Chromium）と静的取得（自前の native）が、同じ ClientHello を送る（scripts/tls-fingerprint/run.ts。docs/browser-alignment.md）
#   3. Chromium が別 uid で動き、運用者の秘密を読めない（scripts/browser-isolation-check.ts。設計: docs/superpowers/specs/2026-11-12-isolation-design.md）
#   4. --cap-drop=ALL（uid を落とすのに要る capability が無い）でも、ブラウザが起動して描画でき、落とせないことを警告で知らせる（scripts/browser-capdrop-check.ts）
#   5. --cap-drop=ALL に、uid を落とすのに要る 4 つ（CHOWN・DAC_OVERRIDE・SETGID・SETUID）だけを足した運用でも、3 が通る
# 使い方: scripts/verify-image.sh <イメージ>（どれかが失敗すれば、終了コードは 0 でない）
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

# 3. Chromium が root でなく別 uid で動き、運用者の秘密（ここでは偽の値）を読めず、プロファイルが後始末される（scripts/browser-isolation-check.ts）
docker run --rm \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' -e SORA_API_KEY=sk-verify-image-fake-secret \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/browser-isolation-check.ts

# 4. --cap-drop=ALL のコンテナ（uid を落とせない）でも、ブラウザが起動して描画でき、従来どおり（root）に戻る。既定の挙動が、硬化した運用を壊さないことの確認
docker run --rm --cap-drop=ALL \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/browser-capdrop-check.ts

# 5. --cap-drop=ALL に、uid を落とすのに要る 4 つだけを足した運用（硬化した Docker の例）でも、3 の確認が通る
docker run --rm --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETGID --cap-add=SETUID \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' -e SORA_API_KEY=sk-verify-image-fake-secret \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/browser-isolation-check.ts
