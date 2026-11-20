import { describe, expect, test } from 'bun:test';

/**
 * wreq-js は、最初の取得のときに読み込む。読み込みの途中に来た取得が、読み込み済みの結果を待たずに「使えない」と受け取ると、
 * 標準の fetch の代用のセッションになり、それがプールに残って使われ続ける。
 * 読み込み済みかどうかはプロセスごとなので、起動したばかりの子プロセスで確かめる。
 */
describe('起動直後の最初の取得が同時に来たとき', () => {
  const child = new URL('./test_fixtures/http_session_cold_child.ts', import.meta.url).pathname;

  test('すべての取得が、wreq-js のセッションを受ける（標準の fetch の代用にならない）', async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)));
    const proc = Bun.spawn([process.execPath, child], {
      env: { ...env, NODE_ENV: 'test', SORA_DB_PATH: ':memory:' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const line = out.split('\n').find((text) => text.startsWith('RESULT '));
    expect(line).toBeDefined();
    const kinds = line!.slice('RESULT '.length).split(',');
    expect(kinds).toHaveLength(4);
    expect(kinds.filter((kind) => kind === 'NativeFetchSession')).toEqual([]);
  }, 30_000);
});
