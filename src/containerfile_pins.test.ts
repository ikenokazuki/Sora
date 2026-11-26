import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const root = (path: string) => new URL(`../${path}`, import.meta.url);
const containerfile = readFileSync(root('Containerfile'), 'utf8');
const arg = (name: string): string | undefined => containerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];

describe('Containerfile の固定: wreq-js の native をソースからビルドする段', () => {
  test('ソースの版は、bun.lock でインストールされる wreq-js と同じ（JS と native の版を食い違わせない）', () => {
    const installed = JSON.parse(readFileSync(root('node_modules/wreq-js/package.json'), 'utf8')).version as string;
    // 食い違ったら: Containerfile の WREQ_JS_VERSION を上げ、WREQ_JS_REV を、そのタグ（v<版>）のコミットの SHA にし、
    // bun scripts/wreq-native/update.ts で vendor/wreq-js の固定を作り直す
    expect(arg('WREQ_JS_VERSION')).toBe(installed);
  });

  test('コミットは、40 桁の SHA で固定する（タグが動いても、別のソースをビルドしない）', () => {
    expect(arg('WREQ_JS_REV')).toMatch(/^[0-9a-f]{40}$/);
  });

  test('自前の native は、npm のビルド済みの native と同じ場所（@wreq-js/binding-linux-x64-gnu の中）を置き換える', () => {
    // server.js は wreq-js の JS を取り込むので、native は bare の @wreq-js/binding-<target> から探される（../rust/... は server.js からの相対になる）
    expect(containerfile).toContain('COPY --from=wreq-native /wreq-js.linux-x64-gnu.node /app/node_modules/@wreq-js/binding-linux-x64-gnu/wreq-js.linux-x64-gnu.node');
    // 置き換える前にファイルがあることを確かめる（wreq-js のパッケージの構成が変わったら、黙って npm のものを使い続けずに、ビルドを落とす）
    expect(containerfile).toContain('test -f node_modules/@wreq-js/binding-linux-x64-gnu/wreq-js.linux-x64-gnu.node');
  });

  test('wreq-js の JS は、native を @wreq-js/binding-<target> からも探す（上の置き換えが効く前提。wreq-js を上げて探し方が変わったら、ここで気づく）', () => {
    const dist = readFileSync(root('node_modules/wreq-js/dist/wreq-js.js'), 'utf8');
    expect(dist).toMatch(/@wreq-js\/binding-\$\{target\}/);
  });
});

describe('vendor/wreq-js の固定（上流の wreq-util の新しい Chrome プロファイル）', () => {
  const pins = JSON.parse(readFileSync(root('vendor/wreq-js/pins.json'), 'utf8')) as {
    wreqJs: { version: string; rev: string };
    wreqUtilRev: string;
    wreqRev: string;
    wreqVersion: string;
    btlsRev: string;
    cargoImage: string;
  };
  const patch = readFileSync(root('vendor/wreq-js/Cargo.toml.patch'), 'utf8');
  const lock = readFileSync(root('vendor/wreq-js/Cargo.lock'), 'utf8');

  test('pins.json の wreq-js のタグ・コミットと cargo のイメージが、Containerfile と同じ', () => {
    expect(pins.wreqJs).toEqual({ version: arg('WREQ_JS_VERSION') as string, rev: arg('WREQ_JS_REV') as string });
    expect(containerfile).toContain(`FROM ${pins.cargoImage} AS wreq-native`);
  });

  test('patch が、pins.json の rev（wreq-util・wreq・btls・btls-sys）と wreq の版に向いている', () => {
    expect(patch).toContain(`rev = "${pins.wreqUtilRev}"`);
    expect(patch).toContain(`wreq = { git = "https://github.com/0x676e67/wreq", rev = "${pins.wreqRev}" }`);
    expect(patch).toContain(`btls = { git = "https://github.com/0x676e67/btls", rev = "${pins.btlsRev}" }`);
    expect(patch).toContain(`btls-sys = { git = "https://github.com/0x676e67/btls", rev = "${pins.btlsRev}" }`);
    expect(patch).toContain(`wreq = { version = "=${pins.wreqVersion}"`);
  });

  test('Cargo.lock の git の依存が、同じ rev に固定されている（手で直して、patch と食い違わせない）', () => {
    const sources = new Set([...lock.matchAll(/^source = "git\+([^"]+)"$/gm)].map((m) => m[1]));
    expect(sources).toEqual(
      new Set([
        `https://github.com/0x676e67/wreq-util?rev=${pins.wreqUtilRev}#${pins.wreqUtilRev}`,
        `https://github.com/0x676e67/wreq?rev=${pins.wreqRev}#${pins.wreqRev}`,
        `https://github.com/0x676e67/btls?rev=${pins.btlsRev}#${pins.btlsRev}`,
      ]),
    );
  });

  test('WREQ_MAX_CHROME_PROFILE は、3 桁の Chrome の版で、wreq の最小（136）以上', () => {
    const max = arg('WREQ_MAX_CHROME_PROFILE');
    expect(max).toMatch(/^\d{3}$/);
    expect(Number(max)).toBeGreaterThanOrEqual(136);
  });
});

describe('依存に当てるパッチ（patchedDependencies）', () => {
  const patched = (JSON.parse(readFileSync(root('package.json'), 'utf8')).patchedDependencies ?? {}) as Record<string, string>;

  test('bun install をする段は、その前にパッチのフォルダをコピーする（無いと、イメージのビルドが失敗する）', () => {
    expect(Object.keys(patched).length).toBeGreaterThan(0);
    const stages = containerfile.split(/^FROM /m).filter((stage) => /^RUN bun install /m.test(stage));
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) expect(stage.indexOf('\nCOPY patches ./patches\n')).toBeGreaterThan(-1);
    for (const stage of stages) expect(stage.indexOf('\nCOPY patches ./patches\n')).toBeLessThan(stage.search(/^RUN bun install /m));
  });

  test('turndown の仕上げは、空白の長い並びで二乗にならない形（パッチが当たっている）', () => {
    expect(patched['turndown@7.2.5']).toBe('patches/turndown@7.2.5.patch');
    for (const file of ['turndown.cjs.js', 'turndown.es.js']) {
      // 直した行があることを確かめる（パッチの説明のコメントには、前の正規表現の字がある）
      expect(readFileSync(root(`node_modules/turndown/lib/${file}`), 'utf8')).toContain("return output.join('').replace(/^[\\t\\r\\n]+/, '').trimEnd();");
    }
  });
});
