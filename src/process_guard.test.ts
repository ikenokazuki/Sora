import { describe, expect, test } from 'bun:test';

// 受け止められなかった失敗の受け皿（installUnhandledRejectionGuard）。bun test は、受け止めない失敗をテストの失敗にするので、子プロセスで確かめる
const root = `${import.meta.dir}/..`;
const GUARD_LOG = '[Sora] 受け止められなかった失敗';

/** 子の環境は最小にする（親の設定とプロキシを持ち込まない） */
const childEnv = (vars: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', SORA_DB_PATH: ':memory:',
  ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
  ...vars,
});

async function probe(guard: 'guard' | 'none', kind: string) {
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'src/test_fixtures/leak_probe.ts', guard, kind], { cwd: root, env: childEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe('受け皿（子プロセスで確かめる）', () => {
  test('対照: 受け皿が無ければ、受け止めない失敗 1 件で、プロセスは終わる', async () => {
    const { code, stdout, stderr } = await probe('none', 'error');
    expect(stderr).toContain('probe-leak');
    expect(stdout).not.toContain('alive');
    expect(code).toBe(1);
  }, 30_000);

  test('受け皿があれば、記録して数え上げ、続く。失敗の持つ値（資格情報など）は書かない', async () => {
    const { code, stdout, stderr } = await probe('guard', 'error');
    expect(stdout).toContain('alive 1');
    expect(code).toBe(0);
    expect(stderr).toContain(GUARD_LOG);
    expect(stderr).toContain('probe-leak');
    expect(stderr).toContain('leak_probe.ts');
    expect(stderr).not.toContain('TOPSECRET');
  }, 30_000);

  for (const [name, kind, logged] of [['Error でない失敗', 'string', 'probe-string'], ['文字にできない失敗', 'unprintable', '']] as const) {
    test(`${name}でも、続いて数える`, async () => {
      const { code, stdout, stderr } = await probe('guard', kind);
      expect(stdout).toContain('alive 1');
      expect(code).toBe(0);
      expect(stderr).toContain(logged);
    }, 30_000);
  }

  test('長い失敗の文は、切り詰めて書く', async () => {
    const { code, stderr } = await probe('guard', 'long');
    expect(code).toBe(0);
    expect(stderr).toContain('probe-long');
    expect(stderr.length).toBeLessThan(5000);
  }, 30_000);

  test('同期の例外は受けない（これまでどおり終了する）', async () => {
    const { code, stdout, stderr } = await probe('guard', 'sync-throw');
    expect(stderr).toContain('probe-sync');
    expect(stdout).not.toContain('alive');
    expect(code).toBe(1);
  }, 30_000);
});

/** 標準エラーを、目当ての文が出るまで読む（出なければ、時間切れまでに読めたぶんを返す） */
async function readUntil(stream: ReadableStream<Uint8Array>, wanted: (text: string) => boolean, ms: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (!wanted(text) && Date.now() < deadline) {
    const next = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => undefined)]);
    if (!next || next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

/** 空いているポート（PORT=0 は既定の 8000 になるので、番号を先に決める） */
function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port as number;
}

const spawnEntry = (file: string, vars: Record<string, string>) =>
  Bun.spawn([process.execPath, '--no-env-file', '--preload', './src/test_fixtures/leak_after_guard.ts', file], { cwd: root, env: childEnv(vars), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
const settled = (text: string) => text.includes('probe: listeners=0') || (text.includes(GUARD_LOG) && text.includes('probe-entry-leak'));

describe('2 つの入口は、受け皿を付ける', () => {
  test('HTTP の入口: 受け止めない失敗の後も、要求に答える', async () => {
    const port = freePort();
    const proc = spawnEntry('src/index.ts', { PORT: String(port) });
    try {
      const log = await readUntil(proc.stderr, settled, 40_000);
      expect(log).toContain('probe: listeners=1');
      expect(log).toContain('probe-entry-leak');
      const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(10_000) });
      expect(health.status).toBe(200);
      expect(proc.exitCode).toBeNull();
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 60_000);

  test('stdio の入口: 受け止めない失敗の後も、MCP の要求に答える', async () => {
    const proc = spawnEntry('src/stdio.ts', {});
    try {
      const log = await readUntil(proc.stderr, settled, 40_000);
      expect(log).toContain('probe: listeners=1');
      expect(log).toContain('probe-entry-leak');
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } })}\n`);
      proc.stdin.flush();
      const out = await readUntil(proc.stdout, (text) => text.includes('"id":1'), 20_000);
      expect(out).toContain('"serverInfo"');
      expect(proc.exitCode).toBeNull();
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 60_000);
});
