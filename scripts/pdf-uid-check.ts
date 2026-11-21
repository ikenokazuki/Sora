/**
 * イメージの中で動かす確認（scripts/verify-image.sh の 14）: PDF の解析の別プロセスが、本体（root）と別の uid に落ちて動き、
 * 運用者の秘密を読めず、同時に動くもう 1 件の解析のプロセスにも届かず、終わったあとにプロセスもファイルも残さないこと。
 * root で動かす（Sora 本体と同じ）。uid を落とすのに要る capability が足りない運用（--cap-drop=ALL）では、落とさずに従来どおり動き、
 * strict の起動の確認が、落とせないことで断ること（14c）を確かめる。どちらの運用かは、このコンテナの capability から自動で決める。
 * 使い方: docker run --rm -e NODE_ENV=test -e SORA_DB_PATH=:memory: -e SORA_API_KEY=sk-verify-image-fake-secret \
 *           -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/pdf-uid-check.ts
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（穴 26。実装の状態「PDF の解析の別プロセスの uid」。E48）
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyStrictPdf } from '../src/browser_startup.js';
import { DEFAULT_LAUNCHER, missingDropCapabilities } from '../src/browser_launch_plan.js';
import { parsePdfToMarkdown } from '../src/pdf.js';
import { DEFAULT_PDF_UID, PDF_CONCURRENCY } from '../src/pdf_uid.js';
import { makePdf } from '../src/test_fixtures/pdf.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const URL_OF = 'https://x.example/a.pdf';
const UIDS = Array.from({ length: PDF_CONCURRENCY }, (_, i) => DEFAULT_PDF_UID + i);
const make = () => makePdf([['Hello from a dropped child']], { title: 'Uid Check' });

check(process.getuid?.() === 0, `この確認は root（Sora 本体と同じ）で動かす（uid=${process.getuid?.()}）`);
check(existsSync(DEFAULT_LAUNCHER), `起動用バイナリ ${DEFAULT_LAUNCHER} が無い（Containerfile の chromium-launcher と COPY を確かめる）`);
check(existsSync('/app/pdf-parse.js'), 'イメージに /app/pdf-parse.js が無い');

const missing = missingDropCapabilities(readFileSync('/proc/self/status', 'utf8'));
const canDrop = missing.length === 0;

// 運用者の秘密の代わり: root だけが読める DB（src/db.ts は 0600 で作る）
const workDir = '/tmp/sora-pdf-uid-check';
mkdirSync(workDir, { recursive: true });
chmodSync(workDir, 0o755);
const dbPath = join(workDir, 'sora.db');
writeFileSync(dbPath, 'fake database', { mode: 0o600 });

/** 子の中で動かす台本: 自分の状態と、読めてはいけないものを試した結果を、1 ページの本文（JSON）にして返す */
function probeScript(options: { parentPid: number; waitForPeer: boolean; stray: boolean }): string {
  return `
    const fs = require('node:fs');
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const field = (name) => (new RegExp('^' + name + ':[ \\\\t]*(.*)$', 'm').exec(status) || [])[1] ?? '';
    const attempt = (f) => { try { f(); return 'ok'; } catch (e) { return e.code || String(e); } };
    const uids = field('Uid').split(/\\s+/).map(Number);
    const peerUid = ${JSON.stringify(UIDS)}.find((uid) => uid !== uids[0]);
    const peerOf = () => {
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\\d+$/.test(name) || Number(name) === process.pid) continue;
        try {
          const s = fs.readFileSync('/proc/' + name + '/status', 'utf8');
          if (/^State:\\s*Z/m.test(s)) continue;
          if (new RegExp('^Uid:\\\\s+' + peerUid + '\\\\s').test(s.split('\\n').find((l) => l.startsWith('Uid:')) ?? '')) return Number(name);
        } catch {}
      }
      return undefined;
    };
    const obs = {
      uids,
      gids: field('Gid').split(/\\s+/).map(Number),
      groups: field('Groups').trim(),
      capEff: field('CapEff'),
      noNewPrivs: field('NoNewPrivs'),
      env: Object.keys(process.env).sort(),
      parentEnviron: attempt(() => fs.readFileSync('/proc/${options.parentPid}/environ')),
      parentMem: attempt(() => fs.openSync('/proc/${options.parentPid}/mem', 'r')),
      signalParent: attempt(() => process.kill(${options.parentPid}, 0)),
      database: attempt(() => fs.readFileSync(${JSON.stringify(dbPath)})),
      rootDirWrite: attempt(() => fs.writeFileSync('/app/should-not-exist', 'x')),
      peer: null,
    };
    ${
      options.waitForPeer
        ? `
    // もう 1 件の解析のプロセス（別の uid）が見えるまで待って、届かないことを確かめる。見えたあと、少し生きて、相手にも見せる
    let peerPid;
    const until = Date.now() + 8000;
    while (peerPid === undefined && Date.now() < until) { peerPid = peerOf(); if (peerPid === undefined) await Bun.sleep(30); }
    if (peerPid !== undefined) {
      obs.peer = {
        signal: attempt(() => process.kill(peerPid, 0)),
        mem: attempt(() => fs.openSync('/proc/' + peerPid + '/mem', 'r')),
        environ: attempt(() => fs.readFileSync('/proc/' + peerPid + '/environ')),
        cwd: attempt(() => fs.readlinkSync('/proc/' + peerPid + '/cwd')),
      };
      await Bun.sleep(1200);
    }`
        : ''
    }
    ${
      options.stray
        ? `
    // 解析が終わっても残るプロセス（片づけの確認）。標準入出力は握らない
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' }).unref();`
        : ''
    }
    out({ t: 'open', numPages: 1, info: {} });
    out({ t: 'page', n: 1, text: JSON.stringify(obs) });
    out({ t: 'done', timeBudgetHit: false });
  `;
}

type Observation = {
  uids: number[];
  gids: number[];
  groups: string;
  capEff: string;
  noNewPrivs: string;
  env: string[];
  parentEnviron: string;
  parentMem: string;
  signalParent: string;
  database: string;
  rootDirWrite: string;
  peer: { signal: string; mem: string; environ: string; cwd: string } | null;
};

async function probe(options: { waitForPeer: boolean; stray: boolean }): Promise<Observation> {
  const command = [process.execPath, '-e', probeScript({ parentPid: process.pid, ...options })];
  const result = await parsePdfToMarkdown(make(), URL_OF, 30_000, { child: { command } });
  return JSON.parse(result.content) as Observation;
}

/** uid が uid のプロセス（ゾンビを除く）の pid */
function processesOf(uids: readonly number[]): number[] {
  const found: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      if (/^State:\s*Z/m.test(status)) continue;
      const ids = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
      if (ids && uids.some((uid) => Number(ids[1]) === uid || Number(ids[2]) === uid)) found.push(Number(name));
    } catch {}
  }
  return found;
}

/** 書ける共有の場所に、uid の所有のファイルが残っていないか（直下から 2 階層まで） */
function filesOwnedBy(uids: readonly number[]): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (uids.includes(stat.uid)) found.push(path);
        if (stat.isDirectory() && depth < 2) walk(path, depth + 1);
      } catch {}
    }
  };
  for (const dir of ['/tmp', '/var/tmp', '/dev/shm']) walk(dir, 0);
  return found;
}

if (canDrop) {
  // 1. 同時に 2 件: それぞれ別の uid（65530・65531）に落ち、権限を持たず、秘密を読めず、お互いにも届かない
  const [first, second] = await Promise.all([probe({ waitForPeer: true, stray: false }), probe({ waitForPeer: true, stray: false })]);
  const seen = [first, second];
  const uidsSeen = seen.map((o) => o.uids[0]).sort();
  check(JSON.stringify(uidsSeen) === JSON.stringify(UIDS), `同時の 2 件が、別々の uid（${UIDS.join('・')}）になっていない: ${uidsSeen.join('・')}`);
  for (const [index, o] of seen.entries()) {
    const who = `解析 ${index + 1}（uid ${o.uids[0]}）`;
    check(o.uids.length === 4 && o.uids.every((uid) => UIDS.includes(uid) && uid === o.uids[0]), `${who}: 実・実効・保存・fs の uid が、落とした uid で揃っていない: ${o.uids.join(',')}`);
    check(o.gids.length === 4 && o.gids.every((gid) => gid === o.uids[0]), `${who}: gid が uid と揃っていない: ${o.gids.join(',')}`);
    check(o.groups === '', `${who}: 補助グループが残っている: ${JSON.stringify(o.groups)}`);
    check(/^0+$/.test(o.capEff), `${who}: capability が残っている（CapEff=${o.capEff}）`);
    check(o.noNewPrivs === '1', `${who}: NoNewPrivs が立っていない（${o.noNewPrivs}）`);
    check(!o.env.some((name) => /SORA_|KEY|SECRET|TOKEN/.test(name)), `${who}: 環境変数に秘密や SORA_* が届いている: ${o.env.join(',')}`);
    check(!o.env.some((name) => name.startsWith('SORA_LAUNCH_')), `${who}: 起動用バイナリへの伝言（SORA_LAUNCH_*）が子に残っている`);
    check(o.parentEnviron === 'EACCES', `${who}: 本体の環境変数（/proc/<本体>/environ）を読める（${o.parentEnviron}）`);
    check(o.parentMem !== 'ok', `${who}: 本体のメモリ（/proc/<本体>/mem）を開ける`);
    check(o.signalParent === 'EPERM', `${who}: 本体にシグナルを送れる（${o.signalParent}）`);
    check(o.database === 'EACCES', `${who}: 運用者の DB（0600）を読める（${o.database}）`);
    check(o.rootDirWrite !== 'ok', `${who}: root の所有の /app に書ける`);
    check(o.peer !== null, `${who}: もう 1 件の解析のプロセスが見えなかった（同時に動いていない）`);
    if (o.peer) {
      check(o.peer.signal === 'EPERM', `${who}: もう 1 件の解析のプロセスにシグナルを送れる（${o.peer.signal}）`);
      check(o.peer.mem !== 'ok', `${who}: もう 1 件の解析のプロセスのメモリを開ける（${o.peer.mem}）`);
      check(o.peer.environ === 'EACCES', `${who}: もう 1 件の解析のプロセスの環境変数を読める（${o.peer.environ}）`);
    }
  }
  check(processesOf(UIDS).length === 0, `2 件が終わったあとに、解析の uid のプロセスが残っている: ${processesOf(UIDS).join(',')}`);

  // 2. 1 件だけ: 返した最小の uid をまた使う。解析が置いていった（切り離した）プロセスは、終わったときに片づけられる
  const stray = await probe({ waitForPeer: false, stray: true });
  check(stray.uids[0] === DEFAULT_PDF_UID, `返したあとの最小の uid を使っていない（${stray.uids[0]}）`);
  check(processesOf(UIDS).length === 0, `解析が置いていったプロセスが、終わっても残っている: ${processesOf(UIDS).join(',')}`);

  // 3. 同梱の入口（本物の pdf-parse.js）でも読めて、ファイルを残さない
  const bundled = await parsePdfToMarkdown(make(), URL_OF, 30_000, { child: { entryDir: '/app' } });
  check(bundled.content.includes('Hello from a dropped child'), `同梱の入口で、本文を読めない: ${JSON.stringify(bundled.content)}`);
  check(filesOwnedBy(UIDS).length === 0, `解析の uid の所有のファイルが残っている: ${filesOwnedBy(UIDS).join(' ')}`);

  // 4. strict の起動の確認と同じ試し読みが、落とす運用で通る（同梱の入口で）
  process.env.SORA_ISOLATION = 'strict';
  const strictProbe = await verifyStrictPdf((bytes, url, max, options) => parsePdfToMarkdown(bytes, url, max, { ...options, child: { entryDir: '/app' } }));
  check(strictProbe.status === 'ok', `strict の試し読みが通らない: ${JSON.stringify(strictProbe)}`);
  delete process.env.SORA_ISOLATION;
} else {
  // 落とす capability が足りない運用（--cap-drop=ALL）: standard は従来どおり動き（警告つき）、strict の起動の確認は、落とせないことで断る
  console.log(`落とす capability が足りない運用（${missing.join(', ')}）として確かめる`);
  const plain = await parsePdfToMarkdown(make(), URL_OF, 30_000, { child: { entryDir: '/app' } });
  check(plain.content.includes('Hello from a dropped child'), `standard で、従来どおり読めない: ${JSON.stringify(plain.content)}`);
  process.env.SORA_ISOLATION = 'strict';
  const strictProbe = await verifyStrictPdf((bytes, url, max, options) => parsePdfToMarkdown(bytes, url, max, { ...options, child: { entryDir: '/app' } }));
  check(strictProbe.status === 'failed', `strict で、落とせないのに通ってしまう: ${JSON.stringify(strictProbe)}`);
  if (strictProbe.status === 'failed') {
    check(missing.every((name) => strictProbe.problem.includes(name)), `strict の断りの文に、足りない capability（${missing.join(', ')}）が無い: ${strictProbe.problem}`);
    check(strictProbe.problem.includes('--cap-add='), `strict の断りの文に、足す方法（--cap-add=）が無い: ${strictProbe.problem}`);
  }
  delete process.env.SORA_ISOLATION;
  check(processesOf(UIDS).length === 0, '落とさない運用なのに、解析の uid のプロセスがある');
}

if (failures.length > 0) {
  console.error(`失敗 ${failures.length} 件:\n${failures.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(canDrop ? `ok: PDF の解析の別プロセスは、uid ${UIDS.join('・')} に落ちて動き、秘密にも、もう 1 件にも届かず、終わったあとに何も残さない` : 'ok: capability が足りない運用では、standard は従来どおり動き、strict の起動の確認は断る');
