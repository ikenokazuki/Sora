import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { LineBuffer, type PdfChildEvent, type PdfChildLimits, type PdfChildOutcome, pdfChildCommand, pdfChildEnv, resolvePdfChildEntry, runPdfChild } from './pdf_child.js';

/**
 * PDF の解析を別プロセスで動かす部分（pdf_child.ts）。ここでは、PDF を読まない偽の子プロセス（bun -e の短い台本）で、
 * 親が守る約束（行の約束事・時間・メモリ・出力量の上限・環境変数・後始末）を確かめる。本物の子との通しは pdf.test.ts にある。
 */

const LIMITS: PdfChildLimits = { memoryMb: 4096, hardMs: 20_000, maxOutputBytes: 1 << 20, pollMs: 20, exitGraceMs: 300 };
const PARAMS = { pageLimit: 10, needed: 1000, budgetMs: 1000 };
const BYTES = new Uint8Array([1, 2, 3, 250]);

/** 偽の子: bun -e の台本。--no-env-file は、本物の子の起動と同じ */
const script = (body: string): string[] => [process.execPath, '--no-env-file', '-e', body];
const line = (event: object): string => `console.log(${JSON.stringify(JSON.stringify(event))});`;
const HANG = 'setInterval(() => {}, 1000);';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // 終わったが、まだ刈られていない（ゾンビ）子は、止まっている
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    // /proc があるのに、この pid の欄だけ読めない = kill(0) が通ったあと、読む前に刈られた（もう居ない）。負荷のもとで実際に起きた。
    // /proc 自体が無い環境（Linux 以外）だけ、見分けられないので、生きているとする
    return !existsSync('/proc/self/stat');
  }
};

interface Run {
  outcome: PdfChildOutcome;
  events: PdfChildEvent[];
  pid: number;
}

async function run(command: string[], limits: Partial<PdfChildLimits> = {}, bytes: Uint8Array = BYTES, params = PARAMS): Promise<Run> {
  const events: PdfChildEvent[] = [];
  let pid = 0;
  const outcome = await runPdfChild(bytes, params, { ...LIMITS, ...limits }, (event) => events.push(event), { command, onSpawn: (p) => (pid = p) });
  return { outcome, events, pid };
}

/** 残っている子の状態（/proc/<pid>/status の State・PPid）。落ちたときの手がかり（全体試験で 1 度だけ落ちたが、再現しない） */
function processState(pid: number): string {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    return `State=${/^State:\s*(.*)$/m.exec(status)?.[1] ?? '?'} PPid=${/^PPid:\s*(.*)$/m.exec(status)?.[1] ?? '?'}`;
  } catch {
    return '/proc/<pid>/status を読めない';
  }
}

/** 後始末の確認用: 子が止まったあと、少し待っても残っていない */
async function expectGone(pid: number): Promise<void> {
  for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20);
  const remains = alive(pid);
  expect(remains, remains ? `pid ${pid} が、1 秒待っても残っている（${processState(pid)}）` : undefined).toBe(false);
}

const secretNames: string[] = [];
afterEach(() => {
  for (const name of secretNames.splice(0)) delete process.env[name];
});

describe('行の約束事（open → page … → done）', () => {
  test('open・page の行を順に受け取り、done で終わる', async () => {
    const { outcome, events } = await run(
      script([line({ t: 'open', numPages: 2, info: { Title: '題' } }), line({ t: 'page', n: 1, text: '一' }), line({ t: 'page', n: 2, text: '二' }), line({ t: 'done', timeBudgetHit: false })].join('\n')),
    );
    expect(outcome).toEqual({ kind: 'done', timeBudgetHit: false });
    expect(events).toEqual([
      { t: 'open', numPages: 2, info: { Title: '題' } },
      { t: 'page', n: 1, text: '一' },
      { t: 'page', n: 2, text: '二' },
    ]);
  });

  test('done の timeBudgetHit を、そのまま返す', async () => {
    const { outcome } = await run(script([line({ t: 'open', numPages: 5, info: {} }), line({ t: 'done', timeBudgetHit: true })].join('\n')));
    expect(outcome).toEqual({ kind: 'done', timeBudgetHit: true });
  });

  test('標準入力に、PDF のバイト列が、そのまま届く（大きくても欠けない）', async () => {
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) & 255);
    const expected = new Bun.CryptoHasher('sha256').update(big).digest('hex');
    const body = `
      const data = new Uint8Array(await Bun.stdin.arrayBuffer());
      const sha = new Bun.CryptoHasher('sha256').update(data).digest('hex');
      console.log(JSON.stringify({ t: 'open', numPages: 1, info: {} }));
      console.log(JSON.stringify({ t: 'page', n: 1, text: sha + ':' + data.length }));
      console.log(JSON.stringify({ t: 'done', timeBudgetHit: false }));`;
    const { events } = await run(script(body), {}, big);
    expect(events[1]).toEqual({ t: 'page', n: 1, text: `${expected}:${big.length}` });
  });

  test('error の行は、名前と文を、そのまま error として返す', async () => {
    const { outcome } = await run(script(line({ t: 'error', name: 'InvalidPDFException', message: 'Invalid PDF structure.' })));
    expect(outcome).toEqual({ kind: 'error', name: 'InvalidPDFException', message: 'Invalid PDF structure.' });
  });

  test('error の名前と文は、長さを切る（子が、長い文を返しても）', async () => {
    const { outcome } = await run(script(line({ t: 'error', name: 'N'.repeat(500), message: 'M'.repeat(5000) })));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.name.length).toBeLessThanOrEqual(100);
      expect(outcome.message.length).toBeLessThanOrEqual(300);
    }
  });

  test('open に info が無くても（または、オブジェクトでなくても）受け入れる。文書情報は空', async () => {
    for (const info of ['', ', "info": null', ', "info": "text"', ', "info": [1, 2]']) {
      const body = `console.log('{"t":"open","numPages":0${info}}');\n${line({ t: 'done', timeBudgetHit: false })}`;
      const { outcome, events } = await run(script(body));
      expect(outcome, info).toEqual({ kind: 'done', timeBudgetHit: false });
      expect(events, info).toEqual([{ t: 'open', numPages: 0, info: {} }]);
    }
  });

  test('numPages は 2^31 - 1 まで（PDF の側が決める値。それを超えたら約束違反）', async () => {
    const ok = await run(script(`${line({ t: 'open', numPages: 2 ** 31 - 1, info: {} })}${line({ t: 'done', timeBudgetHit: false })}`));
    expect(ok.outcome).toEqual({ kind: 'done', timeBudgetHit: false });
    const tooMany = await run(script(`${line({ t: 'open', numPages: 2 ** 31, info: {} })}${HANG}`));
    expect(tooMany.outcome).toMatchObject({ kind: 'killed', reason: 'protocol' });
    const fraction = await run(script(`${line({ t: 'open', numPages: 1.5, info: {} })}${HANG}`));
    expect(fraction.outcome).toMatchObject({ kind: 'killed', reason: 'protocol' });
  });

  test('open の文書情報は、決まった項目だけを、長さを切って受け取る（子が嘘をついても）', async () => {
    const info = { Title: 'T'.repeat(1000), Author: 'A', Custom: { x: 1 }, Evil: 'e', Subject: 42, Keywords: 'k'.repeat(1000) };
    const { events } = await run(script([line({ t: 'open', numPages: 1, info }), line({ t: 'done', timeBudgetHit: false })].join('\n')));
    const open = events[0] as Extract<PdfChildEvent, { t: 'open' }>;
    expect(Object.keys(open.info).sort()).toEqual(['Author', 'Keywords', 'Title']);
    expect(open.info.Title?.length).toBeLessThanOrEqual(301);
    expect(open.info.Keywords?.length).toBeLessThanOrEqual(501);
  });
});

describe('約束を破る子は、止める（protocol）', () => {
  const cases: Array<[string, string]> = [
    ['JSON でない行', 'console.log("garbage");'],
    ['知らない種類の行', line({ t: 'launch-missiles' })],
    ['open の前の page', `${line({ t: 'page', n: 1, text: 'x' })}`],
    ['open が 2 回', `${line({ t: 'open', numPages: 1, info: {} })}${line({ t: 'open', numPages: 1, info: {} })}`],
    ['ページ番号が飛ぶ', `${line({ t: 'open', numPages: 5, info: {} })}${line({ t: 'page', n: 2, text: 'x' })}`],
    ['ページ番号が戻る', `${line({ t: 'open', numPages: 5, info: {} })}${line({ t: 'page', n: 1, text: 'a' })}${line({ t: 'page', n: 1, text: 'b' })}`],
    ['頼んだページ数の上限を超える', `${line({ t: 'open', numPages: 50, info: {} })}${Array.from({ length: 11 }, (_, i) => line({ t: 'page', n: i + 1, text: 'x' })).join('')}`],
    ['文書のページ数を超える', `${line({ t: 'open', numPages: 1, info: {} })}${line({ t: 'page', n: 1, text: 'a' })}${line({ t: 'page', n: 2, text: 'b' })}`],
    ['text が文字列でない', `${line({ t: 'open', numPages: 1, info: {} })}${line({ t: 'page', n: 1, text: 123 })}`],
    ['numPages が整数でない', line({ t: 'open', numPages: 'many', info: {} })],
    ['numPages が負', line({ t: 'open', numPages: -1, info: {} })],
    ['done の後に続きがある', `${line({ t: 'open', numPages: 0, info: {} })}${line({ t: 'done', timeBudgetHit: false })}${line({ t: 'page', n: 1, text: 'late' })}`],
  ];
  for (const [name, body] of cases) {
    test(name, async () => {
      const { outcome, pid } = await run(script(`${body}\n${HANG}`));
      expect(outcome.kind, JSON.stringify(outcome)).toBe('killed');
      if (outcome.kind === 'killed') expect(outcome.reason).toBe('protocol');
      await expectGone(pid);
    });
  }

  test('done の timeBudgetHit が真偽値でない（文字列・数・無い）なら、約束違反（読めたふりの done を受けない）', async () => {
    for (const flag of ['"timeBudgetHit":"yes"', '"timeBudgetHit":1', '"timeBudgetHit":null', '']) {
      const body = `${line({ t: 'open', numPages: 0, info: {} })}console.log('{"t":"done"${flag ? `,${flag}` : ''}}');\n${HANG}`;
      const { outcome } = await run(script(body));
      expect(outcome, flag).toMatchObject({ kind: 'killed', reason: 'protocol' });
    }
  });

  test('done の後に page が続くのは、ページ数に余裕があっても約束違反（done で終わった）', async () => {
    const body = `${line({ t: 'open', numPages: 3, info: {} })}${line({ t: 'done', timeBudgetHit: false })}${line({ t: 'page', n: 1, text: 'late page' })}${HANG}`;
    const { outcome, events } = await run(script(body));
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'protocol' });
    expect(events.map((e) => e.t)).toEqual(['open']);
  });

  test('error の後に続きがあるのも、約束違反', async () => {
    const body = `${line({ t: 'error', name: 'X', message: 'y' })}${line({ t: 'open', numPages: 1, info: {} })}${HANG}`;
    const { outcome, events } = await run(script(body));
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'protocol' });
    expect(events).toEqual([]);
  });

  test('空行は、読み飛ばす（行のあいだに空行があっても、約束違反にしない）', async () => {
    const body = `console.log('');\n${line({ t: 'open', numPages: 1, info: {} })}console.log('   ');\n${line({ t: 'page', n: 1, text: 'p' })}console.log('');\n${line({ t: 'done', timeBudgetHit: false })}`;
    const { outcome, events } = await run(script(body));
    expect(outcome).toEqual({ kind: 'done', timeBudgetHit: false });
    expect(events.map((e) => e.t)).toEqual(['open', 'page']);
  });

  test('open の前に done を返しても、done として受けない（文書を開いていない）', async () => {
    const { outcome } = await run(script(line({ t: 'done', timeBudgetHit: false })));
    expect(outcome.kind).toBe('killed');
  });
});

describe('上限（時間・メモリ・出力量）', () => {
  test('時間の上限を過ぎたら、子を止める。それまでに届いた行は残る', async () => {
    const { outcome, events, pid } = await run(script(`${line({ t: 'open', numPages: 3, info: {} })}${line({ t: 'page', n: 1, text: '先頭' })}${HANG}`), { hardMs: 2000 });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'time' });
    expect(events.map((e) => e.t)).toEqual(['open', 'page']);
    await expectGone(pid);
  });

  test('時間の上限は、子の起動から数える（何も返さない子も止める）', async () => {
    const started = Date.now();
    const { outcome, pid } = await run(script(HANG), { hardMs: 300 });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'time' });
    expect(Date.now() - started).toBeLessThan(3000);
    await expectGone(pid);
  });

  test('CPU を握って止まらない子も、止める（子は止まっていても、親のタイマーは動く）', async () => {
    const { outcome, pid } = await run(script(`${line({ t: 'open', numPages: 1, info: {} })}while (true) {}`), { hardMs: 300 });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'time' });
    await expectGone(pid);
  });

  test.skipIf(!existsSync('/proc/self/status'))('メモリ（RSS）が上限を超えたら、子を止める。それまでに届いた行は残る', async () => {
    const body = `${line({ t: 'open', numPages: 2, info: {} })}${line({ t: 'page', n: 1, text: '先頭' })}
      const keep = [];
      setInterval(() => { keep.push(new Uint8Array(32 * 1024 * 1024).fill(7)); }, 10);`;
    const { outcome, events, pid } = await run(script(body), { memoryMb: 250 });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'memory' });
    if (outcome.kind === 'killed') expect(outcome.detail).toMatch(/\d+ MB/);
    expect(events.map((e) => e.t)).toEqual(['open', 'page']);
    await expectGone(pid);
  });

  test('メモリの上限以内なら、止めない（RSS の読み取りを差し替えて確かめる）', async () => {
    const events: PdfChildEvent[] = [];
    const outcome = await runPdfChild(
      BYTES,
      PARAMS,
      { ...LIMITS, memoryMb: 100 },
      (event) => events.push(event),
      { command: script(`${line({ t: 'open', numPages: 0, info: {} })}await Bun.sleep(150);\n${line({ t: 'done', timeBudgetHit: false })}`), readRssMb: () => 100 },
    );
    expect(outcome).toEqual({ kind: 'done', timeBudgetHit: false });
  });

  test('メモリの上限をわずかに超えたら止める（境界。RSS の読み取りを差し替えて確かめる）', async () => {
    const outcome = await runPdfChild(BYTES, PARAMS, { ...LIMITS, memoryMb: 100 }, () => {}, { command: script(`${line({ t: 'open', numPages: 0, info: {} })}${HANG}`), readRssMb: () => 100.5 });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'memory' });
  });

  test('RSS を読めない環境（/proc が無い）では、メモリの監視を省く（時間の上限は効く）', async () => {
    const outcome = await runPdfChild(BYTES, PARAMS, { ...LIMITS, hardMs: 300 }, () => {}, { command: script(HANG), readRssMb: () => undefined });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'time' });
  });

  test('正当な行（連番のページ）でも、合計が上限を超えたら、子を止める（親のメモリを増やさせない）', async () => {
    const body = `${line({ t: 'open', numPages: 5000, info: {} })}
      const chunk = 'x'.repeat(100000);
      for (let n = 1; n <= 1000; n++) console.log(JSON.stringify({ t: 'page', n, text: chunk }));
      ${HANG}`;
    const { outcome, events, pid } = await run(script(body), { maxOutputBytes: 300_000 }, BYTES, { pageLimit: 5000, needed: 1, budgetMs: 1 });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'output' });
    // 上限の内の行までは届き、超えた塊は捨てる
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeLessThanOrEqual(4);
    await expectGone(pid);
  });

  test('改行の無い長い出力も、上限で止める（1 行が際限なく長い）', async () => {
    const body = `${line({ t: 'open', numPages: 1, info: {} })}
      const chunk = 'x'.repeat(100000);
      setInterval(() => process.stdout.write(chunk), 5);`;
    const { outcome, pid } = await run(script(body), { maxOutputBytes: 300_000 });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'output' });
    await expectGone(pid);
  });

  test('上限ちょうどの出力は通す（境界）', async () => {
    const open = `${JSON.stringify({ t: 'open', numPages: 1, info: {} })}\n`;
    const page = `${JSON.stringify({ t: 'page', n: 1, text: 'p' })}\n`;
    const done = `${JSON.stringify({ t: 'done', timeBudgetHit: false })}\n`;
    const total = Buffer.byteLength(open + page + done);
    const body = [open, page, done].map((l) => `process.stdout.write(${JSON.stringify(l)});`).join('\n');
    expect((await run(script(body), { maxOutputBytes: total })).outcome).toEqual({ kind: 'done', timeBudgetHit: false });
    expect((await run(script(body), { maxOutputBytes: total - 1 })).outcome).toMatchObject({ kind: 'killed' });
  });
});

describe('子が勝手に終わる・終わらない', () => {
  test('done の前に終了コード 0 で終わったら、異常終了（done が無い）', async () => {
    const { outcome } = await run(script(line({ t: 'open', numPages: 1, info: {} })));
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'crashed' });
  });

  test('途中で非 0 で終わったら、異常終了。終了コードを添え、それまでの行は残る', async () => {
    const { outcome, events } = await run(script(`${line({ t: 'open', numPages: 2, info: {} })}${line({ t: 'page', n: 1, text: 'a' })}process.exit(7);`));
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'crashed' });
    if (outcome.kind === 'killed') expect(outcome.detail).toContain('7');
    expect(events).toHaveLength(2);
  });

  test('シグナルで殺された（カーネルの OOM など）ときも、異常終了としてシグナルを添える', async () => {
    const { outcome } = await run(script(`${line({ t: 'open', numPages: 1, info: {} })}process.kill(process.pid, 'SIGKILL');`));
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'crashed' });
    if (outcome.kind === 'killed') expect(outcome.detail).toMatch(/SIGKILL|9/);
  });

  test('done のあと、子が終わらなくても、少し待って止める（結果は done のまま）', async () => {
    const started = Date.now();
    const { outcome, pid } = await run(script(`${line({ t: 'open', numPages: 0, info: {} })}${line({ t: 'done', timeBudgetHit: false })}${HANG}`), { exitGraceMs: 200 });
    expect(outcome).toEqual({ kind: 'done', timeBudgetHit: false });
    expect(Date.now() - started).toBeLessThan(5000);
    await expectGone(pid);
  });

  test('子の標準エラーは、末尾だけ（4KB まで）記録に残す（勝手に終わったときの手がかり。利用者には見せない）', async () => {
    const body = `process.stderr.write('a'.repeat(20000) + 'LAST-WORDS'); process.exit(1);`;
    const { outcome } = await run(script(body));
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'crashed' });
    if (outcome.kind === 'killed') {
      expect(outcome.stderrTail.endsWith('LAST-WORDS')).toBe(true);
      expect(outcome.stderrTail.length).toBeLessThanOrEqual(4096);
      expect(outcome.stderrTail.length).toBeGreaterThan(1000);
    }
  });

  test('親が終わるとき（process.exit）に、動いている子を残さない', async () => {
    const parent = `
      import { runPdfChild } from ${JSON.stringify(new URL('./pdf_child.ts', import.meta.url).pathname)};
      let childPid = 0;
      const running = runPdfChild(new Uint8Array(1), { pageLimit: 1, needed: 1, budgetMs: 1 },
        { memoryMb: 4096, hardMs: 60000, maxOutputBytes: 1 << 20, pollMs: 50, exitGraceMs: 100 },
        () => {}, { command: [process.execPath, '--no-env-file', '-e', 'setInterval(() => {}, 1000);'], onSpawn: (pid) => { childPid = pid; } });
      await Bun.sleep(300);
      console.log(childPid);
      process.exit(0);
      await running;`;
    const proc = Bun.spawn([process.execPath, '--no-env-file', '-e', parent], { stdout: 'pipe', stderr: 'pipe' });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    await expectGone(pid);
  });

  test('末尾に改行が無い最後の行も受ける（done を書いてすぐ終わった子）', async () => {
    const body = `process.stdout.write(${JSON.stringify(`${JSON.stringify({ t: 'open', numPages: 0, info: {} })}\n${JSON.stringify({ t: 'done', timeBudgetHit: false })}`)});`;
    const { outcome } = await run(script(body));
    expect(outcome).toEqual({ kind: 'done', timeBudgetHit: false });
  });

  test('done を受けたあとは、時間の上限で結果を変えない（終わるのを待つ間に、時間の上限が来ても、done のまま）', async () => {
    const { outcome } = await run(script(`${line({ t: 'open', numPages: 0, info: {} })}${line({ t: 'done', timeBudgetHit: false })}${HANG}`), { hardMs: 1500, exitGraceMs: 2500 });
    expect(outcome).toEqual({ kind: 'done', timeBudgetHit: false });
  });

  test('done を受けたあとも、メモリの監視は続ける（終わるのを待つ間の暴走は、結果を変えずに、すぐ止める）', async () => {
    let opened = false;
    let pid = 0;
    const startedAt = Date.now();
    // open と done を 1 回の書き込みで送る（別々に届くと、そのあいだに RSS を読まれうる）
    const both = `${JSON.stringify({ t: 'open', numPages: 0, info: {} })}\n${JSON.stringify({ t: 'done', timeBudgetHit: false })}\n`;
    const outcome = await runPdfChild(
      BYTES,
      PARAMS,
      { ...LIMITS, memoryMb: 100, exitGraceMs: 8000 },
      (event) => {
        if (event.t === 'open') opened = true;
      },
      { command: script(`process.stdout.write(${JSON.stringify(both)});${HANG}`), onSpawn: (p) => (pid = p), readRssMb: () => (opened ? 9999 : 0) },
    );
    expect(outcome).toEqual({ kind: 'done', timeBudgetHit: false });
    // 終わるのを待つ 8 秒を待たずに、止めた
    expect(Date.now() - startedAt).toBeLessThan(5000);
    await expectGone(pid);
  });

  test('子が終わっても、孫プロセスが標準出力・標準エラーを握り続けるとき（EOF が来ない）、待ちを打ち切って戻る。順番の枠を塞がない', async () => {
    const body = `
      Bun.spawn([process.execPath, '--no-env-file', '-e', 'setTimeout(() => {}, 5000)'], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
      ${line({ t: 'open', numPages: 1, info: {} })}
      ${HANG}`;
    const startedAt = Date.now();
    const { outcome, pid } = await run(script(body), { hardMs: 1500, exitGraceMs: 600 });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'time' });
    // 孫が終わる 5 秒を待たない（時間の上限 + 読みの打ち切り）
    expect(Date.now() - startedAt).toBeLessThan(4000);
    await expectGone(pid);
  });

  test('1 行の途中でカーネルに殺された（OOM など）子は、約束違反でなく、勝手な終了（crashed）', async () => {
    const body = `process.stdout.write(${JSON.stringify(`${JSON.stringify({ t: 'open', numPages: 1, info: {} })}\n{"t":"page","n":1,"te`)});
      await Bun.sleep(100); process.kill(process.pid, 'SIGKILL');`;
    const { outcome, events } = await run(script(body));
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'crashed' });
    expect(events.map((e) => e.t)).toEqual(['open']);
  });

  test('きれいに終わった（終了コード 0）のに、最後の行が途中で切れているのは、約束違反', async () => {
    const body = `process.stdout.write(${JSON.stringify(`${JSON.stringify({ t: 'open', numPages: 1, info: {} })}\n{"t":"page","n":1,"te`)});`;
    const { outcome } = await run(script(body));
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'protocol' });
  });

  test('標準エラーを洪水のように流す子も、止める（親の CPU を使わせ続けない）', async () => {
    const body = `${line({ t: 'open', numPages: 1, info: {} })}
      const chunk = 'e'.repeat(100000);
      setInterval(() => process.stderr.write(chunk), 5);`;
    const { outcome, pid } = await run(script(body), { maxOutputBytes: 300_000 });
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'output' });
    if (outcome.kind === 'killed') expect(outcome.detail).toContain('標準エラー');
    await expectGone(pid);
  });

  test('標準エラーの上限ちょうどは通す。1 バイト超えたら止める（境界）', async () => {
    const limit = 50_000;
    const scriptFor = (bytes: number) => `process.stderr.write('e'.repeat(${bytes}));
      await Bun.sleep(50);
      ${line({ t: 'open', numPages: 0, info: {} })}${line({ t: 'done', timeBudgetHit: false })}`;
    const exact = await run(script(scriptFor(limit)), { maxOutputBytes: limit });
    expect(exact.outcome).toEqual({ kind: 'done', timeBudgetHit: false });
    const over = await run(script(scriptFor(limit + 1)), { maxOutputBytes: limit });
    expect(over.outcome).toMatchObject({ kind: 'killed', reason: 'output' });
  });

  test('日本語・絵文字（UTF-8 の 3・4 バイト）を含む大きな行が、チャンクの境目で欠けずに届く', async () => {
    const unit = '日本語の本文🙂𠮷';
    const text = unit.repeat(40000);
    // 台本の引数に 1.5MB を埋め込むと、引数の長さの上限（E2BIG）に当たる。子の中で作る
    const body = `const text = ${JSON.stringify(unit)}.repeat(40000);
      process.stdout.write(JSON.stringify({ t: 'open', numPages: 1, info: { Title: '題名🙂' } }) + '\\n');
      process.stdout.write(JSON.stringify({ t: 'page', n: 1, text }) + '\\n');
      process.stdout.write(JSON.stringify({ t: 'done', timeBudgetHit: false }) + '\\n');`;
    const { outcome, events } = await run(script(body), { maxOutputBytes: 8 << 20 });
    expect(outcome).toEqual({ kind: 'done', timeBudgetHit: false });
    expect((events[1] as Extract<PdfChildEvent, { t: 'page' }>).text).toBe(text);
    expect((events[0] as Extract<PdfChildEvent, { t: 'open' }>).info.Title).toBe('題名🙂');
  });

  test('標準入力を読まずに終わる子でも、親は落ちない（書き込みの EPIPE）', async () => {
    const big = new Uint8Array(8 * 1024 * 1024);
    const { outcome } = await run(script('process.exit(3);'), {}, big);
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'crashed' });
  });

  test('起動できないコマンドは、起動の失敗として返す（例外にしない）', async () => {
    const { outcome } = await run(['/nonexistent/definitely-not-a-binary']);
    expect(outcome).toMatchObject({ kind: 'killed', reason: 'crashed' });
  });
});

describe('子の作業ディレクトリ', () => {
  const cwdOf = async (cwd?: string): Promise<string> => {
    const body = `${line({ t: 'open', numPages: 1, info: {} })}console.log(JSON.stringify({ t: 'page', n: 1, text: process.cwd() }));${line({ t: 'done', timeBudgetHit: false })}`;
    const events: PdfChildEvent[] = [];
    await runPdfChild(BYTES, PARAMS, LIMITS, (event) => events.push(event), { command: script(body), ...(cwd === undefined ? {} : { cwd }) });
    return (events[1] as Extract<PdfChildEvent, { t: 'page' }>).text;
  };

  test('cwd を指定すると、子はそこで動く。指定しなければ、親の作業ディレクトリのまま', async () => {
    expect(await cwdOf('/')).toBe('/');
    expect(await cwdOf()).toBe(process.cwd());
  });
});

describe('子に渡す環境変数（運用者の秘密は渡さない。bun を動かすのに要るものだけ）', () => {
  test('Sora の秘密・プロキシ（認証情報を含みうる）・証明書・ロケールは、子に届かない。PATH は届く', async () => {
    const names = ['SORA_API_KEY', 'SORA_AUTH_KEYS_FILE', 'OPENAI_API_KEY', 'PDF_TEST_SECRET', 'HTTPS_PROXY', 'http_proxy', 'ALL_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'LANG'];
    const saved: Record<string, string | undefined> = {};
    for (const name of names) {
      saved[name] = process.env[name];
      process.env[name] = name.includes('PROXY') || name.includes('proxy') ? 'http://user:password@proxy.example:3128' : 'secret-value';
    }
    try {
      const body = `
        console.log(JSON.stringify({ t: 'open', numPages: 1, info: {} }));
        console.log(JSON.stringify({ t: 'page', n: 1, text: JSON.stringify(Object.keys(process.env).sort()) }));
        console.log(JSON.stringify({ t: 'done', timeBudgetHit: false }));`;
      const { events } = await run(script(body));
      const seen = JSON.parse((events[1] as Extract<PdfChildEvent, { t: 'page' }>).text) as string[];
      expect(seen).toContain('PATH');
      for (const name of names) expect(seen, name).not.toContain(name);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  test('pdfChildEnv: extra は足す（許可リストの外の名前でも。起動用バイナリへの伝言）。入力の許可リストの外は、足さない', () => {
    const source = { PATH: '/bin', SORA_API_KEY: 'k' };
    expect(pdfChildEnv(source, { SORA_LAUNCH_UID: '65530' })).toEqual({ PATH: '/bin', SORA_LAUNCH_UID: '65530' });
    expect(pdfChildEnv(source)).toEqual({ PATH: '/bin' });
  });

  test('pdfChildEnv: PATH・HOME・TMPDIR・LD_LIBRARY_PATH・TZ だけを、あるものだけ渡す（入力を書き換えない）', () => {
    const source = { PATH: '/bin', HOME: '/home/x', TMPDIR: '/tmp', LD_LIBRARY_PATH: '/lib', TZ: 'Asia/Tokyo', LANG: 'ja_JP.UTF-8', HTTPS_PROXY: 'http://u:p@h', SORA_API_KEY: 'k', EMPTY: undefined };
    const before = JSON.stringify(source);
    expect(pdfChildEnv(source)).toEqual({ PATH: '/bin', HOME: '/home/x', TMPDIR: '/tmp', LD_LIBRARY_PATH: '/lib', TZ: 'Asia/Tokyo' });
    expect(pdfChildEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin' });
    expect(pdfChildEnv({})).toEqual({});
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe('LineBuffer（バイトを行に分ける。足した分だけを調べる）', () => {
  const collect = (chunks: Uint8Array[]): { lines: string[]; rest: string } => {
    const buffer = new LineBuffer();
    const lines: string[] = [];
    for (const chunk of chunks) {
      buffer.push(chunk, (line) => {
        lines.push(new TextDecoder().decode(line));
        return false;
      });
    }
    return { lines, rest: new TextDecoder().decode(buffer.rest()) };
  };
  const bytes = (text: string) => new TextEncoder().encode(text);

  test('改行で分ける。チャンクをまたぐ行、1 チャンクに複数の行、空行、末尾の改行の無い残りを、正しく扱う', () => {
    expect(collect([bytes('ab\ncd'), bytes('ef\n\ngh\nij')])).toEqual({ lines: ['ab', 'cdef', '', 'gh'], rest: 'ij' });
    expect(collect([bytes('\n')])).toEqual({ lines: [''], rest: '' });
    expect(collect([])).toEqual({ lines: [], rest: '' });
  });

  test('UTF-8 の文字の途中でチャンクが切れても、行は欠けない（バイトで分けてから文字にする）', () => {
    const encoded = bytes('日本語🙂\nあ\n');
    for (let cut = 1; cut < encoded.length; cut++) {
      expect(collect([encoded.subarray(0, cut), encoded.subarray(cut)]).lines, `cut=${cut}`).toEqual(['日本語🙂', 'あ']);
    }
  });

  test('onLine が true を返したら、残りを捨てて止める', () => {
    const buffer = new LineBuffer();
    const seen: string[] = [];
    buffer.push(bytes('a\nb\nc\n'), (line) => {
      seen.push(new TextDecoder().decode(line));
      return seen.length === 2;
    });
    expect(seen).toEqual(['a', 'b']);
    expect(buffer.rest().length).toBe(0);
  });

  test('改行のない 8MB のあとに、1 バイトずつ 20 万回足しても、速い（足した分だけを調べる。線形）', () => {
    const buffer = new LineBuffer();
    const noop = () => false;
    buffer.push(new Uint8Array(8 * 1024 * 1024).fill(120), noop);
    const one = new Uint8Array([120]);
    const started = performance.now();
    for (let i = 0; i < 200_000; i++) buffer.push(one, noop);
    // 全体を調べ直す作りなら、1 回 8MB × 20 万回で、何十秒もかかる
    expect(performance.now() - started).toBeLessThan(2000);
    expect(buffer.rest().length).toBe(8 * 1024 * 1024 + 200_000);
  });

  test('長い行が続いたあとに短い行が来ても、バッファの中身が混ざらない（詰め直し）', () => {
    const buffer = new LineBuffer();
    const lines: string[] = [];
    const onLine = (line: Uint8Array) => {
      lines.push(new TextDecoder().decode(line));
      return false;
    };
    buffer.push(bytes(`${'x'.repeat(50000)}\nshort\n`), onLine);
    buffer.push(bytes('tail-1\ntail'), onLine);
    buffer.push(bytes('-2\n'), onLine);
    expect(lines).toEqual(['x'.repeat(50000), 'short', 'tail-1', 'tail-2']);
  });
});

describe('入口の探し方と起動コマンド', () => {
  test('同梱の pdf-parse.js（本番）を優先し、無ければ TypeScript の入口（開発・テスト）、どちらも無ければ undefined', () => {
    expect(resolvePdfChildEntry('/app', (path) => path === '/app/pdf-parse.js')).toBe('/app/pdf-parse.js');
    expect(resolvePdfChildEntry('/app', () => true)).toBe('/app/pdf-parse.js');
    expect(resolvePdfChildEntry('/src', (path) => path === '/src/pdf_child_main.ts')).toBe('/src/pdf_child_main.ts');
    expect(resolvePdfChildEntry('/nowhere', () => false)).toBeUndefined();
  });

  test('起動コマンド: bun --no-env-file <入口> --params <JSON>。.env を読ませない', () => {
    const command = pdfChildCommand('/app/pdf-parse.js', { pageLimit: 200, needed: 451_000, budgetMs: 15_000 });
    expect(command.slice(0, 3)).toEqual([process.execPath, '--no-env-file', '/app/pdf-parse.js']);
    expect(command[3]).toBe('--params');
    expect(JSON.parse(command[4] ?? '')).toEqual({ pageLimit: 200, needed: 451_000, budgetMs: 15_000 });
    expect(command).toHaveLength(5);
  });
});
