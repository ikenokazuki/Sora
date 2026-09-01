FROM oven/bun:1-slim AS base
WORKDIR /app

# Chromium と日本語フォントのインストール（Stealth レンダリング用）
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=8000
ENV ALLOW_LOCAL_NO_AUTH=true

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

EXPOSE 8000

# デフォルトは stdio MCP サーバー（Glama / AI クライアント用）
# HTTP サーバーとして起動する場合は CMD ["bun", "run", "src/index.ts"]
CMD ["bun", "run", "src/stdio.ts"]
