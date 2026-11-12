/**
 * 環境変数の一致の検査（登録簿 src/config.ts が正本）。
 * (1) src/ の中で環境を読むのは config.ts だけ (2) 旧名がリポジトリに残っていない
 * (3) 設定ファイル・文書の SORA_* と、コンテナ・CI・run_test.sh が渡す名前が登録簿にある。
 * 語の取り出しは、識別子の字（英数字と `_`）の続きで区切る（正規表現を旧名から組み立てない。線形）。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTERNAL, LEGACY, NOT_SETTINGS, SETTINGS } from './config.js';

const ROOT = join(import.meta.dir, '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);
/** 過去の記録（書き換えない） */
const HISTORY_DIRS = ['docs/superpowers/', 'docs/evaluations/'];

/** ディレクトリ dir の下のファイルの、ROOT からの相対パス。 */
function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    SKIP_DIRS.has(e.name) ? [] : e.isDirectory() ? files(`${dir}/${e.name}`) : e.isFile() ? [`${dir}/${e.name}`] : []);
}

/** 文字列のファイルの行（NUL を含むファイルは読まない）。 */
function lines(rel: string): string[] {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  return text.includes('\0') ? [] : text.split('\n');
}

const isIdent = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_';

/** 行の中の語（英数字と `_` の続き）。 */
function words(line: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= line.length; i++) {
    if (i < line.length && isIdent(line[i])) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push(line.slice(start, i));
      start = -1;
    }
  }
  return out;
}

const docsFiles = () => files('docs').filter((f) => !HISTORY_DIRS.some((d) => f.startsWith(d)));
const workflowFiles = () => files('.github/workflows').filter((f) => f.endsWith('.yml'));

describe('(1) src/ の中で環境を読むのは src/config.ts だけ', () => {
  const NEEDLES = ['process.env', 'Bun.env', 'import.meta.env'];
  /** 引数の既定値（読み取りでなく、呼ぶ側の環境を受け取る口） */
  const DEFAULT_PARAMS = [
    // `env: Env = process.env`・`source: Env = process.env`・`source: Record<string, string | undefined> = process.env`（名前の続きの字が無いこと）
    /\b[A-Za-z_]\w*\s*:\s*(?:Env|Record<string,\s*string\s*\|\s*undefined>)\s*=\s*process\.env(?![A-Za-z0-9_$.])/g,
    // 分割代入の引数: `{ env: given = process.env }`
    /\benv:\s*given\s*=\s*process\.env(?![A-Za-z0-9_$.])/g,
  ];
  /** 例外（ファイルと、その中で許す読み取り。名前の続きの字が無いこと（PATHEXT などは許さない）） */
  const ALLOWED: Record<string, RegExp> = {
    // Chromium の標準の場所と PATH の走査。OS の変数（NOT_SETTINGS）で、Sora の設定ではない（登録簿に読み取りの口が無い）
    'src/browser_engine.ts': /process\.env\.(?:LOCALAPPDATA|PATH)(?![A-Za-z0-9_$])/g,
  };

  test('config.ts・テスト・test_preload.ts・test_fixtures の外に、環境の読み取りが無い', () => {
    const targets = files('src').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
      && f !== 'src/config.ts' && f !== 'src/test_preload.ts' && !f.startsWith('src/test_fixtures/'));
    const hits = targets.flatMap((f) => lines(f).flatMap((line, i) => {
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return [];
      let rest = line;
      for (const ok of DEFAULT_PARAMS) rest = rest.replace(ok, '');
      if (ALLOWED[f]) rest = rest.replace(ALLOWED[f], '');
      return NEEDLES.some((n) => rest.includes(n)) ? [`${f}:${i + 1}: ${line.trim()}`] : [];
    }));
    expect(hits).toEqual([]);
  });
});

describe('(2) 旧名（LEGACY）が残っていない', () => {
  /** 旧名を入力に使うテスト（わざと） */
  const OLD_NAME_TESTS = ['src/config.ts', 'src/config.test.ts', 'src/env_names.test.ts', 'src/startup_check.test.ts'];

  test('README・docs・scripts・src・packages・plugins・client・設定ファイル・workflow に、旧名が語として無い（RELEASE_NOTES.md は対象外）', () => {
    const targets = [
      'README.md', 'Containerfile', 'smithery.yaml', 'run_test.sh', 'package.json',
      ...docsFiles(), ...files('scripts'), ...files('src').filter((f) => !OLD_NAME_TESTS.includes(f)),
      ...files('packages'), ...files('plugins'), ...files('client'), ...files('.github'),
    ];
    const hits = targets.flatMap((f) => lines(f).flatMap((line, i) => {
      // GitHub の secret の名前（secrets.NAME）は環境変数でない。secret の名前は変えていない
      const text = f.startsWith('.github/') ? line.replace(/secrets\.[A-Za-z0-9_]+/g, '') : line;
      return words(text).filter((w) => Object.hasOwn(LEGACY, w)).map((w) => `${f}:${i + 1}: ${w}`);
    }));
    expect(hits).toEqual([]);
  });
});

describe('(3) 設定ファイル・文書・CI の名前が登録簿にある', () => {
  const KNOWN = new Set([...Object.keys(SETTINGS), ...Object.keys(EXTERNAL), ...NOT_SETTINGS]);

  test('Containerfile・smithery.yaml・run_test.sh・workflow・README・docs の SORA_* が登録簿にある', () => {
    const targets = ['Containerfile', 'smithery.yaml', 'run_test.sh', ...workflowFiles(), 'README.md', ...docsFiles()];
    // `SORA_*`・`SORA_GCC_` のような接頭辞の言及（`_` で終わる語）は、その接頭辞の名前が登録簿にあればよい
    const known = (w: string) => KNOWN.has(w) || (w.endsWith('_') && [...KNOWN].some((k) => k.startsWith(w)));
    const hits = targets.flatMap((f) => lines(f).flatMap((line, i) =>
      words(line).filter((w) => w.startsWith('SORA_') && w === w.toUpperCase() && !known(w)).map((w) => `${f}:${i + 1}: ${w}`)));
    expect(hits).toEqual([]);
  });

  test('コンテナの ENV・ARG・workflow の env:・run_test.sh の代入の名前が、登録簿か下の一覧にある', () => {
    /** Sora の設定でない名前（ビルド・CI・リンカの変数） */
    const NOT_SORA = new Set([
      'WREQ_MAX_CHROME_PROFILE', 'WREQ_JS_VERSION', 'WREQ_JS_REV', 'RS_TRAFILATURA_REV', // Containerfile: ビルドの引数（イメージの環境には入らない）
      'REGISTRY', 'IMAGE_NAME', 'CANDIDATE_TAG', // docker-publish.yml: イメージの名前とタグ
      'IMAGE_TAG', // live-tools.yml: 検査するイメージ（tool-health/run.ts の --image に渡す）
      'GH_TOKEN', // runtime-update-check.yml: gh の認証
      'WREQ_UTIL', 'FORCE', 'RUN_URL', 'CONTAINER_RUNTIME', // wreq-native-update.yml: 試しビルド（scripts/wreq-native/trial.sh）への入力
      'LIBSTDCXX_PATH', 'LD_LIBRARY_PATH', // run_test.sh: nix の libstdc++ の場所
    ]);
    /** 読み取った名前（読み取り元ごと。`場所: 名前`） */
    const found = { env: [] as string[], arg: [] as string[], workflow: [] as string[], runTest: [] as string[] };
    // Containerfile の ARG と ENV（続きの行も）。ENV は NAME=値 の形だけを見る
    let inEnv = false;
    lines('Containerfile').forEach((line, i) => {
      const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (arg) found.arg.push(`Containerfile:${i + 1}: ${arg[1]}`);
      if (/^ENV\s/.test(line)) inEnv = true;
      if (inEnv) for (const m of line.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)) found.env.push(`Containerfile:${i + 1}: ${m[1]}`);
      inEnv = inEnv && line.trimEnd().endsWith('\\');
    });
    // workflow の env: の塊（env: より深い字下げの `NAME:` の行）
    for (const f of workflowFiles()) {
      let indent = -1;
      lines(f).forEach((line, i) => {
        const depth = line.length - line.trimStart().length;
        if (indent >= 0 && line.trim() !== '' && depth <= indent) indent = -1;
        if (indent >= 0) {
          const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
          if (m) found.workflow.push(`${f}:${i + 1}: ${m[1]}`);
        }
        if (/^\s*env:\s*$/.test(line)) indent = depth;
      });
    }
    // run_test.sh の NAME=値
    lines('run_test.sh').forEach((line, i) => {
      for (const m of line.matchAll(/(?:^|[\s"])([A-Za-z_][A-Za-z0-9_]*)=/g)) found.runTest.push(`run_test.sh:${i + 1}: ${m[1]}`);
    });

    // 走査が壊れて黙って通るのを防ぐ（読み取り元ごとの下限。いまは ENV 8・ARG 6・workflow 14・run_test.sh 4）
    expect({ env: found.env.length >= 5, arg: found.arg.length >= 3, workflow: found.workflow.length >= 8, runTest: found.runTest.length >= 2 })
      .toEqual({ env: true, arg: true, workflow: true, runTest: true });
    expect(Object.values(found).flat().filter((n) => {
      const name = n.slice(n.lastIndexOf(' ') + 1);
      return !KNOWN.has(name) && !NOT_SORA.has(name);
    })).toEqual([]);
  });
});
