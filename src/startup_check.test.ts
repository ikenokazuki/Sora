import { describe, expect, test } from 'bun:test';
import { checkEnv, type Env } from './config.js';
import { checkStartupEnv } from './startup_check.js';

/** 起動時の検査を、出力・終了・ファイルの有無を差し替えて走らせる。 */
function run(env: Env, existing: readonly string[] = []) {
  const lines: string[] = [];
  const exits: number[] = [];
  const asked: string[] = [];
  checkStartupEnv({
    env,
    stderr: (line) => lines.push(line),
    exit: (code) => void exits.push(code),
    exists: (path) => {
      asked.push(path);
      return existing.includes(path);
    },
  });
  return { lines, exits, asked };
}

const PREFIX = '[Sora/Config]';

describe('checkStartupEnv', () => {
  test('a clean environment prints nothing and starts (Fail-Open: no SORA_API_KEY and no SORA_ALLOW_ANONYMOUS is fine)', () => {
    expect(run({})).toEqual({ lines: [], exits: [], asked: [] });
    expect(run({ PATH: '/usr/bin', HOME: '/home/user', NODE_ENV: 'production', PORT: '8000' })).toEqual({ lines: [], exits: [], asked: [] });
  });

  test('warnings are printed one per line and the start continues', () => {
    const { lines, exits } = run({ LOG_FORMAT: 'json', SORA_MODULE: 'web' });
    expect(exits).toEqual([]);
    expect(lines).toEqual(checkEnv({ LOG_FORMAT: 'json', SORA_MODULE: 'web' }).warnings.map((w) => `${PREFIX} 警告: ${w}`));
    expect(lines).toHaveLength(2);
  });

  test('errors are printed after the warnings, with a closing line, and exit(1) is called once', () => {
    const env = { PORT: 'abc', SORA_MODULES: 'weeb', LOG_FORMAT: 'json' };
    const { errors, warnings } = checkEnv(env);
    const { lines, exits } = run(env);
    expect(exits).toEqual([1]);
    expect(lines).toEqual([
      ...warnings.map((w) => `${PREFIX} 警告: ${w}`),
      ...errors.map((e) => `${PREFIX} エラー: ${e}`),
      `${PREFIX} 環境変数の誤りが 2 件あるので、起動しません`,
    ]);
    expect(lines).toContain(`${PREFIX} エラー: PORT の値（"abc"）は不正です。正しい形: 1〜65535 の整数`);
  });

  test('WEB_FETCHER_API_KEY alone refuses to start', () => {
    const { lines, exits } = run({ WEB_FETCHER_API_KEY: 'x' });
    expect(exits).toEqual([1]);
    expect(lines[0]).toStartWith(`${PREFIX} エラー: WEB_FETCHER_API_KEY は SORA_API_KEY に変わりました`);
  });

  test('a bundled program path that is set but missing warns and the start continues; an existing or unset path is quiet', () => {
    const yahoo = run({ SORA_YAHOO_MCP_PATH: ' /opt/missing/yahoo-search-mcp ' });
    expect(yahoo.exits).toEqual([]);
    expect(yahoo.asked).toEqual(['/opt/missing/yahoo-search-mcp']);
    expect(yahoo.lines).toEqual([`${PREFIX} 警告: SORA_YAHOO_MCP_PATH のファイル（"/opt/missing/yahoo-search-mcp"）がありません。同梱の Yahoo 検索を起動できません（パスを確かめてください）`]);

    const rs = run({ SORA_RS_TRAFILATURA_PATH: '/opt/missing/rs-trafilatura' });
    expect(rs.exits).toEqual([]);
    expect(rs.lines).toEqual([`${PREFIX} 警告: SORA_RS_TRAFILATURA_PATH のファイル（"/opt/missing/rs-trafilatura"）がありません。本文は Readability で取り出します（パスを確かめてください）`]);

    expect(run({ SORA_YAHOO_MCP_PATH: '/app/yahoo-search-mcp', SORA_RS_TRAFILATURA_PATH: '/usr/local/bin/rs-trafilatura' }, ['/app/yahoo-search-mcp', '/usr/local/bin/rs-trafilatura']))
      .toEqual({ lines: [], exits: [], asked: ['/app/yahoo-search-mcp', '/usr/local/bin/rs-trafilatura'] });
    expect(run({ SORA_YAHOO_MCP_PATH: '  ' }).asked).toEqual([]);
  });

  test('a missing path does not stop the start even next to an error (the error alone decides)', () => {
    const { lines, exits } = run({ SORA_RS_TRAFILATURA_PATH: '/opt/missing/rs', PORT: 'abc' });
    expect(exits).toEqual([1]);
    expect(lines[0]).toStartWith(`${PREFIX} 警告: SORA_RS_TRAFILATURA_PATH`);
    expect(lines.at(-1)).toBe(`${PREFIX} 環境変数の誤りが 1 件あるので、起動しません`);
  });

  test('secret values never appear in the output (only "設定済み、長さ N")', () => {
    const proxy = 'socks5h://user-7q:pw-7q@proxy-7q.example.test:1080';
    const { lines, exits } = run({ SORA_PROXY_URL: proxy, SORA_PROXY_LIST: `http://ok.example.test:3128,${proxy}`, SORA_TRACKING_UPS_CLIENT_ID: 'id-7q' });
    expect(exits).toEqual([1]);
    const output = lines.join('\n');
    for (const leak of ['user-7q', 'pw-7q', 'proxy-7q', 'id-7q', 'ok.example.test']) expect(output).not.toContain(leak);
    expect(output).toContain(`SORA_PROXY_URL の値（設定済み、長さ ${proxy.length}）`);
    expect(output).toContain('SORA_PROXY_LIST の値（設定済み、長さ');
  });
});

/**
 * 起動の検査が止めるもの（作業 2〜4 のあと、検査が入るまで黙って緩くなっていたもの）。
 * 1 つずつ: checkEnv がその変数のエラーを 1 つ出し、起動の検査が exit(1) にする。
 */
const REFUSED: Record<string, Env> = {
  'SORA_MODULES の未知の名前': { SORA_MODULES: 'weeb' },
  'SORA_MODULES の空白区切り': { SORA_MODULES: 'web youtube' },
  'SORA_MODULES のセミコロン区切り': { SORA_MODULES: 'web;trade' },
  'SORA_ALLOWED_HOSTS の scheme つきの要素': { SORA_ALLOWED_HOSTS: 'sora.example.com,https://sora.example.com' },
  'SORA_ALLOWED_ORIGINS の scheme の無い要素': { SORA_ALLOWED_ORIGINS: 'http://localhost:3016,localhost:5173' },
  'SORA_ALLOWED_ORIGINS のパスつきの要素': { SORA_ALLOWED_ORIGINS: 'http://localhost:3016/app' },
  'PORT の数でない値': { PORT: 'abc' },
  'PORT の範囲の外': { PORT: '70000' },
  'SORA_BROWSER_IDLE_TTL_MS の数でない値': { SORA_BROWSER_IDLE_TTL_MS: 'abc' },
  'SORA_ALERT_WEBHOOK_URL の URL でない値': { SORA_ALERT_WEBHOOK_URL: 'hooks.example.test/alert' },
  'SORA_PROXY_URL の host:port': { SORA_PROXY_URL: 'proxy.example.test:3128' },
  'SORA_PROXY_URL の socks5h': { SORA_PROXY_URL: 'socks5h://proxy.example.test:1080' },
  'SORA_PROXY_URL の socks4': { SORA_PROXY_URL: 'socks4://proxy.example.test:1080' },
  'SORA_PROXY_LIST の不正な要素': { SORA_PROXY_LIST: 'http://a.example.test:3128,proxy.example.test:3128' },
  'SORA_X_DETAIL_BASE_URL の URL でない値': { SORA_X_DETAIL_BASE_URL: 'fx.example.test' },
  'SORA_OPENPOI_BASE_URL の URL でない値': { SORA_OPENPOI_BASE_URL: 'poi.example.test' },
  'SORA_SEARCH_SCRAPE_DEADLINE_MS の 1e3': { SORA_SEARCH_SCRAPE_DEADLINE_MS: '1e3' },
  'SORA_SEARCH_SCRAPE_DEADLINE_MS の 1.5': { SORA_SEARCH_SCRAPE_DEADLINE_MS: '1.5' },
  'SORA_X_DETAIL_TIMEOUT_MS の 0': { SORA_X_DETAIL_TIMEOUT_MS: '0' },
  'SORA_X_DETAIL_TIMEOUT_MS の -5': { SORA_X_DETAIL_TIMEOUT_MS: '-5' },
  'SORA_X_DETAIL_TIMEOUT_MS の 100abc': { SORA_X_DETAIL_TIMEOUT_MS: '100abc' },
  'SORA_YAHOO_MIN_INTERVAL_MS の 250ms': { SORA_YAHOO_MIN_INTERVAL_MS: '250ms' },
  'SORA_YAHOO_BREAKER_COOLDOWN_MS の 250ms': { SORA_YAHOO_BREAKER_COOLDOWN_MS: '250ms' },
  'SORA_X_DETAIL_PROVIDER の disabled': { SORA_X_DETAIL_PROVIDER: 'disabled' },
  'SORA_HTS_CROSS_INDEX_URL だけ': { SORA_HTS_CROSS_INDEX_URL: 'https://index.example.test/cross.jsonl.gz' },
  'SORA_HTS_CROSS_INDEX_SHA256 だけ': { SORA_HTS_CROSS_INDEX_SHA256: 'a'.repeat(64) },
};

describe('what the start-up check refuses', () => {
  test.each(Object.entries(REFUSED))('%s', (_, env) => {
    const [name] = Object.keys(env);
    const { errors, warnings } = checkEnv(env);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${name} `);
    expect(warnings).toEqual([]);
    const { lines, exits } = run(env);
    expect(exits).toEqual([1]);
    expect(lines).toEqual([`${PREFIX} エラー: ${errors[0]}`, `${PREFIX} 環境変数の誤りが 1 件あるので、起動しません`]);
  });

  test('a blank SORA_API_KEY only warns (authentication is off) and the start continues', () => {
    for (const blank of ['', '   ']) {
      expect(run({ SORA_API_KEY: blank })).toEqual({ lines: [`${PREFIX} 警告: SORA_API_KEY が空です。未設定として扱い、認証は無効になります`], exits: [], asked: [] });
    }
  });

  test('a carrier ID without its secret (or the reverse) only warns', () => {
    for (const env of [{ SORA_TRACKING_UPS_CLIENT_ID: 'x' }, { SORA_TRACKING_FEDEX_CLIENT_SECRET: 'x' }]) {
      const { lines, exits } = run(env);
      expect(exits).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith(`${PREFIX} 警告: `);
    }
  });
});

/** 実際の起動（子プロセス）。環境は最小にし、親の設定を持ち込まない。止まらなければ時間切れで殺す。 */
async function start(args: string[], vars: Env) {
  const env: Env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', SORA_DB_PATH: ':memory:', ...vars };
  if (process.env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
  const proc = Bun.spawn(['bun', ...args], { cwd: `${import.meta.dir}/..`, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe('the entry points run the start-up check', () => {
  test('the HTTP server refuses WEB_FETCHER_API_KEY alone with exit 1, before listening', async () => {
    const { code, stdout, stderr } = await start(['src/index.ts'], { WEB_FETCHER_API_KEY: 'x' });
    expect(stderr).toContain(`${PREFIX} エラー: WEB_FETCHER_API_KEY は SORA_API_KEY に変わりました`);
    expect(code).toBe(1);
    expect(stdout).not.toContain('Starting Sora service');
  }, 30_000);

  test('the stdio server refuses PORT=abc with exit 1, and writes nothing to stdout (the JSON-RPC stream)', async () => {
    const { code, stdout, stderr } = await start(['src/stdio.ts'], { PORT: 'abc' });
    expect(stderr).toContain(`${PREFIX} エラー: PORT の値（"abc"）は不正です`);
    expect(stderr).not.toContain('Stdio server connected');
    expect(code).toBe(1);
    expect(stdout).toBe('');
  }, 30_000);

  test('importing index.ts (as the tests do) does not run the check', async () => {
    const { code, stdout, stderr } = await start(['-e', "await import('./src/index.ts'); console.log('imported'); process.exit(0);"], { PORT: 'abc' });
    expect(stderr).not.toContain(PREFIX);
    expect(stdout).toContain('imported');
    expect(code).toBe(0);
  }, 30_000);
});
