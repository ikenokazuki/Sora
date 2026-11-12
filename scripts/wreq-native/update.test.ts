import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseMaxChromeProfile, parseWreqUtilPatchRevs, patchCargoToml, readContainerfilePins, readMaxChromeProfile, readPackageVersion, setMaxChromeProfile } from './update.js';

const UPSTREAM_CARGO = `[package]
name = "wreq-js"
version = "3.2.0"

[dependencies]
# HTTP client with browser impersonation
wreq = { version = "0.16.0", default-features = false, features = ["cookies", "gzip"] }
wreq-util = { version = "0.2.0", features = ["emulation-serde", "tokio-rt"] }
webpki-root-certs = "1.0.9"

[build-dependencies]
serde = { version = "1.0.229", features = ["derive"] }
wreq-util = { version = "0.2.0", features = ["emulation-serde", "tokio-rt"] }

[profile.release]
lto = true
`;

const PINS = {
  wreqUtilRev: '917d2581d6761a94db66466caa6c2eb4d4cdbd43',
  wreqRev: 'cd76bcdf1307153de289d34e072528bdf0510a3b',
  wreqVersion: '0.16.1',
  btlsRev: '129887582a538b8f4dcf371d15c953335312ca37',
};

describe('patchCargoToml', () => {
  test('wreq の版を固定し、wreq-util（dependencies と build-dependencies の 2 つ）を git の rev に向け、[patch.crates-io] を足す', () => {
    const out = patchCargoToml(UPSTREAM_CARGO, PINS);
    expect(out).toContain('wreq = { version = "=0.16.1", default-features = false, features = ["cookies", "gzip"] }');
    expect(out.match(/wreq-util = \{ git = "https:\/\/github.com\/0x676e67\/wreq-util", rev = "917d2581d6761a94db66466caa6c2eb4d4cdbd43", features/g)).toHaveLength(2);
    expect(out).not.toContain('wreq-util = { version');
    expect(out).toContain('[patch.crates-io]');
    expect(out).toContain(`wreq = { git = "https://github.com/0x676e67/wreq", rev = "${PINS.wreqRev}" }`);
    expect(out).toContain(`btls = { git = "https://github.com/0x676e67/btls", rev = "${PINS.btlsRev}" }`);
    expect(out).toContain(`btls-sys = { git = "https://github.com/0x676e67/btls", rev = "${PINS.btlsRev}" }`);
    // ほかの行は、そのまま
    expect(out).toContain('webpki-root-certs = "1.0.9"');
    expect(out).toContain('[profile.release]\nlto = true');
  });

  test('想定と違う形は、黙って通さずに落とす', () => {
    expect(() => patchCargoToml(UPSTREAM_CARGO.replace('wreq = {', 'wreq_ = {'), PINS)).toThrow('wreq の version の指定');
    expect(() => patchCargoToml(UPSTREAM_CARGO.replace(/\[build-dependencies\][\s\S]*\[profile/, '[profile'), PINS)).toThrow('1 箇所');
    expect(() => patchCargoToml(`${UPSTREAM_CARGO}\n[patch.crates-io]\nfoo = "1"\n`, PINS)).toThrow('[patch.crates-io]');
  });
});

describe('parseWreqUtilPatchRevs / readPackageVersion', () => {
  const WREQ_UTIL_CARGO = `[package]
name = "wreq-util"
version = "0.2.0"

[patch.crates-io]
wreq = { git = "https://github.com/0x676e67/wreq", rev = "cd76bcdf1307153de289d34e072528bdf0510a3b" }
btls = { git = "https://github.com/0x676e67/btls", rev = "129887582a538b8f4dcf371d15c953335312ca37" }
btls-sys = { git = "https://github.com/0x676e67/btls", rev = "129887582a538b8f4dcf371d15c953335312ca37" }
`;

  test('wreq-util の [patch.crates-io] から、wreq と btls の rev を読む', () => {
    expect(parseWreqUtilPatchRevs(WREQ_UTIL_CARGO)).toEqual({ wreqRev: PINS.wreqRev, btlsRev: PINS.btlsRev });
    expect(readPackageVersion(WREQ_UTIL_CARGO)).toBe('0.2.0');
  });

  test('rev が無い・btls と btls-sys の rev が違うときは落とす', () => {
    expect(() => parseWreqUtilPatchRevs(WREQ_UTIL_CARGO.replace(/^wreq = .*$/m, 'wreq = "0.16"'))).toThrow('wreq の 40 桁の rev');
    expect(() => parseWreqUtilPatchRevs(WREQ_UTIL_CARGO.replace(/(btls-sys.*rev = ")1298/, '$1ffff'))).toThrow('rev が違う');
  });
});

describe('parseMaxChromeProfile（wreq-util の src/emulate.rs）', () => {
  const EMULATE_RS = `define_enum!(
    Profile, Chrome100,
    Emulation,

    // Chrome versions
    Chrome100 => ("chrome_100", v100::emulation),
    Chrome153 => ("chrome_153", v153::emulation),
    Chrome154 => ("chrome_154", v154::emulation),
    // Edge versions
    Edge101 => ("edge_101", edge101::emulation),
    Firefox139 => ("firefox_139", firefox139::emulation),
);`;

  test('Profile の一覧から、Chrome の最大の版を読む（edge・firefox は数えない）', () => {
    expect(parseMaxChromeProfile(EMULATE_RS)).toBe(154);
  });

  test('並びに依らず、最大を返す（文字列の比べ方ではなく、数として）', () => {
    expect(parseMaxChromeProfile('("chrome_155", a), ("chrome_100", b)')).toBe(155);
  });

  test('chrome のプロファイルが 1 つも読めなければ落とす（上流の書き方が変わった）', () => {
    expect(() => parseMaxChromeProfile('Firefox139 => ("firefox_139", f),')).toThrow('chrome_');
  });
});

describe('readMaxChromeProfile / setMaxChromeProfile', () => {
  const CONTAINERFILE = 'ARG WREQ_JS_VERSION=3.2.0\nARG WREQ_MAX_CHROME_PROFILE=154\nFROM x AS y\n';

  test('ARG WREQ_MAX_CHROME_PROFILE を読む', () => {
    expect(readMaxChromeProfile(CONTAINERFILE)).toBe(154);
  });

  test('その 1 行だけを書き換える', () => {
    expect(setMaxChromeProfile(CONTAINERFILE, 155)).toBe(CONTAINERFILE.replace('=154', '=155'));
  });

  test('136 未満・3 桁でない版は、書かずに落とす', () => {
    for (const bad of [135, 15, 1550, 154.5, Number.NaN]) expect(() => setMaxChromeProfile(CONTAINERFILE, bad)).toThrow('Chrome の版');
  });

  test('ARG が無い・2 つあるときは落とす（形が変わったのを、黙って通さない）', () => {
    expect(() => readMaxChromeProfile('FROM x\n')).toThrow('WREQ_MAX_CHROME_PROFILE');
    expect(() => setMaxChromeProfile(`${CONTAINERFILE}ARG WREQ_MAX_CHROME_PROFILE=150\n`, 155)).toThrow('WREQ_MAX_CHROME_PROFILE');
  });

  test('実際の Containerfile から読める', () => {
    const max = readMaxChromeProfile(readFileSync(new URL('../../Containerfile', import.meta.url), 'utf8'));
    expect(max).toBeGreaterThanOrEqual(136);
    expect(max).toBeLessThan(1000);
  });
});

describe('readContainerfilePins（実際の Containerfile）', () => {
  test('wreq-native の段のイメージ・wreq-js のタグ・コミットを読める', () => {
    const pins = readContainerfilePins(readFileSync(new URL('../../Containerfile', import.meta.url), 'utf8'));
    expect(pins.rustImage).toMatch(/^docker\.io\/library\/rust:\d+\.\d+\.\d+-bookworm$/);
    expect(pins.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.rev).toMatch(/^[0-9a-f]{40}$/);
  });
});
