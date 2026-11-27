import { afterEach, describe, expect, test } from 'bun:test';
import { app } from './index.js';
import { bodyBudget } from './net/body_budget.js';
import { resetSecurityMetrics } from './security/metrics.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * 読み込み中の本文の量の上限を、本物のアプリ（/scrape → 静的な取得 → 本文の読み込み）で見る（監査 8）。
 * 以前は、止まる大きな本文を同時に取ると、本数だけメモリを使い続けた（29MB の本文 20 本で +720MB）。
 */
const MB = 1024 * 1024;
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
  resetSecurityMetrics();
});

describe('strict の読み込み中の本文の量（1 人 64MB）', () => {
  test('1 人が、止まる大きな本文（29MB）を同時に 3 本取ると、64MB に収まる 2 本は時間切れまで読み、残りの 1 本は 429。読み終えたら返す', async () => {
    // 29MB の本文を gzip で 29KB にして送り、最後（gzip の末尾 8 バイト）を送らずに止める
    const gz = Bun.gzipSync(new Uint8Array(29 * MB).fill(0x20));
    const head = gz.slice(0, gz.byteLength - 8);
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 60,
      fetch: () =>
        new Response(new ReadableStream({ start: (controller) => controller.enqueue(head) }), {
          headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        }),
    });
    servers.push(server);
    await withEnv({ SORA_ISOLATION: 'strict', SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true', SORA_EGRESS_GATEWAY: undefined }, async () => {
      const responses = await Promise.all(
        [0, 1, 2].map((i) =>
          app.fetch(
            new Request('http://localhost/scrape', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: `http://127.0.0.1:${server.port}/p${i}`, mode: 'fast', timeoutMs: 3000, noCache: true }),
            }),
            { remoteAddr: null },
          ),
        ),
      );
      const statuses = responses.map((response) => response.status).toSorted();
      expect(statuses).toEqual([408, 408, 429]);
      const busy = await responses.find((response) => response.status === 429)!.json();
      expect(JSON.stringify(busy)).toContain('64 MB');
      expect(bodyBudget.used()).toBe(0);
    });
  }, 30_000);
});
