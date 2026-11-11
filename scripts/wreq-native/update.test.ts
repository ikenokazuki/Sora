import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseWreqUtilPatchRevs, patchCargoToml, readContainerfilePins, readPackageVersion } from './update.js';

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

describe('readContainerfilePins（実際の Containerfile）', () => {
  test('wreq-native の段のイメージ・wreq-js のタグ・コミットを読める', () => {
    const pins = readContainerfilePins(readFileSync(new URL('../../Containerfile', import.meta.url), 'utf8'));
    expect(pins.rustImage).toMatch(/^docker\.io\/library\/rust:\d+\.\d+\.\d+-bookworm$/);
    expect(pins.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.rev).toMatch(/^[0-9a-f]{40}$/);
  });
});
