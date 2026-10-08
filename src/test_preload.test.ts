import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChromiumPath } from './browser_engine.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// bun test は終了時に puppeteer の終了処理を回避するため、共有 Chromium を閉じないテストファイルがあると
// 孤児プロセスが残りホストのメモリを圧迫する。bunfig.toml の preload が各ファイルの終了時に閉じることを固定する。
describe.skipIf(!resolveChromiumPath())('bun test preload', () => {
  test('a test file that opens the shared browser and never closes it leaves no Chromium behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sora-preload-'));
    const pidFile = join(dir, 'pid');
    const engine = join(import.meta.dir, 'browser_engine.ts');
    writeFileSync(join(dir, 'leak.test.ts'), `
      import { test, expect } from 'bun:test';
      import { writeFileSync } from 'node:fs';
      import { getBrowser } from ${JSON.stringify(engine)};
      test('opens the shared browser without closing it', async () => {
        const { browser } = await getBrowser();
        writeFileSync(${JSON.stringify(pidFile)}, String(browser.process()?.pid));
        expect(browser.connected).toBe(true);
      }, 30000);
    `);
    let pid = 0;
    try {
      const proc = Bun.spawn(['bun', 'test', join(dir, 'leak.test.ts'), '--timeout', '30000'], { cwd: join(import.meta.dir, '..'), stdout: 'ignore', stderr: 'ignore', env: { ...process.env, NODE_ENV: 'test', SORA_DB_PATH: ':memory:' } });
      expect(await proc.exited).toBe(0);
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      await Bun.sleep(1500);
      expect(alive(pid)).toBe(false);
    } finally {
      if (pid && alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
