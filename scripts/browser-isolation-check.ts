/**
 * イメージの中で動かす確認（scripts/verify-image.sh から）: Sora の起動のままで、Chromium が root でなく別 uid で動き、
 * 運用者の秘密（root だけが読めるファイル）を読めず、プロファイルが後始末され、サンドボックスの状態が分かること。
 * 使い方: docker run --rm -e NODE_ENV=test -e SORA_DB_PATH=:memory: -e SORA_API_KEY=<偽の秘密> -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
 *           --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/browser-isolation-check.ts
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 2）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { browserSandboxStatus, closeSharedBrowser, getBrowser } from '../src/browser_engine.js';
import { DEFAULT_LAUNCHER } from '../src/browser_launch_plan.js';

// テストの既定（サンドボックスなし）を、本番と同じ auto にする
process.env.SORA_BROWSER_SANDBOX ??= 'auto';
const secret = process.env.SORA_API_KEY;
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

check(process.getuid?.() === 0, `この確認は root（Sora 本体と同じ）で動かす（uid=${process.getuid?.()}）`);
check(Boolean(secret), '偽の運用者の秘密（SORA_API_KEY）を渡して動かす');

// (0) 起動用バイナリ単体: 本物の Chromium の代わりに bun を起動させ、落とした先の状態を読む
const launcherEnv = { SORA_LAUNCH_EXEC: process.execPath, SORA_LAUNCH_UID: '65532', HOME: '/tmp' };
const probe = Bun.spawnSync([DEFAULT_LAUNCHER, '-e', 'console.log(JSON.stringify({ status: require("node:fs").readFileSync("/proc/self/status", "utf8"), env: Object.keys(process.env) }))'], { env: launcherEnv });
check(probe.exitCode === 0, `起動用バイナリが、別 uid で bun を起動できない: exit=${probe.exitCode} ${probe.stderr.toString().trim()}`);
if (probe.exitCode === 0) {
  const { status, env } = JSON.parse(probe.stdout.toString()) as { status: string; env: string[] };
  const field = (name: string) => status.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'))?.[1].trim();
  // 実・実効・保存・ファイルシステムのすべてが落とし先（保存が 0 のままだと、root に戻れる）
  check(/^65532\s+65532\s+65532\s+65532$/.test(field('Uid') ?? ''), `起動用バイナリが落とした uid が 65532 ではない: ${field('Uid')}`);
  check(/^65532\s+65532\s+65532\s+65532$/.test(field('Gid') ?? ''), `起動用バイナリが落とした gid が 65532 ではない: ${field('Gid')}`);
  check(['', '65532'].includes(field('Groups') ?? '?'), `起動用バイナリが落としたあと、補助グループが残っている: ${field('Groups')}`);
  check(field('NoNewPrivs') === '1', `NoNewPrivs が立っていない: ${field('NoNewPrivs')}`);
  check(/^0+$/.test(field('CapPrm') ?? '?') && /^0+$/.test(field('CapEff') ?? '?'), `capability が残っている: CapPrm=${field('CapPrm')} CapEff=${field('CapEff')}`);
  check(!env.some((name) => name.startsWith('SORA_LAUNCH')), `起動先に、起動用バイナリの設定が残っている: ${env.filter((name) => name.startsWith('SORA_LAUNCH')).join(',')}`);
}
// 落とせない設定では、root のまま起動せず、終了コード 126 で止まる
const refusals: Array<[string, Record<string, string>]> = [
  ['SORA_LAUNCH_EXEC なし', { SORA_LAUNCH_UID: '65532' }],
  ['相対パス', { SORA_LAUNCH_EXEC: 'bun', SORA_LAUNCH_UID: '65532' }],
  ['uid 0', { SORA_LAUNCH_EXEC: process.execPath, SORA_LAUNCH_UID: '0' }],
  ['gid 0', { SORA_LAUNCH_EXEC: process.execPath, SORA_LAUNCH_UID: '65532', SORA_LAUNCH_GID: '0' }],
  ['uid が数でない', { SORA_LAUNCH_EXEC: process.execPath, SORA_LAUNCH_UID: 'abc' }],
  ['存在しない実行ファイル', { SORA_LAUNCH_EXEC: '/nonexistent', SORA_LAUNCH_UID: '65532' }],
];
for (const [label, env] of refusals) {
  const result = Bun.spawnSync([DEFAULT_LAUNCHER, '--version'], { env });
  check(result.exitCode === 126, `起動用バイナリが、${label}で止まらない: exit=${result.exitCode}`);
}

const { browser } = await getBrowser();
const pid = browser.process()?.pid;
check(pid !== undefined, 'Chromium の pid を取れない');
const procFile = (name: string) => readFileSync(`/proc/${pid}/${name}`, 'utf8');

// (1) uid: 実効・実・保存・ファイルシステムのどれも root でない
const uids = procFile('status').match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m)?.slice(1).map(Number) ?? [];
check(uids.length === 4 && uids.every((uid) => uid !== 0), `Chromium が root で動いている: Uid=${uids.join(',')}`);
const groups = procFile('status').match(/^Groups:[ \t]*(.*)$/m)?.[1].trim(); // 空の行をまたがない（\s にしない）
check(groups === '' || groups === '65532', `補助グループが残っている: Groups=${groups}`);

// (2) プロファイル: --user-data-dir のディレクトリが、Chromium の uid の所有で、0700。
// 環境変数は、ここでは見ない: 落とした Chromium は dumpable でなくなり、root でも（CAP_SYS_PTRACE がなければ）/proc/<pid>/environ を読めない。
// 許可リストの中身は、child_env.test.ts・chromium_env.test.ts が確かめる（運用者の秘密を読めないことは、次の (3) で確かめる）
const profile = browser.process()?.spawnargs.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
check(Boolean(profile?.startsWith('/tmp/sora-chromium-')), `プロファイルが、Sora が作ったディレクトリではない: ${profile}`);
if (profile && existsSync(profile)) {
  const stat = statSync(profile);
  check(stat.uid === uids[0], `プロファイルの所有者が、Chromium の uid ではない: ${stat.uid}`);
  check((stat.mode & 0o777) === 0o700, `プロファイルが 0700 ではない: ${(stat.mode & 0o777).toString(8)}`);
} else check(false, `プロファイルのディレクトリが無い: ${profile}`);

// (3) 権限の分離: root だけが読めるファイル（Sora 本体の環境変数）を、Chromium が読めない
const context = await browser.createBrowserContext();
const page = await context.newPage();
const target = `file:///proc/${process.pid}/environ`;
check(secret ? readFileSync(`/proc/${process.pid}/environ`, 'utf8').includes(secret) : false, '確認の前提: root の Sora 本体は、自分の環境変数を読める');
const leaked = await page.goto(target, { timeout: 10_000 }).then(
  async () => (secret ? (await page.content()).includes(secret) : false),
  () => false, // 開けない（権限がない）のが期待
);
check(!leaked, `Chromium が、Sora 本体の環境変数（${target}）を読めてしまった`);

// (4) 描画できる
await page.setContent('<html><body><h1>隔離の確認</h1></body></html>');
check((await page.evaluate(() => document.body.innerText)) === '隔離の確認', '描画できない');

// (5) サンドボックス: 有効なら chrome://sandbox で確かめる。使えない環境（Docker の既定の seccomp など）では、サンドボックスなしに戻っている
const sandbox = browserSandboxStatus();
if (sandbox === 'on') {
  const sandboxPage = await context.newPage();
  await sandboxPage.goto('chrome://sandbox', { timeout: 10_000 });
  check((await sandboxPage.evaluate(() => document.body.innerText)).includes('You are adequately sandboxed.'), 'サンドボックスが有効のはずが、chrome://sandbox は有効と言わない');
} else check(sandbox === 'off', `サンドボックスの状態が決まっていない: ${sandbox}`);

// (6) 後始末: 閉じると、Chromium が終わり、プロファイルのディレクトリが消える
await context.close();
await closeSharedBrowser();
const deadline = Date.now() + 5000;
while (profile && existsSync(profile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
check(!profile || !existsSync(profile), `閉じたあとも、プロファイルのディレクトリが残っている: ${profile}`);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`ok: Chromium は uid ${uids[0]} で動き、運用者の秘密を読めない。サンドボックス: ${sandbox}。プロファイルは後始末された`);
