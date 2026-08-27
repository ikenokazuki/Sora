# Stage 1: Build Application Binary (Bun)
FROM docker.io/oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun build ./src/index.ts --compile --minify-syntax --minify-whitespace --keep-names --sourcemap=none --outfile server

# Stage 2: Harvest Chromium and required dependencies (Debian Bookworm)
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
    && rm -rf /var/lib/apt/lists/*

# Stage 3: Final Minimal Distroless Image
FROM gcr.io/distroless/cc-debian12:latest
WORKDIR /app

# Copy Application & Yahoo MCP binaries
COPY --from=builder /app/server /app/server
COPY --from=builder /app/bin/yahoo-search-mcp /app/yahoo-search-mcp

# Copy Chromium and all shared libraries & assets
COPY --from=browser-harvester /usr/bin/chromium /usr/bin/chromium
COPY --from=browser-harvester /usr/lib/chromium /usr/lib/chromium
COPY --from=browser-harvester /usr/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu
COPY --from=browser-harvester /lib/x86_64-linux-gnu /lib/x86_64-linux-gnu
COPY --from=browser-harvester /usr/share/fonts /usr/share/fonts
COPY --from=browser-harvester /etc/fonts /etc/fonts
COPY --from=browser-harvester /etc/ssl/certs /etc/ssl/certs

ENV PORT=8000 \
    CHROME_PATH=/usr/lib/chromium/chromium \
    YAHOO_MCP_PATH=/app/yahoo-search-mcp

EXPOSE 8000
ENTRYPOINT ["/app/server"]
