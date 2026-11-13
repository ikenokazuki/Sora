import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 「外向きの通信は、出口のゲートウェイを通る」は、外向きの通信の口が、決まった 4 つに限られることに頼る:
//   ブラウザ（起動の引数）・静的取得（wreq。fetchWithSafeRedirects）・Bun の fetch（globalThis.fetch を包む。net/egress_fetch.ts）・子プロセス（環境変数）。
// 新しい口（node:http の要求・WebSocket・生のソケット・UDP・通信する子プロセス）を足すと、ゲートウェイを迂回する。
// 足すときは、ゲートウェイを通す道を作ってから、ここの一覧を更新する（設計: docs/superpowers/specs/2026-11-12-isolation-design.md の設計 1）。

const SRC = join(import.meta.dir);

function sourceFiles(dir = ''): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name === 'test_fixtures' ? [] : sourceFiles(rel);
    // テストと、テスト用の道具は、本番では動かない
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('_test_kit.ts') && entry.name !== 'test_preload.ts' ? [`src/${rel}`] : [];
  });
}

/** コメントの行を除いた、行の一覧（行番号つき） */
function codeLines(file: string): Array<{ no: number; text: string }> {
  return readFileSync(join(SRC, '..', file), 'utf8')
    .split('\n')
    .map((text, index) => ({ no: index + 1, text }))
    .filter(({ text }) => {
      const t = text.trimStart();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    });
}

describe('外向きの通信の口は、決まった 4 つだけ', () => {
  const OUTBOUND: Array<[string, RegExp]> = [
    ['node:http・node:https', /from\s+['"](?:node:)?https?['"]|require\(\s*['"](?:node:)?https?['"]\s*\)/],
    ['WebSocket のクライアント', /\bnew\s+WebSocket\s*\(/],
    ['Bun.fetch（globalThis.fetch を包んだものを通らない）', /\bBun\.fetch\s*\(/],
    ['生のソケット・UDP', /\b(?:Bun\.connect|Bun\.udpSocket|net\.connect|net\.createConnection|tls\.connect)\s*\(|from\s+['"](?:node:)?(?:net|tls|dgram|http2)['"]/],
  ];
  /** ゲートウェイ自身（宛先への接続・上流のプロキシへの接続は、ここだけ） */
  const GATEWAY = ['src/net/egress_gateway.ts'];

  test('ゲートウェイ（net/egress_gateway.ts）のほかに、ソケット・HTTP のクライアント・WebSocket を作らない', () => {
    const hits = sourceFiles()
      .filter((file) => !GATEWAY.includes(file))
      .flatMap((file) => codeLines(file).flatMap(({ no, text }) => OUTBOUND.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${file}:${no}: ${label}: ${text.trim()}`)));
    expect(hits).toEqual([]);
  });
});

describe('子プロセスは、通信するかを決めてある', () => {
  const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(|\bBun\.spawn(?:Sync)?\s*\(|from\s+['"](?:node:)?child_process['"]/;
  /** 通信する子プロセス。環境変数に egressChildProxyEnv() を重ねて、通信をゲートウェイに通す */
  const NETWORKED = ['src/services/yahoo.ts', 'src/services/address_builder.ts'];
  /** 通信しない子プロセス（本文の抽出・実行ファイルの版の問い合わせ）。Chromium は、起動の引数でゲートウェイを指す（browser_launch_plan.ts） */
  const OFFLINE = ['src/browser_engine.ts', 'src/extractor/rs_trafilatura.ts'];

  test('子プロセスを起こすのは、一覧のファイルだけ（足すときは、通信するかを決めて、一覧に足す）', () => {
    const spawners = sourceFiles().filter((file) => codeLines(file).some(({ text }) => SPAWN.test(text)));
    expect(spawners.sort()).toEqual([...NETWORKED, ...OFFLINE].sort());
  });

  test.each(NETWORKED)('通信する子プロセス（%s）は、環境変数に egressChildProxyEnv() を重ねる', (file) => {
    expect(codeLines(file).some(({ text }) => text.includes('egressChildProxyEnv('))).toBe(true);
  });
});

describe('起動の入口は、起動時の検査のあとに、fetch をゲートウェイに通す包みを入れる', () => {
  test.each(['src/index.ts', 'src/stdio.ts'])('%s', (file) => {
    const text = readFileSync(join(SRC, '..', file), 'utf8');
    const check = text.indexOf('checkStartupEnv(');
    const install = text.indexOf('installEgressFetch()');
    expect(check).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(check);
  });
});
