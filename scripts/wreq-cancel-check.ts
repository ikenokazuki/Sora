/**
 * イメージの中で動かす確認（scripts/verify-image.sh の 19）: 静的取得の wreq-js（イメージの自前の native。vendor/wreq-js/body-cancel.patch を当てたもの）で、
 * 読み込みをやめた本文の接続が、すぐ閉じること。パッチの前は、サーバーが本文を止めると、取り消しても、要求ごとの時間切れのエラーでも、
 * native の Cache の time_to_idle（300 秒）まで接続が残った。本文を最後まで読む、ふつうの読み込みが変わらないことも確かめる。
 * 宛先は、この確認の中の Bun.serve（ループバックだけ）。
 * 使い方: docker run --rm -v "$PWD/scripts:/app/scripts:ro" --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/wreq-cancel-check.ts
 */
import { readFileSync } from 'node:fs';
import { createSession } from 'wreq-js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

/** 頭部と本文の一部だけを送り、本文を終えない宛先 */
function stalledServer() {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 255,
    fetch: () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode('<html><body>')) }), { headers: { 'content-type': 'text/html' } }),
  });
}

/** 宛先の側の、確立した接続の数（/proc/net/tcp の、手元のポートが宛先の行） */
function established(port: number): number {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  return readFileSync('/proc/net/tcp', 'utf8')
    .split('\n')
    .slice(1)
    .filter((line) => {
      const fields = line.trim().split(/\s+/);
      return fields.length > 3 && fields[1]!.endsWith(`:${hex}`) && fields[3] === '01';
    }).length;
}

async function closesWithin(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (established(port) > 0 && Date.now() < deadline) await Bun.sleep(50);
  return established(port) === 0;
}

const COUNT = 3;

/** 止まる本文を COUNT 本取り、how で扱ったあと、宛先の接続が閉じるか。keep は、応答を持ち続けるための入れ物（対照） */
async function run(how: 'hold' | 'drop' | 'cancel' | 'timeout'): Promise<{ open: number; closed: boolean }> {
  const server = stalledServer();
  const session = await createSession({ browser: 'chrome_149' });
  const keep: unknown[] = [];
  try {
    for (let i = 0; i < COUNT; i++) {
      const response = await session.fetch(`http://127.0.0.1:${server.port}/p${i}`, { method: 'GET', ...(how === 'timeout' ? { timeout: 1000 } : {}) });
      keep.push(response);
      if (how === 'hold') continue;
      if (how === 'drop') {
        await response.body!.cancel();
        continue;
      }
      const reader = response.body!.getReader();
      await reader.read();
      const pending = reader.read().then(() => 'done', () => 'error');
      keep.push(pending);
      if (how === 'cancel') await reader.cancel();
    }
    const port = Number(server.port);
    const open = established(port);
    const closed = await closesWithin(port, how === 'timeout' ? 3000 : 1500);
    return { open, closed };
  } finally {
    await session.close().catch(() => {});
    server.stop(true);
  }
}

// 対照: 読まずに持っている応答の接続は、開いたまま（数え方が、接続をとらえていることの確認）
const hold = await run('hold');
check(hold.open === COUNT && !hold.closed, `対照: 読まずに持っている応答の接続が ${COUNT} 本開いていない（開いた ${hold.open} 本・閉じた ${hold.closed}）`);

// 1. 読まずに取り消す（ReadableStream の cancel）
check((await run('drop')).closed, '読まずに取り消した本文の接続が、閉じない');

// 2. 読みかけで取り消す（読み込みが次の塊を待っている間に cancel。Sora の readBodyWithLimit の時間切れと同じ形）
check((await run('cancel')).closed, '読みかけで取り消した本文の接続が、閉じない');

// 3. 要求ごとの時間切れ（native の timeout）で、読みかけの読み込みがエラーになる
check((await run('timeout')).closed, '要求の時間切れでエラーになった本文の接続が、閉じない');

// 4. ふつうの読み込み: 本文を最後まで読める（流しで読む・まとめて読む）
const payload = 'あ'.repeat(1_000_000);
const full = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(payload, { headers: { 'content-type': 'text/plain; charset=utf-8' } }) });
try {
  const session = await createSession({ browser: 'chrome_149' });
  const streamed = await session.fetch(`http://127.0.0.1:${full.port}/s`, { method: 'GET' });
  const chunks: Uint8Array[] = [];
  const reader = streamed.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  check(new TextDecoder().decode(Buffer.concat(chunks)) === payload, '流しで読んだ本文が、送った本文と違う');
  const whole = await (await session.fetch(`http://127.0.0.1:${full.port}/w`, { method: 'GET' })).text();
  check(whole === payload, 'まとめて読んだ本文が、送った本文と違う');
  await session.close();
} finally {
  full.stop(true);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`NG: ${failure}`);
  process.exit(1);
}
console.log('OK: 読み込みをやめた本文（取り消し・読みかけの取り消し・要求の時間切れ）の接続は、すぐ閉じ、ふつうの読み込みは変わらない');
