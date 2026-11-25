import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildDropError } from '../child_uid.js';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { withEnv } from '../test_fixtures/env.js';
import { installFakePdfLauncher } from '../test_fixtures/pdf_launcher.js';
import { extractMainContentWithRs } from './rs_trafilatura.js';
import { DEFAULT_RS_UID, RS_UID_COUNT, rsUidRange, withRsUid } from './rs_uid.js';

/**
 * 本文の抽出（rs-trafilatura）の別プロセスを、Sora 本体（root）とも Chromium とも PDF の解析とも別の uid に落とす（設計 2 の続き）。
 * 同時に動く抽出の数に上限が無いので、1 件に 1 つの uid を、広い範囲から渡す。共通の部品（child_uid.ts）の決め方は pdf_uid.test.ts が確かめる。
 * 実際に uid が落ちることの確認は、公開イメージでの実行（scripts/rs-uid-check.ts）。
 */

const dir = mkdtempSync(join(tmpdir(), 'sora-rs-uid-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
const okRs = () => script('ok-rs', `cat > /dev/null\nprintf '{"page_type":"article","content_html":"<p>body</p>"}'`);
const unavailable = () => getSecurityMetrics().sora_main_content_rs_uid_unavailable_total ?? 0;

let fake: ReturnType<typeof installFakePdfLauncher>;
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  fake = installFakePdfLauncher();
  resetSecurityMetrics();
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  fake.restore();
  warn.mockRestore();
});

const command = ['/usr/local/bin/rs-trafilatura', '--url', 'https://x.example/'];
const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

describe('uid の範囲', () => {
  test('既定は 64000 から 256 個（Chromium の 65532〜・PDF の 65530〜と重ならない）', () => {
    expect(DEFAULT_RS_UID).toBe(64000);
    expect(RS_UID_COUNT).toBe(256);
    expect(rsUidRange({})).toMatchObject({ first: 64000, last: 64255, setting: 'SORA_RS_TRAFILATURA_UID' });
  });

  test('off は範囲なし。数は基準になる', () => {
    expect(rsUidRange({ SORA_RS_TRAFILATURA_UID: 'off' })).toBeNull();
    expect(rsUidRange({ SORA_RS_TRAFILATURA_UID: '30000' })).toMatchObject({ first: 30000, last: 30255 });
  });
});

describe('withRsUid', () => {
  test('落とすとき: 起動用バイナリ経由で、uid 64000・作業ディレクトリ /。終わったら uid を片づける', async () => {
    const launch = await withRsUid(command, async (l) => l);
    expect(launch.command[0]).not.toBe(command[0]);
    expect(launch.command.slice(1)).toEqual(command.slice(1));
    expect(launch.env).toMatchObject({ SORA_LAUNCH_EXEC: command[0], SORA_LAUNCH_UID: '64000', HOME: '/nonexistent' });
    expect(launch.cwd).toBe('/');
    expect(fake.reaped).toEqual([64000]);
    expect(unavailable()).toBe(0);
  });

  test('落とさないとき（root でない）: コマンドはそのまま。環境変数と作業ディレクトリは指定しない', async () => {
    const { childDropProbe } = await import('../child_uid.js');
    childDropProbe.currentUid = () => 1000;
    const launch = await withRsUid(command, async (l) => l);
    expect(launch).toEqual({ command });
    expect(fake.reaped).toEqual([]);
  });

  test('同時の 2 件は、別の uid', async () => {
    const uids: Array<string | undefined> = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jobs = [0, 1].map(() =>
      withRsUid(command, async (l) => {
        uids.push(l.env?.SORA_LAUNCH_UID);
        await gate;
      }),
    );
    await Bun.sleep(20);
    release();
    await Promise.all(jobs);
    expect(uids.sort()).toEqual(['64000', '64001']);
  });

  test('256 件が同時に動いていて、空きが無ければ、run を呼ばずに ChildDropError。数える', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = Array.from({ length: RS_UID_COUNT }, () => withRsUid(command, () => gate));
    await Bun.sleep(20);
    let called = false;
    await expect(
      withRsUid(command, async () => {
        called = true;
      }),
    ).rejects.toThrow(ChildDropError);
    expect(called).toBe(false);
    expect(unavailable()).toBe(1);
    release();
    await Promise.all(held);
    await withRsUid(command, async () => {}); // 空けば、また使える
  });

  test('strict で落とせないなら、run を呼ばずに ChildDropError。数えて、1 回だけ知らせる', async () => {
    const { childDropProbe } = await import('../child_uid.js');
    childDropProbe.currentUid = () => 1000;
    let called = false;
    for (let i = 0; i < 2; i++) {
      await expect(
        withEnv({ SORA_ISOLATION: 'strict' }, () =>
          withRsUid(command, async () => {
            called = true;
          }),
        ),
      ).rejects.toThrow(ChildDropError);
    }
    expect(called).toBe(false);
    expect(unavailable()).toBe(2);
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('[Sora/rs-trafilatura]'))).toHaveLength(1);
    expect(warnings()).toContain('Readability');
  });

  test('PDF の解析の uid と重なる設定: standard は落とさずに警告し、strict は使わない', async () => {
    const env = { SORA_PDF_UID: '64100' };
    const launch = await withRsUid(command, async (l) => l, env);
    expect(launch).toEqual({ command });
    expect(warnings()).toContain('PDF の解析');
    await expect(withRsUid(command, async () => {}, { ...env, SORA_ISOLATION: 'strict' })).rejects.toThrow(ChildDropError);
  });

  test('Chromium の uid と重なる設定: standard は落とさない。strict は、プロセスの数の範囲で調べて使わない', async () => {
    expect(await withRsUid(command, async (l) => l, { SORA_BROWSER_UID: '64255' })).toEqual({ command });
    expect(warnings()).toContain('Chromium');
    // strict は 4 つ分（64252〜64255）で重なる。standard の 1 つ分なら重ならない
    expect((await withRsUid(command, async (l) => l, { SORA_BROWSER_UID: '64256' })).cwd).toBe('/');
    await expect(withRsUid(command, async () => {}, { SORA_BROWSER_UID: '64253', SORA_ISOLATION: 'strict' })).rejects.toThrow(ChildDropError);
  });

  test('ブラウザの uid の範囲は、standard は 1 つ分、strict はプロセスの数ぶんで調べる（抽出の範囲の手前に置いて、違いが出る位置で確かめる）', async () => {
    // 基準 63998: 1 つ分なら 63998 だけ（重ならない）。strict の 4 つ分は 63998〜64001（抽出の 64000 と重なる）
    const env = { SORA_BROWSER_UID: '63998' };
    expect((await withRsUid(command, async (l) => l, env)).cwd).toBe('/');
    expect(warnings()).toBe('');
    await expect(withRsUid(command, async () => {}, { ...env, SORA_ISOLATION: 'strict' })).rejects.toThrow(ChildDropError);
  });

  test('渡した環境の SORA_RS_TRAFILATURA_UID を読む（プロセスの環境ではなく）', async () => {
    const launch = await withRsUid(command, async (l) => l, { SORA_RS_TRAFILATURA_UID: '30000' });
    expect(launch.env).toMatchObject({ SORA_LAUNCH_UID: '30000' });
    expect(fake.reaped).toEqual([30000]);
  });

  test('既定の組み合わせは、どれとも重ならず、警告もない', async () => {
    await withRsUid(command, async () => {}, { SORA_ISOLATION: 'strict' });
    expect(warnings()).toBe('');
  });
});

describe('extractMainContentWithRs（起動用バイナリ経由）', () => {
  test('抽出は別の uid で動き、結果は同じ。終わったら uid を片づける', async () => {
    const result = await extractMainContentWithRs('<html><body><p>x</p></body></html>', 'https://x.example/', okRs());
    expect(result).toEqual({ pageType: 'article', contentHtml: '<p>body</p>' });
    expect(fake.launches()).toHaveLength(1);
    expect(fake.launches()[0]).toContain('uid=64000 gid=64000');
    expect(fake.reaped).toEqual([64000]);
  });

  test('子は、作業ディレクトリ / と、書けない HOME で動く', async () => {
    const bin = script('cwd-rs', `cat > /dev/null\nprintf '{"content_html":"%s|%s"}' "$(pwd)" "$HOME"`);
    expect((await extractMainContentWithRs('<html></html>', 'https://x.example/', bin))?.contentHtml).toBe('/|/nonexistent');
  });

  test('strict で落とせないときは、コマンドを動かさず、undefined（呼び出し側は Readability に戻る）', async () => {
    const { childDropProbe } = await import('../child_uid.js');
    childDropProbe.currentUid = () => 1000;
    const marker = join(dir, 'ran');
    const bin = script('marker-rs', `touch '${marker}'\ncat > /dev/null\nprintf '{"content_html":"<p>x</p>"}'`);
    expect(await withEnv({ SORA_ISOLATION: 'strict' }, () => extractMainContentWithRs('<html></html>', 'https://x.example/', bin))).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(unavailable()).toBe(1);
    expect(getSecurityMetrics().sora_main_content_rs_empty_total ?? 0).toBe(0);
    expect(getSecurityMetrics().sora_main_content_rs_failed_total ?? 0).toBe(0);
  });
});

describe('抽出の子が、本体を待たせ続けない', () => {
  test('時間の上限で、SIGTERM を無視する子も止める', async () => {
    const bin = script('stubborn-rs', `trap '' TERM\ncat > /dev/null\nwhile :; do sleep 1; done`);
    const started = Date.now();
    expect(await extractMainContentWithRs('<html></html>', 'https://x.example/', bin)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(9000);
  }, 20_000);

  test('子が終わっても、孫が標準出力を握ったままなら、少し待って打ち切り、読めた出力を使う', async () => {
    const bin = script('daemon-rs', `cat > /dev/null\nsleep 4 &\nprintf '{"content_html":"<p>kept</p>"}'`);
    const started = Date.now();
    expect((await extractMainContentWithRs('<html></html>', 'https://x.example/', bin))?.contentHtml).toBe('<p>kept</p>');
    expect(Date.now() - started).toBeLessThan(3000);
  }, 20_000);
});
