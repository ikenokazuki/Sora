import { describe, expect, test } from 'bun:test';
import {
  AREAS,
  envBool,
  envEnum,
  envInt,
  envJson,
  envList,
  envPath,
  envStr,
  envUrl,
  EXTERNAL,
  LEGACY,
  NOT_SETTINGS,
  type Setting,
  SETTINGS,
} from './config.js';
import { EXPLICIT_ONLY_MODULES as REGISTRY_EXPLICIT_ONLY } from './mcp/registry.js';
import { EXPLICIT_ONLY_MODULES, MODULE_NAMES } from './modules.js';

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

describe('registry', () => {
  test('counts match the design (53 + 3 settings, 13 standard names, 40 old names)', () => {
    expect(Object.keys(SETTINGS)).toHaveLength(56);
    expect(Object.keys(EXTERNAL)).toHaveLength(13);
    expect(Object.keys(LEGACY)).toHaveLength(40);
    expect(Object.keys(LEGACY).filter((n) => LEGACY[n].policy === 'error').sort()).toEqual(Object.keys(REFUSED).sort());
    expect(Object.keys(LEGACY).filter((n) => !LEGACY[n].to).sort()).toEqual([...REMOVED].sort());
    for (const [old, [to]] of Object.entries(REFUSED)) expect(LEGACY[old].to).toBe(to as never);
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
    expect(envInt('SORA_BROWSER_MAX_CONCURRENCY', { SORA_BROWSER_MAX_CONCURRENCY: '51' })).toBeUndefined();
    expect(envInt('SORA_BROWSER_MAX_CONCURRENCY', { SORA_BROWSER_MAX_CONCURRENCY: '0' })).toBeUndefined();
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
    expect(envList('SORA_MODULES', { SORA_MODULES: 'web,weeb' })).toEqual(['all']);
    expect(envList('SORA_MODULES', { SORA_MODULES: ',,' })).toEqual(['all']);
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
