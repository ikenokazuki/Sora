import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnv, type Env } from './config.js';
import { getApiKeyStore, resetApiKeyStoreCache } from './security/api_keys.js';
import { checkStartupEnv } from './startup_check.js';

/** 起動時の検査を、出力・終了・ファイルの有無を差し替えて走らせる。 */
function run(env: Env, existing: readonly string[] = [], transport?: 'http' | 'stdio') {
  const lines: string[] = [];
  const exits: number[] = [];
  const asked: string[] = [];
  checkStartupEnv({
    env,
    transport,
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
    expect(yahoo.lines).toEqual([`${PREFIX} 警告: SORA_YAHOO_MCP_PATH のファイル（"/opt/missing/yahoo-search-mcp"）がありません。代わりに既定の場所（/usr/local/bin・リポジトリの bin・PATH）を探します（パスを確かめてください）`]);

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

  test('stdio does not check the generic names it cannot use (it listens on nothing and has no auth); HTTP still does', () => {
    const generic = { PORT: 'abc', API_KEY: 'x', WEB_FETCHER_API_KEY: 'x', DAILY_REQUEST_LIMIT: '5' };
    const copy = { ...generic };
    expect(run(generic, [], 'stdio')).toEqual({ lines: [], exits: [], asked: [] });
    expect(generic).toEqual(copy);
    const http = run(generic);
    expect(http.exits).toEqual([1]);
    expect(http.lines.filter((l) => l.startsWith(`${PREFIX} エラー: `))).toHaveLength(4);
    expect(run(generic, [], 'http')).toEqual(http);
  });

  test('stdio still checks everything else (SORA_* values, the other old names, pairs, paths)', () => {
    for (const env of [{ SORA_MODULES: 'weeb' }, { ENABLED_MODULES: 'web' }, { SORA_HTS_CROSS_INDEX_URL: 'https://index.example.test/cross.jsonl.gz' }, { PORT: 'abc', SORA_PROXY_URL: 'proxy.example.test:3128' }]) {
      const { lines, exits } = run(env, [], 'stdio');
      expect(exits, JSON.stringify(env)).toEqual([1]);
      expect(lines).toEqual(run(Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'PORT'))).lines);
    }
    expect(run({ LOG_FORMAT: 'json', SORA_RS_TRAFILATURA_PATH: '/opt/missing/rs' }, [], 'stdio').lines).toHaveLength(2);
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
 * 起動の検査が止めるもの（読み取りは黙って既定値に戻るが、起動のときだけは変数名と正しい形を示して止める）。
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
  const proc = Bun.spawn([process.execPath, '--no-env-file', ...args], { cwd: `${import.meta.dir}/..`, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
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

  test('the stdio server refuses SORA_MODULES=weeb with exit 1 (ignoring PORT and API_KEY), and writes nothing to stdout (the JSON-RPC stream)', async () => {
    const { code, stdout, stderr } = await start(['src/stdio.ts'], { SORA_MODULES: 'weeb', PORT: 'abc', API_KEY: 'x' });
    expect(stderr).toContain(`${PREFIX} エラー: SORA_MODULES の値（"weeb"）は不正です`);
    expect(stderr).toContain(`${PREFIX} 環境変数の誤りが 1 件あるので、起動しません`);
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

describe('出口のゲートウェイを使うとき（SORA_EGRESS_GATEWAY=on）、ほかの設定との食い違いは、起動のときに止める', () => {
  // 食い違いは、ゲートウェイを作るとき（最初の通信）にも分かるが、そのときは、すべての外向きの通信（Bun の fetch・子プロセスを含む）が失敗する。起動で分かるようにする
  test('SORA_PROXY_LIST（リクエストごとに替える一覧）とは、一緒に使えない', () => {
    const { lines, exits } = run({ SORA_EGRESS_GATEWAY: 'on', SORA_PROXY_LIST: 'http://proxy-a.example:8080,http://proxy-b.example:8080' });
    expect(exits).toEqual([1]);
    expect(lines.filter((line) => line.startsWith(`${PREFIX} エラー: SORA_PROXY_LIST（`))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('proxy-a.example'); // 値（運用者のプロキシ）は出さない
  });

  test('対応していない上流の方式（標準の HTTPS_PROXY の socks4）は、止める', () => {
    const { lines, exits } = run({ SORA_EGRESS_GATEWAY: 'on', HTTPS_PROXY: 'socks4://user:secret-value@proxy.example:1080' });
    expect(exits).toEqual([1]);
    expect(lines.filter((line) => line.startsWith(`${PREFIX} エラー: `) && line.includes('socks4'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('secret-value');
  });

  test('使わないとき（未設定・off）は、同じ設定でも、止めない（これまでどおり）', () => {
    for (const gateway of [{}, { SORA_EGRESS_GATEWAY: 'off' }]) {
      const { exits } = run({ ...gateway, SORA_PROXY_LIST: 'http://proxy-a.example:8080,http://proxy-b.example:8080', HTTPS_PROXY: 'socks4://proxy.example:1080' });
      expect(exits).toEqual([]);
    }
  });

  test('正しい設定（上流が 1 つの http プロキシ）は、止めず、何も出さない', () => {
    expect(run({ SORA_EGRESS_GATEWAY: 'on', SORA_PROXY_URL: 'http://proxy.example:8080', SORA_EGRESS_PORTS: '80,443,8443' })).toEqual({ lines: [], exits: [], asked: [] });
  });

  test('書き方の誤り（SORA_EGRESS_GATEWAY=onn）は、レジストリの検査の 1 件だけ（重ねて数えない）', () => {
    const { lines, exits } = run({ SORA_EGRESS_GATEWAY: 'onn' });
    expect(exits).toEqual([1]);
    expect(lines.filter((line) => line.includes('SORA_EGRESS_GATEWAY'))).toHaveLength(1);
  });
});

describe('出口のゲートウェイの許す宛先（SORA_EGRESS_ALLOW_HOSTS）は、起動のときに検査する', () => {
  test.each(['169.254.169.254:80', 'metadata.google.internal:80', '[fe80::1]:80'])('挙げても通さない宛先 %j は、止める', (entry) => {
    const { lines, exits } = run({ SORA_EGRESS_GATEWAY: 'on', SORA_EGRESS_ALLOW_HOSTS: entry });
    expect(exits).toEqual([1]);
    expect(lines.filter((line) => line.startsWith(`${PREFIX} エラー: SORA_EGRESS_ALLOW_HOSTS`))).toHaveLength(1);
  });

  test('使わないとき（off）は、挙げても通さない宛先でも、止めない（書き方の誤りだけは、レジストリが止める）', () => {
    expect(run({ SORA_EGRESS_ALLOW_HOSTS: '169.254.169.254:80' }).exits).toEqual([]);
    expect(run({ SORA_EGRESS_ALLOW_HOSTS: 'noport' }).exits).toEqual([1]);
  });

  // SORA_FETCH_ALLOW_PRIVATE_NETWORK=true のときも、ゲートウェイは使わない（isEgressGatewayEnabled が false）ので、同じ警告になる。
  // ただし、その警告は、プロセスで 1 回だけ出す作りで、egress.test.ts の確認と順序で食い合うので、ここでは試さない
  test('ゲートウェイを使わないとき（未設定・off）は、効かないことを、警告で知らせる（止めない）', () => {
    for (const gateway of [{}, { SORA_EGRESS_GATEWAY: 'off' }]) {
      const { lines, exits } = run({ ...gateway, SORA_EGRESS_ALLOW_HOSTS: 'fxembed.internal:3000' });
      expect(exits).toEqual([]);
      expect(lines.filter((line) => line.startsWith(`${PREFIX} 警告: SORA_EGRESS_ALLOW_HOSTS は、出口のゲートウェイが有効なときだけ効きます`))).toHaveLength(1);
    }
  });

  test('正しい宛先は、止めず、何も出さない', () => {
    expect(run({ SORA_EGRESS_GATEWAY: 'on', SORA_EGRESS_ALLOW_HOSTS: 'fxembed.internal:3000,10.0.0.5:8080,[fd00::5]:8443' })).toEqual({ lines: [], exits: [], asked: [] });
  });
});

describe('名前つきの複数の鍵（SORA_AUTH_KEYS_FILE）は、起動のときに読んで検査する', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sora-startup-keys-'));
    resetApiKeyStoreCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetApiKeyStoreCache();
  });
  const write = (content: string, mode = 0o600) => {
    const path = join(dir, 'keys.json');
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  };
  const keys = (...rows: unknown[]) => JSON.stringify({ keys: rows });
  const ALICE = { name: 'alice', key: 'alice-key-0123456789abcdef' };
  const errorLines = (lines: string[]) => lines.filter((line) => line.startsWith(`${PREFIX} エラー:`));

  test('正しいファイルは、止めず、何も出さない。読んだ鍵の表を、認証が使う（要求のたびに読み直さない）', () => {
    const path = write(keys(ALICE));
    expect(run({ SORA_AUTH_KEYS_FILE: path })).toEqual({ lines: [], exits: [], asked: [] });
    writeFileSync(path, keys({ name: 'bob', key: 'bob-key-0123456789abcdefgh' }));
    expect(getApiKeyStore({ SORA_AUTH_KEYS_FILE: path })?.lookup(ALICE.key)).toBe('alice');
  });

  test('ファイルが無い・読めない: 匿名にせず、起動を止める', () => {
    const path = join(dir, 'missing.json');
    const { lines, exits } = run({ SORA_AUTH_KEYS_FILE: path });
    expect(exits).toEqual([1]);
    expect(errorLines(lines)).toEqual([`${PREFIX} エラー: SORA_AUTH_KEYS_FILE: 鍵ファイル（${JSON.stringify(path)}）を読めません（ENOENT）。パスと権限を確かめてください`]);
    expect(lines.at(-1)).toBe(`${PREFIX} 環境変数の誤りが 1 件あるので、起動しません`);
  });

  test('中身の誤りは、すべてを出して止める。鍵の値は出さない', () => {
    const path = write(keys({ name: 'Alice', key: 'short-SECRET' }, { name: 'bob' }));
    const { lines, exits } = run({ SORA_AUTH_KEYS_FILE: path });
    expect(exits).toEqual([1]);
    expect(errorLines(lines)).toEqual([
      `${PREFIX} エラー: SORA_AUTH_KEYS_FILE: keys[0].name は、英小文字・数字・-・_ の 1〜64 字にしてください（先頭は英小文字か数字）`,
      `${PREFIX} エラー: SORA_AUTH_KEYS_FILE: keys[0].key は、16〜256 字の、空白を含まない ASCII の印字可能な文字にしてください`,
      `${PREFIX} エラー: SORA_AUTH_KEYS_FILE: keys[1] に key か keyHash が要ります（どちらか 1 つ）`,
    ]);
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  test('鍵が 1 つも無い・JSON でない: 止める（鍵が無い状態を、Fail-Open の匿名にしない）', () => {
    for (const content of [keys(), '', '{']) {
      const { exits, lines } = run({ SORA_AUTH_KEYS_FILE: write(content) });
      expect(exits, content).toEqual([1]);
      expect(errorLines(lines), content).toHaveLength(1);
      resetApiKeyStoreCache();
    }
  });

  test('SORA_API_KEY との併用は、止める（鍵ファイルの誤りも、あわせて知らせる）', () => {
    const { lines, exits } = run({ SORA_AUTH_KEYS_FILE: write(keys(ALICE)), SORA_API_KEY: 'single-key-0123456789' });
    expect(exits).toEqual([1]);
    expect(errorLines(lines)).toEqual([`${PREFIX} エラー: SORA_API_KEY と SORA_AUTH_KEYS_FILE は併用できません。鍵ファイルを使うときは SORA_API_KEY を消してください（鍵ファイルは、名前つきの複数の鍵を持ちます）`]);
    expect(lines.join('\n')).not.toContain('single-key');
    const both = run({ SORA_AUTH_KEYS_FILE: join(dir, 'missing.json'), SORA_API_KEY: 'single-key-0123456789' });
    expect(errorLines(both.lines)).toHaveLength(2);
  });

  test('平文の鍵のファイルを、所有者以外も読めるときは、警告して続ける', () => {
    const path = write(keys(ALICE), 0o644);
    const { lines, exits } = run({ SORA_AUTH_KEYS_FILE: path });
    expect(exits).toEqual([]);
    expect(lines).toEqual([`${PREFIX} 警告: SORA_AUTH_KEYS_FILE: 鍵ファイル（${JSON.stringify(path)}）に平文の鍵があり、所有者以外も読めます（権限 644）。chmod 600 にするか、keyHash で書いてください`]);
  });

  test('SORA_ALLOW_ANONYMOUS=true は効かないと警告する（止めない）', () => {
    const { lines, exits } = run({ SORA_AUTH_KEYS_FILE: write(keys(ALICE)), SORA_ALLOW_ANONYMOUS: 'true' });
    expect(exits).toEqual([]);
    expect(lines).toEqual([`${PREFIX} 警告: SORA_ALLOW_ANONYMOUS は、SORA_AUTH_KEYS_FILE があるとき効きません（鍵ファイルがあると、匿名は認めません）。この設定を消してください`]);
  });

  test('stdio は認証を通らないので、鍵ファイルを読まない（無くても止めない）', () => {
    expect(run({ SORA_AUTH_KEYS_FILE: join(dir, 'missing.json') }, [], 'stdio')).toEqual({ lines: [], exits: [], asked: [] });
  });
});
