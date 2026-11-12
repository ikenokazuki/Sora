import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChromiumPath } from './browser_engine.js';
import { SETTINGS } from './config.js';

// Chromium と同梱の実行ファイル（rs-trafilatura・yahoo-search-mcp）と住所データの構築の子プロセスは、Sora の秘密（API キー・運送会社の鍵・プロキシの資格情報など）を受け継がない。
// 子プロセスに渡すのは許可リスト（security/child_env.ts）の環境変数だけで、秘密でない Sora の設定も渡さない。PATH のような許可リストの名前は渡る。

const SECRETS = {
  SORA_API_KEY: 'fake-secret-api-key',
  SORA_TRACKING_PAGE_SECRET: 'fake-secret-page',
  SORA_PROXY_URL: 'http://user:fake-secret-proxy@127.0.0.1:9',
  SORA_PROXY_LIST: 'http://user:fake-secret-list@127.0.0.1:9',
  SORA_TRACKING_FEDEX_CLIENT_SECRET: 'fake-secret-fedex',
  // 旧名のまま秘密を入れている環境もある（旧名も外す）
  [SETTINGS.SORA_TRACKING_FEDEX_CLIENT_SECRET.legacy[0]]: 'fake-secret-fedex-old',
  SORA_GCC_CERTIFIER: '{"name":"fake-secret-gcc"}',
};
// 秘密でなくても、許可リストにない名前は渡らない
const NOT_ALLOWED = { SORA_BROWSER_LOW_MEMORY: 'false', SORA_CHILD_ENV_MARKER: 'not-allowlisted' };

function scratch(): { dir: string; script: (body: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'sora-child-env-'));
  return {
    dir,
    script: (body) => {
      const bin = join(dir, 'bin');
      // 呼ばれるたびに、環境を $0.env に書き足す
      writeFileSync(bin, `#!/bin/sh\nexport -p >> "$0.env"\n${body}\n`);
      chmodSync(bin, 0o755);
      return bin;
    },
  };
}

/** 失敗しても環境の中身を表示しない（開発機・CI のほかの秘密を出さない）よう、真偽値で比べる。 */
function expectStripped(dumped: string): void {
  expect(dumped.includes('fake-secret'), 'a secret value').toBe(false);
  for (const name of [...Object.keys(SECRETS), ...Object.keys(NOT_ALLOWED)]) expect(dumped.includes(name), name).toBe(false);
  expect(dumped.includes('PATH='), 'PATH (allowlisted)').toBe(true);
}

/**
 * 秘密を起動時の環境に入れた Sora（bun）を子プロセスで走らせる。本番と同じく、秘密は起動の前から環境にある
 * （Bun.spawn は env を渡さないと、起動時の環境を渡す。実行中に process.env へ書いた値は渡らない）。
 */
async function runSora(code: string, env: Record<string, string>, unset: string[] = []): Promise<string> {
  const composed: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'test', SORA_DB_PATH: ':memory:', ...SECRETS, ...NOT_ALLOWED, ...env };
  for (const name of unset) delete composed[name];
  const proc = Bun.spawn([process.execPath, '--no-env-file', '-e', code], {
    cwd: new URL('..', import.meta.url).pathname,
    env: composed as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), 25_000);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return out.split('\n').find((line) => line.startsWith('RESULT ')) ?? `no RESULT: ${out} ${err}`;
  } finally {
    clearTimeout(timer);
  }
}

describe('子プロセスに秘密を渡さない', () => {
  test('rs-trafilatura', async () => {
    const { dir, script } = scratch();
    try {
      const bin = script(`cat > /dev/null\nprintf '%s' '{"page_type":"article","content_html":"<p>本文</p>"}'`);
      const code = `import { extractMainContentWithRs } from './src/extractor/rs_trafilatura.ts'; const r = await extractMainContentWithRs('<p>本文</p>', 'https://example.com/a', ${JSON.stringify(bin)}); console.log('RESULT', r?.contentHtml);`;
      expect(await runSora(code, {})).toBe('RESULT <p>本文</p>');
      expectStripped(readFileSync(`${bin}.env`, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('yahoo-search-mcp', async () => {
    const { dir, script } = scratch();
    try {
      const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: JSON.stringify({ items: [{ title: 't', url: 'https://example.com/' }] }) }] } });
      const bin = script(`cat > /dev/null\nprintf '%s\\n' '${response}'`);
      const code = `import { callYahooMcp } from './src/services/yahoo.ts'; const r = await callYahooMcp('web_search', { query: 'q' }); console.log('RESULT', r.content.length);`;
      expect(await runSora(code, { SORA_YAHOO_MCP_PATH: bin })).toBe('RESULT 1');
      expectStripped(readFileSync(`${bin}.env`, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('住所データの構築', async () => {
    const { dir, script } = scratch();
    try {
      const bin = script('exit 0');
      const code = `import { ChildProcessBuilder } from './src/services/address_builder.ts'; await new ChildProcessBuilder({ dir: '/x', command: () => [${JSON.stringify(bin)}] }).run({ kind: 'postal' }); console.log('RESULT ok');`;
      expect(await runSora(code, {})).toBe('RESULT ok');
      expectStripped(readFileSync(`${bin}.env`, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // /proc/<pid>/environ は、Chromium がプロセスの題名を書き換えるので読めない。起動するコマンドを、環境を書き出してから本物を exec する包みにする
  test.skipIf(!resolveChromiumPath())('Chromium（--version の問い合わせと、起動の両方）', async () => {
    const { dir, script } = scratch();
    try {
      const bin = script(`exec ${JSON.stringify(resolveChromiumPath())} "$@"`);
      const code = `import { closeSharedBrowser, getBrowser } from './src/browser_engine.ts'; await getBrowser(); await closeSharedBrowser(); console.log('RESULT ok');`;
      expect(await runSora(code, { CHROME_PATH: bin })).toBe('RESULT ok');
      const dumped = readFileSync(`${bin}.env`, 'utf8');
      expectStripped(dumped);
      expect(dumped.includes('Asia/Tokyo'), 'TZ').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// 出口のゲートウェイを使うとき（SORA_EGRESS_GATEWAY=on）、通信する子プロセスは、HTTP(S)_PROXY でゲートウェイを指す。
// 運用者の上流のプロキシ・ALL_PROXY・NO_PROXY は渡さない（NO_PROXY の宛先を、子が、ゲートウェイを通さず、直接つなぐのを防ぐ。上流と NO_PROXY は、ゲートウェイが受け持つ）。
describe('出口のゲートウェイを使うとき、通信する子プロセスの通信も、ゲートウェイに通る', () => {
  // 手元の（直接つなぐ）テスト用の環境には、プロキシ・NO_PROXY の事前設定がある（test_preload.ts）。ゲートウェイを使う設定では、静的取得の一覧（SORA_PROXY_LIST）は併用できない
  const gatewayEnv = { SORA_EGRESS_GATEWAY: 'on', SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'false', NO_PROXY: 'localhost,.internal', no_proxy: 'localhost,.internal', ALL_PROXY: 'socks5://127.0.0.1:9', all_proxy: 'socks5://127.0.0.1:9' };
  const unset = ['SORA_PROXY_LIST'];

  /** 子プロセスが受けた環境から、プロキシの変数を取り出す（`export -p` の出力。sh の種類で、引用符が違う） */
  function proxyVariables(dumped: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const match of dumped.matchAll(/\b((?:HTTPS?|ALL|NO)_PROXY|(?:https?|all|no)_proxy)=["']([^"'\n]*)["']/g)) found[match[1]] = match[2];
    return found;
  }

  function expectViaGateway(dumped: string): void {
    expectStripped(dumped);
    const variables = proxyVariables(dumped);
    const url = variables.HTTPS_PROXY ?? '';
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(variables).toEqual({ HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url });
  }

  test('yahoo-search-mcp', async () => {
    const { dir, script } = scratch();
    try {
      const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: JSON.stringify({ items: [] }) }] } });
      const bin = script(`cat > /dev/null\nprintf '%s\\n' '${response}'`);
      const code = `import { callYahooMcp } from './src/services/yahoo.ts'; const r = await callYahooMcp('web_search', { query: 'q' }); console.log('RESULT', r.content.length);`;
      expect(await runSora(code, { SORA_YAHOO_MCP_PATH: bin, ...gatewayEnv }, unset)).toBe('RESULT 1');
      expectViaGateway(readFileSync(`${bin}.env`, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('住所データの構築', async () => {
    const { dir, script } = scratch();
    try {
      const bin = script('exit 0');
      const code = `import { ChildProcessBuilder } from './src/services/address_builder.ts'; await new ChildProcessBuilder({ dir: '/x', command: () => [${JSON.stringify(bin)}] }).run({ kind: 'postal' }); console.log('RESULT ok');`;
      expect(await runSora(code, gatewayEnv, unset)).toBe('RESULT ok');
      expectViaGateway(readFileSync(`${bin}.env`, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('使わないとき（SORA_EGRESS_GATEWAY が未設定）は、これまでどおり、運用者のプロキシの変数が、そのまま渡る', async () => {
    const { dir, script } = scratch();
    try {
      const bin = script('exit 0');
      const code = `import { ChildProcessBuilder } from './src/services/address_builder.ts'; await new ChildProcessBuilder({ dir: '/x', command: () => [${JSON.stringify(bin)}] }).run({ kind: 'postal' }); console.log('RESULT ok');`;
      expect(await runSora(code, { HTTPS_PROXY: 'http://upstream.example:3128', NO_PROXY: 'localhost,.internal', SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'false' }, [...unset, 'SORA_EGRESS_GATEWAY'])).toBe('RESULT ok');
      const variables = proxyVariables(readFileSync(`${bin}.env`, 'utf8'));
      expect(variables.HTTPS_PROXY).toBe('http://upstream.example:3128');
      expect(variables.NO_PROXY).toBe('localhost,.internal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
