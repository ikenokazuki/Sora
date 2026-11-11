# Stage 1: Build Application Bundle (Bun)
FROM docker.io/oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build ./src/index.ts --target=bun --outfile=server.js
# 住所データの構築専用の入口。アプリ本体を読み込まないので、子プロセスとして軽く起動できる
RUN bun build ./src/services/address_build_main.ts --target=bun --outfile=address-build.js

# Stage 1b: wreq-js の native（静的取得の TLS・HTTP の実装）を、ソースからビルドする。
# npm の wreq-js が持つ native（ビルド済み）は、wreq-js が新しい版を公開しないかぎり古いまま残る（3.2.0 は 2026-08-23 で、それ以降の公開はない）。
# 同じ版のソース（git のタグ）を、コミットを固定し、上流の Cargo.lock のまま（--locked）ビルドする。依存の版はタグの時点のままなので、
# npm 版と同じ挙動になる（133 プロファイルの ClientHello が同じで、wreq-js 自身のテストの結果も同じ。2026-11-12 に確認）。
# 版を上げるときは、package.json の wreq-js の版と、この 2 つの ARG をそろえる（src/containerfile_pins.test.ts が、そろっていなければ落ちる）。
# JS（npm の wreq-js）と native の版を食い違わせないためで、食い違うと、プロファイルや引数の扱いが合わなくなる。
FROM docker.io/library/rust:1.99.1-bookworm AS wreq-native
ARG WREQ_JS_VERSION=3.2.0
ARG WREQ_JS_REV=0d52d5fa252841aeef34d4d063b1766a59612bf7
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang libclang-dev perl \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "v${WREQ_JS_VERSION}" https://github.com/sqdshguy/wreq-js /src \
    && cd /src && test "$(git rev-parse HEAD)" = "$WREQ_JS_REV"
RUN cd /src/rust && cargo build --release --locked \
    && cp target/release/libwreq_js.so /wreq-js.linux-x64-gnu.node

# Stage 1c: 実行に要る node_modules だけ。builder の node_modules には開発用の Biome（127MB）・TypeScript（23MB）・型定義が入っていて、
# 実行には使わない。wreq-js の musl 用バイナリ（glibc の distroless では選ばれない）も要らない（約 165MB 減）。
# wreq-js の native は、npm のビルド済みのもの（@wreq-js/binding-linux-x64-gnu の中のファイル）を、Stage 1b で作ったものに置き換える。
# server.js は wreq-js の JS を取り込んで（bun build）、native を bare の @wreq-js/binding-<target> から探す（../rust/wreq-js.<target>.node は
# server.js からの相対になり、見つからない）。だから、このパッケージの中のファイルを置き換える。ファイルが無ければ、ここで落とす
# （wreq-js のパッケージの構成が変わったとき、黙って npm のものを使い続けないため）。
FROM docker.io/oven/bun:1 AS prod-deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production \
    && rm -rf node_modules/@wreq-js/binding-*-musl \
    && test -f node_modules/@wreq-js/binding-linux-x64-gnu/wreq-js.linux-x64-gnu.node
COPY --from=wreq-native /wreq-js.linux-x64-gnu.node /app/node_modules/@wreq-js/binding-linux-x64-gnu/wreq-js.linux-x64-gnu.node
# 読み込めて、プロファイルが揃っていることを、ビルドの時点で確かめる（distroless の最終段は、シェルが無く、ビルド中に実行して確かめられない。
# server.js に取り込んだ状態での確認は、イメージを作ったあとの scripts/image-smoke.ts）
RUN bun -e "const w = await import('wreq-js'); const p = w.getProfiles(); if (p.length < 100 || !p.includes('chrome_149')) { console.error('wreq-js native: unexpected profiles', p.length); process.exit(1); } console.log('wreq-js native ok:', p.length, 'profiles')"

# Stage 2: 本文の取り出しに使う rs-trafilatura（https://github.com/Murrough-Foley/rs-trafilatura、MIT OR Apache-2.0）。
# 版はコミットで固定する。上流は Cargo.lock を持たない（.gitignore）ので、依存の版は vendor/rs-trafilatura/Cargo.lock で固定する
# （2026-10-28 に Cargo 1.91 で作ったもの）。rust-toolchain.toml の 1.85 の指定は消して、この Cargo.lock を作った版でビルドする。
# 評価は docs/evaluations/main-content/results.md
FROM docker.io/library/rust:1.91-slim-bookworm AS rs-trafilatura
ARG RS_TRAFILATURA_REV=2a4f56eef84cca2d319d27c9108373d593110355
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/Murrough-Foley/rs-trafilatura /src \
    && cd /src && git checkout "$RS_TRAFILATURA_REV" \
    && rm -f rust-toolchain.toml
COPY vendor/rs-trafilatura/Cargo.lock /src/Cargo.lock
RUN cd /src && cargo build --release --locked --bin extract_stdin

# Stage 3: Harvest Chromium and required dependencies (Debian Bookworm)
FROM docker.io/library/debian:bookworm-slim AS browser-harvester
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    fonts-noto-cjk \
    fonts-ipafont-gothic \
    ca-certificates \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Stage 3b: Chromium が実際に使う共有ライブラリだけを /out に集める。
# 以前は Debian の /usr/lib/x86_64-linux-gnu（約 300MB）を丸ごと、さらに /lib/x86_64-linux-gnu としてもう一度コピーして、
# イメージに約 600MB 入っていた（distroless の /lib は実ディレクトリなので、2 回目は重複した別の層になる）。
# 実際に読み込まれるのは、Chromium の依存の閉包（ldd）と、dlopen される NSS・SQLite・udev・Wayland で約 45MB
# （screenshot・日本語・WebGL・WebRTC・Web Audio・Worker を動かして LD_DEBUG=libs で確かめた。ldd の閉包は全部読み込まれていた）。
# glibc・libstdc++・libgcc・OpenSSL は distroless のベースが持つので、ここでは持ち込まない（loader と libc の版を食い違わせない）。
FROM browser-harvester AS browser-libs
RUN set -eu; \
    mkdir -p /out/usr/lib; \
    cp -a /usr/lib/chromium /out/usr/lib/chromium; \
    rm -f /out/usr/lib/chromium/libVkLayer_khronos_validation.so* /out/usr/lib/chromium/libVkICD_mock_icd.so*; \
    L=/usr/lib/x86_64-linux-gnu; \
    EXTRA="$(ls $L/libnss*.so $L/libsoftokn3.so $L/libfreebl*.so $L/libsqlite3.so.0 $L/libwayland-client.so.0 $L/libwayland-server.so.0 $L/libudev.so.1 2>/dev/null || true)"; \
    { ldd /usr/lib/chromium/chromium; \
      for f in /usr/lib/chromium/*.so* $EXTRA; do ldd "$f" 2>/dev/null || true; done; } \
      | awk '$3 ~ /^\// {print $3}' | sort -u > /tmp/libs.txt; \
    printf '%s\n' $EXTRA >> /tmp/libs.txt; \
    SKIP='^(ld-linux-x86-64\.so\.2|libc\.so\.6|libm\.so\.6|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|libresolv\.so\.2|libutil\.so\.1|libnss_[a-z]+\.so\.2|libstdc\+\+\.so\.6|libgcc_s\.so\.1|libgomp\.so\.1|libssl\.so\.3|libcrypto\.so\.3)$'; \
    sort -u /tmp/libs.txt | while read -r p; do \
      name="$(basename "$p")"; \
      if printf '%s' "$name" | grep -Eq "$SKIP"; then continue; fi; \
      real="$(readlink -f "$p")"; \
      case "$real" in /usr/lib/chromium/*) continue;; esac; \
      pdir="$(readlink -f "$(dirname "$p")")"; rdir="$(dirname "$real")"; \
      mkdir -p "/out$rdir"; cp -a "$real" "/out$rdir/$(basename "$real")"; \
      if [ "$pdir/$name" != "$real" ]; then mkdir -p "/out$pdir"; ln -sf "$(realpath --relative-to="$pdir" "$real")" "/out$pdir/$name"; fi; \
    done; \
    test -e /out$L/libnss3.so; test -e /out$L/libsoftokn3.so

# Stage 4: Final Minimal Distroless Image
FROM gcr.io/distroless/cc-debian12:latest
WORKDIR /app

# Copy Bun runtime, bundled server, and native dependencies
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
COPY --from=builder /app/server.js /app/server.js
COPY --from=builder /app/address-build.js /app/address-build.js
COPY --from=builder /app/client /app/client
# MCP リソースとして配るスキル（src/mcp/resources.ts が /app/plugins/ から読む）
COPY --from=builder /app/plugins/sora-deep-research/skills /app/plugins/sora-deep-research/skills
COPY --from=builder /app/package.json /app/package.json
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=builder /app/bin/yahoo-search-mcp /app/yahoo-search-mcp

# Copy Chromium and the shared libraries & assets it actually uses
COPY --from=browser-harvester /usr/bin/chromium /usr/bin/chromium
COPY --from=browser-libs /out/ /
COPY --from=browser-harvester /usr/share/fonts /usr/share/fonts
COPY --from=browser-harvester /etc/fonts /etc/fonts
COPY --from=browser-harvester /etc/ssl/certs /etc/ssl/certs
# 本文の取り出し（src/extractor/rs_trafilatura.ts が RS_TRAFILATURA_PATH から呼ぶ）
COPY --from=rs-trafilatura /src/target/release/extract_stdin /usr/local/bin/rs-trafilatura
COPY --from=rs-trafilatura /src/LICENSE-MIT /src/LICENSE-APACHE /usr/share/licenses/rs-trafilatura/
# PID 1 で孤児プロセスを回収する init。bun が PID 1 だと、共有 Chromium を閉じるたびに
# 補助プロセス（zygote・crashpad）がゾンビとして残る
COPY --from=browser-harvester /usr/bin/tini-static /usr/bin/tini

ENV PORT=8000 \
    NODE_ENV=production \
    CHROME_PATH=/usr/lib/chromium/chromium \
    YAHOO_MCP_PATH=/app/yahoo-search-mcp \
    RS_TRAFILATURA_PATH=/usr/local/bin/rs-trafilatura

EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bun", "/app/server.js"]

VOLUME ["/data"]
