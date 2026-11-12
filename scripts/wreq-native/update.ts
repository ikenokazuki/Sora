/**
 * wreq-js の native を、上流（wreq-util の main）の新しい Chrome プロファイルでビルドするための、固定の一式を作り直す。
 * 作るもの（vendor/wreq-js/）:
 *   - Cargo.toml.patch: wreq-js の rust/Cargo.toml を、wreq-util（git の rev）・wreq・btls の固定した rev に向ける差分
 *   - Cargo.lock: その依存の版の固定（Containerfile が --locked でビルドする）
 *   - pins.json: 固定した rev の一覧（見直しやすいように）
 * wreq・btls の rev は、wreq-util の Cargo.toml の [patch.crates-io] が使っているものに合わせる（wreq-util がその組み合わせでテストしているため。
 * btls を main にすると、wreq の rev と API が食い違ってビルドできなかった）。wreq-js のタグは、Containerfile の WREQ_JS_VERSION・WREQ_JS_REV から読む。
 *
 * 使い方: bun scripts/wreq-native/update.ts [--wreq-util <rev か ブランチ。既定は main>] [--max-chrome-profile <版>]
 *   --max-chrome-profile: Containerfile の ARG WREQ_MAX_CHROME_PROFILE（名乗る Chrome の版の上限）も、その版に書き換える。
 *   bun scripts/wreq-native/update.ts --check [--wreq-util …]: 何も書かず、上流の最新の Chrome のプロファイルが、いまの上限より新しいかを表示する
 *   （key=value の行。scripts/wreq-native/trial.sh が使う）。
 * 要るもの: git・podman か docker（rust のイメージで cargo を動かす。環境変数 CONTAINER_RUNTIME で選べる）・ネットワーク。
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WREQ_UTIL_REPO = 'https://github.com/0x676e67/wreq-util';
const WREQ_REPO = 'https://github.com/0x676e67/wreq';
const BTLS_REPO = 'https://github.com/0x676e67/btls';

export interface Pins {
  wreqUtilRev: string;
  wreqRev: string;
  wreqVersion: string;
  btlsRev: string;
}

/** wreq-util の Cargo.toml の [patch.crates-io] から、wreq・btls・btls-sys の rev を読む。 */
export function parseWreqUtilPatchRevs(cargoToml: string): { wreqRev: string; btlsRev: string } {
  const rev = (name: string): string => {
    const m = cargoToml.match(new RegExp(`^${name}\\s*=\\s*\\{[^}]*\\brev\\s*=\\s*"([0-9a-f]{40})"`, 'm'));
    if (!m) throw new Error(`wreq-util の Cargo.toml の [patch.crates-io] に、${name} の 40 桁の rev が無い`);
    return m[1];
  };
  const btls = rev('btls');
  if (rev('btls-sys') !== btls) throw new Error('btls と btls-sys の rev が違う');
  return { wreqRev: rev('wreq'), btlsRev: btls };
}

/** Cargo.toml の version = "x.y.z" を読む（[package] の最初のもの）。 */
export function readPackageVersion(cargoToml: string): string {
  const m = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('Cargo.toml に version が無い');
  return m[1];
}

/**
 * wreq-js の rust/Cargo.toml を、固定した rev に向ける。形が想定と違えば、黙って通さずに落とす
 * （wreq の version の指定が 1 つ・wreq-util の指定が dependencies と build-dependencies の 2 つ、[patch.crates-io] が無いこと）。
 */
export function patchCargoToml(text: string, pins: Pins): string {
  let out = text;
  const wreq = /^wreq = \{ version = "[^"]+"/m;
  if (!wreq.test(out)) throw new Error('wreq の version の指定が見つからない');
  out = out.replace(wreq, `wreq = { version = "=${pins.wreqVersion}"`);
  const util = /^wreq-util = \{ version = "[^"]+",/gm;
  const found = out.match(util)?.length ?? 0;
  if (found !== 2) throw new Error(`wreq-util の指定が ${found} 箇所（2 箇所のはず: dependencies と build-dependencies）`);
  out = out.replace(util, `wreq-util = { git = "${WREQ_UTIL_REPO}", rev = "${pins.wreqUtilRev}",`);
  if (out.includes('[patch.crates-io]')) throw new Error('Cargo.toml に、すでに [patch.crates-io] がある');
  return `${out.trimEnd()}

# 上流（wreq-util の main）の新しい Chrome プロファイルを使うための固定。rev は vendor/wreq-js/pins.json（scripts/wreq-native/update.ts が作る）
[patch.crates-io]
wreq = { git = "${WREQ_REPO}", rev = "${pins.wreqRev}" }
btls = { git = "${BTLS_REPO}", rev = "${pins.btlsRev}" }
btls-sys = { git = "${BTLS_REPO}", rev = "${pins.btlsRev}" }
`;
}

/** Containerfile から、wreq-js のタグ・コミットと、cargo を動かす rust のイメージを読む。 */
export function readContainerfilePins(containerfile: string): { version: string; rev: string; rustImage: string } {
  const arg = (name: string) => containerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];
  const rustImage = containerfile.match(/^FROM (\S+) AS wreq-native$/m)?.[1];
  const version = arg('WREQ_JS_VERSION');
  const rev = arg('WREQ_JS_REV');
  if (!rustImage || !version || !rev) throw new Error('Containerfile から、wreq-native の段のイメージ・WREQ_JS_VERSION・WREQ_JS_REV を読めない');
  return { version, rev, rustImage };
}

/** wreq-util の src/emulate.rs の Profile の一覧（`Chrome154 => ("chrome_154", v154::emulation),`）から、Chrome の最大の版を読む。 */
export function parseMaxChromeProfile(emulateRs: string): number {
  const versions = [...emulateRs.matchAll(/\("chrome_(\d{3})",/g)].map((m) => Number(m[1]));
  if (versions.length === 0) throw new Error('wreq-util の src/emulate.rs から、("chrome_<3 桁>", …) のプロファイルを読めない（上流の書き方が変わった）');
  return Math.max(...versions);
}

/** Containerfile の ARG WREQ_MAX_CHROME_PROFILE（静的取得とブラウザが名乗る Chrome の版の上限）を読む。1 個だけあることを求める。 */
export function readMaxChromeProfile(containerfile: string): number {
  const found = [...containerfile.matchAll(/^ARG WREQ_MAX_CHROME_PROFILE=(\S+)$/gm)];
  if (found.length !== 1) throw new Error(`Containerfile の ARG WREQ_MAX_CHROME_PROFILE が ${found.length} 個ある（1 個のはず）`);
  return Number(found[0][1]);
}

/** ARG WREQ_MAX_CHROME_PROFILE の値を書き換える（その 1 行だけ）。 */
export function setMaxChromeProfile(containerfile: string, max: number): string {
  // 136 は、src/http_fetcher.ts の MIN_CHROME_PROFILE_VERSION（静的取得が使う Chrome の版の下限）と同じ
  if (!Number.isInteger(max) || max < 136 || max > 999) throw new Error(`Chrome の版が、136 以上 999 以下の整数ではない: ${max}`);
  readMaxChromeProfile(containerfile);
  return containerfile.replace(/^ARG WREQ_MAX_CHROME_PROFILE=\S+$/m, `ARG WREQ_MAX_CHROME_PROFILE=${max}`);
}

async function run(cmd: string[], options: { cwd?: string } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: options.cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} が失敗した（${code}）:\n${err || out}`);
  return out;
}

async function rawFile(repo: string, rev: string, path: string): Promise<string> {
  const url = `${repo.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${rev}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} を取れない（${res.status}）`);
  return res.text();
}

async function resolveRev(repo: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const out = await run(['git', 'ls-remote', repo, `refs/heads/${ref}`, ref]);
  const sha = out.split('\n').find((l) => l.trim())?.split(/\s+/)[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${repo} の ${ref} を解決できない`);
  return sha;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i >= 0 && !argv[i + 1]) throw new Error(`${name} に値が要る`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = resolve(import.meta.dir, '..', '..');
  const containerfilePath = join(root, 'Containerfile');
  const containerfile = readFileSync(containerfilePath, 'utf8');
  const wreqUtilRev = await resolveRev(WREQ_UTIL_REPO, option('--wreq-util') ?? 'main');

  if (argv.includes('--check')) {
    // 書かない。上流の最新の Chrome のプロファイルが、いまの上限より新しいかだけ見る（ビルドの前の、安い判定）
    const upstreamMax = parseMaxChromeProfile(await rawFile(WREQ_UTIL_REPO, wreqUtilRev, 'src/emulate.rs'));
    const currentMax = readMaxChromeProfile(containerfile);
    console.log(`wreq_util_rev=${wreqUtilRev}\nupstream_max=${upstreamMax}\ncurrent_max=${currentMax}\nnewer=${upstreamMax > currentMax}`);
    process.exit(0);
  }

  const maxChrome = option('--max-chrome-profile');
  const newContainerfile = maxChrome === undefined ? undefined : setMaxChromeProfile(containerfile, Number(maxChrome)); // 値の誤りは、長い処理の前に分かるように、先に作る
  const { version, rev, rustImage } = readContainerfilePins(containerfile);
  const { wreqRev, btlsRev } = parseWreqUtilPatchRevs(await rawFile(WREQ_UTIL_REPO, wreqUtilRev, 'Cargo.toml'));
  const wreqVersion = readPackageVersion(await rawFile(WREQ_REPO, wreqRev, 'Cargo.toml'));
  const pins: Pins = { wreqUtilRev, wreqRev, wreqVersion, btlsRev };
  console.log(`wreq-util ${wreqUtilRev}\nwreq ${wreqRev}（${wreqVersion}）\nbtls ${btlsRev}\nwreq-js v${version}（${rev}）、cargo は ${rustImage}`);

  const work = mkdtempSync(join(tmpdir(), 'wreq-native-'));
  await run(['git', 'clone', '--quiet', '--depth', '1', '--branch', `v${version}`, 'https://github.com/sqdshguy/wreq-js', work]);
  const head = (await run(['git', 'rev-parse', 'HEAD'], { cwd: work })).trim();
  if (head !== rev) throw new Error(`タグ v${version} のコミットが Containerfile の WREQ_JS_REV と違う: ${head} != ${rev}`);

  const manifest = join(work, 'rust', 'Cargo.toml');
  writeFileSync(manifest, patchCargoToml(readFileSync(manifest, 'utf8'), pins));

  // 前回の Cargo.lock（vendor/wreq-js）から出発して、変わった依存だけを解決し直す（cargo metadata が、必要な分だけ Cargo.lock を更新する）。
  // 上流のタグの Cargo.lock から出発すると、rev が同じでも、推移的な依存が、その時点の最新に動いてしまう。最初の 1 回だけ、タグの Cargo.lock から出発する
  const vendoredLock = join(root, 'vendor', 'wreq-js', 'Cargo.lock');
  if (existsSync(vendoredLock)) copyFileSync(vendoredLock, join(work, 'rust', 'Cargo.lock'));
  const preferred = process.env.CONTAINER_RUNTIME;
  const runtime = preferred ? Bun.which(preferred) : (Bun.which('podman') ?? Bun.which('docker'));
  if (!runtime) throw new Error(preferred ? `${preferred} が見つからない（CONTAINER_RUNTIME）` : 'podman か docker が要る');
  const isPodman = runtime.endsWith('podman');
  const user = isPodman ? [] : ['--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`];
  await run([runtime, 'run', '--rm', ...(isPodman ? ['--http-proxy=false'] : []), ...user, '-e', 'CARGO_HOME=/tmp/cargo', '-v', `${work}:/src`, '-w', '/src/rust', rustImage, 'cargo', 'metadata', '--format-version', '1', '--quiet']);

  const out = join(root, 'vendor', 'wreq-js');
  writeFileSync(join(out, 'Cargo.toml.patch'), await run(['git', 'diff', '--', 'rust/Cargo.toml'], { cwd: work }));
  writeFileSync(join(out, 'Cargo.lock'), readFileSync(join(work, 'rust', 'Cargo.lock')));
  writeFileSync(join(out, 'pins.json'), `${JSON.stringify({ wreqJs: { version, rev }, ...pins, cargoImage: rustImage }, null, 2)}\n`);
  if (!existsSync(join(out, 'Cargo.lock'))) throw new Error('Cargo.lock を書けなかった');
  rmSync(work, { recursive: true, force: true });
  console.log(`書いた: ${out}/{Cargo.toml.patch,Cargo.lock,pins.json}`);

  if (newContainerfile !== undefined) {
    writeFileSync(containerfilePath, newContainerfile);
    console.log(`書いた: Containerfile の WREQ_MAX_CHROME_PROFILE を ${maxChrome} に`);
  }
}
