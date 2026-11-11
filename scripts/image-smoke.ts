/**
 * イメージの中で動かす確認（.github/workflows/containerfile-check.yml から）。
 * 本番の server.js と同じく wreq-js の JS を取り込んだ（bun build）状態で、native を読めること、読んだのが Containerfile の Stage 1b で作って
 * 置き換えたファイル（node_modules/@wreq-js/binding-linux-x64-gnu の中）であることを確かめる。
 * 使い方: docker run --rm -v "$PWD/scripts/image-smoke.ts:/app/image-smoke.ts:ro" --entrypoint /usr/local/bin/bun <image> /app/image-smoke.ts
 * /app に置くのは、取り込んだあとの JS が、bare の @wreq-js/binding-* を /app/node_modules から探すようにするため（server.js と同じ）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const NATIVE = '/app/node_modules/@wreq-js/binding-linux-x64-gnu/wreq-js.linux-x64-gnu.node';
const failures: string[] = [];
if (!existsSync(NATIVE)) failures.push(`native が無い（${NATIVE}）`);
if (existsSync('/app/node_modules/wreq-js/rust')) failures.push('node_modules/wreq-js/rust がある（server.js からは探されないので、置き場所を間違えている）');

writeFileSync('/app/image-smoke-entry.ts', "import { getProfiles } from 'wreq-js';\nexport const profiles: string[] = getProfiles();\n");
const built = await Bun.build({ entrypoints: ['/app/image-smoke-entry.ts'], target: 'bun', outdir: '/app/image-smoke-out' });
if (!built.success) {
  console.error(built.logs.join('\n'));
  process.exit(1);
}
const bundlePath = '/app/image-smoke-out/image-smoke-entry.js'; // 変数にするのは、型検査が、イメージの中にしか無い実行時のファイルを探さないようにするため
const { profiles } = (await import(bundlePath)) as { profiles: string[] };
// イメージが上限に決めた版（ENV の SORA_FETCH_MAX_CHROME_PROFILE。Containerfile の WREQ_MAX_CHROME_PROFILE）のプロファイルを、native が持つこと
const max = process.env.SORA_FETCH_MAX_CHROME_PROFILE;
if (!max || !/^\d{3}$/.test(max)) failures.push(`SORA_FETCH_MAX_CHROME_PROFILE が、3 桁の Chrome の版ではない（${JSON.stringify(max)}）`);
if (profiles.length < 100 || !profiles.includes(`chrome_${max}`)) failures.push(`プロファイルが想定と違う（${profiles.length} 件。chrome_${max} が要る）`);

const loaded = readFileSync('/proc/self/maps', 'utf8')
  .split('\n')
  .filter((line) => line.includes('.node'))
  .map((line) => line.trim().split(/\s+/).pop());
if (!loaded.includes(NATIVE)) failures.push(`読み込まれた native が想定の場所ではない: ${JSON.stringify([...new Set(loaded)])}`);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`ok: wreq-js native（${NATIVE}）, ${profiles.length} profiles, chrome_${max} まで`);
