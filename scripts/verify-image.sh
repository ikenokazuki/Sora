#!/usr/bin/env bash
# ビルドしたイメージの中で、静的取得の native とブラウザの整合を確かめる。
# .github/workflows/containerfile-check.yml（Containerfile などを変える PR）と、wreq-native-update.yml（上流の新しい rev の試しビルド）が使う。
#   1. wreq-js の native が、Containerfile で置き換えたものを読めている（scripts/image-smoke.ts）
#   2. ブラウザ（イメージの Chromium）と静的取得（自前の native）が、同じ ClientHello を送る（scripts/tls-fingerprint/run.ts。docs/browser-alignment.md）
#   3. Chromium が別 uid で動き、運用者の秘密を読めない（scripts/browser-isolation-check.ts。設計: docs/superpowers/specs/2026-11-12-isolation-design.md）
#   4. --cap-drop=ALL（uid を落とすのに要る capability が無い）でも、ブラウザが起動して描画でき、落とせないことを警告で知らせる（scripts/browser-capdrop-check.ts）
#   5. --cap-drop=ALL に、uid を落とすのに要る 5 つ（CHOWN・DAC_OVERRIDE・KILL・SETGID・SETUID）だけを足した運用でも、3 が通る
#   6. Docker の既定の seccomp を、ユーザー名前空間を許す版（deploy/seccomp-sora.json）に替えると、Chromium のサンドボックスが有効になる（SORA_BROWSER_SANDBOX=on。有効にできなければ失敗する）
#   7. 6 に、--cap-drop=ALL と、uid を落とすのに要る 5 つの capability、no-new-privileges を足した運用でも、サンドボックスが有効になる
#   8. ブラウザの通信を、出口のゲートウェイ（SORA_EGRESS_GATEWAY=on）に通すと、内部の宛先は断られ、名前はゲートウェイが解決し、ClientHello は変わらない（scripts/browser-egress-check.ts）
#   9. 8 を、7 と同じ硬化した運用（サンドボックス有効）でも確かめる
#  10. 静的取得（wreq-js。イメージの自前の native）の通信を、出口のゲートウェイに通すと、DNS rebinding は断られ、名前はゲートウェイが解決し、ClientHello は変わらない（scripts/static-egress-check.ts）
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

# 5. --cap-drop=ALL に、uid を落とすのに要る 5 つだけを足した運用（硬化した Docker の例）でも、3 の確認が通る。KILL が無いと、root の Sora が、別 uid の
#    Chromium に信号を送れず、puppeteer の後始末の kill が EPERM になって、Bun が異常終了する（起動に失敗したときなどに、2 回に 1 回ほど）
docker run --rm --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=KILL --cap-add=SETGID --cap-add=SETUID \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' -e SORA_API_KEY=sk-verify-image-fake-secret \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/browser-isolation-check.ts

# 6. Docker の既定の seccomp は、ユーザー名前空間を作る syscall を止めるので、Chromium のサンドボックスが使えない（3 の既定では、使えなければ off に戻る）。
#    それを許す版（deploy/seccomp-sora.json。README 4.5）を渡すと、有効になる。SORA_BROWSER_SANDBOX=on なので、有効にできなければ、起動に失敗する
docker run --rm --security-opt "seccomp=$PWD/deploy/seccomp-sora.json" \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' -e SORA_API_KEY=sk-verify-image-fake-secret -e SORA_BROWSER_SANDBOX=on \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/browser-isolation-check.ts

# 7. 6 に、硬化した運用（--cap-drop=ALL に 5 つだけを足す・no-new-privileges）を重ねても、サンドボックスが有効になる
docker run --rm --security-opt "seccomp=$PWD/deploy/seccomp-sora.json" --security-opt no-new-privileges \
  --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=KILL --cap-add=SETGID --cap-add=SETUID \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' -e SORA_API_KEY=sk-verify-image-fake-secret -e SORA_BROWSER_SANDBOX=on \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/browser-isolation-check.ts

# 8. ブラウザの通信を、出口のゲートウェイ（SORA_EGRESS_GATEWAY=on。確認のスクリプトが設定する）に通す。内部の宛先（ループバック）はゲートウェイが断り、名前はゲートウェイが解決し、
#    ブラウザの ClientHello は、ゲートウェイ越しでも直接のときと変わらない（scripts/browser-egress-check.ts。設計 1）
docker run --rm \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/browser-egress-check.ts

# 9. 8 を、7 と同じ硬化した運用（サンドボックス有効・--cap-drop=ALL に 5 つだけ・no-new-privileges）でも確かめる。サンドボックスの中のブラウザも、ゲートウェイに届くこと
docker run --rm --security-opt "seccomp=$PWD/deploy/seccomp-sora.json" --security-opt no-new-privileges \
  --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=KILL --cap-add=SETGID --cap-add=SETUID \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' -e SORA_BROWSER_SANDBOX=on \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/browser-egress-check.ts

# 10. 静的取得（wreq-js。イメージの自前の native）の通信を、出口のゲートウェイ（SORA_EGRESS_GATEWAY=on。確認のスクリプトが設定する）に通す。DNS rebinding（検査のときは解決できない名前が、
#     ゲートウェイの解決では内部の IP になる）は断られ、名前はゲートウェイが解決し、TLS の ClientHello は、ゲートウェイ越しでも直接のときと変わらない（scripts/static-egress-check.ts。設計 1）
docker run --rm \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/static-egress-check.ts
