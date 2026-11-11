import { beforeEach, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { wreqAlignDisabledFeatures } from './browser_engine.js';
import { highestChromeProfileAtMost, parseMaxChromeProfile, profileMajorFor, withinMaxProfile } from './http_fetcher.js';

describe('parseMaxChromeProfile（SORA_FETCH_MAX_CHROME_PROFILE）', () => {
  let warn: ReturnType<typeof spyOn<Console, 'warn'>>;
  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test('未設定・空・空白だけは、既定の 149（npm の wreq-js が持つ最新）。警告は出さない', () => {
    for (const raw of [undefined, '', '  ']) expect(parseMaxChromeProfile(raw)).toBe(149);
    expect(warn).not.toHaveBeenCalled();
  });

  test('136 以上の整数は、そのまま（前後の空白は問わない）', () => {
    expect(parseMaxChromeProfile('154')).toBe(154);
    expect(parseMaxChromeProfile(' 150 ')).toBe(150);
    expect(parseMaxChromeProfile('136')).toBe(136);
    expect(warn).not.toHaveBeenCalled();
  });

  test('136 未満・整数でない値・大きすぎる値は、既定の 149 にして、警告を 1 回出す。例外は投げない', () => {
    for (const raw of ['135', 'abc', '150.5', '1000', '-1', '0x9a', '1e3']) {
      warn.mockClear();
      expect(parseMaxChromeProfile(raw)).toBe(149);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });
});

describe('profileMajorFor（上限つき）', () => {
  test('実ブラウザが上限より新しければ上限、範囲内ならその版、136 より古ければ 136、分からなければ上限', () => {
    expect(profileMajorFor(156, 154)).toBe(154);
    expect(profileMajorFor(156, 149)).toBe(149);
    expect(profileMajorFor(150, 154)).toBe(150);
    expect(profileMajorFor(154, 154)).toBe(154);
    expect(profileMajorFor(141, 149)).toBe(141);
    expect(profileMajorFor(120, 154)).toBe(136);
    expect(profileMajorFor(undefined, 154)).toBe(154);
  });
});

describe('withinMaxProfile（native の読み込みの前に決めたプロファイルを、上限に収める）', () => {
  test('上限を超える chrome_<版> は上限に、以下や、chrome 以外は、そのまま', () => {
    expect(withinMaxProfile('chrome_156' as never, 154)).toBe('chrome_154' as never);
    expect(withinMaxProfile('chrome_154' as never, 154)).toBe('chrome_154' as never);
    expect(withinMaxProfile('chrome_141' as never, 154)).toBe('chrome_141');
    expect(withinMaxProfile('firefox_160' as never, 154)).toBe('firefox_160' as never);
  });
});

describe('highestChromeProfileAtMost（native が持つプロファイルへの切り詰め）', () => {
  const profiles = ['chrome_136', 'chrome_149', 'chrome_150', 'chrome_android_137', 'edge_148', 'firefox_150', 'chrome_100', 'safari_26.4'];

  test('chrome_<数字> だけを見て、上限以下で最大の版を返す（chrome_android_* や edge_* は数えない）', () => {
    expect(highestChromeProfileAtMost(profiles, 154)).toBe(150);
    expect(highestChromeProfileAtMost(profiles, 149)).toBe(149);
    expect(highestChromeProfileAtMost(profiles, 140)).toBe(136);
  });

  test('該当が無ければ undefined', () => {
    expect(highestChromeProfileAtMost(['firefox_150', 'chrome_android_137'], 154)).toBeUndefined();
    expect(highestChromeProfileAtMost([], 154)).toBeUndefined();
  });
});

describe('wreqAlignDisabledFeatures（ブラウザの起動で止める機能は、名乗る版で決まる）', () => {
  test('152 未満のプロファイルは、拡張 51764（Trust Anchor IDs）・署名の GREASE・image/jxl をすべて止める', () => {
    for (const major of [0, 136, 149, 151]) {
      expect(wreqAlignDisabledFeatures(major)).toEqual(['TLSTrustAnchorIDs', 'NonMtcTrustAnchorIDs', 'TlsGreaseSigalgs', 'JXLImageFormat']);
    }
  });

  test('152 以上のプロファイルは、51764 と GREASE を止めず（ブラウザが自然に送るものが、プロファイルと同じ）、image/jxl だけ止める', () => {
    for (const major of [152, 154, 160]) expect(wreqAlignDisabledFeatures(major)).toEqual(['JXLImageFormat']);
  });
});

/** SORA_FETCH_MAX_CHROME_PROFILE は、プロセスの起動時に読むので、子プロセスで確かめる。 */
describe('SORA_FETCH_MAX_CHROME_PROFILE が、実際に上限になる', () => {
  async function run(env: Record<string, string>): Promise<string> {
    const code = `import { MAX_SUPPORTED_CHROME_PROFILE_VERSION, profileMajorFor } from './src/http_fetcher.ts'; console.log('RESULT', MAX_SUPPORTED_CHROME_PROFILE_VERSION, profileMajorFor(156), profileMajorFor(undefined));`;
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SORA_FETCH_MAX_CHROME_PROFILE|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)/i.test(k)));
    const proc = Bun.spawn([process.execPath, '-e', code], { cwd: new URL('..', import.meta.url).pathname, env: { ...base, NODE_ENV: 'test', SORA_DB_PATH: ':memory:', ...env }, stdout: 'pipe', stderr: 'pipe' });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return out.split('\n').find((line) => line.startsWith('RESULT ')) ?? `no RESULT: ${out}`;
  }

  test('未設定は 149、設定すれば、その値（実ブラウザが新しければ上限、分からなければ上限）', async () => {
    expect(await run({})).toBe('RESULT 149 149 149');
    expect(await run({ SORA_FETCH_MAX_CHROME_PROFILE: '154' })).toBe('RESULT 154 154 154');
    expect(await run({ SORA_FETCH_MAX_CHROME_PROFILE: '150' })).toBe('RESULT 150 150 150');
    expect(await run({ SORA_FETCH_MAX_CHROME_PROFILE: 'abc' })).toBe('RESULT 149 149 149');
  }, 60_000);
});
