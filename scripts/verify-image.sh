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
#  11. Bun の fetch と、通信する子プロセス（同梱の Yahoo 検索バイナリ・住所データの構築）の通信を、出口のゲートウェイに通すと、内部の宛先は断られ、NO_PROXY でも迂回せず、名前はゲートウェイが解決し、許す宛先の一覧（SORA_EGRESS_ALLOW_HOSTS）に挙げた宛先だけが内部の IP でも届く（scripts/fetch-egress-check.ts）
#  12. 本物のアプリ（認証のミドルウェア → MCP・REST）を、本物の Bun.serve に載せると、MCP の tenant は認証が決めたものだけ（同じ鍵はどの書き方でも同じ tenant・誤った Bearer と正しい X-API-Key は通らない・匿名は鍵を持つ利用者と別）で、ループバックからでも鍵が要り（鍵なしの通過は廃止）、鍵ファイル（SORA_AUTH_KEYS_FILE）は鍵ごとに別の tenant で、匿名を認めず、読めないときは 503。保存済みのセッションで得たページは、共有キャッシュ経由で別の tenant に返らず、ウォッチは、別の tenant の一覧に出ず、確認も削除もできない。map_site は、呼んだ tenant の保存済みのセッションで取り、結果を別の tenant に返さず、POST /cache/clear は、admin の鍵だけが全員分を消し、ほかの鍵は自分の tenant の分だけ消す。SORA_MODULES で絞ったモジュールの経路は、REST でも閉じる。SORA_ISOLATION=strict では、増幅の上限（サイトマップ・パターン・セレクタ）を締める（scripts/auth-check.ts）
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

# 11. Bun の fetch（固定の提供元・webhook など）と、通信する子プロセス（同梱の Yahoo 検索バイナリ・住所データの構築）の通信を、出口のゲートウェイ（SORA_EGRESS_GATEWAY=on。
#     確認のスクリプトが設定する）に通す。内部の宛先は断られ、環境変数 NO_PROXY が挙げていても、迂回せず（Bun も、Yahoo のバイナリも、NO_PROXY の宛先には、プロキシを使わず直接つなぐ）、
#     名前はゲートウェイが解決する（scripts/fetch-egress-check.ts。設計 1）
docker run --rm \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/fetch-egress-check.ts

# 12. 認証の入口（設計 4。E20・E22〜E24）。本物のアプリを、src/index.ts と同じ待ち受けの本物の Bun.serve に載せて、HTTP で叩く。
#     MCP の tenant は認証が決めたものだけ（同じ鍵は X-API-Key でも Bearer の大文字小文字違いでも同じ tenant。誤った Bearer と正しい X-API-Key は 401。匿名は鍵を持つ利用者と別の scope）。
#     ループバックは特別ではない（127.0.0.1・::1 から、X-Forwarded-For・X-Real-IP つきでも、廃止した鍵なしの通過の設定を置いたままでも、鍵が要る）。
#     鍵ファイル（SORA_AUTH_KEYS_FILE）は鍵ごとに別の tenant（MCP のセッションも、サイトごとの Cookie も）で、匿名は SORA_ALLOW_ANONYMOUS=true でも 401、読めないときは 503
#     共有キャッシュ（設計 5。E25）: ある tenant が、保存済みのセッション（Cookie）で得た個人向けのページを、別の tenant に返さない（ログインしていない tenant どうしは共有する）
#     ウォッチ（設計 5。E26）: ある tenant が登録したウォッチは、別の tenant の一覧に出ず（通知先・取得した内容も）、確認も削除もできない。id を省いた確認は、呼んだ tenant の分だけ
#     map_site（設計 5。E27）: robots.txt・サイトマップを、呼んだ tenant の保存済みのセッションで取り、保存済みのセッションで見えた map を、別の tenant に返さない（ログインしていない tenant どうしは共有する）
#     管理者の鍵と POST /cache/clear（設計 5。E28）: 鍵ファイルの admin: true の鍵だけが、全員分（共有のキャッシュも）を消せる。ほかの鍵は、自分の tenant のキャッシュだけ。admin は鍵ごとの属性。鍵ファイルを使わない運用（鍵が 1 つ）は、これまでどおり全体
#     REST のモジュール（設計 5。E29）: SORA_MODULES=web にすると、/watch/*・/trade/* など web 以外の経路は、REST でも 404（MODULE_DISABLED）。認証のあとに検査する（鍵のない要求は 401）。/openapi.json にも載らない。既定（all）では開いている
#     増幅の上限（設計 6。E30）: SORA_ISOLATION=strict で、map_site は robots.txt の Sitemap: 行の先頭 5 つだけを取り（100 行並べた悪意のあるサイトでも、通信は 5 回）、crawl のパターンとセレクタは 20 個まで（21 個は 400）。既定（standard）では、緩い値（51 個のセレクタは通り、Sitemap: は 5 行より多く取る）
#     ブラウザの枠（設計 6。E31）: SORA_ISOLATION=strict で、枠を全部埋め、ある tenant の待ちを上限（10 件）まで埋めると、その tenant の /browser/action は、待たされず 429（Retry-After つき）。別の tenant は断られない（main の src に当てると、待たされて失敗する）
#     アプリ全体（src/index.ts）を読み込むので、楽曲認識の指紋のパッケージ（packages/audio-signature。src が相対で読む）も /app に置く
docker run --rm \
  -e NODE_ENV=test -e SORA_DB_PATH=':memory:' \
  -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/packages:/app/packages:ro" \
  --entrypoint /usr/local/bin/bun "$image" /app/scripts/auth-check.ts
