/**
 * イメージの中で動かす確認（scripts/verify-image.sh の 16）: 本文の抽出（rs-trafilatura）の別プロセスが、本体（root）と別の uid に落ちて動き、
 * 運用者の秘密にも、同時に動くもう 1 件の抽出にも届かず、終わったあとにプロセスを残さないこと。本物の rs-trafilatura の結果は、落とす前と同じこと。
 * 子の中から調べるために、抽出のコマンドの代わりに、同じ引数・入出力で、自分の状態を本文として返す台本（bun）を使う。
 * root で動かす。uid を落とすのに要る capability が足りない運用（--cap-drop=ALL）では、standard は従来どおり抽出でき、strict は抽出コマンドを動かさないことを確かめる。
 * 使い方: docker run --rm -e NODE_ENV=test -e SORA_DB_PATH=:memory: -e SORA_API_KEY=sk-verify-image-fake-secret \
 *           -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/rs-uid-check.ts
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { missingDropCapabilities } from '../src/browser_launch_plan.js';
import { extractMainContentWithRs } from '../src/extractor/rs_trafilatura.js';
import { DEFAULT_RS_UID, RS_UID_COUNT } from '../src/extractor/rs_uid.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const REAL = '/usr/local/bin/rs-trafilatura';
const inRange = (uid: number) => uid >= DEFAULT_RS_UID && uid < DEFAULT_RS_UID + RS_UID_COUNT;

const missing = missingDropCapabilities(readFileSync('/proc/self/status', 'utf8'));
const canDrop = missing.length === 0;
check(process.getuid?.() === 0, `この確認は root（Sora 本体と同じ）で動かす（uid=${process.getuid?.()}）`);

const workDir = '/tmp/sora-rs-uid-check';
mkdirSync(workDir, { recursive: true });
chmodSync(workDir, 0o755);
const dbPath = `${workDir}/sora.db`;
writeFileSync(dbPath, 'fake database', { mode: 0o600 });

// 抽出のコマンドの代わり: 標準入力を読み、URL の問い合わせで受けた指示に従って自分の状態を調べ、本文（JSON）として返す
const probePath = `${workDir}/probe.js`;
writeFileSync(
  probePath,
  `#!/usr/local/bin/bun
const fs = require('node:fs');
await Bun.stdin.text();
const options = new URL(process.argv[process.argv.indexOf('--url') + 1]).searchParams;
const parent = Number(options.get('parent'));
const attempt = (f) => { try { f(); return 'ok'; } catch (e) { return e.code || String(e); } };
const status = fs.readFileSync('/proc/self/status', 'utf8');
const field = (name) => (new RegExp('^' + name + ':[ \\\\t]*(.*)$', 'm').exec(status) || [])[1] ?? '';
const uids = field('Uid').split(/\\s+/).map(Number);
const obs = {
  uids, gids: field('Gid').split(/\\s+/).map(Number), groups: field('Groups').trim(), capEff: field('CapEff'), noNewPrivs: field('NoNewPrivs'),
  cwd: process.cwd(), home: process.env.HOME ?? '', env: Object.keys(process.env),
  parentEnviron: attempt(() => fs.readFileSync('/proc/' + parent + '/environ')),
  signalParent: attempt(() => process.kill(parent, 0)),
  database: attempt(() => fs.readFileSync(options.get('db'))),
  cwdCache: attempt(() => fs.mkdirSync('node_modules/.cache', { recursive: true })),
  peer: null,
};
if (options.get('peer') === '1') {
  const peerOf = () => {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        const line = fs.readFileSync('/proc/' + name + '/status', 'utf8').split('\\n').find((l) => l.startsWith('Uid:'));
        const uid = Number(line.split(/\\s+/)[1]);
        if (uid !== uids[0] && uid >= ${DEFAULT_RS_UID} && uid < ${DEFAULT_RS_UID + RS_UID_COUNT}) return Number(name);
      } catch {}
    }
  };
  let peer;
  for (const until = Date.now() + 2500; !peer && Date.now() < until; await Bun.sleep(20)) peer = peerOf();
  if (peer) {
    obs.peer = { signal: attempt(() => process.kill(peer, 0)), mem: attempt(() => fs.openSync('/proc/' + peer + '/mem', 'r')) };
    await Bun.sleep(700);
  }
}
if (options.get('stray') === '1') require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' }).unref();
process.stdout.write(JSON.stringify({ page_type: 'article', content_html: JSON.stringify(obs) }));
`,
);
chmodSync(probePath, 0o755);

type Observation = { uids: number[]; gids: number[]; groups: string; capEff: string; noNewPrivs: string; cwd: string; home: string; env: string[]; parentEnviron: string; signalParent: string; database: string; cwdCache: string; peer: { signal: string; mem: string } | null };

async function probe(flags: { peer?: boolean; stray?: boolean } = {}): Promise<Observation | undefined> {
  const url = `https://probe.example/?parent=${process.pid}&db=${encodeURIComponent(dbPath)}&peer=${flags.peer ? 1 : 0}&stray=${flags.stray ? 1 : 0}`;
  const result = await extractMainContentWithRs('<html><body><p>probe</p></body></html>', url, probePath);
  return result ? (JSON.parse(result.contentHtml) as Observation) : undefined;
}

function processesInRange(): number[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        const status = readFileSync(`/proc/${name}/status`, 'utf8');
        if (/^State:\s*Z/m.test(status)) return false;
        return inRange(Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]));
      } catch {
        return false;
      }
    })
    .map(Number);
}

const page = `<!doctype html><html><head><title>Check</title></head><body><nav><a href="/x">menu</a></nav><article><h1>Check</h1>${'<p>The quick brown fox jumps over the lazy dog, and this paragraph is part of the main article body.</p>'.repeat(12)}</article></body></html>`;
const real = () => extractMainContentWithRs(page, 'https://x.example/article', REAL);

if (canDrop) {
  // 1. 同時の 2 件: 別々の uid に落ち、権限が無く、秘密にも、お互いにも届かない
  const seen = await Promise.all([probe({ peer: true }), probe({ peer: true })]);
  check(seen.every(Boolean), '偽の抽出コマンドが、落とした uid で動かなかった（結果が無い）');
  const uids = seen.map((o) => o?.uids[0] ?? -1);
  check(uids.every(inRange) && uids[0] !== uids[1], `同時の 2 件が、別々の uid（${DEFAULT_RS_UID}〜）になっていない: ${uids.join('・')}`);
  for (const [i, o] of seen.entries()) {
    if (!o) continue;
    const who = `抽出 ${i + 1}（uid ${o.uids[0]}）`;
    check(o.uids.every((u) => u === o.uids[0]) && o.gids.every((g) => g === o.uids[0]), `${who}: uid・gid が揃っていない: ${o.uids} / ${o.gids}`);
    check(o.groups === '' && /^0+$/.test(o.capEff) && o.noNewPrivs === '1', `${who}: 権限が残っている（Groups=${JSON.stringify(o.groups)} CapEff=${o.capEff} NoNewPrivs=${o.noNewPrivs}）`);
    check(o.cwd === '/' && o.home === '/nonexistent' && o.cwdCache !== 'ok', `${who}: 作業ディレクトリ・HOME が違う（cwd=${o.cwd} HOME=${o.home} cache=${o.cwdCache}）`);
    check(!o.env.some((name) => /SORA_|KEY|SECRET|TOKEN/.test(name)), `${who}: 環境変数に秘密や SORA_* が届いている: ${o.env.join(',')}`);
    check(o.parentEnviron === 'EACCES' && o.signalParent === 'EPERM' && o.database === 'EACCES', `${who}: 本体に届く（environ=${o.parentEnviron} signal=${o.signalParent} db=${o.database}）`);
    check(o.peer !== null && o.peer.signal === 'EPERM' && o.peer.mem !== 'ok', `${who}: もう 1 件の抽出に届く、または同時に動かなかった: ${JSON.stringify(o.peer)}`);
  }
  check(processesInRange().length === 0, `終わったあとに、抽出の uid のプロセスが残っている: ${processesInRange()}`);

  // 2. 置いていったプロセスは、終わったときに片づく。返した最小の uid をまた使う
  const stray = await probe({ stray: true });
  check(stray?.uids[0] === DEFAULT_RS_UID, `返したあとの最小の uid を使っていない（${stray?.uids[0]}）`);
  check(processesInRange().length === 0, `抽出が置いていったプロセスが残っている: ${processesInRange()}`);

  // 3. 本物の rs-trafilatura: 落としても、落とさないときと同じ結果。strict でも動く
  const dropped = await real();
  process.env.SORA_RS_TRAFILATURA_UID = 'off';
  const asBefore = await real();
  delete process.env.SORA_RS_TRAFILATURA_UID;
  check(dropped !== undefined && JSON.stringify(dropped) === JSON.stringify(asBefore), `本物の rs-trafilatura の結果が、落とす前と違う: ${JSON.stringify(dropped)?.slice(0, 120)} / ${JSON.stringify(asBefore)?.slice(0, 120)}`);
  process.env.SORA_ISOLATION = 'strict';
  const strict = await real();
  delete process.env.SORA_ISOLATION;
  check(JSON.stringify(strict) === JSON.stringify(dropped), 'strict で、本物の rs-trafilatura が同じ結果にならない');
} else {
  console.log(`落とす capability が足りない運用（${missing.join(', ')}）として確かめる`);
  const standard = await real();
  check(standard?.contentHtml.includes('quick brown fox') === true, `standard で、従来どおり抽出できない: ${JSON.stringify(standard)?.slice(0, 120)}`);
  process.env.SORA_ISOLATION = 'strict';
  const strict = await probe();
  delete process.env.SORA_ISOLATION;
  check(strict === undefined, 'strict で、落とせないのに、抽出コマンドを動かした');
  check(processesInRange().length === 0, '落とさない運用なのに、抽出の uid のプロセスがある');
}

if (failures.length > 0) {
  console.error(`失敗 ${failures.length} 件:\n${failures.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(canDrop ? `ok: 本文の抽出の別プロセスは、uid ${DEFAULT_RS_UID}〜 に 1 件ずつ落ちて動き、秘密にも、もう 1 件にも届かず、本物の結果は同じ` : 'ok: capability が足りない運用では、standard は従来どおり抽出でき、strict は抽出コマンドを動かさない');
