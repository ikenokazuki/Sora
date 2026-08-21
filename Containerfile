FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun build ./src/index.ts --compile --outfile server

FROM ghcr.io/browserless/chromium:latest
USER root
WORKDIR /app
COPY --from=builder /app/server /app/server
COPY --from=builder /app/bin/yahoo-search-mcp /app/yahoo-search-mcp
RUN chmod +x /app/server /app/yahoo-search-mcp

ENV PORT=8000 \
    CHROME_PATH=/usr/bin/chromium \
    YAHOO_MCP_PATH=/app/yahoo-search-mcp

EXPOSE 8000
ENTRYPOINT ["/app/server"]


