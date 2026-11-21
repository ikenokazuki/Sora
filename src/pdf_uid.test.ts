import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LAUNCHER } from './browser_launch_plan.js';
import { parsePdfToMarkdown } from './pdf.js';
import { DEFAULT_PDF_UID, droppedChild, PdfDropError, pdfDropProbe, PdfUidPool, planPdfDrop, resetPdfDropWarnings, withPdfUid } from './pdf_uid.js';
import { withEnv } from './test_fixtures/env.js';
import { makePdf } from './test_fixtures/pdf.js';
import { installFakePdfLauncher } from './test_fixtures/pdf_launcher.js';

/**
 * PDF の解析の別プロセスを、Sora 本体（root）とも Chromium とも別の uid に落とす（設計 2 の続き。穴 26）。
 * 実際に uid が落ちることの確認は、公開イメージでの実行（scripts/pdf-uid-check.ts。設計書の E48）。ここは、決め方・番号の割り当て・つなぎ方。
 */

const base = { env: {}, strict: false, currentUid: 0 as number | undefined, launcherExists: true, size: 2 };

/** 落とせずに終わる起動用バイナリ（本物は、uid・gid を落とせないと、この文を出して終了コード 126 で終わる） */
const failingDir = mkdtempSync(join(tmpdir(), 'pdf-uid-fail-'));
const failingLauncher = join(failingDir, 'launch.sh');
writeFileSync(failingLauncher, "#!/bin/sh\necho 'sora-chromium-launch: 落とせなかった' >&2\nexit 126\n");
chmodSync(failingLauncher, 0o755);
afterAll(() => rmSync(failingDir, { recursive: true, force: true }));

describe('planPdfDrop（別 uid に落とすか）: standard', () => {
  test('root で、起動用バイナリがあれば、既定の uid（65530）から落とす。警告はない', () => {
    expect(planPdfDrop(base)).toEqual({ drop: { baseUid: DEFAULT_PDF_UID, launcher: DEFAULT_LAUNCHER }, warnings: [] });
    expect(DEFAULT_PDF_UID).toBe(65530);
  });

  test('SORA_PDF_UID=off（大文字小文字・前後の空白は問わない）で、落とさない', () => {
    expect(planPdfDrop({ ...base, env: { SORA_PDF_UID: ' OFF ' } })).toEqual({ drop: null, warnings: [] });
  });

  test('SORA_PDF_UID に数を入れると、その uid から落とす。auto は既定と同じ', () => {
    expect(planPdfDrop({ ...base, env: { SORA_PDF_UID: '10001' } }).drop?.baseUid).toBe(10001);
    expect(planPdfDrop({ ...base, env: { SORA_PDF_UID: 'auto' } }).drop?.baseUid).toBe(DEFAULT_PDF_UID);
  });

  test('不正な SORA_PDF_UID（数でない・0・負・大きすぎる）は、既定に戻して警告する', () => {
    for (const bad of ['abc', '0', '-5', '4294967295', '1.5', '65530x']) {
      const { drop, warnings } = planPdfDrop({ ...base, env: { SORA_PDF_UID: bad } });
      expect(drop?.baseUid, bad).toBe(DEFAULT_PDF_UID);
      expect(warnings.join('\n'), bad).toContain('SORA_PDF_UID');
    }
  });

  test('root でない（または uid が分からない）なら、落とさない。落とす元が無いので、警告もしない', () => {
    expect(planPdfDrop({ ...base, currentUid: 1000 })).toEqual({ drop: null, warnings: [] });
    expect(planPdfDrop({ ...base, currentUid: undefined })).toEqual({ drop: null, warnings: [] });
  });

  test('起動用バイナリがなければ（自分で作ったイメージ）、落とさない', () => {
    expect(planPdfDrop({ ...base, launcherExists: false })).toEqual({ drop: null, warnings: [] });
  });

  test('capability が足りなければ、auto は警告して落とさず（従来どおり）、足す capability を案内する', () => {
    const { drop, warnings } = planPdfDrop({ ...base, missingCapabilities: ['CAP_SETUID', 'CAP_KILL'] });
    expect(drop).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CAP_SETUID, CAP_KILL');
    expect(warnings[0]).toContain('--cap-add=SETUID --cap-add=KILL');
    expect(warnings[0]).toContain('SORA_PDF_UID=off');
  });

  test('不正な値（auto として扱う）は、数を明示したことにならない。capability が足りなければ、警告で済ませる', () => {
    const { drop, warnings } = planPdfDrop({ ...base, env: { SORA_PDF_UID: 'abc' }, missingCapabilities: ['CAP_SETUID'] });
    expect(drop).toBeNull();
    expect(warnings.join('\n')).toContain('capability が足りない');
  });

  test('capability が足りないとき、数を明示していれば失敗させる（黙って弱くしない）', () => {
    expect(() => planPdfDrop({ ...base, env: { SORA_PDF_UID: '10001' }, missingCapabilities: ['CAP_SETUID'] })).toThrow(PdfDropError);
  });

  test('落とさないと決まっているとき（off・root でない・バイナリなし）は、capability が足りなくても警告しない', () => {
    const missing = ['CAP_SETUID'];
    expect(planPdfDrop({ ...base, env: { SORA_PDF_UID: 'off' }, missingCapabilities: missing }).warnings).toEqual([]);
    expect(planPdfDrop({ ...base, currentUid: 1000, missingCapabilities: missing }).warnings).toEqual([]);
    expect(planPdfDrop({ ...base, launcherExists: false, missingCapabilities: missing }).warnings).toEqual([]);
  });

  test('番号を足した最後の uid が、uid の最大を超えるなら失敗させる', () => {
    expect(() => planPdfDrop({ ...base, env: { SORA_PDF_UID: '4294967294' } })).toThrow(PdfDropError);
    // 最後がちょうど最大なら通る
    expect(planPdfDrop({ ...base, env: { SORA_PDF_UID: '4294967293' } }).drop?.baseUid).toBe(4_294_967_293);
  });

  test('Chromium の uid の範囲と重なるなら、落とさず（従来どおり）警告する。落とすと、解析のあとの片づけが Chromium まで終わらせる', () => {
    const { drop, warnings } = planPdfDrop({ ...base, browser: { first: 65531, last: 65534 } });
    expect(drop).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Chromium');
    expect(warnings[0]).toContain('SORA_PDF_UID');
    expect(warnings[0]).toContain('片づけ');
  });

  test('Chromium の範囲の最後の uid が、PDF の最初の uid と同じでも、重なる（両端を含む）', () => {
    const { drop, warnings } = planPdfDrop({ ...base, browser: { first: 65528, last: 65530 } });
    expect(drop).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test('Chromium の uid の範囲と重ならなければ、警告しない（範囲の境目は、隣り合っても重ならない）', () => {
    expect(planPdfDrop({ ...base, browser: { first: 65532, last: 65535 } }).warnings).toEqual([]);
    expect(planPdfDrop({ ...base, browser: null }).warnings).toEqual([]);
    expect(planPdfDrop({ ...base, browser: { first: 65528, last: 65529 } }).warnings).toEqual([]);
  });

  test('起動用バイナリの場所を替えられる', () => {
    expect(planPdfDrop({ ...base, launcher: '/opt/launch' }).drop?.launcher).toBe('/opt/launch');
  });
});

describe('planPdfDrop: strict（落とせないものは、黙って弱い側に戻らず、失敗させる）', () => {
  const strict = { ...base, strict: true };

  test('すべて整っていれば、落とす', () => {
    expect(planPdfDrop(strict).drop).toEqual({ baseUid: DEFAULT_PDF_UID, launcher: DEFAULT_LAUNCHER });
  });

  test('SORA_PDF_UID=off は使えない', () => {
    expect(() => planPdfDrop({ ...strict, env: { SORA_PDF_UID: 'off' } })).toThrow(/SORA_ISOLATION=strict.*SORA_PDF_UID=off/s);
  });

  test('root でない・uid が分からないなら失敗する', () => {
    expect(() => planPdfDrop({ ...strict, currentUid: 1000 })).toThrow(/root/);
    expect(() => planPdfDrop({ ...strict, currentUid: undefined })).toThrow(PdfDropError);
  });

  test('起動用バイナリが無ければ失敗する。場所を案内する', () => {
    expect(() => planPdfDrop({ ...strict, launcherExists: false })).toThrow(DEFAULT_LAUNCHER);
  });

  test('capability が足りなければ失敗する。足すものを案内する（auto でも、警告で済ませない）', () => {
    expect(() => planPdfDrop({ ...strict, missingCapabilities: ['CAP_KILL'] })).toThrow(/CAP_KILL.*--cap-add=KILL/s);
  });

  test('Chromium の uid の範囲と重なるなら失敗する', () => {
    expect(() => planPdfDrop({ ...strict, browser: { first: 65531, last: 65534 } })).toThrow(/Chromium/);
  });

  test('番号を足した uid が最大を超えるなら失敗する', () => {
    expect(() => planPdfDrop({ ...strict, env: { SORA_PDF_UID: '4294967294' } })).toThrow(PdfDropError);
  });

  test('失敗は PdfDropError（利用者に見せる文ではなく、運用者への案内）', () => {
    try {
      planPdfDrop({ ...strict, currentUid: 1000 });
      throw new Error('投げなかった');
    } catch (error) {
      expect(error).toBeInstanceOf(PdfDropError);
      expect((error as Error).name).toBe('PdfDropError');
    }
  });
});

describe('droppedChild（起動用バイナリ経由の起動コマンド）', () => {
  const source = { PATH: '/usr/bin', HOME: '/root', TZ: 'UTC', SORA_API_KEY: 'secret-key', AWS_SECRET_ACCESS_KEY: 'aws-secret' };

  test('起動用バイナリが先頭になり、本物の実行ファイルは SORA_LAUNCH_EXEC に移る。残りの引数は、そのまま', () => {
    const launch = droppedChild(['/usr/local/bin/bun', '--no-env-file', '/app/pdf-parse.js', '--params', '{"a":1}'], '/usr/local/bin/launch', 65531, 65533, source);
    expect(launch.command).toEqual(['/usr/local/bin/launch', '--no-env-file', '/app/pdf-parse.js', '--params', '{"a":1}']);
    expect(launch.env).toMatchObject({ SORA_LAUNCH_EXEC: '/usr/local/bin/bun', SORA_LAUNCH_UID: '65531', SORA_LAUNCH_GID: '65533' });
  });

  test('環境変数は許可リストのものだけ（運用者の秘密は渡さない）。SORA_LAUNCH_* は足される', () => {
    const { env } = droppedChild(['/usr/local/bin/bun', 'x'], '/l', 65530, 65530, source);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'SORA_LAUNCH_EXEC', 'SORA_LAUNCH_GID', 'SORA_LAUNCH_UID', 'TZ']);
    expect(JSON.stringify(env)).not.toContain('secret');
  });

  test('元のコマンドの配列は書き換えない', () => {
    const command = ['/usr/local/bin/bun', 'x'];
    droppedChild(command, '/l', 65530, 65530, source);
    expect(command).toEqual(['/usr/local/bin/bun', 'x']);
  });
});

describe('PdfUidPool（同時に動く別プロセスどうしが、同じ uid を持たない）', () => {
  const noop = async () => true;

  test('使っていない最小の番号の uid を渡す。基準の uid + 番号', async () => {
    const pool = new PdfUidPool(2, noop);
    const a = await pool.lease(65530);
    const b = await pool.lease(65530);
    expect([a.uid, b.uid]).toEqual([65530, 65531]);
    expect([a.gid, b.gid]).toEqual([65530, 65531]);
  });

  test('空きが無ければ（同時の数を超えて借りれば）失敗する', async () => {
    const pool = new PdfUidPool(2, noop);
    await pool.lease(65530);
    await pool.lease(65530);
    await expect(pool.lease(65530)).rejects.toThrow(PdfDropError);
  });

  test('返したら、その番号をまた渡せる（最小の番号から）', async () => {
    const pool = new PdfUidPool(2, noop);
    const a = await pool.lease(65530);
    const b = await pool.lease(65530);
    await a.done();
    const c = await pool.lease(65530);
    expect(c.uid).toBe(a.uid);
    await b.done();
    await c.done();
  });

  test('返すときに、その uid のプロセスが残っていないかを確かめる。確かめている間は、その番号を渡さない', async () => {
    const reaped: number[] = [];
    let finish: (clean: boolean) => void = () => {};
    const pool = new PdfUidPool(1, (uid) => {
      reaped.push(uid);
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    const a = await pool.lease(65530);
    const returning = a.done();
    await expect(pool.lease(65530)).rejects.toThrow(PdfDropError); // 確かめ中は、まだ空かない
    finish(true);
    await returning;
    expect(reaped).toEqual([65530]); // 確かめは、返すときの 1 回だけ（空きが無いだけの失敗では、確かめない）
    const again = await pool.lease(65530);
    expect(again.uid).toBe(65530);
  });

  test('返す確かめは 1 回ずつ（返すたびに 1 回。借りるだけでは確かめない）', async () => {
    const reaped: number[] = [];
    const pool = new PdfUidPool(2, async (uid) => {
      reaped.push(uid);
      return true;
    });
    const a = await pool.lease(65530);
    expect(reaped).toEqual([]);
    await a.done();
    expect(reaped).toEqual([65530]);
  });

  test('done を 2 回呼んでも、確かめも手放しも 1 回だけ（別の借り手の番号を手放さない）', async () => {
    const reaped: number[] = [];
    const pool = new PdfUidPool(2, async (uid) => {
      reaped.push(uid);
      return true;
    });
    const a = await pool.lease(65530);
    await a.done();
    const b = await pool.lease(65530); // a と同じ番号を、b が借りる
    await a.done(); // 2 回目: b の番号を手放してはいけない
    const c = await pool.lease(65530);
    expect([b.uid, c.uid]).toEqual([65530, 65531]);
    expect(reaped).toEqual([65530]);
  });

  test('プロセスが残っていた uid は、渡さない（隔離して、残りの番号だけを使う）', async () => {
    const pool = new PdfUidPool(2, async (uid) => uid !== 65530);
    const a = await pool.lease(65530);
    expect(a.uid).toBe(65530);
    await a.done(); // 65530 は片づかなかった
    const b = await pool.lease(65530);
    expect(b.uid).toBe(65531);
  });

  test('隔離した uid は、あとで片づいていれば、また渡す（借りようとしたときに、もう一度確かめる）', async () => {
    let clean = false;
    const reaped: number[] = [];
    const pool = new PdfUidPool(1, async (uid) => {
      reaped.push(uid);
      return clean;
    });
    const a = await pool.lease(65530);
    await a.done(); // 片づかない
    await expect(pool.lease(65530)).rejects.toThrow(PdfDropError); // 空きも無く、まだ片づかない
    clean = true;
    const b = await pool.lease(65530);
    expect(b.uid).toBe(65530);
    expect(reaped).toEqual([65530, 65530, 65530]);
  });

  test('片づいて戻した uid は、隔離の記録から消える（あとで空きが無いときに、また確かめない）', async () => {
    let clean = false;
    const reaped: number[] = [];
    const pool = new PdfUidPool(1, async (uid) => {
      reaped.push(uid);
      return clean;
    });
    const a = await pool.lease(65530);
    await a.done(); // 片づかない（確かめ 1 回）
    clean = true;
    const b = await pool.lease(65530); // 片づいたので戻す（確かめ 2 回）。b が借りた
    expect(reaped).toEqual([65530, 65530]);
    await expect(pool.lease(65530)).rejects.toThrow(PdfDropError); // 空きは無いが、隔離中の uid は無い: 確かめない
    expect(reaped).toEqual([65530, 65530]);
    await b.done();
  });

  test('片づかなかった uid を隔離したときは、運用者に知らせる（uid と、その後の動き）。片づいたときは、知らせない', async () => {
    const warnings: string[] = [];
    const pool = new PdfUidPool(2, async (uid) => uid !== 65530, (message) => warnings.push(message));
    const clean = await pool.lease(65530); // 65530（片づかない）
    const other = await pool.lease(65530); // 65531（片づく）
    await other.done();
    expect(warnings).toEqual([]);
    await clean.done();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('65530');
    expect(warnings[0]).toContain('隔離');
  });

  test('確かめが例外になっても、片づいたとはみなさない（隔離する）。done は投げない', async () => {
    const pool = new PdfUidPool(1, async () => {
      throw new Error('boom');
    });
    const a = await pool.lease(65530);
    await a.done();
    await expect(pool.lease(65530)).rejects.toThrow(PdfDropError);
  });

  test('借りるときの基準が前と違っても、隔離していた uid は、その uid のまま確かめる', async () => {
    const reaped: number[] = [];
    let clean = false;
    const pool = new PdfUidPool(1, async (uid) => {
      reaped.push(uid);
      return clean;
    });
    const a = await pool.lease(65530);
    await a.done();
    clean = true;
    const b = await pool.lease(40000); // 基準が替わった
    expect(reaped[1]).toBe(65530); // 隔離していたのは 65530。そちらを確かめる
    expect(b.uid).toBe(40000);
  });
});

describe('withPdfUid（計画 → uid を借りる → 起動 → 返す）', () => {
  const original = { ...pdfDropProbe };
  const reaped: number[] = [];
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    reaped.length = 0;
    resetPdfDropWarnings();
    pdfDropProbe.currentUid = () => 0;
    pdfDropProbe.launcherExists = () => true;
    pdfDropProbe.missingCapabilities = () => [];
    pdfDropProbe.reap = async (uid) => {
      reaped.push(uid);
      return true;
    };
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    Object.assign(pdfDropProbe, original);
    warn.mockRestore();
  });

  const command = ['/usr/local/bin/bun', '--no-env-file', '/app/pdf-parse.js', '--params', '{}'];

  test('落とすとき: 起動用バイナリ経由のコマンドと環境変数を渡し、終わったら、その uid のプロセスを片づける', async () => {
    const seen = await withPdfUid(command, async (launch) => launch);
    expect(seen.command).toEqual([DEFAULT_LAUNCHER, '--no-env-file', '/app/pdf-parse.js', '--params', '{}']);
    expect(seen.env).toMatchObject({ SORA_LAUNCH_EXEC: '/usr/local/bin/bun', SORA_LAUNCH_UID: '65530', SORA_LAUNCH_GID: '65530' });
    expect(reaped).toEqual([65530]);
  });

  test('渡した環境の SORA_PDF_UID を読む（プロセスの環境ではなく）', async () => {
    const seen = await withPdfUid(command, async (launch) => launch, { SORA_PDF_UID: '10001' });
    expect(seen.env).toMatchObject({ SORA_LAUNCH_UID: '10001', SORA_LAUNCH_GID: '10001' });
    expect(reaped).toEqual([10001]);
  });

  test('落とさないとき（root でない）: コマンドはそのまま・環境変数は指定しない（既定の許可リスト）。片づけもしない', async () => {
    pdfDropProbe.currentUid = () => 1000;
    const seen = await withPdfUid(command, async (launch) => launch);
    expect(seen.command).toEqual(command);
    expect(seen.env).toBeUndefined();
    expect(reaped).toEqual([]);
  });

  test('SORA_PDF_UID=off: 落とさない', async () => {
    const seen = await withEnv({ SORA_PDF_UID: 'off' }, () => withPdfUid(command, async (launch) => launch));
    expect(seen.command).toEqual(command);
    expect(reaped).toEqual([]);
  });

  test('起動の側が例外を投げても、uid は片づけて返す。例外はそのまま伝える', async () => {
    await expect(
      withPdfUid(command, async () => {
        throw new Error('起動の失敗');
      }),
    ).rejects.toThrow('起動の失敗');
    expect(reaped).toEqual([65530]);
    // 返したので、また借りられる（最小の番号から）
    const seen = await withPdfUid(command, async (launch) => launch.env?.SORA_LAUNCH_UID);
    expect(seen).toBe('65530');
  });

  test('同時に 2 件: 別々の uid になる', async () => {
    const uids: Array<string | undefined> = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withPdfUid(command, async (launch) => {
      uids.push(launch.env?.SORA_LAUNCH_UID);
      await gate;
    });
    const second = withPdfUid(command, async (launch) => {
      uids.push(launch.env?.SORA_LAUNCH_UID);
      await gate;
    });
    await Bun.sleep(20);
    release();
    await Promise.all([first, second]);
    expect(uids.sort()).toEqual(['65530', '65531']);
    expect(reaped.sort()).toEqual([65530, 65531]);
  });

  test('strict で落とせないなら、起動の側を呼ばずに失敗する（root で動かさない）', async () => {
    pdfDropProbe.currentUid = () => 1000;
    let called = false;
    await expect(
      withEnv({ SORA_ISOLATION: 'strict' }, () =>
        withPdfUid(command, async () => {
          called = true;
        }),
      ),
    ).rejects.toThrow(PdfDropError);
    expect(called).toBe(false);
  });

  test('Chromium の uid と重なる設定: standard は落とさず（片づけが Chromium を終わらせないように）警告する', async () => {
    const seen = await withPdfUid(command, async (launch) => launch, { SORA_BROWSER_UID: '65531' });
    expect(seen.command).toEqual(command);
    expect(reaped).toEqual([]);
    expect(warn.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')).toContain('Chromium の uid');
  });

  test('Chromium の uid の範囲は、standard では共有の 1 つ分、strict ではプロセスの数ぶんで調べる', async () => {
    // 基準 65527: 1 つ分なら 65527 だけ（PDF の 65530・65531 と重ならない）。strict の 4 つ分なら 65527〜65530（65530 で重なる）
    const env = { SORA_BROWSER_UID: '65527' };
    const standard = await withPdfUid(command, async (launch) => launch, env);
    expect(standard.command[0]).toBe(DEFAULT_LAUNCHER);
    await expect(withPdfUid(command, async () => {}, { ...env, SORA_ISOLATION: 'strict' })).rejects.toThrow(/Chromium の uid/);
    // プロセスの数を 3 に絞れば（65527〜65529）、strict でも重ならない
    const narrowed = await withPdfUid(command, async (launch) => launch, { ...env, SORA_ISOLATION: 'strict', SORA_BROWSER_MAX_PROCESSES: '3' });
    expect(narrowed.command[0]).toBe(DEFAULT_LAUNCHER);
  });

  test('警告は、同じ文を 1 回だけ出す（capability が足りないとき。PDF のたびに出さない）', async () => {
    pdfDropProbe.missingCapabilities = () => ['CAP_SETUID'];
    await withPdfUid(command, async () => {});
    await withPdfUid(command, async () => {});
    const lines = warn.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.includes('CAP_SETUID'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[Sora/PDF]');
  });
});

describe('parsePdfToMarkdown（起動用バイナリ経由で、本物の別プロセスが動く）', () => {
  let fake: ReturnType<typeof installFakePdfLauncher>;
  beforeEach(() => {
    fake = installFakePdfLauncher();
  });
  afterEach(() => {
    fake.restore();
  });

  test('PDF を読める。起動用バイナリには uid と本物の実行ファイルが渡り、終わったら uid を片づける', async () => {
    const result = await parsePdfToMarkdown(makePdf([['Hello via launcher'], ['page two']]), 'https://x.example/a.pdf', 30_000);
    expect(result.content).toContain('Hello via launcher');
    expect(result.metadata).toMatchObject({ totalPages: 2, pagesRead: 2 });
    expect(fake.launches()).toEqual([`uid=65530 gid=65530 exec=${process.execPath}`]);
    expect(fake.reaped).toEqual([65530]);
  });

  test('2 件続けて読むと、返したあとの uid をまた使う', async () => {
    await parsePdfToMarkdown(makePdf([['one']]), 'https://x.example/1.pdf', 30_000);
    await parsePdfToMarkdown(makePdf([['two']]), 'https://x.example/2.pdf', 30_000);
    expect(fake.launches()).toEqual([`uid=65530 gid=65530 exec=${process.execPath}`, `uid=65530 gid=65530 exec=${process.execPath}`]);
    expect(fake.reaped).toEqual([65530, 65530]);
  });

  test('起動用バイナリが約束どおり動かなければ（落とせずに終わる）、失敗する。uid は返す', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pdfDropProbe.launcher = () => failingLauncher;
      await expect(parsePdfToMarkdown(makePdf([['x']]), 'https://x.example/a.pdf', 30_000)).rejects.toThrow(/中止されました/);
      expect(fake.reaped).toEqual([65530]);
    } finally {
      warn.mockRestore();
    }
  });

  test('strict で落とせないなら、PDF を読まずに失敗する（root のままでは動かさない）', async () => {
    pdfDropProbe.currentUid = () => 1000;
    await expect(withEnv({ SORA_ISOLATION: 'strict' }, () => parsePdfToMarkdown(makePdf([['x']]), 'https://x.example/a.pdf', 30_000))).rejects.toThrow(PdfDropError);
    expect(fake.launches()).toEqual([]);
  });

  test('strict で落とせるなら、読める', async () => {
    const result = await withEnv({ SORA_ISOLATION: 'strict' }, () => parsePdfToMarkdown(makePdf([['strict body']]), 'https://x.example/a.pdf', 30_000));
    expect(result.content).toContain('strict body');
    expect(fake.launches()).toHaveLength(1);
  });

  test('inline（試験用の、このプロセスの中の解析）では、起動用バイナリを使わない', async () => {
    const result = await parsePdfToMarkdown(makePdf([['inline body']]), 'https://x.example/a.pdf', 30_000, { inline: true });
    expect(result.content).toContain('inline body');
    expect(fake.launches()).toEqual([]);
    expect(fake.reaped).toEqual([]);
  });
});
