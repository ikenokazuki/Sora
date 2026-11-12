import { describe, expect, test } from 'bun:test';
import {
  AREAS,
  checkEnv,
  envBool,
  envEnum,
  envError,
  envInt,
  envJson,
  envList,
  envPath,
  envRaw,
  envStr,
  envUrl,
  envWithoutSecrets,
  EXTERNAL,
  LEGACY,
  NOT_SETTINGS,
  renderEnvTable,
  type Setting,
  SETTINGS,
} from './config.js';
import { EXPLICIT_ONLY_MODULES as REGISTRY_EXPLICIT_ONLY } from './mcp/registry.js';
import { EXPLICIT_ONLY_MODULES, MODULE_NAMES } from './modules.js';
import { withEnv } from './test_fixtures/env.js';

const all = { ...SETTINGS, ...EXTERNAL } as Record<string, Setting>;

/** 拒否の 10 個（設計メモの「起動時の検査」(c)）と、新名に入れてよい値。 */
const REFUSED: Record<string, [string, string]> = {
  WEB_FETCHER_API_KEY: ['SORA_API_KEY', 'k'],
  API_KEY: ['SORA_API_KEY', 'k'],
  ENABLED_MODULES: ['SORA_MODULES', 'web'],
  DAILY_REQUEST_LIMIT: ['SORA_AUTH_DAILY_LIMIT', '10'],
  SORA_DEFER_TOOLS: ['SORA_MCP_DEFER_TOOLS', 'false'],
  SORA_DEFAULT_REFERER: ['SORA_FETCH_DEFAULT_REFERER', 'off'],
  FXTWITTER_API_BASE: ['SORA_X_DETAIL_BASE_URL', 'https://fx.example.test'],
  SORA_ADDRESS: ['SORA_ADDRESS_MODE', 'off'],
  SORA_CROSS_INDEX_URL: ['SORA_HTS_CROSS_INDEX_URL', 'https://example.test/cross.jsonl.gz'],
  SORA_CROSS_INDEX_SHA256: ['SORA_HTS_CROSS_INDEX_SHA256', 'a'.repeat(64)],
};

const REMOVED = ['SORA_YAHOO_THROTTLE', 'SORA_WEB_RETRY_WAIT_MS', 'SORA_WEB_NATIVE_RANKING', 'SORA_RRF_ENABLED', 'SORA_WEB_QUERY_UNION', 'SORA_X_SOURCE_ISOLATION', 'SORA_REALTIME_ANCHOR'];

/** 旧名だけのとき警告する、改名・統合の 23 個（設計メモの対応表から手で写した）。 */
const RENAMED_WARN: Record<string, string> = {
  ALLOW_LOCAL_NO_AUTH: 'SORA_AUTH_LOOPBACK_NO_KEY',
  TRUST_PROXY: 'SORA_AUTH_TRUST_PROXY',
  LOG_FORMAT: 'SORA_LOG_FORMAT',
  ADMIN_ALERT_WEBHOOK_URL: 'SORA_ALERT_WEBHOOK_URL',
  SORA_TOOL_OUTPUT_SCHEMA: 'SORA_MCP_OUTPUT_SCHEMA',
  MAX_CONCURRENT_BROWSERS: 'SORA_BROWSER_MAX_CONCURRENCY',
  BROWSER_IDLE_TTL_MS: 'SORA_BROWSER_IDLE_TTL_MS',
  ALLOW_BROWSER_EVALUATE: 'SORA_BROWSER_ALLOW_EVALUATE',
  ALLOW_LOCAL_FETCH: 'SORA_FETCH_ALLOW_PRIVATE_NETWORK',
  RS_TRAFILATURA_PATH: 'SORA_RS_TRAFILATURA_PATH',
  YAHOO_MCP_PATH: 'SORA_YAHOO_MCP_PATH',
  SORA_SCRAPE_DEADLINE_MS: 'SORA_SEARCH_SCRAPE_DEADLINE_MS',
  FXTWITTER_TIMEOUT_MS: 'SORA_X_DETAIL_TIMEOUT_MS',
  CROSS_SOURCE: 'SORA_HTS_CROSS_SOURCE',
  UPS_CLIENT_ID: 'SORA_TRACKING_UPS_CLIENT_ID',
  UPS_CLIENT_SECRET: 'SORA_TRACKING_UPS_CLIENT_SECRET',
  FEDEX_API_KEY: 'SORA_TRACKING_FEDEX_CLIENT_ID',
  FEDEX_CLIENT_ID: 'SORA_TRACKING_FEDEX_CLIENT_ID',
  FEDEX_API_SECRET: 'SORA_TRACKING_FEDEX_CLIENT_SECRET',
  FEDEX_CLIENT_SECRET: 'SORA_TRACKING_FEDEX_CLIENT_SECRET',
  DHL_EXPRESS_API_KEY: 'SORA_TRACKING_DHL_API_KEY',
  DHL_API_KEY: 'SORA_TRACKING_DHL_API_KEY',
  SORA_BLUESKY_DIDS: 'SORA_INTEL_BLUESKY_DIDS',
};

/** 秘密の 12 個（値を表示しない。Chromium などの子プロセスに渡さない）。 */
const SECRETS = [
  'SORA_API_KEY', 'SORA_ALERT_WEBHOOK_URL', 'SORA_PROXY_URL', 'SORA_PROXY_LIST', 'SORA_GCC_CERTIFIER', 'SORA_GCC_CUSTODIAN',
  'SORA_TRACKING_PAGE_SECRET', 'SORA_TRACKING_UPS_CLIENT_ID', 'SORA_TRACKING_UPS_CLIENT_SECRET',
  'SORA_TRACKING_FEDEX_CLIENT_ID', 'SORA_TRACKING_FEDEX_CLIENT_SECRET', 'SORA_TRACKING_DHL_API_KEY',
];

/** 整数の設定の全部: [最小, 最大, 既定, 頭打ち]（設計メモの対応表とコードから手で写した）。頭打ちを超える値は不正でなく、頭打ちの値に読む。 */
const INTS: Record<string, [number, number | undefined, number | undefined, number?]> = {
  PORT: [1, 65_535, 8000],
  SORA_AUTH_DAILY_LIMIT: [1, undefined, undefined],
  SORA_MCP_MAX_SESSIONS: [1, undefined, 100],
  SORA_BROWSER_MAX_CONCURRENCY: [1, undefined, undefined, 50],
  SORA_BROWSER_IDLE_TTL_MS: [0, undefined, 300_000],
  SORA_FETCH_MAX_CHROME_PROFILE: [136, 999, 149],
  SORA_SEARCH_SCRAPE_DEADLINE_MS: [0, undefined, 0],
  SORA_YAHOO_MIN_INTERVAL_MS: [0, undefined, 500],
  SORA_YAHOO_BREAKER_COOLDOWN_MS: [0, undefined, 120_000],
  SORA_X_DETAIL_TIMEOUT_MS: [1, undefined, 1500],
  SORA_ADDRESS_MAX_MB: [64, 1_048_576, 2048],
  SORA_ADDRESS_WAIT_MS: [1000, 120_000, 20_000],
  SORA_ADDRESS_BUILD_CONCURRENCY: [1, 4, 1],
};

/** 既定で有効な真偽値（ほかの真偽値は既定で無効）。 */
const BOOLS_ON_BY_DEFAULT = ['SORA_MCP_DEFER_TOOLS', 'SORA_FETCH_DEFAULT_REFERER', 'SORA_X_DETAIL_PROVIDER', 'SORA_INTEL_SCRAPE', 'SORA_INTEL_WEB_SEARCH'];

/** 組で設定する名前と、その相手の正しい値（片方だけだと checkEnv が組の検査で知らせる）。ほかのことを確かめるテストは、相手も入れる。 */
const PARTNER: Record<string, [string, string]> = {
  SORA_HTS_CROSS_INDEX_URL: ['SORA_HTS_CROSS_INDEX_SHA256', 'a'.repeat(64)],
  SORA_HTS_CROSS_INDEX_SHA256: ['SORA_HTS_CROSS_INDEX_URL', 'https://index.example.test/cross.jsonl.gz'],
  SORA_TRACKING_UPS_CLIENT_ID: ['SORA_TRACKING_UPS_CLIENT_SECRET', 'x'],
  SORA_TRACKING_UPS_CLIENT_SECRET: ['SORA_TRACKING_UPS_CLIENT_ID', 'x'],
  SORA_TRACKING_FEDEX_CLIENT_ID: ['SORA_TRACKING_FEDEX_CLIENT_SECRET', 'x'],
  SORA_TRACKING_FEDEX_CLIENT_SECRET: ['SORA_TRACKING_FEDEX_CLIENT_ID', 'x'],
};
const partnerOf = (name: string): Record<string, string> => (PARTNER[name] ? { [PARTNER[name][0]]: PARTNER[name][1] } : {});

/** 3 回計って、いちばん速い値（ミリ秒）。負荷で 1 回が遅れても、線形かどうかの判定が揺れないようにする */
function fastestOf3(fn: () => unknown): number {
  return Math.min(...Array.from({ length: 3 }, () => {
    const started = performance.now();
    fn();
    return performance.now() - started;
  }));
}

describe('registry', () => {
  test('counts match the design (53 + 3 settings, 13 standard names, 40 old names)', () => {
    expect(Object.keys(SETTINGS)).toHaveLength(56);
    expect(Object.keys(EXTERNAL)).toHaveLength(13);
    expect(Object.keys(LEGACY)).toHaveLength(40);
    expect(Object.keys(LEGACY).filter((n) => LEGACY[n].policy === 'error').sort()).toEqual(Object.keys(REFUSED).sort());
    expect(Object.keys(LEGACY).filter((n) => !LEGACY[n].to).sort()).toEqual([...REMOVED].sort());
    for (const [old, [to]] of Object.entries(REFUSED)) expect(LEGACY[old].to).toBe(to as never);
  });

  test('every old name maps to its hand-written replacement and policy (40 rows)', () => {
    expect(LEGACY as unknown).toEqual({
      ...Object.fromEntries(Object.entries(REFUSED).map(([old, [to]]) => [old, { to, policy: 'error' }])),
      ...Object.fromEntries(Object.entries(RENAMED_WARN).map(([old, to]) => [old, { to, policy: 'warn' }])),
      ...Object.fromEntries(REMOVED.map((old) => [old, { policy: 'warn' }])),
    });
  });

  test('exactly the 12 hand-listed settings are secret (no standard name is)', () => {
    expect(Object.entries(all).filter(([, s]) => s.secret).map(([name]) => name).sort()).toEqual([...SECRETS].sort());
  });

  test('every integer setting has the hand-written minimum, maximum and default', () => {
    expect(Object.entries(all).filter(([, s]) => s.kind === 'int').map(([name]) => name).sort()).toEqual(Object.keys(INTS).sort());
    for (const [name, [min, max, fallback, cap]] of Object.entries(INTS)) {
      const read = (raw?: string) => envInt(name as 'PORT', { [name]: raw });
      expect(read(), name).toBe(fallback as number);
      expect(read(String(min)), name).toBe(min);
      if (min > 0) expect(read(String(min - 1)), name).toBe(fallback as number);
      if (max !== undefined) {
        expect(read(String(max)), name).toBe(max);
        expect(read(String(max + 1)), name).toBe(fallback as number);
      }
      if (cap !== undefined) {
        expect(read(String(cap)), name).toBe(cap);
        expect(read(String(cap + 1)), name).toBe(cap);
        expect(checkEnv({ [name]: String(cap * 2) }).errors, name).toEqual([]);
      }
    }
  });

  test('boolean defaults: only the hand-listed ones are on', () => {
    const bools = Object.entries(all).filter(([, s]) => s.kind === 'bool');
    expect(bools.filter(([, s]) => s.default === true).map(([name]) => name).sort()).toEqual([...BOOLS_ON_BY_DEFAULT].sort());
    for (const [name] of bools) expect(envBool(name as 'SORA_MCP_DEFER_TOOLS', {}), name).toBe(BOOLS_ON_BY_DEFAULT.includes(name));
  });

  test('every default reads back as itself when written as the value', () => {
    for (const [name, s] of Object.entries(all)) {
      if (s.default === undefined) continue;
      const raw = Array.isArray(s.default) ? s.default.join(',') : String(s.default);
      const env = { [name]: raw };
      const readers: Record<Setting['kind'], (name: never, env: Record<string, string>) => unknown> = { bool: envBool, int: envInt, enum: envEnum, list: envList, url: envUrl, path: envPath, str: envStr, json: envJson };
      const value = readers[s.kind](name as never, env);
      expect(value, name).toEqual(s.default);
      expect(checkEnv(env).errors, name).toEqual([]);
    }
  });

  test('a default list is returned as a copy', () => {
    const first = envList('SORA_MODULES', {});
    first.push('web');
    expect(envList('SORA_MODULES', {})).toEqual(['all']);
    expect(SETTINGS.SORA_MODULES.default).toEqual(['all']);
  });

  test('the three settings added after the design are registered', () => {
    expect(SETTINGS.SORA_BROWSER_LOW_MEMORY).toMatchObject({ area: 'browser', kind: 'bool', default: false });
    expect(SETTINGS.SORA_FETCH_TRUST_STORE).toMatchObject({ area: 'fetch', kind: 'enum', values: ['combined', 'mozilla', 'defaultPaths'] });
    expect(SETTINGS.SORA_FETCH_MAX_CHROME_PROFILE).toMatchObject({ area: 'fetch', kind: 'int', default: 149, min: 136 });
  });

  test('names follow the naming rules and do not collide', () => {
    const core = ['SORA_API_KEY', 'SORA_ALLOW_ANONYMOUS', 'SORA_MODULES', 'SORA_DB_PATH', 'SORA_PUBLIC_URL', 'SORA_ALLOWED_HOSTS', 'SORA_ALLOWED_ORIGINS'];
    for (const [name, s] of Object.entries(SETTINGS as Record<string, Setting>)) {
      expect(name.startsWith('SORA_')).toBe(true);
      if (s.area === 'core') expect(core).toContain(name);
    }
    const names = [...Object.keys(SETTINGS), ...Object.keys(EXTERNAL), ...Object.keys(LEGACY), ...NOT_SETTINGS];
    expect(new Set(names).size).toBe(names.length);
  });

  test('every entry is complete: one-line doc, kind details, form text where it cannot be derived', () => {
    for (const [name, s] of Object.entries(all)) {
      expect(Object.keys(AREAS)).toContain(s.area);
      expect(s.doc.length > 10 && !s.doc.includes('\n')).toBe(true);
      if (s.kind === 'enum') expect(s.values?.length).toBeGreaterThan(1);
      if (s.kind === 'list') expect(typeof s.item).toBe('function');
      if (s.kind === 'json') expect(typeof s.shape).toBe('function');
      if (s.kind === 'list' || s.kind === 'json' || s.pattern) expect(s.form, name).toBeString();
      if (s.legacy) expect(s.legacyOnly, name).toBeDefined();
    }
  });

  test('readers are typed by kind (checked by typecheck)', () => {
    const port: number = envInt('PORT', {});
    const mode: 'lazy' | 'eager' | 'off' = envEnum('SORA_ADDRESS_MODE', {});
    const limit: number | undefined = envInt('SORA_AUTH_DAILY_LIMIT', {});
    const typeOnly = () => {
      // @ts-expect-error SORA_MODULES is a list, not a boolean
      envBool('SORA_MODULES', {});
      // @ts-expect-error old names are not readable
      envStr('API_KEY', {});
    };
    expect(typeof typeOnly).toBe('function');
    expect([port, mode, limit]).toEqual([8000, 'lazy', undefined]);
  });

  test('an unregistered name is a programming error with a clear message', () => {
    expect(() => envStr('NOT_A_SETTING' as never, {})).toThrow('Unknown setting: NOT_A_SETTING');
    expect(() => envBool('constructor' as never, {})).toThrow('Unknown setting: constructor');
    expect(() => envList('API_KEY' as never, {})).toThrow('Unknown setting: API_KEY');
  });

  test('odd environment objects (non-string values) are read as unset and never throw', () => {
    const odd = { PORT: 8080, SORA_MODULES: null, SORA_MCP_DEFER_TOOLS: false, SORA_TYPO: 1, LOG_FORMAT: ['json'] } as unknown as Record<string, string>;
    expect(envInt('PORT', odd)).toBe(8000);
    expect(envList('SORA_MODULES', odd)).toEqual(['all']);
    expect(envBool('SORA_MCP_DEFER_TOOLS', odd)).toBe(true);
    expect(checkEnv(odd)).toEqual({ errors: [], warnings: [] });
  });

  test('modules.ts is the list the MCP registry uses', () => {
    expect(REGISTRY_EXPLICIT_ONLY).toBe(EXPLICIT_ONLY_MODULES);
    expect(MODULE_NAMES).toContain('hts-archive');
    for (const m of EXPLICIT_ONLY_MODULES) expect(MODULE_NAMES).toContain(m);
  });
});

describe('envBool', () => {
  const name = 'SORA_BROWSER_LOW_MEMORY';
  test.each([
    ['true', true], ['TRUE', true], [' True ', true], ['1', true], ['on', true], ['ON', true], ['yes', true], ['Yes', true],
    ['false', false], ['FALSE', false], ['0', false], ['off', false], ['Off', false], ['no', false], [' no ', false],
  ])('%p -> %p', (raw, expected) => {
    expect(envBool(name, { [name]: raw })).toBe(expected);
  });

  test('unset, empty, whitespace-only and invalid values give the default without throwing', () => {
    for (const raw of [undefined, '', '   ', 'enabled', 'tru', '2', 'y']) {
      expect(envBool(name, { [name]: raw })).toBe(false);
      expect(envBool('SORA_MCP_DEFER_TOOLS', { SORA_MCP_DEFER_TOOLS: raw })).toBe(true);
    }
  });

  test('a default-true setting is turned off by any false spelling', () => {
    for (const raw of ['false', '0', 'off', 'no']) expect(envBool('SORA_MCP_DEFER_TOOLS', { SORA_MCP_DEFER_TOOLS: raw })).toBe(false);
  });

  test('reads the environment on every call (process.env by default)', () => {
    const before = process.env.SORA_BROWSER_LOW_MEMORY;
    try {
      process.env.SORA_BROWSER_LOW_MEMORY = 'yes';
      expect(envBool(name)).toBe(true);
      process.env.SORA_BROWSER_LOW_MEMORY = 'no';
      expect(envBool(name)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.SORA_BROWSER_LOW_MEMORY;
      else process.env.SORA_BROWSER_LOW_MEMORY = before;
    }
  });
});

describe('envInt', () => {
  test('plain decimal digits, trimmed', () => {
    expect(envInt('SORA_MCP_MAX_SESSIONS', { SORA_MCP_MAX_SESSIONS: '20' })).toBe(20);
    expect(envInt('SORA_MCP_MAX_SESSIONS', { SORA_MCP_MAX_SESSIONS: ' 7 ' })).toBe(7);
    expect(envInt('PORT', { PORT: '3016' })).toBe(3016);
  });

  test.each(['5m', '1e3', '0x10', '-1', '1.5', '+3', 'abc', '1 000', '１２'])('%p is invalid -> default', (raw) => {
    expect(envInt('SORA_MCP_MAX_SESSIONS', { SORA_MCP_MAX_SESSIONS: raw })).toBe(100);
    expect(envInt('SORA_AUTH_DAILY_LIMIT', { SORA_AUTH_DAILY_LIMIT: raw })).toBeUndefined();
  });

  test('per-variable min and max', () => {
    expect(envInt('SORA_AUTH_DAILY_LIMIT', { SORA_AUTH_DAILY_LIMIT: '0' })).toBeUndefined();
    expect(envInt('SORA_AUTH_DAILY_LIMIT', { SORA_AUTH_DAILY_LIMIT: '1' })).toBe(1);
    expect(envInt('SORA_BROWSER_IDLE_TTL_MS', { SORA_BROWSER_IDLE_TTL_MS: '0' })).toBe(0);
    expect(envInt('SORA_BROWSER_IDLE_TTL_MS', { SORA_BROWSER_IDLE_TTL_MS: 'abc' })).toBe(300_000);
    expect(envInt('SORA_BROWSER_MAX_CONCURRENCY', { SORA_BROWSER_MAX_CONCURRENCY: '50' })).toBe(50);
    expect(envInt('SORA_BROWSER_MAX_CONCURRENCY', { SORA_BROWSER_MAX_CONCURRENCY: '60' })).toBe(50);
    expect(envInt('SORA_BROWSER_MAX_CONCURRENCY', { SORA_BROWSER_MAX_CONCURRENCY: '80' })).toBe(50);
    // 桁の多い値も、不正にせず cap に丸める（安全な整数の範囲を超えても）
    expect(envInt('SORA_BROWSER_MAX_CONCURRENCY', { SORA_BROWSER_MAX_CONCURRENCY: '9'.repeat(20) })).toBe(50);
    expect(envError('SORA_BROWSER_MAX_CONCURRENCY', { SORA_BROWSER_MAX_CONCURRENCY: '9'.repeat(20) })).toBeUndefined();
    for (const raw of ['0', 'abc', '5m']) expect(envInt('SORA_BROWSER_MAX_CONCURRENCY', { SORA_BROWSER_MAX_CONCURRENCY: raw })).toBeUndefined();
    expect(envInt('SORA_ADDRESS_BUILD_CONCURRENCY', { SORA_ADDRESS_BUILD_CONCURRENCY: '99' })).toBe(1);
    expect(envInt('PORT', { PORT: '0' })).toBe(8000);
    expect(envInt('PORT', { PORT: '65536' })).toBe(8000);
  });

  test('SORA_FETCH_MAX_CHROME_PROFILE is exactly three digits and at least 136', () => {
    const read = (raw: string) => envInt('SORA_FETCH_MAX_CHROME_PROFILE', { SORA_FETCH_MAX_CHROME_PROFILE: raw });
    expect(read('154')).toBe(154);
    expect(read('136')).toBe(136);
    expect(read('135')).toBe(149);
    expect(read('0150')).toBe(149);
    expect(read('1000')).toBe(149);
    expect(read('0x9a')).toBe(149);
    expect(envInt('SORA_FETCH_MAX_CHROME_PROFILE', {})).toBe(149);
  });
});

describe('envEnum', () => {
  test('trimmed, case-insensitive, returns the registered spelling', () => {
    expect(envEnum('SORA_LOG_FORMAT', { SORA_LOG_FORMAT: ' JSON ' })).toBe('json');
    expect(envEnum('SORA_ADDRESS_MODE', { SORA_ADDRESS_MODE: 'Eager' })).toBe('eager');
    expect(envEnum('SORA_FETCH_TRUST_STORE', { SORA_FETCH_TRUST_STORE: 'defaultpaths' })).toBe('defaultPaths');
  });

  test('unknown values give the default (or undefined)', () => {
    expect(envEnum('SORA_LOG_FORMAT', { SORA_LOG_FORMAT: 'yaml' })).toBe('text');
    expect(envEnum('SORA_ADDRESS_MODE', { SORA_ADDRESS_MODE: 'sometimes' })).toBe('lazy');
    expect(envEnum('SORA_HTS_CROSS_SOURCE', {})).toBe('local');
    expect(envEnum('SORA_FETCH_TRUST_STORE', { SORA_FETCH_TRUST_STORE: 'system' })).toBeUndefined();
    expect(envEnum('SORA_FETCH_TRUST_STORE', { SORA_FETCH_TRUST_STORE: '  ' })).toBeUndefined();
  });
});

describe('envList', () => {
  test('splits by comma, trims, drops empty elements and duplicates', () => {
    expect(envList('SORA_MODULES', { SORA_MODULES: ' web, ,browser,,web ' })).toEqual(['web', 'browser']);
    expect(envList('SORA_INTEL_DISABLED', { SORA_INTEL_DISABLED: 'usgs, eonet,,bluesky' })).toEqual(['usgs', 'eonet', 'bluesky']);
  });

  test('SORA_MODULES: default all, case-insensitive, `*` means all, unknown names are invalid', () => {
    expect(envList('SORA_MODULES', {})).toEqual(['all']);
    expect(envList('SORA_MODULES', { SORA_MODULES: ' All , Lyrics ' })).toEqual(['all', 'lyrics']);
    expect(envList('SORA_MODULES', { SORA_MODULES: '*' })).toEqual(['all']);
    expect(envList('SORA_MODULES', { SORA_MODULES: 'hts-archive' })).toEqual(['hts-archive']);
    expect(envList('SORA_MODULES', { SORA_MODULES: 'web,weeb' })).toEqual(['web']);
    expect(envList('SORA_MODULES', { SORA_MODULES: 'weeb' })).toEqual(['all']);
    expect(envList('SORA_MODULES', { SORA_MODULES: ',,' })).toEqual(['all']);
  });

  test('a per-call read keeps the valid elements; with none valid it gives the default (startup still rejects the value)', () => {
    expect(envList('SORA_ADDRESS_PRELOAD', { SORA_ADDRESS_PRELOAD: '13,abc,14' })).toEqual(['13', '14']);
    expect(envList('SORA_ALLOWED_HOSTS', { SORA_ALLOWED_HOSTS: 'sora.example.com,https://bad.example.com' })).toEqual(['sora.example.com']);
    expect(envList('SORA_INTEL_DISABLED', { SORA_INTEL_DISABLED: 'usgs,USGS' })).toEqual(['usgs']);
    expect(checkEnv({ SORA_MODULES: 'web,weeb' }).errors).toHaveLength(1);
    expect(checkEnv({ SORA_ADDRESS_PRELOAD: '13,abc,14' }).errors).toHaveLength(1);
  });

  test('long lists are de-duplicated in linear time', () => {
    // 2 乗の重複除去（includes）では約 1.4 秒かかる大きさ。線形なら数ミリ秒
    const ids = Array.from({ length: 20_000 }, (_, i) => `p${i}`);
    const raw = [...ids, ...ids].join(',');
    expect(envList('SORA_INTEL_DISABLED', { SORA_INTEL_DISABLED: raw })).toHaveLength(20_000);
    expect(fastestOf3(() => envList('SORA_INTEL_DISABLED', { SORA_INTEL_DISABLED: raw }))).toBeLessThan(300);
  });

  test('`all` is accepted only where the setting allows it', () => {
    expect(envList('SORA_ADDRESS_PRELOAD', { SORA_ADDRESS_PRELOAD: 'ALL' })).toEqual(['all']);
    expect(envList('SORA_INTEL_DISABLED', { SORA_INTEL_DISABLED: 'all' })).toEqual([]);
    expect(envList('SORA_ALLOWED_HOSTS', { SORA_ALLOWED_HOSTS: 'all' })).toEqual([]);
  });

  test('elements are checked by their type', () => {
    expect(envList('SORA_ADDRESS_PRELOAD', { SORA_ADDRESS_PRELOAD: '13, 27,1' })).toEqual(['13', '27', '01']);
    expect(envList('SORA_ADDRESS_PRELOAD', { SORA_ADDRESS_PRELOAD: 'tokyo' })).toEqual([]);
    expect(envList('SORA_ADDRESS_PRELOAD', { SORA_ADDRESS_PRELOAD: '48' })).toEqual([]);
    expect(envList('SORA_ALLOWED_HOSTS', { SORA_ALLOWED_HOSTS: 'Sora.Example.com,localhost:3016,[::1]:8000' })).toEqual(['sora.example.com', 'localhost:3016', '[::1]:8000']);
    expect(envList('SORA_ALLOWED_HOSTS', { SORA_ALLOWED_HOSTS: 'https://sora.example.com' })).toEqual([]);
    expect(envList('SORA_ALLOWED_HOSTS', { SORA_ALLOWED_HOSTS: 'host:abc' })).toEqual([]);
    expect(envList('SORA_ALLOWED_ORIGINS', { SORA_ALLOWED_ORIGINS: 'http://localhost:3016, https://sora.example.com/' })).toEqual(['http://localhost:3016', 'https://sora.example.com']);
    expect(envList('SORA_ALLOWED_ORIGINS', { SORA_ALLOWED_ORIGINS: 'https://sora.example.com/app' })).toEqual([]);
    expect(envList('SORA_ALLOWED_ORIGINS', { SORA_ALLOWED_ORIGINS: 'null' })).toEqual([]);
    expect(envList('SORA_PROXY_LIST', { SORA_PROXY_LIST: 'http://a.example.test:8080,socks5://b.example.test:1080' })).toEqual(['http://a.example.test:8080', 'socks5://b.example.test:1080']);
    expect(envList('SORA_PROXY_LIST', { SORA_PROXY_LIST: 'ftp://a.example.test' })).toEqual([]);
    expect(envList('SORA_INTEL_BLUESKY_DIDS', { SORA_INTEL_BLUESKY_DIDS: 'did:plc:abc123, did:web:example.com' })).toEqual(['did:plc:abc123', 'did:web:example.com']);
    expect(envList('SORA_INTEL_BLUESKY_DIDS', { SORA_INTEL_BLUESKY_DIDS: '@someone.bsky.social' })).toEqual([]);
  });
});

describe('envUrl', () => {
  test('parsable by new URL, scheme per variable, trailing slash removed', () => {
    expect(envUrl('SORA_PUBLIC_URL', { SORA_PUBLIC_URL: ' https://sora.example.com/ ' })).toBe('https://sora.example.com');
    expect(envUrl('SORA_X_DETAIL_BASE_URL', { SORA_X_DETAIL_BASE_URL: 'http://fxembed.internal.test:8080//' })).toBe('http://fxembed.internal.test:8080');
    expect(envUrl('SORA_PROXY_URL', { SORA_PROXY_URL: 'socks5://proxy.example.test:1080' })).toBe('socks5://proxy.example.test:1080');
    expect(envUrl('SORA_HTS_CROSS_INDEX_URL', { SORA_HTS_CROSS_INDEX_URL: 'file:///srv/cross.jsonl.gz' })).toBe('file:///srv/cross.jsonl.gz');
  });

  test('trailing slashes are removed in linear time (no backtracking regex)', () => {
    // /\/+$/ では約 1.2 秒かかる大きさ（斜線の並びのあとに別の文字）。線形なら数ミリ秒
    const path = `https://sora.example.com${'/'.repeat(40_000)}x`;
    expect(envUrl('SORA_PUBLIC_URL', { SORA_PUBLIC_URL: path })).toBe(path);
    expect(fastestOf3(() => envUrl('SORA_PUBLIC_URL', { SORA_PUBLIC_URL: path }))).toBeLessThan(300);
    expect(envUrl('SORA_PUBLIC_URL', { SORA_PUBLIC_URL: `https://sora.example.com${'/'.repeat(40_000)}` })).toBe('https://sora.example.com');
  });

  test('full endpoint URLs (alert webhook, cross index) are trimmed and checked, trailing slash kept', () => {
    // 末尾の / の有無で別の URL として扱う受け手がある（/ の無い形に 301 を返すと、redirect: error では送れない）
    expect(envUrl('SORA_ALERT_WEBHOOK_URL', { SORA_ALERT_WEBHOOK_URL: ' https://hooks.example.com/catch/123/abc/ ' })).toBe('https://hooks.example.com/catch/123/abc/');
    expect(envUrl('SORA_ALERT_WEBHOOK_URL', { SORA_ALERT_WEBHOOK_URL: 'https://hooks.example.com/a//' })).toBe('https://hooks.example.com/a//');
    expect(envUrl('SORA_ALERT_WEBHOOK_URL', { SORA_ALERT_WEBHOOK_URL: 'https://hooks.example.com/a?next=/b/' })).toBe('https://hooks.example.com/a?next=/b/');
    expect(envUrl('SORA_ALERT_WEBHOOK_URL', { SORA_ALERT_WEBHOOK_URL: 'https://hooks.example.com/a' })).toBe('https://hooks.example.com/a');
    expect(envUrl('SORA_ALERT_WEBHOOK_URL', { SORA_ALERT_WEBHOOK_URL: 'ftp://hooks.example.com/a/' })).toBeUndefined();
    // 判例の索引の URL も、そのまま取りに行く宛先
    expect(envUrl('SORA_HTS_CROSS_INDEX_URL', { SORA_HTS_CROSS_INDEX_URL: ' https://index.example.test/cross/ ' })).toBe('https://index.example.test/cross/');
    expect(envUrl('SORA_HTS_CROSS_INDEX_URL', { SORA_HTS_CROSS_INDEX_URL: 'file:///srv/index/cross.jsonl.gz' })).toBe('file:///srv/index/cross.jsonl.gz');
    // 基底の URL は今までどおり外す
    expect(envUrl('SORA_PUBLIC_URL', { SORA_PUBLIC_URL: 'https://sora.example.com/base/' })).toBe('https://sora.example.com/base');
    expect(envUrl('SORA_OPENPOI_BASE_URL', { SORA_OPENPOI_BASE_URL: 'https://poi.example.test/' })).toBe('https://poi.example.test');
  });

  test('invalid URLs and schemes give the default (or undefined)', () => {
    expect(envUrl('SORA_X_DETAIL_BASE_URL', {})).toBe('https://api.fxtwitter.com');
    expect(envUrl('SORA_X_DETAIL_BASE_URL', { SORA_X_DETAIL_BASE_URL: 'fxembed.internal.test' })).toBe('https://api.fxtwitter.com');
    expect(envUrl('SORA_OPENPOI_BASE_URL', { SORA_OPENPOI_BASE_URL: 'ftp://poi.example.test' })).toBe('https://api.openpoiapi.com');
    expect(envUrl('SORA_PUBLIC_URL', { SORA_PUBLIC_URL: 'file:///tmp' })).toBeUndefined();
    expect(envUrl('SORA_PROXY_URL', { SORA_PROXY_URL: 'socks5:proxy' })).toBeUndefined();
    expect(envUrl('SORA_HTS_CROSS_INDEX_URL', { SORA_HTS_CROSS_INDEX_URL: 'http://example.test/cross.jsonl.gz' })).toBeUndefined();
    expect(envUrl('SORA_ALERT_WEBHOOK_URL', { SORA_ALERT_WEBHOOK_URL: 'not a url' })).toBeUndefined();
  });
});

describe('envPath and envStr', () => {
  test('paths are trimmed', () => {
    expect(envPath('SORA_DB_PATH', { SORA_DB_PATH: ' /data/sora.db ' })).toBe('/data/sora.db');
    expect(envPath('SORA_DB_PATH', { SORA_DB_PATH: '   ' })).toBeUndefined();
    expect(envPath('CHROME_PATH', { CHROME_PATH: '/usr/bin/chromium' })).toBe('/usr/bin/chromium');
  });

  test('strings are returned as they are; whitespace-only is unset', () => {
    expect(envStr('SORA_API_KEY', { SORA_API_KEY: 'secret-key' })).toBe('secret-key');
    expect(envStr('SORA_API_KEY', { SORA_API_KEY: '  ' })).toBeUndefined();
    expect(envStr('NODE_ENV', { NODE_ENV: 'test' })).toBe('test');
  });

  test('a string with a pattern must match it', () => {
    expect(envStr('SORA_HTS_CROSS_INDEX_SHA256', { SORA_HTS_CROSS_INDEX_SHA256: 'ab'.repeat(32) })).toBe('ab'.repeat(32));
    expect(envStr('SORA_HTS_CROSS_INDEX_SHA256', { SORA_HTS_CROSS_INDEX_SHA256: 'xyz' })).toBeUndefined();
  });
});

describe('envRaw', () => {
  test('gives the value as it is (invalid values too); unset, blank and non-string values are undefined', () => {
    expect(envRaw('SORA_FETCH_MAX_CHROME_PROFILE', { SORA_FETCH_MAX_CHROME_PROFILE: ' 0x9a ' })).toBe(' 0x9a ');
    for (const raw of [undefined, '', '  ', 150]) expect(envRaw('SORA_FETCH_TRUST_STORE', { SORA_FETCH_TRUST_STORE: raw as string })).toBeUndefined();
    expect(() => envRaw('NOT_A_SETTING' as never, {})).toThrow('Unknown setting: NOT_A_SETTING');
    // 秘密の設定は返さない（警告の文に出してしまわないため）
    expect(() => envRaw('SORA_API_KEY', { SORA_API_KEY: 'fake-secret-value' })).toThrow('秘密の設定');
    expect(() => envRaw('SORA_PROXY_URL', { SORA_PROXY_URL: 'http://user:pw@proxy.example.test:3128' })).toThrow('秘密の設定');
  });
});

describe('envWithoutSecrets (the environment for Chromium and the bundled programs)', () => {
  const kept = {
    PATH: '/usr/bin', HOME: '/home/sora', LD_LIBRARY_PATH: '/opt/lib', TZ: 'UTC', SSL_CERT_FILE: '/etc/ssl/certs/ca.crt',
    CHROME_PATH: '/usr/bin/chromium', HTTPS_PROXY: 'http://proxy.example.test:3128', no_proxy: 'localhost',
    SORA_BROWSER_LOW_MEMORY: 'true', SORA_FETCH_TRUST_STORE: 'defaultPaths', OTHER_PROGRAM_TOKEN: 'not-ours',
  };

  test('drops every secret setting, the old names of secret settings and SORA_GCC_*, and keeps everything else', () => {
    const secretNames = [...SECRETS, ...Object.entries(LEGACY).filter(([, { to }]) => to && SECRETS.includes(to)).map(([old]) => old), 'SORA_GCC_EXTRA'];
    expect(secretNames).toContain('API_KEY');
    expect(secretNames).toContain('FEDEX_API_SECRET');
    const env: Record<string, string> = { ...kept, ...Object.fromEntries(secretNames.map((name) => [name, `fake-secret-${name}`])) };
    const child = envWithoutSecrets(env);
    expect(child).toEqual(kept);
    expect(JSON.stringify(child)).not.toContain('fake-secret');
    expect(env.SORA_API_KEY).toBe('fake-secret-SORA_API_KEY'); // the input is not changed
  });

  test('reads process.env by default', async () => {
    await withEnv({ SORA_API_KEY: 'fake-secret-default', SORA_BROWSER_LOW_MEMORY: 'on' }, () => {
      const child = envWithoutSecrets();
      expect(child.SORA_API_KEY).toBeUndefined();
      expect(child.SORA_BROWSER_LOW_MEMORY).toBe('on');
      expect(child.PATH).toBe(process.env.PATH);
    });
  });
});

describe('envJson', () => {
  const party = { name: 'Example Importer LLC', street: '1 Example Way', city: 'Springfield', state: 'ZZ', country: 'US', email: 'gcc@example.test', phone: '+1-555-0100' };

  test('parses and checks the shape', () => {
    expect(envJson('SORA_GCC_CERTIFIER', { SORA_GCC_CERTIFIER: JSON.stringify(party) })).toEqual(party);
    expect(envJson('SORA_GCC_CUSTODIAN', { SORA_GCC_CUSTODIAN: '{"name":"QA lead"}' })).toEqual({ name: 'QA lead' });
  });

  test('broken JSON or the wrong shape gives undefined', () => {
    for (const raw of ['{name:', '[]', '"x"', 'null', '{"name":1}']) {
      expect(envJson('SORA_GCC_CERTIFIER', { SORA_GCC_CERTIFIER: raw })).toBeUndefined();
    }
  });
});

describe('checkEnv', () => {
  test('an empty environment is fine (Fail-Open: no key and no anonymous flag is not an error)', () => {
    expect(checkEnv({})).toEqual({ errors: [], warnings: [] });
    expect(checkEnv({ HOME: '/home/user', PATH: '/usr/bin', LANG: 'C.UTF-8', NODE_ENV: 'production', PORT: '8000' })).toEqual({ errors: [], warnings: [] });
  });

  test('(a) unknown SORA_* names warn; the non-setting names are known', () => {
    const { errors, warnings } = checkEnv({ SORA_MODULE: 'web', SORA_BROWSER_LOW_MEMRY: '1' });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('SORA_MODULE');
    expect(warnings.join('\n')).toContain('SORA_BROWSER_LOW_MEMRY');
    expect(checkEnv({
      SORA_VERSION: '5.0.0', SORA_MCP_INSTRUCTIONS: 'x', SORA_GCC_SOMETHING: 'x', SORA_LIVE_TESTS: '1',
      SORA_TOOL_HEALTH_CASES_JSON: '[]', SORA_URL: 'http://127.0.0.1:3016', LOCALAPPDATA: 'C:\\x', OTHER_PROGRAM_SETTING: 'x',
    })).toEqual({ errors: [], warnings: [] });
  });

  test.each(Object.entries(REFUSED))('(c) %s alone refuses to start', (old, [to]) => {
    const { errors, warnings } = checkEnv({ [old]: 'value-of-the-old-name' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(old);
    expect(errors[0]).toContain(to);
    expect(errors[0]).not.toContain('value-of-the-old-name');
    expect(warnings).toEqual([]);
  });

  test.each(Object.entries(REFUSED))('(b) %s next to its new name is ignored with a warning', (old, [to, value]) => {
    const { errors, warnings } = checkEnv({ [old]: 'x', [to]: value, ...partnerOf(to) });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(old);
    expect(warnings[0]).toContain(to);
  });

  test('API_KEY alone: tells to unset it if it belongs to another program, or to set SORA_API_KEY, and that Sora does not start', () => {
    const [message] = checkEnv({ API_KEY: 'x' }).errors;
    expect(message).toContain('unset');
    expect(message).toContain('SORA_API_KEY');
    expect(message).toContain('起動しません');
  });

  test('generic old names (without SORA_) say that another program may keep them', () => {
    const others = 'ほかのプログラムのものなら、そのままで構いません';
    for (const [old, to] of Object.entries(RENAMED_WARN)) {
      const alone = checkEnv({ [old]: 'x' }).warnings[0];
      const ignored = checkEnv({ [old]: 'x', [to]: 'x' }).warnings[0];
      for (const message of [alone, ignored]) {
        if (old.startsWith('SORA_')) expect(message, old).not.toContain(others);
        else expect(message, old).toContain(others);
      }
    }
  });

  test('SORA_API_KEY present but blank warns that authentication is off (Fail-Open)', () => {
    for (const blank of ['', '   ']) {
      expect(checkEnv({ SORA_API_KEY: blank })).toEqual({ errors: [], warnings: ['SORA_API_KEY が空です。未設定として扱い、認証は無効になります'] });
    }
    expect(checkEnv({ SORA_API_KEY: 'k' })).toEqual({ errors: [], warnings: [] });
  });

  test.each(Object.entries(RENAMED_WARN))('(b) %s alone warns with its replacement %s, without printing the value', (old, to) => {
    const value = 'distinctive-old-value-7f3a';
    for (const env of [{ [old]: value }, { [old]: value, [to]: 'x', ...partnerOf(to) }]) {
      const { errors, warnings } = checkEnv(env);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(old);
      expect(warnings[0]).toContain(to);
      for (const message of [...errors, ...warnings]) expect(message).not.toContain(value);
    }
    expect(checkEnv({ [old]: value }).errors).toEqual([]);
  });

  test('(b) removed names warn as removed', () => {
    for (const old of REMOVED) {
      const { errors, warnings } = checkEnv({ [old]: 'off' });
      expect(errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(old);
      expect(warnings[0]).toContain('廃止');
    }
  });

  test('empty old names are treated as unset', () => {
    expect(checkEnv({ API_KEY: '', ENABLED_MODULES: '  ', SORA_REALTIME_ANCHOR: '' })).toEqual({ errors: [], warnings: [] });
  });

  test('(d) invalid values are errors naming the variable and the expected form', () => {
    const cases: [string, string, string][] = [
      ['PORT', 'abc', '1〜65535'],
      ['PORT', '0', '1〜65535'],
      ['SORA_BROWSER_IDLE_TTL_MS', 'abc', '0 以上'],
      ['SORA_BROWSER_IDLE_TTL_MS', '5m', '0 以上'],
      ['SORA_AUTH_DAILY_LIMIT', '1e3', '1 以上'],
      ['SORA_BROWSER_MAX_CONCURRENCY', '0', '50 を超える値は 50'],
      ['SORA_MCP_DEFER_TOOLS', 'nope', 'yes'],
      ['SORA_LOG_FORMAT', 'yaml', 'json'],
      ['SORA_PUBLIC_URL', 'sora.example.com', 'https'],
      ['SORA_HTS_CROSS_INDEX_SHA256', 'xyz', '64'],
      ['SORA_FETCH_MAX_CHROME_PROFILE', '0x9a', '136'],
      ['SORA_ALLOWED_HOSTS', 'https://sora.example.com', 'Host'],
      ['SORA_GCC_CUSTODIAN', '{oops', 'JSON'],
    ];
    for (const [name, raw, form] of cases) {
      const { errors } = checkEnv({ ...partnerOf(name), [name]: raw });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(name);
      expect(errors[0]).toContain(form);
    }
  });

  test('(d) unknown module names in SORA_MODULES list the valid ones', () => {
    const { errors } = checkEnv({ SORA_MODULES: 'weeb' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('SORA_MODULES');
    expect(errors[0]).toContain('weeb');
    for (const m of MODULE_NAMES) expect(errors[0]).toContain(m);
    expect(checkEnv({ SORA_MODULES: 'all,lyrics,shazam,hts-archive' }).errors).toEqual([]);
    expect(checkEnv({ SORA_MODULES: '*' }).errors).toEqual([]);
  });

  test('secret values are never printed', () => {
    const secrets = { SORA_PROXY_URL: 'ftp://user:hunter2@proxy.example.test', SORA_GCC_CERTIFIER: '{"name":"hunter2"', SORA_ALERT_WEBHOOK_URL: 'hunter2-hook' };
    const { errors } = checkEnv(secrets);
    expect(errors).toHaveLength(3);
    for (const message of errors) {
      expect(message).not.toContain('hunter2');
      expect(message).toMatch(/設定済み、長さ \d+/);
    }
    expect(errors.find((m) => m.includes('SORA_PROXY_URL'))).toContain(`長さ ${secrets.SORA_PROXY_URL.length}`);
  });

  test('a non-secret invalid value is shown', () => {
    expect(checkEnv({ PORT: 'abc' }).errors[0]).toContain('"abc"');
  });

  test('URL values never show credentials, the query or the fragment; an unreadable URL shows only its length', () => {
    const [masked] = checkEnv({ SORA_X_DETAIL_BASE_URL: 'ftp://user9:pw-9q@fx.example.test/v1?token=tk-8z#frag-5' }).errors;
    expect(masked).toContain('"ftp://***@fx.example.test/v1?…#…"');
    for (const leak of ['user9', 'pw-9q', 'token', 'tk-8z', 'frag-5']) expect(masked).not.toContain(leak);
    const unreadable = 'sora.example.com/?k=v-3x';
    const [message] = checkEnv({ SORA_PUBLIC_URL: unreadable }).errors;
    expect(message).toContain(`読めない値、長さ ${unreadable.length}`);
    expect(message).not.toContain('sora.example.com');
    expect(checkEnv({ SORA_HTS_CROSS_INDEX_URL: 'http://index.example.test/cross.jsonl.gz' }).errors[0]).toContain('"http://index.example.test/cross.jsonl.gz"');
  });

  test('envError gives the same message as checkEnv for one variable, and nothing for a valid or unset value', () => {
    expect(envError('PORT', { PORT: 'abc' })).toBe(checkEnv({ PORT: 'abc' }).errors[0]);
    expect(envError('SORA_FETCH_MAX_CHROME_PROFILE', { SORA_FETCH_MAX_CHROME_PROFILE: '0x9a' })).toContain('136');
    expect(envError('SORA_FETCH_TRUST_STORE', { SORA_FETCH_TRUST_STORE: 'system' })).toContain('defaultPaths');
    expect(envError('SORA_MODULES', { SORA_MODULES: 'web,weeb' })).toContain('weeb');
    expect(envError('PORT', { PORT: '80' })).toBeUndefined();
    expect(envError('PORT', {})).toBeUndefined();
    expect(envError('PORT', { PORT: '  ' })).toBeUndefined();
    expect(() => envError('NOT_A_SETTING' as never, {})).toThrow('Unknown setting: NOT_A_SETTING');
  });

  test('the HTS cross index URL and SHA-256 are a pair: one without the other refuses to start', () => {
    const URL_ = 'https://index.example.test/cross.jsonl.gz';
    const SHA = 'a'.repeat(64);
    expect(checkEnv({ SORA_HTS_CROSS_INDEX_URL: URL_, SORA_HTS_CROSS_INDEX_SHA256: SHA })).toEqual({ errors: [], warnings: [] });
    for (const [set, missing, env] of [
      ['SORA_HTS_CROSS_INDEX_URL', 'SORA_HTS_CROSS_INDEX_SHA256', { SORA_HTS_CROSS_INDEX_URL: URL_ }],
      ['SORA_HTS_CROSS_INDEX_SHA256', 'SORA_HTS_CROSS_INDEX_URL', { SORA_HTS_CROSS_INDEX_SHA256: SHA, SORA_HTS_CROSS_INDEX_URL: '  ' }],
    ] as const) {
      const { errors, warnings } = checkEnv(env);
      expect(warnings, set).toEqual([]);
      expect(errors, set).toEqual([`SORA_HTS_CROSS_INDEX_URL と SORA_HTS_CROSS_INDEX_SHA256 は組で設定します。${set} だけでは効かないので、起動しません（${missing} も設定するか、${set} を消してください）`]);
    }
  });

  test.each([['UPS'], ['FEDEX']])('the %s client ID and secret are a pair: one without the other warns (the browser lookup is used), without printing the value', (carrier) => {
    const [id, secret] = [`SORA_TRACKING_${carrier}_CLIENT_ID`, `SORA_TRACKING_${carrier}_CLIENT_SECRET`];
    expect(checkEnv({ [id]: 'id-4k', [secret]: 'secret-4k' })).toEqual({ errors: [], warnings: [] });
    for (const [set, missing] of [[id, secret], [secret, id]]) {
      const { errors, warnings } = checkEnv({ [set]: 'value-9r', [missing]: ' ' });
      expect(errors, set).toEqual([]);
      expect(warnings, set).toEqual([`${id} と ${secret} は組で設定します。${set} だけでは効かず、API を使わずにブラウザで照会します（${missing} も設定するか、${set} を消してください）`]);
      expect(warnings[0]).not.toContain('value-9r');
    }
  });

  test('the output is deterministic', () => {
    const env = { SORA_ZZZ: '1', SORA_AAA: '1', ADMIN_ALERT_WEBHOOK_URL: 'x', LOG_FORMAT: 'json', PORT: 'x', SORA_MODULES: 'x' };
    const { warnings } = checkEnv(env);
    expect(checkEnv({ ...env })).toEqual(checkEnv(env));
    expect(warnings.findIndex((w) => w.includes('SORA_AAA'))).toBeLessThan(warnings.findIndex((w) => w.includes('SORA_ZZZ')));
  });
});

describe('renderEnvTable', () => {
  const table = renderEnvTable();

  test('contains every setting and standard name, and none of the old names', () => {
    for (const name of Object.keys(all)) expect(table).toContain(`| \`${name}\` |`);
    for (const old of Object.keys(LEGACY)) expect(table).not.toContain(`\`${old}\``);
  });

  test('is deterministic, grouped by area in the naming-rule order, sorted by name within an area', () => {
    expect(renderEnvTable()).toBe(table);
    const labels = Object.values(AREAS);
    const shown = table.split('\n').filter((line) => labels.some((l) => line === `**${l}**`)).map((line) => line.slice(2, -2));
    expect(shown).toEqual(labels.filter((l) => shown.includes(l)));
    for (const block of table.split(/\n(?=\*\*)/)) {
      const names = [...block.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
      expect(names).toEqual([...names].sort((a, b) => (a.toUpperCase() === b.toUpperCase() ? (a < b ? -1 : 1) : a.toUpperCase() < b.toUpperCase() ? -1 : 1)));
    }
  });

  test('every row has exactly three cells', () => {
    const rows = table.split('\n').filter((line) => line.startsWith('| `'));
    expect(rows).toHaveLength(Object.keys(all).length);
    for (const row of rows) expect(row.split(/(?<!\\)\|/)).toHaveLength(5);
  });

  test('defaults are shown', () => {
    expect(table).toContain('| `PORT` | `8000` |');
    expect(table).toContain('| `SORA_MCP_DEFER_TOOLS` | `true` |');
    expect(table).toContain('| `SORA_MODULES` | `all` |');
    expect(table).toContain('| `SORA_PUBLIC_URL` | *(未設定)* |');
  });
});
