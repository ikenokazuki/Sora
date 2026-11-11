import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const containerfile = readFileSync(new URL('../Containerfile', import.meta.url), 'utf8');
const arg = (name: string): string | undefined => containerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];

describe('Containerfile の固定: wreq-js の native をソースからビルドする段', () => {
  test('ソースの版は、bun.lock でインストールされる wreq-js と同じ（JS と native の版を食い違わせない）', () => {
    const installed = JSON.parse(readFileSync(new URL('../node_modules/wreq-js/package.json', import.meta.url), 'utf8')).version as string;
    // 食い違ったら: Containerfile の WREQ_JS_VERSION を上げ、WREQ_JS_REV を、そのタグ（v<版>）のコミットの SHA にする
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
    const dist = readFileSync(new URL('../node_modules/wreq-js/dist/wreq-js.js', import.meta.url), 'utf8');
    expect(dist).toMatch(/@wreq-js\/binding-\$\{target\}/);
  });
});
