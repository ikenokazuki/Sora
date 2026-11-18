import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pidsOfUid, reapUid } from './browser_reap.js';

/**
 * tenant ごとのブラウザの uid に、プロセスが残っていないことの確認（設計 2。段階 6）。
 * 起動に失敗した Chromium・強制終了で残った子孫のプロセスは、起動した子プロセスの追跡では分からないので、番号を手放す前に、uid で探して終わらせる。
 * /proc の代わりに、偽のディレクトリを使う。
 */

let proc: string;
beforeEach(() => {
  proc = mkdtempSync(join(tmpdir(), 'fake-proc-'));
});
afterEach(() => rmSync(proc, { recursive: true, force: true }));

function addProcess(pid: number, uid: number, state = 'S (sleeping)', effective = uid): void {
  mkdirSync(join(proc, String(pid)));
  writeFileSync(join(proc, String(pid), 'status'), `Name:\tchromium\nState:\t${state}\nUid:\t${uid}\t${effective}\t${uid}\t${effective}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
}

describe('pidsOfUid', () => {
  test('その uid のプロセスだけを返す（実 uid か実効 uid が一致するもの）。ほかの uid・数字でない名前・ゾンビは返さない', () => {
    addProcess(100, 65533);
    addProcess(101, 65533);
    addProcess(102, 65532);
    addProcess(103, 65534, 'S (sleeping)', 65533); // 実効 uid が一致
    addProcess(104, 65533, 'Z (zombie)'); // ゾンビ（もう動いていない）
    mkdirSync(join(proc, 'self'));
    mkdirSync(join(proc, 'net'));
    writeFileSync(join(proc, 'cpuinfo'), 'x');
    expect(pidsOfUid(65533, proc).toSorted((a, b) => a - b)).toEqual([100, 101, 103]);
  });

  test('読めないプロセス（途中で消えた）は、飛ばす。/proc が読めなければ空', () => {
    mkdirSync(join(proc, '200')); // status が無い
    addProcess(201, 65533);
    expect(pidsOfUid(65533, proc)).toEqual([201]);
    expect(pidsOfUid(65533, join(proc, 'nothing'))).toEqual([]);
  });
});

describe('reapUid', () => {
  test('残っているプロセスに SIGKILL を送り、いなくなったら true', async () => {
    addProcess(100, 65533);
    addProcess(101, 65533);
    addProcess(102, 65532);
    const killed: Array<[number, string]> = [];
    const result = await reapUid(65533, {
      procDir: proc,
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        rmSync(join(proc, String(pid)), { recursive: true });
      },
      sleep: async () => undefined,
    });
    expect(result).toBe(true);
    expect(killed.toSorted((a, b) => a[0] - b[0])).toEqual([[100, 'SIGKILL'], [101, 'SIGKILL']]);
    expect(pidsOfUid(65532, proc)).toEqual([102]); // ほかの uid は、触らない
  });

  test('残っていなければ、何も送らず、すぐ true', async () => {
    addProcess(102, 65532);
    let kills = 0;
    expect(await reapUid(65533, { procDir: proc, kill: () => { kills++; }, sleep: async () => undefined })).toBe(true);
    expect(kills).toBe(0);
  });

  test('送っても残り続ける（終わらない）なら、時間の上限のあと false（番号を手放させない）', async () => {
    addProcess(100, 65533);
    let now = 0;
    let kills = 0;
    const result = await reapUid(65533, {
      procDir: proc,
      kill: () => { kills++; },
      sleep: async (ms) => { now += ms; },
      now: () => now,
      timeoutMs: 100,
    });
    expect(result).toBe(false);
    expect(kills).toBeGreaterThan(1); // 繰り返し送る
  });

  test('kill が例外を投げても（すでに終わった・権限が無い）、落ちず、確かめを続ける', async () => {
    addProcess(100, 65533);
    let attempts = 0;
    const result = await reapUid(65533, {
      procDir: proc,
      kill: (pid) => {
        attempts++;
        if (attempts === 1) throw new Error('ESRCH');
        rmSync(join(proc, String(pid)), { recursive: true });
      },
      sleep: async () => undefined,
    });
    expect(result).toBe(true);
  });

  test('root（0）・自分自身の uid・不正な uid には、何もしない（false）。自分や root のプロセスを撃たない', async () => {
    addProcess(100, 0);
    const own = typeof process.getuid === 'function' ? process.getuid() : 1000;
    addProcess(101, own);
    let kills = 0;
    const options = { procDir: proc, kill: () => { kills++; }, sleep: async () => undefined };
    expect(await reapUid(0, options)).toBe(false);
    expect(await reapUid(own, options)).toBe(false);
    expect(await reapUid(-1, options)).toBe(false);
    expect(await reapUid(1.5, options)).toBe(false);
    expect(kills).toBe(0);
  });

  test('自分の pid は、撃たない', async () => {
    addProcess(process.pid, 65533);
    let killedSelf = false;
    await reapUid(65533, {
      procDir: proc,
      kill: (pid) => { if (pid === process.pid) killedSelf = true; },
      sleep: async () => undefined,
      now: (() => { let t = 0; return () => (t += 60); })(),
      timeoutMs: 100,
    });
    expect(killedSelf).toBe(false);
  });
});
