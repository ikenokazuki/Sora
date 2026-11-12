// E10（実行: README.md）。パイプ接続の耐久: 起動と終了の繰り返し・並行の起動・強制終了の検知。Bun の版で比べる
import puppeteer from 'puppeteer-core';
const exe = process.env.CHROME_PATH ?? '/usr/lib/chromium/chromium';
const noSandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
const launch = () => puppeteer.launch({ executablePath: exe, headless: true, pipe: true, args: [...noSandbox, '--disable-dev-shm-usage', `--user-data-dir=/tmp/ud-e10-${Math.random().toString(36).slice(2)}`] });
const within = <T>(p: Promise<T>, ms: number, label: string) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label}: ${ms}ms で止まった`)), ms))]);
const out: string[] = [];
try {
  // (1) 起動 → 描画 → 閉じる を 15 回
  const t0 = Date.now();
  for (let i = 0; i < 15; i++) {
    const b = await within(launch(), 15000, `起動 ${i}`);
    const p = await within(b.newPage(), 8000, `newPage ${i}`);
    await within(p.setContent('<h1>x</h1>'), 8000, `setContent ${i}`);
    await within(p.evaluate(() => 'y'.repeat(1_000_000)), 8000, `evaluate ${i}`);
    await within(b.close(), 10000, `close ${i}`);
  }
  out.push(`(1) 起動・描画・終了 ×15: ok ${Date.now() - t0}ms`);
  // (2) 5 つ並行で起動し、それぞれで描画して閉じる ×3 ラウンド
  for (let r = 0; r < 3; r++) {
    await within(Promise.all(Array.from({ length: 5 }, async (_, k) => { const b = await launch(); const p = await b.newPage(); await p.setContent(`<h1>${k}</h1>`); await p.evaluate(() => 'z'.repeat(500_000)); await b.close(); })), 40000, `並行 ${r}`);
  }
  out.push('(2) 5 並行 ×3 ラウンド: ok');
  // (3) 強制終了（SIGKILL）を検知できるか
  const b = await launch(); const pid = b.process()?.pid!;
  const gone = new Promise<string>((res) => b.once('disconnected', () => res('disconnected')));
  process.kill(pid, 'SIGKILL');
  out.push(`(3) SIGKILL の検知: ${await within(gone, 5000, '強制終了の検知')} connected=${b.connected}`);
  // (4) 検知のあと、新しく起動できる
  const b2 = await launch(); await b2.close(); out.push('(4) 強制終了のあとの再起動: ok');
} catch (e) { out.push(`失敗: ${(e as Error).message}`); }
console.log(`Bun ${Bun.version}\n` + out.join('\n'));
process.exit(0);
