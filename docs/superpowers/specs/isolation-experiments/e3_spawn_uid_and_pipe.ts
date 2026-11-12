// E3a: root の Sora 本体から、別 uid の子プロセスを起こせるか。puppeteer のパイプ接続が Bun で動くか（実行: README.md）
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const out: Record<string, unknown> = {};
// (1) node:child_process の uid/gid
out.nodeSpawnUid = await new Promise<string>((resolve) => {
  const p = spawn('/usr/local/bin/bun', ['-e', 'console.log("uid=" + process.getuid() + " gid=" + process.getgid())'], { uid: 65532, gid: 65532, stdio: ['ignore', 'pipe', 'pipe'] });
  let s = ''; p.stdout.on('data', (d) => (s += d)); p.stderr.on('data', (d) => (s += d));
  p.on('error', (e) => resolve('error: ' + e.message)); p.on('close', (c) => resolve(`${s.trim()} (exit ${c})`));
});
// (2) Bun.spawn の uid/gid
try {
  const q = Bun.spawn(['/usr/local/bin/bun', '-e', 'console.log("uid=" + process.getuid())'], { stdout: 'pipe', stderr: 'pipe', ...({ uid: 65532, gid: 65532 } as object) });
  out.bunSpawnUid = ((await new Response(q.stdout).text()) + (await new Response(q.stderr).text())).trim();
} catch (e) { out.bunSpawnUid = 'error: ' + String(e).slice(0, 100); }
// (3) puppeteer の pipe 接続（root・--no-sandbox。いまの Sora と同じ前提）
try {
  const browser = await puppeteer.launch({ executablePath: '/usr/lib/chromium/chromium', headless: true, pipe: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--user-data-dir=/tmp/ud-pipe'] });
  const page = await browser.newPage();
  await page.setContent('<h1>pipe ok</h1>');
  out.pipeMode = `ok: ${await page.evaluate(() => document.body.innerText)} / ${await browser.version()}`;
  await browser.close();
} catch (e) { out.pipeMode = 'error: ' + String(e).slice(0, 200); }
console.log(JSON.stringify(out, null, 2));
process.exit(0);
