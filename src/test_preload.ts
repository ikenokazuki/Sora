import { afterAll } from 'bun:test';
import { closeSharedBrowser } from './browser_engine.js';

// bun test は終了時に puppeteer の終了処理を回避するため、共有 Chromium を閉じないテストファイルが
// 孤児プロセスを残す（1ファイルにつき約 150〜700MB）。ファイルごとに閉じて、次のファイルが必要なら再起動する。
afterAll(async () => {
  await closeSharedBrowser();
});
