import { afterAll } from 'bun:test';
import { closeSharedBrowser } from './browser_engine.js';

// テストから外部ネットワークへ出さない（SORA_LIVE_TESTS=1 の実 API テストは除く）。
// fetch・wreq・Chromium・同梱の Yahoo 検索バイナリはどれもプロキシの環境変数に従うため、閉じたポートを
// プロキシに指定して、外部への接続をすぐ失敗させる。手元のテスト用サーバーは NO_PROXY で除外する。
if (!process.env.SORA_LIVE_TESTS) {
  const blackhole = 'http://127.0.0.1:9';
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    process.env[key] = blackhole;
  }
  // Bun 標準の fetch は CIDR（127.0.0.0/8）を解釈しないため、テストで使うループバックのアドレスは個別にも書く
  const loopback = 'localhost,127.0.0.1,127.0.0.2,::1,127.0.0.0/8';
  process.env.NO_PROXY = loopback;
  process.env.no_proxy = loopback;
}

// bun test は終了時に puppeteer の終了処理を回避するため、共有 Chromium を閉じないテストファイルが
// 孤児プロセスを残す（1ファイルにつき約 150〜700MB）。ファイルごとに閉じて、次のファイルが必要なら再起動する。
afterAll(async () => {
  await closeSharedBrowser();
});
