import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStrictStartup, STARTUP_PROBE_TENANT, sweepStaleProfileDirs, verifyStrictBrowser } from './browser_startup.js';

/**
 * strict の起動の確認（設計 2。段階 8）: 前回の実行が異常終了して残った Chromium のプロファイルの掃除と、Chromium の試し起動。
 * 掃除は、実際のファイルと実際のプロセスで確かめる。ほかの Sora が使っている /tmp を触らないよう、専用の親ディレクトリを渡す。
 */

let parent: string;
const children: Array<{ pid: number }> = [];
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'sora-sweep-test-'));
});
afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {}
  }
  rmSync(parent, { recursive: true, force: true });
});

const profile = (name: string, withFile = true) => {
  const path = join(parent, name);
  mkdirSync(join(path, 'Default'), { recursive: true });
  if (withFile) writeFileSync(join(path, 'Default', 'Cookies'), 'secret');
  return path;
};
/** Chromium のふりをする別プロセス: 引数に --user-data-dir=<path> を持って、生きている */
const liveChromium = (path: string) => {
  // exec にしない（sh が sleep に置き換わると、引数が消える）。`; true` で、sh が子として sleep を動かし続ける
  const child = Bun.spawn(['sh', '-c', 'sleep 60; true', 'sh', `--user-data-dir=${path}`], { stdout: 'ignore', stderr: 'ignore' });
  children.push({ pid: child.pid });
  return child.pid;
};
const waitForCmdline = async (pid: number, needle: string) => {
  for (let i = 0; i < 100; i++) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(needle)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('プロセスの引数が見えない');
};

describe('sweepStaleProfileDirs（前回の実行が残したプロファイルを消す）', () => {
  test('Chromium が動いていないプロファイル（sora-chromium-XXXXXX）を、中身ごと消す', () => {
    const stale = profile('sora-chromium-abc123');
    const result = sweepStaleProfileDirs({ dir: parent, commandLines: () => [] });
    expect(result.removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(result.failed).toEqual([]);
  });

  test.skipIf(process.platform !== 'linux')('Chromium が動いているプロファイル（引数に --user-data-dir=<path> を持つプロセスがある）は、消さない（実プロセスと /proc。Linux だけ）', async () => {
    const live = profile('sora-chromium-live01');
    const stale = profile('sora-chromium-old001');
    const pid = liveChromium(live);
    await waitForCmdline(pid, live);
    const result = sweepStaleProfileDirs({ dir: parent });
    expect(result.removed).toEqual([stale]);
    expect(result.inUse).toEqual([live]);
    expect(existsSync(join(live, 'Default', 'Cookies'))).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  test.skipIf(process.platform !== 'linux')('そのプロセスが終われば、次の掃除で消える（動いているかは、毎回プロセスから決める。実プロセスと /proc。Linux だけ）', async () => {
    const live = profile('sora-chromium-live02');
    const pid = liveChromium(live);
    await waitForCmdline(pid, live);
    expect(sweepStaleProfileDirs({ dir: parent }).removed).toEqual([]);
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100 && existsSync(`/proc/${pid}/cmdline`) && readFileSync(`/proc/${pid}/cmdline`, 'utf8') !== ''; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sweepStaleProfileDirs({ dir: parent }).removed).toEqual([live]);
  });

  test('名前が合わないもの・ファイル・シンボリックリンクは、触らない（リンクの先も消さない）', () => {
    const victim = join(parent, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep'), 'x');
    symlinkSync(victim, join(parent, 'sora-chromium-link01'));
    writeFileSync(join(parent, 'sora-chromium-file01'), 'x');
    const odd = [profile('sora-chromium-short'), profile('sora-chromium-toolong1'), profile('other-abc123'), profile('sora-chromium-abc12!')];
    const result = sweepStaleProfileDirs({ dir: parent, commandLines: () => [] });
    expect(result.removed).toEqual([]);
    expect(existsSync(join(victim, 'keep'))).toBe(true);
    expect(existsSync(join(parent, 'sora-chromium-link01'))).toBe(true);
    expect(existsSync(join(parent, 'sora-chromium-file01'))).toBe(true);
    for (const path of odd) expect(existsSync(path), path).toBe(true);
  });

  test('消せなかったものは、failed に理由を入れて返す。ほかのものの掃除は続ける', () => {
    const a = profile('sora-chromium-aaaaaa');
    const b = profile('sora-chromium-bbbbbb');
    const result = sweepStaleProfileDirs({
      dir: parent,
      commandLines: () => [],
      remove: (path) => {
        if (path === a) throw new Error('EACCES: permission denied');
        rmSync(path, { recursive: true, force: true });
      },
    });
    expect(result.removed).toEqual([b]);
    expect(result.failed).toEqual([{ path: a, error: 'EACCES: permission denied' }]);
    expect(existsSync(a)).toBe(true);
  });

  test('プロセスの一覧を読めないとき（/proc が無い）は、動いているか分からないので、何も消さない', () => {
    const path = profile('sora-chromium-abc123');
    const result = sweepStaleProfileDirs({ dir: parent, commandLines: () => undefined });
    expect(result).toMatchObject({ removed: [], inUse: [], skipped: 'processes-unreadable' });
    expect(existsSync(path)).toBe(true);
  });

  test('親のディレクトリが無くても、例外にしない（何もしない）', () => {
    expect(sweepStaleProfileDirs({ dir: join(parent, 'nope') })).toMatchObject({ removed: [], failed: [] });
  });

  test('引数の途中に path を含むプロセス（子プロセスの --database=<path>/Crashpad など）も、使用中として、消さない', () => {
    const path = profile('sora-chromium-abc123');
    const result = sweepStaleProfileDirs({ dir: parent, commandLines: () => [`chrome_crashpad_handler\0--database=${path}/Crashpad\0`] });
    expect(result.inUse).toEqual([path]);
    expect(existsSync(path)).toBe(true);
  });
});

describe('verifyStrictBrowser（Chromium の試し起動）', () => {
  const browserFake = () => ({ browser: {} as never, isDedicated: false });

  test('起動でき、サンドボックスが有効なら、通る。専用の tenant で起動し、確かめたあとは閉じる', async () => {
    const calls: string[] = [];
    const result = await verifyStrictBrowser({
      chromiumAvailable: true,
      getBrowser: async (proxy, tenant) => {
        calls.push(`get:${proxy}:${tenant}`);
        return browserFake();
      },
      closeAll: async () => void calls.push('close'),
      sandboxStatus: () => 'on',
    });
    expect(result).toEqual({ status: 'ok' });
    expect(calls).toEqual([`get:undefined:${STARTUP_PROBE_TENANT}`, 'close']);
  });

  test('試し起動の tenant は、利用者の tenant（name:・key:・legacy）と重ならない', () => {
    expect(STARTUP_PROBE_TENANT).not.toMatch(/^(name:|key:|legacy$|public$)/);
  });

  test('起動に失敗したら、理由を添えて断る。それでも閉じる', async () => {
    let closed = false;
    const result = await verifyStrictBrowser({
      chromiumAvailable: true,
      getBrowser: async () => {
        throw new Error('Chromium が見つからない');
      },
      closeAll: async () => void (closed = true),
      sandboxStatus: () => 'unknown',
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.problem).toContain('Chromium が見つからない');
    expect(closed).toBe(true);
  });

  test('サンドボックスで起動できなかったときは、包んだ文（auto にするか、という助言を含む）でなく、元の原因を出す（strict は auto に戻せない）', async () => {
    const wrapped = new Error('SORA_BROWSER_SANDBOX=on だが、サンドボックスを有効にして Chromium を起動できなかった（ユーザー名前空間を作れない環境では、auto にするか、README 4.5 の seccomp プロファイルを渡す）:Protocol error (Target.setDiscoverTargets): Target closed', {
      cause: new Error('Protocol error (Target.setDiscoverTargets): Target closed'),
    });
    const result = await verifyStrictBrowser({
      chromiumAvailable: true,
      getBrowser: async () => {
        throw wrapped;
      },
      closeAll: async () => {},
      sandboxStatus: () => 'unknown',
    });
    const problem = result.status === 'failed' ? result.problem : '';
    expect(problem).toContain('Target closed');
    expect(problem).not.toContain('auto にするか');
    // 助言は 1 つ（strict は auto に戻せない、と言う）
    expect(problem.match(/auto/g)?.length).toBe(1);
    expect(problem).toContain('auto には戻せません');
  });

  test('いちばん奥の原因の文が空でも（puppeteer の ProtocolError は文が空。実機で確かめた形）、その手前の、空でない文を出す', async () => {
    const real = new Error('SORA_BROWSER_SANDBOX=on だが、サンドボックスを有効にして Chromium を起動できなかった（auto にするか、…）', {
      cause: new Error('Protocol error (Target.setDiscoverTargets): Target closed', { cause: new Error('') }),
    });
    const result = await verifyStrictBrowser({ chromiumAvailable: true, getBrowser: async () => Promise.reject(real), closeAll: async () => {}, sandboxStatus: () => 'unknown' });
    const problem = result.status === 'failed' ? result.problem : '';
    expect(problem).toContain('起動できませんでした: Protocol error (Target.setDiscoverTargets): Target closed（');
    // 全部が空なら、いちばん外側の文
    const empty = await verifyStrictBrowser({ chromiumAvailable: true, getBrowser: async () => Promise.reject(new Error('外側の文', { cause: new Error('  ') })), closeAll: async () => {}, sandboxStatus: () => 'unknown' });
    expect(empty.status === 'failed' && empty.problem).toContain('起動できませんでした: 外側の文（');
  });

  test('原因の連鎖が深くても、いちばん奥の原因を出す。原因が Error でないときは、その文字', async () => {
    const deep = new Error('外側', { cause: new Error('中', { cause: new Error('奥') }) });
    for (const [thrown, expected] of [[deep, '奥'], [new Error('外側', { cause: 'ただの文字' }), '外側'], ['文字だけ', '文字だけ']] as const) {
      const result = await verifyStrictBrowser({ chromiumAvailable: true, getBrowser: async () => Promise.reject(thrown), closeAll: async () => {}, sandboxStatus: () => 'unknown' });
      expect(result.status === 'failed' && result.problem, String(expected)).toContain(expected);
    }
  });

  test('起動できても、サンドボックスが on でなければ断る（auto で戻された場合に備える）', async () => {
    for (const status of ['off', 'unknown'] as const) {
      const result = await verifyStrictBrowser({ chromiumAvailable: true, getBrowser: async () => browserFake(), closeAll: async () => {}, sandboxStatus: () => status });
      expect(result.status, status).toBe('failed');
      expect(result.status === 'failed' && result.problem).toContain('サンドボックス');
    }
  });

  test('Chromium が無いときは、起動を試さずに省く', async () => {
    let launched = false;
    const result = await verifyStrictBrowser({
      chromiumAvailable: false,
      getBrowser: async () => {
        launched = true;
        return browserFake();
      },
      closeAll: async () => {},
      sandboxStatus: () => 'unknown',
    });
    expect(result).toEqual({ status: 'skipped' });
    expect(launched).toBe(false);
  });

  test('閉じるのに失敗しても、確かめた結果は変えない（閉じる失敗は握る）', async () => {
    const result = await verifyStrictBrowser({
      chromiumAvailable: true,
      getBrowser: async () => browserFake(),
      closeAll: async () => {
        throw new Error('close failed');
      },
      sandboxStatus: () => 'on',
    });
    expect(result).toEqual({ status: 'ok' });
  });
});

describe('runStrictStartup（待ち受ける前の、strict の起動の確認）', () => {
  const run = async (deps: Partial<Parameters<typeof runStrictStartup>[0]>) => {
    const lines: string[] = [];
    const exits: number[] = [];
    await runStrictStartup({
      stderr: (line) => lines.push(line),
      exit: (code) => void exits.push(code),
      isStrict: () => true,
      sweep: () => ({ removed: [], inUse: [], failed: [] }),
      verify: async () => ({ status: 'ok' }),
      ...deps,
    });
    return { lines, exits };
  };

  test('strict でなければ、何もしない（掃除も、試し起動も、出力も）', async () => {
    let touched = false;
    const { lines, exits } = await run({
      isStrict: () => false,
      sweep: () => {
        touched = true;
        return { removed: [], inUse: [], failed: [] };
      },
      verify: async () => {
        touched = true;
        return { status: 'ok' };
      },
    });
    expect({ touched, lines, exits }).toEqual({ touched: false, lines: [], exits: [] });
  });

  test('掃除してから、試し起動する（前回の残りが、起動に混ざらないように）', async () => {
    const order: string[] = [];
    await run({
      sweep: () => {
        order.push('sweep');
        return { removed: [], inUse: [], failed: [] };
      },
      verify: async () => {
        order.push('verify');
        return { status: 'ok' };
      },
    });
    expect(order).toEqual(['sweep', 'verify']);
  });

  test('消したプロファイルがあれば、件数を知らせる。何も消さなければ、黙る', async () => {
    const swept = await run({ sweep: () => ({ removed: ['/tmp/sora-chromium-aaaaaa', '/tmp/sora-chromium-bbbbbb'], inUse: [], failed: [] }) });
    expect(swept.lines.join('\n')).toContain('2 個');
    expect(swept.lines.join('\n')).toContain('前回');
    expect(swept.exits).toEqual([]);
    const quiet = await run({});
    expect(quiet.lines.filter((line) => line.includes('前回'))).toEqual([]);
  });

  test('消せなかったものがあれば、起動を断る（残したまま起動すると、同じ uid をもらった別の tenant に読まれうる）。試し起動は始めない', async () => {
    let verified = false;
    const { lines, exits } = await run({
      sweep: () => ({ removed: [], inUse: [], failed: [{ path: '/tmp/sora-chromium-aaaaaa', error: 'EACCES' }] }),
      verify: async () => {
        verified = true;
        return { status: 'ok' };
      },
    });
    expect(exits).toEqual([1]);
    expect(verified).toBe(false);
    expect(lines.join('\n')).toContain('エラー');
    expect(lines.join('\n')).toContain('/tmp/sora-chromium-aaaaaa');
    expect(lines.join('\n')).toContain('EACCES');
    expect(lines.join('\n')).toContain('起動しません');
    expect(lines.join('\n')).not.toContain('通りました');
  });

  test('消せなかったものが複数あるときは、すべてを出す', async () => {
    const { lines } = await run({
      sweep: () => ({
        removed: [],
        inUse: [],
        failed: [
          { path: '/tmp/sora-chromium-aaaaaa', error: 'EACCES' },
          { path: '/tmp/sora-chromium-bbbbbb', error: 'EBUSY' },
        ],
      }),
    });
    expect(lines.filter((line) => line.includes('エラー'))).toHaveLength(2);
  });

  test('Chromium が動いているために残したものは、警告する（前の Chromium が残っているか、同じ一時ディレクトリを使う別の Sora がある）。起動は続ける', async () => {
    const { lines, exits } = await run({ sweep: () => ({ removed: [], inUse: ['/tmp/sora-chromium-live01'], failed: [] }) });
    expect(exits).toEqual([]);
    expect(lines.join('\n')).toContain('警告');
    expect(lines.join('\n')).toContain('/tmp/sora-chromium-live01');
    expect(lines.join('\n')).toContain('通りました');
  });

  test('プロセスの一覧を読めなくて掃除を省いたときは、警告する', async () => {
    const { lines, exits } = await run({ sweep: () => ({ removed: [], inUse: [], failed: [], skipped: 'processes-unreadable' }) });
    expect(exits).toEqual([]);
    expect(lines.join('\n')).toContain('警告');
  });

  test('試し起動に失敗したら、理由を出して exit(1)。通ったと知らせない', async () => {
    const { lines, exits } = await run({ verify: async () => ({ status: 'failed', problem: 'Chromium を起動できません' }) });
    expect(exits).toEqual([1]);
    expect(lines.join('\n')).toContain('エラー');
    expect(lines.join('\n')).toContain('Chromium を起動できません');
    expect(lines.join('\n')).toContain('起動しません');
    expect(lines.join('\n')).not.toContain('通りました');
  });

  test('試し起動が通ったら、そのことを 1 行で知らせる。Chromium が無くて省いたときは、警告する', async () => {
    const ok = await run({});
    expect(ok.exits).toEqual([]);
    expect(ok.lines.filter((line) => line.includes('通りました'))).toHaveLength(1);
    const skipped = await run({ verify: async () => ({ status: 'skipped' }) });
    expect(skipped.exits).toEqual([]);
    expect(skipped.lines.join('\n')).toContain('警告');
    expect(skipped.lines.join('\n')).toContain('Chromium');
    expect(skipped.lines.join('\n')).not.toContain('通りました');
  });
});
