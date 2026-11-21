/**
 * 実機の VPS で、`SORA_ISOLATION=strict` のコンテナが、手引（docs/operations/strict.md・vps.md）どおりの状態かを確かめる（1 回流して、合否を見る）。
 * 単体テストと CI の verify-image は、イメージの中の動きを確かめる。ここが確かめるのは、運用者の起動の設定（docker run の引数・ホストのネットワーク・
 * リバースプロキシ）と、それで動いている本物のコンテナの状態。ふつうは scripts/vps-check.sh から、同じイメージの使い捨てのコンテナ（コンテナの
 * ネットワークと PID の名前空間を共有）で動く。bun は、ホストに要らない。
 *
 * 確かめるもの（1 行ずつ [PASS]・[WARN]・[FAIL]・[SKIP]。FAIL が 1 つでもあれば、終了コード 1）:
 *   container.*  docker inspect・podman inspect（標準入力の JSON）: 特権・capability・seccomp・メモリと PID の上限・ネットワーク・公開するポート・マウント・ユーザー
 *   config.*     コンテナの環境変数（名前と、真偽・列挙の値だけ。秘密の値は出さない）: strict の必須の設定
 *   strict.*     /health?detailed=true（管理者の鍵）の isolation: サンドボックス・ブラウザとの接続・出口のゲートウェイ・鍵の表が前のままでないか
 *   http.*       鍵なし・一般の鍵・管理者の鍵の扱い、内部の宛先（127.0.0.1・メタデータなど）の取得が 403、公開のページ・PDF が読めること
 *   proc.*       Sora のコンテナの中のプロセス（/proc）: 本体の seccomp・Chromium と PDF の解析のプロセスが root でない・権限がない・サンドボックスがある
 *   net.*        コンテナの中から、メタデータの IP・ホスト（ゲートウェイ）のサービスにつなげないか（コンテナの外側の制限。strict.md 5 章）
 *   public.*     --url を渡したとき、リバースプロキシの外から: /health・/metrics が隠れている・鍵なしは 401
 * 判定の部分は純粋な関数で、scripts/vps-check.test.ts が確かめる。標準のモジュールと fetch だけを使い、リポジトリの src は読み込まない。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';

export type Level = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
export interface Finding {
  level: Level;
  id: string;
  title: string;
  detail?: string;
}

const pass = (id: string, title: string): Finding => ({ level: 'PASS', id, title });
const warn = (id: string, title: string, detail?: string): Finding => ({ level: 'WARN', id, title, ...(detail ? { detail } : {}) });
const fail = (id: string, title: string, detail?: string): Finding => ({ level: 'FAIL', id, title, ...(detail ? { detail } : {}) });
const skip = (id: string, title: string, detail?: string): Finding => ({ level: 'SKIP', id, title, ...(detail ? { detail } : {}) });

const isRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------- コンテナの起動の設定（inspect）

/** uid を落とすのに要る capability（strict.md 1 章）。Chromium と PDF の解析の別プロセスを、別の uid に落とすのに使う */
const REQUIRED_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'KILL', 'SETGID', 'SETUID'];
/** 持ってはいけない capability（コンテナの外・同じホストの別のコンテナに届く） */
const DANGEROUS_CAPS = ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'SYS_RAWIO', 'SYS_BOOT', 'SYS_TIME', 'DAC_READ_SEARCH', 'BPF', 'PERFMON'];
/** capability のビットの番号 → 名前（linux/capability.h） */
const CAP_NAMES = [
  'CHOWN', 'DAC_OVERRIDE', 'DAC_READ_SEARCH', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'LINUX_IMMUTABLE', 'NET_BIND_SERVICE', 'NET_BROADCAST', 'NET_ADMIN', 'NET_RAW', 'IPC_LOCK', 'IPC_OWNER',
  'SYS_MODULE', 'SYS_RAWIO', 'SYS_CHROOT', 'SYS_PTRACE', 'SYS_PACCT', 'SYS_ADMIN', 'SYS_BOOT', 'SYS_NICE', 'SYS_RESOURCE', 'SYS_TIME', 'SYS_TTY_CONFIG', 'MKNOD', 'LEASE', 'AUDIT_WRITE', 'AUDIT_CONTROL', 'SETFCAP',
  'MAC_OVERRIDE', 'MAC_ADMIN', 'SYSLOG', 'WAKE_ALARM', 'BLOCK_SUSPEND', 'AUDIT_READ', 'PERFMON', 'BPF', 'CHECKPOINT_RESTORE',
];

/** CapEff などの 16 進から、持っている capability の名前の一覧にする（名前の無いビットは、CAP_<番号>） */
export function capNames(hex: string): string[] {
  const bits = BigInt(`0x${hex || '0'}`);
  const names: string[] = [];
  for (let bit = 0; bit < 64; bit++) {
    if (((bits >> BigInt(bit)) & 1n) === 1n) names.push(CAP_NAMES[bit] ?? `CAP_${bit}`);
  }
  return names;
}

/** 環境変数の配列（`NAME=値`）から、名前 → 値。秘密の値は、この表の外に出さない */
function envTable(value: unknown): Map<string, string> {
  const table = new Map<string, string>();
  if (!Array.isArray(value)) return table;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const at = entry.indexOf('=');
    if (at > 0) table.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return table;
}

const norm = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
const isOn = (value: string | undefined): boolean => ['true', '1', 'on', 'yes'].includes(norm(value));

function rootUser(user: unknown): boolean {
  const name = String(user ?? '').trim().split(':')[0] ?? '';
  return name === '' || name === '0' || name === 'root';
}

/** docker inspect・podman inspect（コンテナ 1 つ）の JSON を、strict.md・vps.md の手引と照らす */
export function auditInspect(inspect: unknown): Finding[] {
  const container = Array.isArray(inspect) ? inspect[0] : undefined;
  if (!isRecord(container)) return [fail('container.inspect', 'コンテナの設定（inspect の JSON）を読めない', 'docker inspect <名前> か podman inspect <名前> の出力を渡す')];
  const host: Record<string, any> = isRecord(container.HostConfig) ? container.HostConfig : {};
  const config: Record<string, any> = isRecord(container.Config) ? container.Config : {};
  const env = envTable(config.Env);
  const out: Finding[] = [];

  // 起動の状態
  if (container.State?.Running === true) out.push(pass('container.running', 'コンテナが動いている'));
  else out.push(fail('container.running', 'コンテナが動いていない'));
  if (container.State?.OOMKilled === true) out.push(warn('container.oom', 'メモリの上限で止められたことがある', '--memory を見直す（strict.md 1 章。PDF の別プロセスと Chromium が使う）'));
  else out.push(pass('container.oom', 'メモリの上限で止められていない'));

  // 特権・名前空間
  out.push(host.Privileged === true ? fail('container.privileged', '特権コンテナ（--privileged）で動いている', 'コンテナの中から、ホストの全部に届く。外す') : pass('container.privileged', '特権コンテナではない'));
  out.push(
    norm(host.NetworkMode) === 'host'
      ? fail('container.network', 'ホストのネットワーク（--network=host）で動いている', 'ホストのループバックと内部のサービスに、そのまま届く。ブリッジのネットワークにして、-p で公開する')
      : pass('container.network', 'ホストのネットワークではない'),
  );
  const sharedNamespaces = [norm(host.PidMode) === 'host' ? 'PID' : '', norm(host.IpcMode) === 'host' ? 'IPC' : ''].filter(Boolean);
  out.push(sharedNamespaces.length > 0 ? fail('container.namespaces', `ホストの ${sharedNamespaces.join('・')} の名前空間を共有している`, '--pid=host・--ipc=host を外す') : pass('container.namespaces', 'ホストの PID・IPC の名前空間を共有していない'));

  // 上限
  out.push(
    typeof host.Memory === 'number' && host.Memory > 0
      ? pass('container.memory', `メモリの上限がある（${Math.round(host.Memory / 1024 / 1024)} MB）`)
      : fail('container.memory', 'メモリの上限（--memory）が無い', 'PDF の別プロセスのメモリの監視は RSS だけを見る。最後の守りは、コンテナの上限（strict.md 1 章）'),
  );
  out.push(
    typeof host.PidsLimit === 'number' && host.PidsLimit > 0
      ? pass('container.pids', `プロセス数の上限がある（${host.PidsLimit}）`)
      : fail('container.pids', 'プロセス数の上限（--pids-limit）が無い', '破られた子プロセスが、プロセスを増やし続けるのを止める（strict.md 1 章）'),
  );

  // seccomp・AppArmor・no-new-privileges
  const securityOpt: string[] = Array.isArray(host.SecurityOpt) ? host.SecurityOpt.filter((o: unknown): o is string => typeof o === 'string') : [];
  const seccomp = securityOpt.find((o) => o.startsWith('seccomp='));
  if (seccomp !== undefined && norm(seccomp.slice('seccomp='.length)) === 'unconfined') {
    out.push(fail('container.seccomp', 'seccomp を外している（seccomp=unconfined）', '系統呼び出しの制限が無い。deploy/seccomp-sora.json を渡す（README 4.5）'));
  } else if (seccomp !== undefined) {
    out.push(pass('container.seccomp', 'seccomp のプロファイルを渡している'));
  } else {
    out.push(pass('container.seccomp', 'seccomp は、ランタイムの既定（Docker の既定ではサンドボックスが有効にならないので、SORA_BROWSER_SANDBOX=on のとき起動しない）'));
  }
  out.push(
    securityOpt.some((o) => norm(o).startsWith('apparmor=') && norm(o).endsWith('unconfined'))
      ? fail('container.apparmor', 'AppArmor を外している（apparmor=unconfined）', 'Ubuntu 24.04 以降は、unconfined のほうがユーザー名前空間を断り、サンドボックスが失敗する。既定のままにする')
      : pass('container.apparmor', 'AppArmor を外していない'),
  );
  const noNewPrivs = securityOpt.some((o) => /^no-new-privileges(:true)?$/i.test(o.trim()));
  out.push(noNewPrivs ? pass('container.no-new-privileges', 'no-new-privileges が効いている') : warn('container.no-new-privileges', 'no-new-privileges が無い', '--security-opt no-new-privileges（README 4.5）'));

  // 公開するポート
  const bindings: Array<{ HostIp?: string }> = isRecord(host.PortBindings) ? Object.values(host.PortBindings).flatMap((list) => (Array.isArray(list) ? (list as Array<{ HostIp?: string }>) : [])) : [];
  const exposed = bindings.filter((binding) => ['', '0.0.0.0', '::'].includes((binding?.HostIp ?? '').trim()));
  out.push(
    exposed.length > 0
      ? warn('container.ports', 'ポートを、すべてのアドレスに公開している', '-p 127.0.0.1:<ポート>:8000 にして、リバースプロキシの手前に置く（vps.md 1 章）')
      : pass('container.ports', bindings.length > 0 ? 'ポートは、ループバックにだけ公開している' : 'ポートを公開していない（同じネットワークのプロキシから使う構成）'),
  );

  // マウント
  const mounts: Array<Record<string, any>> = Array.isArray(container.Mounts) ? container.Mounts.filter(isRecord) : [];
  const dangerousMounts = mounts.filter((mount) => {
    const source = String(mount.Source ?? '');
    return source === '/' || /(docker|podman|containerd)\.sock$/.test(source);
  });
  out.push(
    dangerousMounts.length > 0
      ? fail('container.mounts', `危ないマウントがある（${dangerousMounts.map((m) => m.Source).join('・')}）`, 'コンテナのランタイムのソケットやホストの / は、コンテナを破った人に、ホストを渡す')
      : pass('container.mounts', 'コンテナのランタイムのソケット・ホストの / をマウントしていない'),
  );
  const keysFile = env.get('SORA_AUTH_KEYS_FILE');
  if (keysFile) {
    const dir = keysFile.replace(/\/[^/]*$/, '') || '/';
    const mount = mounts.find((m) => m.Destination === dir);
    if (!mount) out.push(skip('container.keys-mount', `鍵のディレクトリ（${dir}）は、マウントではない`, 'イメージの中か、ボリューム。書き込める人を絞る（README 4.6）'));
    else if (mount.RW === true) out.push(warn('container.keys-mount', '鍵のディレクトリを、書き込み可でマウントしている', '読み取り専用（:ro）にする。鍵を書くのは、発行の仕組みだけ（vps.md 5 章）'));
    else out.push(pass('container.keys-mount', '鍵のディレクトリは、読み取り専用でマウントしている'));
  }

  // ユーザー・ファイルシステム・再起動
  out.push(rootUser(config.User) ? pass('container.user', 'root で起動している（Chromium と PDF の解析だけが別の uid に落ちる）') : fail('container.user', `root 以外（${String(config.User)}）で起動している`, 'strict は、root で起動して、Chromium と PDF の解析を別の uid に落とす。user:・USER を外す'));
  out.push(host.ReadonlyRootfs === true ? pass('container.readonly-rootfs', 'ルートファイルシステムは読み取り専用') : warn('container.readonly-rootfs', 'ルートファイルシステムが書き込み可', '--read-only に、/tmp と /data だけを書けるようにする（破られたときに、置ける場所が減る）'));
  const restart = norm(host.RestartPolicy?.Name);
  out.push(restart === '' || restart === 'no' ? warn('container.restart', '再起動の設定が無い', '--restart unless-stopped（落ちたあと、自動で戻る）') : pass('container.restart', `再起動の設定がある（${restart}）`));

  // 環境変数（名前と、列挙・真偽の値だけを見る）
  out.push(norm(env.get('SORA_ISOLATION')) === 'strict' ? pass('config.isolation', 'SORA_ISOLATION=strict') : fail('config.isolation', 'SORA_ISOLATION=strict ではない', '互いに信頼できない利用者に公開するときは strict（strict.md 1 章）'));
  out.push(norm(env.get('SORA_BROWSER_SANDBOX')) === 'on' ? pass('config.sandbox', 'SORA_BROWSER_SANDBOX=on') : fail('config.sandbox', 'SORA_BROWSER_SANDBOX=on ではない', 'auto は、使えないと黙って --no-sandbox に戻る'));
  out.push(isOn(env.get('SORA_EGRESS_GATEWAY')) ? pass('config.gateway', 'SORA_EGRESS_GATEWAY=on') : fail('config.gateway', 'SORA_EGRESS_GATEWAY=on ではない', '外向きの通信を、出口のゲートウェイに通して、内部への接続を断つ'));
  out.push(keysFile ? pass('config.keys-file', 'SORA_AUTH_KEYS_FILE がある（名前つきの鍵）') : fail('config.keys-file', 'SORA_AUTH_KEYS_FILE が無い', '単一の鍵や鍵なしでは、利用者ごとに状態を分けられない（README 4.6）'));
  out.push(isOn(env.get('SORA_FETCH_ALLOW_PRIVATE_NETWORK')) ? fail('config.private-network', 'SORA_FETCH_ALLOW_PRIVATE_NETWORK=true', '内部のネットワークへの取得を許し、出口のゲートウェイも使われない') : pass('config.private-network', '内部のネットワークへの取得を許していない'));
  const uidOff = ['SORA_BROWSER_UID', 'SORA_PDF_UID'].filter((name) => norm(env.get(name)) === 'off');
  out.push(uidOff.length > 0 ? fail('config.uid-off', `${uidOff.join('・')}=off`, 'Chromium と PDF の解析を、別の uid に落として分けられない') : pass('config.uid-off', 'Chromium と PDF の解析の uid を落とす設定'));
  out.push(env.get('SORA_ALLOWED_HOSTS') ? pass('config.allowed-hosts', 'SORA_ALLOWED_HOSTS がある') : warn('config.allowed-hosts', 'SORA_ALLOWED_HOSTS が無い', '公開ホスト名を書く（MCP の Host の検査。vps.md 2 章）'));
  out.push(env.has('SORA_API_KEY') ? warn('config.single-key', '単一の鍵（SORA_API_KEY）が設定されている', '名前つきの鍵（SORA_AUTH_KEYS_FILE）だけにする') : pass('config.single-key', '単一の鍵（SORA_API_KEY）は使っていない'));
  return out;
}

// ---------------------------------------------------------------- 起動のログ

/** 起動のログに載る警告の行（設定・capability・サンドボックスの戻し） */
const LOG_WARNING = /警告[:：]|落とせない|サンドボックスを有効にして起動できなかった/;

/** コンテナのログ（起動のときの strict の確認の記録）を見る。ログの本文は、警告の行だけを、詳細に出す */
export function auditLogs(text: string): Finding[] {
  const out: Finding[] = [];
  out.push(
    /\[Sora\/Strict\] 起動の確認が通りました/.test(text)
      ? pass('log.strict-startup', '起動の確認（strict）が通った記録がある')
      : fail('log.strict-startup', '起動の確認（strict）が通った記録が無い', 'ログが流れて消えた（ログの保持に限りがある）か、起動の確認が通っていない。ログの先頭を読む（strict.md 2 章）'),
  );
  if (/PDF の解析を、別の uid に落とした別プロセスで動かせることを確かめました/.test(text)) out.push(pass('log.pdf-uid', 'PDF の解析を、別の uid に落とした別プロセスで動かせた記録がある'));
  else if (/PDF の解析を、別プロセスで動かせることを確かめました/.test(text)) out.push(warn('log.pdf-uid', 'PDF の解析の別プロセスを、別の uid に落とす前の版', 'PDF の解析が、本体と同じ uid（root）で動く。新しいイメージに更新する'));
  else out.push(warn('log.pdf-uid', 'PDF の解析の試し読みの記録が無い', 'ログが流れて消えた可能性'));
  const warnings = text.split('\n').filter((line) => LOG_WARNING.test(line));
  out.push(warnings.length > 0 ? warn('log.warnings', `起動のログに警告がある（${warnings.length} 行）`, warnings.slice(0, 3).map((line) => line.trim().slice(0, 160)).join(' / ')) : pass('log.warnings', '起動のログに、警告がない'));
  return out;
}

// ---------------------------------------------------------------- strict の状態（/health?detailed=true）

/** /health?detailed=true（管理者の鍵）の応答の isolation 欄を、手引と照らす */
export function auditIsolation(status: number, body: unknown): Finding[] {
  if (status !== 200 || !isRecord(body)) return [fail('strict.detailed', `/health?detailed=true を、管理者の鍵で読めない（HTTP ${status}）`, '管理者の鍵（admin: true）を渡しているか、Sora が正常かを確かめる')];
  const isolation = body.isolation;
  if (!isRecord(isolation) || isolation.level !== 'strict') return [fail('strict.level', 'isolation が strict になっていない', 'この Sora は standard で動いている（SORA_ISOLATION=strict を確かめる）')];
  const out: Finding[] = [pass('strict.level', 'isolation は strict')];
  const browser = isRecord(isolation.browser) ? isolation.browser : {};
  if (browser.sandbox === 'on') out.push(pass('strict.sandbox', 'Chromium のサンドボックスが有効'));
  else if (browser.sandbox === 'off') out.push(fail('strict.sandbox', 'Chromium のサンドボックスが無効', 'seccomp（Docker は deploy/seccomp-sora.json）・AppArmor（unconfined にしない）を確かめる'));
  else out.push(warn('strict.sandbox', 'Chromium のサンドボックスの状態が、まだ分からない（ブラウザを 1 回も起動していない）', 'ブラウザを使う取得のあと、もう一度流す'));
  out.push(browser.connection === 'pipe' ? pass('strict.connection', 'Chromium との接続は、パイプ') : fail('strict.connection', 'Chromium との接続が、ポート（127.0.0.1 の TCP）', '同じコンテナの別の uid のプロセスから、Chromium を操作できる。SORA_BROWSER_PIPE を確かめる'));
  const gateway = isRecord(isolation.egressGateway) ? isolation.egressGateway : {};
  if (gateway.enabled !== true) out.push(fail('strict.gateway', '出口のゲートウェイが、使う設定になっていない', 'SORA_EGRESS_GATEWAY=on'));
  else if (gateway.started !== true) out.push(warn('strict.gateway', '出口のゲートウェイが、まだ始まっていない（通信していない）', '取得を 1 回したあと、もう一度流す'));
  else out.push(pass('strict.gateway', '出口のゲートウェイが動いている'));
  const keys = isolation.authKeys;
  if (!isRecord(keys)) out.push(warn('strict.keys-fresh', '鍵の表の状態が無い', '鍵ファイル（SORA_AUTH_KEYS_FILE）を使っているかを確かめる'));
  else if (keys.stale === true) out.push(fail('strict.keys-fresh', '鍵ファイルを読み直せず、前の鍵で動いている', `消した鍵・管理者から外した鍵が、まだ有効。${String(keys.staleSeconds ?? '?')} 秒前から。鍵ファイルを直す（README 4.6）`));
  else out.push(pass('strict.keys-fresh', '鍵ファイルを読み直せている'));
  return out;
}

// ---------------------------------------------------------------- プロセス（/proc）

export interface ProcStatus {
  name: string;
  /** State の先頭の 1 字（R・S・D・Z など） */
  state: string;
  ppid: number;
  /** 実・実効・保存・fs の uid */
  uid: number[];
  gid: number[];
  /** NSpid: この PID の名前空間から見た pid と、入れ子の名前空間の中での pid（Chromium のサンドボックスの中は、2 つ以上） */
  nspid: number[];
  /** CapEff の 16 進（無ければ空） */
  capEff: string;
  noNewPrivs: number;
  seccomp: number;
}
export interface ProcInfo {
  pid: number;
  /** 引数を空白で連ねたもの */
  cmdline: string;
  status: ProcStatus;
}

/** /proc/<pid>/status を読む。Uid の行が無ければ undefined。無い欄は、安全でない側（NoNewPrivs 0・Seccomp 0）として読む */
export function parseProcStatus(text: string): ProcStatus | undefined {
  const field = (name: string): string | undefined => new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim();
  const ids = (name: string): number[] => (field(name) ?? '').split(/\s+/).filter(Boolean).map(Number);
  const uid = ids('Uid');
  if (uid.length === 0) return undefined;
  return {
    name: field('Name') ?? '',
    state: (field('State') ?? '?').charAt(0),
    ppid: Number(field('PPid') ?? 0),
    uid,
    gid: ids('Gid'),
    nspid: ids('NSpid'),
    capEff: field('CapEff') ?? '',
    noNewPrivs: Number(field('NoNewPrivs') ?? 0),
    seccomp: Number(field('Seccomp') ?? 0),
  };
}

const exeOf = (cmdline: string): string => cmdline.trim().split(/\s+/)[0] ?? '';
const isChromium = (p: ProcInfo): boolean => /(^|\/)(chromium|chrome)(-browser)?$/.test(exeOf(p.cmdline));
const isPdfChild = (p: ProcInfo): boolean => /(^|\s)\S*(pdf-parse\.js|pdf_child_main\.ts)(\s|$)/.test(p.cmdline);
const isSoraMain = (p: ProcInfo): boolean => /(^|\/)bun$/.test(exeOf(p.cmdline)) && /(server\.js|src\/index\.ts)/.test(p.cmdline);
const allZero = (hex: string): boolean => /^0*$/.test(hex);
const anyRoot = (ids: number[]): boolean => ids.length === 0 || ids.some((id) => id === 0);

/** 本体の実効の capability を、手引（strict.md 1 章。--cap-drop=ALL に 5 つ）と照らす。docker と podman で inspect の持ち方が違うので、/proc の実際の値で見る */
function mainCaps(capEff: string): Finding {
  if (capEff === '') return warn('proc.main-caps', 'Sora 本体の capability が読めない');
  const have = capNames(capEff);
  const dangerous = have.filter((cap) => DANGEROUS_CAPS.includes(cap));
  const missing = REQUIRED_CAPS.filter((cap) => !have.includes(cap));
  if (dangerous.length > 0) return fail('proc.main-caps', `Sora 本体が、危ない capability を持っている（${dangerous.join('・')}）`, 'コンテナの外・同じホストの別のコンテナに届く。--cap-add を見直す');
  if (missing.length > 0) return fail('proc.main-caps', `uid を落とすのに要る capability が足りない（${missing.join('・')}）`, 'Chromium と PDF の解析の別プロセスを別の uid に落とせず、strict は起動しない（strict.md 1 章）');
  const extra = have.filter((cap) => !REQUIRED_CAPS.includes(cap));
  if (extra.length > 0) return warn('proc.main-caps', `Sora 本体が、5 つのほかに capability を持っている（${extra.join('・')}）`, '--cap-drop=ALL に、CHOWN・DAC_OVERRIDE・KILL・SETGID・SETUID の 5 つだけを足す（strict.md 1 章）');
  return pass('proc.main-caps', 'Sora 本体の capability は、5 つだけ（CHOWN・DAC_OVERRIDE・KILL・SETGID・SETUID）');
}

/** Sora のコンテナの中のプロセス（PID の名前空間を共有して読んだもの）を、手引と照らす。selfPid は、確認する側のプロセス（数えない） */
export function auditProcesses(processes: ProcInfo[], selfPid: number): Finding[] {
  const live = processes.filter((p) => p.pid !== selfPid && p.status.state !== 'Z');
  const out: Finding[] = [];

  const main = live.find(isSoraMain);
  if (!main) {
    out.push(warn('proc.main-seccomp', 'Sora 本体のプロセスが見つからない', 'PID の名前空間を共有していない（--pid=container:<名前>）か、本体の起動の形が違う'));
  } else {
    out.push(main.status.seccomp === 2 ? pass('proc.main-seccomp', 'Sora 本体に、seccomp が効いている') : fail('proc.main-seccomp', `Sora 本体に、seccomp が効いていない（Seccomp: ${main.status.seccomp}）`, '--security-opt seccomp=unconfined を外す'));
    out.push(main.status.noNewPrivs === 1 ? pass('proc.main-nonewprivs', 'Sora 本体は、権限を増やせない（NoNewPrivs）') : warn('proc.main-nonewprivs', 'Sora 本体の NoNewPrivs が立っていない', '--security-opt no-new-privileges'));
    out.push(mainCaps(main.status.capEff));
  }

  const chromiums = live.filter(isChromium);
  if (chromiums.length === 0) {
    for (const [id, title] of [
      ['proc.chromium-uid', 'Chromium のプロセスが root でない'],
      ['proc.chromium-sandbox', 'Chromium が --no-sandbox で動いていない'],
      ['proc.chromium-caps', 'Chromium が capability を持っていない'],
    ] as const) {
      out.push(skip(id, title, 'Chromium が動いていない（ブラウザを使う取得の直後に流す）'));
    }
  } else {
    const root = chromiums.filter((p) => anyRoot(p.status.uid) || anyRoot(p.status.gid));
    out.push(root.length > 0 ? fail('proc.chromium-uid', `Chromium が root で動いている（pid ${root.map((p) => p.pid).join('・')}）`, 'uid を落とせていない（SORA_BROWSER_UID・capability・起動用バイナリを確かめる）') : pass('proc.chromium-uid', `Chromium のプロセス ${chromiums.length} 個が、root でない uid で動いている（uid ${[...new Set(chromiums.map((p) => p.status.uid[0]))].join('・')}）`));
    const noSandbox = chromiums.filter((p) => /--no-sandbox/.test(p.cmdline));
    out.push(noSandbox.length > 0 ? fail('proc.chromium-sandbox', 'Chromium が --no-sandbox で動いている', 'strict は、サンドボックス on が必須（SORA_BROWSER_SANDBOX=on）') : pass('proc.chromium-sandbox', 'Chromium は --no-sandbox ではない'));
    // サンドボックスの中（入れ子の PID の名前空間。zygote など）の capability は、その名前空間の中だけのもので、ホストに届かない
    const capable = chromiums.filter((p) => p.status.nspid.length <= 1 && !allZero(p.status.capEff));
    out.push(capable.length > 0 ? warn('proc.chromium-caps', `Chromium が capability を持っている（pid ${capable.map((p) => p.pid).join('・')}）`) : pass('proc.chromium-caps', 'Chromium は capability を持っていない'));
  }

  const pdfChildren = live.filter(isPdfChild);
  if (pdfChildren.length > 0) {
    const root = pdfChildren.filter((p) => anyRoot(p.status.uid));
    out.push(root.length > 0 ? fail('proc.pdf-uid', 'PDF の解析の別プロセスが root で動いている', 'uid を落とせていない（SORA_PDF_UID・capability・起動用バイナリを確かめる）') : pass('proc.pdf-uid', `PDF の解析の別プロセスは、root でない uid で動いている（uid ${pdfChildren[0]?.status.uid[0]}）`));
  }

  const expectedRoot = new Set<number>([1, main?.pid ?? -1]);
  const strayRoot = live.filter((p) => anyRoot(p.status.uid) && !expectedRoot.has(p.pid));
  if (strayRoot.length > 0) {
    out.push(warn('proc.unexpected-root', `本体と pid 1 のほかに、root のプロセスがある（${strayRoot.length} 個）`, strayRoot.slice(0, 3).map((p) => `pid ${p.pid}: ${p.cmdline.slice(0, 80)}`).join(' / ')));
  }
  return out;
}

// ---------------------------------------------------------------- 外向き

export type ConnectResult = 'connected' | 'refused' | 'timeout' | 'unreachable';

/** つなげるかを試した結果を、判定にする。メタデータの IP につながれば FAIL（内部のネットワークへ出られる）。ホストのサービスは WARN */
export function classifyConnect(target: 'metadata' | 'host-service', result: ConnectResult): Finding {
  if (target === 'metadata') {
    return result === 'connected'
      ? fail('net.metadata', 'コンテナから、メタデータの IP（169.254.169.254）につながる', 'クラウドの認証情報に届く。コンテナの外側で、この宛先を断つ（strict.md 5 章）')
      : pass('net.metadata', 'コンテナから、メタデータの IP（169.254.169.254）につながらない');
  }
  return result === 'connected'
    ? warn('net.host-service', 'コンテナから、ホスト（ゲートウェイ）のサービスにつながる', 'ホストの SSH・内部のサービスに届く。破られたプロセスの足場になるので、ホストのファイアウォールで、コンテナからの接続を断つ（strict.md 5 章）')
    : pass('net.host-service', 'コンテナから、ホスト（ゲートウェイ）のサービスにつながらない');
}

/** /proc/net/route の、既定の経路の gateway（リトルエンディアンの 16 進）を、IP の文字列にする */
export function defaultGateway(routeText: string): string | undefined {
  for (const line of routeText.split('\n').slice(1)) {
    const cells = line.trim().split(/\s+/);
    const [, destination, gateway] = cells;
    if (destination !== '00000000' || !gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway) || /^0+$/.test(gateway)) continue;
    return [6, 4, 2, 0].map((at) => Number.parseInt(gateway.slice(at, at + 2), 16)).join('.');
  }
  return undefined;
}

// ---------------------------------------------------------------- リバースプロキシの外から

export interface PublicProbe {
  health: number;
  metricsWithoutKey: number;
  scrapeWithoutKey: number;
}

/** --url（公開の URL）に、外から当てた結果を、手引と照らす。つながらなければ status 0 */
export function auditPublicUrl(probe: PublicProbe): Finding[] {
  return [
    probe.health === 200 ? pass('public.health', '公開の URL の /health が 200') : fail('public.health', `公開の URL の /health が 200 でない（HTTP ${probe.health}）`, 'リバースプロキシ・TLS・DNS を確かめる（vps.md 3・4 章）'),
    probe.metricsWithoutKey !== 200 && probe.metricsWithoutKey !== 0
      ? pass('public.metrics', `公開の URL で、/metrics を、鍵なしで読めない（HTTP ${probe.metricsWithoutKey}）`)
      : fail('public.metrics', probe.metricsWithoutKey === 0 ? '公開の URL につながらない' : '公開の URL で、/metrics を鍵なしで読める', 'プロキシで /metrics を隠す（vps.md 3・4 章）'),
    probe.scrapeWithoutKey === 401 ? pass('public.auth', '公開の URL で、鍵なしの /scrape は 401') : fail('public.auth', `公開の URL で、鍵なしの /scrape が 401 でない（HTTP ${probe.scrapeWithoutKey}）`, '鍵を設定した Sora は、鍵なしを 401 で断る。プロキシが Authorization を落としていないかを確かめる'),
  ];
}

// ---------------------------------------------------------------- 集計と表示

export function summarize(findings: Finding[]): { pass: number; warn: number; fail: number; skip: number; exitCode: number } {
  const count = (level: Level) => findings.filter((f) => f.level === level).length;
  return { pass: count('PASS'), warn: count('WARN'), fail: count('FAIL'), skip: count('SKIP'), exitCode: count('FAIL') > 0 ? 1 : 0 };
}

/** 1 件 1 行（`[LEVEL] id  題`）。詳細は、次の行に字下げして書く */
export function renderFindings(findings: Finding[]): string {
  return findings.map((f) => `[${f.level}] ${f.id}  ${f.title}${f.detail ? `\n       ${f.detail}` : ''}`).join('\n');
}

// ---------------------------------------------------------------- 実機での確認（HTTP・/proc・ネットワーク）

export interface Api {
  status: number;
  body: any;
}

/** 1 回の HTTP。つながらない・時間切れは status 0。鍵は、Authorization に付けるだけで、どこにも出さない */
async function api(base: string, method: 'GET' | 'POST' | 'DELETE', path: string, key?: string, body?: unknown, timeoutMs = 90_000): Promise<Api> {
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: undefined };
  }
}

/** 内部の宛先を取得させたときの応答の見方。静的な取得は 403。ブラウザは、要求を止めて、Chromium のエラーページ（chrome-error://）を 200 で返す。実際のページが返れば、取得できている */
export function scrapeOutcome(res: Api): 'denied' | 'allowed' | 'other' {
  if (res.status === 403) return 'denied';
  if (res.status === 200) return String(res.body?.url ?? '').startsWith('chrome-error://') ? 'denied' : 'allowed';
  return 'other';
}

/** 取得の応答の title か content に、その文字列があるか（本文の先頭の見出しは、title に入って、content から外れる） */
export function pageHas(body: any, text: string): boolean {
  return [body?.title, body?.content].some((value) => typeof value === 'string' && value.includes(text));
}

/** 内部の宛先（取得を断るはずのもの） */
const INTERNAL_URLS = (port: number): string[] => [
  `http://127.0.0.1:${port}/health`,
  'http://localhost/',
  'http://[::1]/',
  'http://169.254.169.254/latest/meta-data/',
  'http://metadata.google.internal/',
  'http://10.0.0.1/',
  'http://192.168.0.1/',
  'http://172.16.0.1/',
];

const PUBLIC_PAGE = { url: 'https://example.com', text: 'Example Domain' };
const PUBLIC_PDF = { url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', text: 'Dummy PDF file' };

interface Keys {
  admin?: string;
  a?: string;
  b?: string;
}

/** 認証・strict の状態・内部の宛先の拒否・（オンラインなら）公開の取得・利用者の分離 */
async function checkHttp(base: string, port: number, keys: Keys, offline: boolean): Promise<Finding[]> {
  const out: Finding[] = [];
  const health = await api(base, 'GET', '/health');
  out.push(health.status === 200 ? pass('http.health', '/health が 200') : fail('http.health', `/health が 200 でない（HTTP ${health.status}）`, 'Sora が起動していない・ポートが違う'));

  // 管理者の鍵の関所（strict は、/health?detailed=true と /metrics を、管理者の鍵だけにする）
  for (const path of ['/health?detailed=true', '/metrics']) {
    const name = path.startsWith('/metrics') ? 'metrics' : 'detailed';
    const without = await api(base, 'GET', path);
    out.push(without.status === 401 ? pass(`http.${name}-nokey`, `${path} は、鍵なしだと 401`) : fail(`http.${name}-nokey`, `${path} を、鍵なしで読める（HTTP ${without.status}）`, 'strict は、管理者の鍵だけにする（README 4.6）'));
    if (keys.a) {
      const plain = await api(base, 'GET', path, keys.a);
      out.push(plain.status === 403 ? pass(`http.${name}-plain`, `${path} は、一般の鍵だと 403`) : fail(`http.${name}-plain`, `${path} を、一般の鍵で読める（HTTP ${plain.status}）`, '管理者の鍵（admin: true）だけにする'));
    }
  }
  if (keys.admin) {
    const detailed = await api(base, 'GET', '/health?detailed=true', keys.admin, undefined, 60_000);
    out.push(...auditIsolation(detailed.status, detailed.body));
    const metrics = await api(base, 'GET', '/metrics', keys.admin);
    out.push(metrics.status === 200 ? pass('http.metrics-admin', '/metrics は、管理者の鍵で 200') : fail('http.metrics-admin', `/metrics を、管理者の鍵で読めない（HTTP ${metrics.status}）`));
  } else {
    out.push(skip('strict.level', 'strict の状態（/health?detailed=true）', '管理者の鍵（VPS_CHECK_ADMIN_KEY）が無い'));
  }

  // 認証
  const noKey = await api(base, 'POST', '/scrape', undefined, { url: 'https://example.com', mode: 'fast' });
  out.push(noKey.status === 401 ? pass('http.auth-nokey', '鍵なしの /scrape は 401') : fail('http.auth-nokey', `鍵なしの /scrape が 401 でない（HTTP ${noKey.status}）`, '鍵の設定（SORA_AUTH_KEYS_FILE）を確かめる'));
  const wrongKey = await api(base, 'POST', '/scrape', 'wrong-key-vps-check-0000000000000000', { url: 'https://example.com', mode: 'fast' });
  out.push(wrongKey.status === 401 ? pass('http.auth-wrong', '誤った鍵の /scrape は 401') : fail('http.auth-wrong', `誤った鍵の /scrape が 401 でない（HTTP ${wrongKey.status}）`));

  if (!keys.a) {
    out.push(skip('http.ssrf', '内部の宛先の取得を断る', '一般の鍵（VPS_CHECK_KEY_A）が無い'));
    return out;
  }

  // 内部の宛先の取得を、断る（SSRF）。事前検査の断りなので、ネットワークは要らない
  const denied: string[] = [];
  const allowed: string[] = [];
  const odd: string[] = [];
  const probes: Array<{ url: string; mode: 'fast' | 'browser' }> = [...INTERNAL_URLS(port).map((url) => ({ url, mode: 'fast' as const })), ...INTERNAL_URLS(port).slice(0, 4).map((url) => ({ url, mode: 'browser' as const }))];
  for (const probe of probes) {
    const res = await api(base, 'POST', '/scrape', keys.a, { url: probe.url, mode: probe.mode, noCache: true }, 60_000);
    const label = `${probe.mode}: ${probe.url}`;
    const outcome = scrapeOutcome(res);
    if (outcome === 'denied') denied.push(label);
    else if (outcome === 'allowed') allowed.push(label);
    else odd.push(`${label}（HTTP ${res.status}）`);
  }
  if (allowed.length > 0) out.push(fail('http.ssrf', `内部の宛先を取得できた（${allowed.length} 件）`, allowed.slice(0, 3).join(' / ')));
  else if (odd.length > 0) out.push(warn('http.ssrf', `内部の宛先の取得が、403・エラーページ以外になった（${odd.length} 件）`, odd.slice(0, 3).join(' / ')));
  else out.push(pass('http.ssrf', `内部の宛先 ${denied.length} 件の取得を断った（127.0.0.1・localhost・::1・メタデータ・プライベート IP。静的な取得は 403、ブラウザはエラーページ）`));

  // 管理者でない鍵の /cache/clear は、自分の利用者の分だけ
  const clear = await api(base, 'POST', '/cache/clear', keys.a, {});
  out.push(clear.status === 200 && clear.body?.scope === 'tenant' ? pass('http.cache-clear', '一般の鍵の /cache/clear は、自分の利用者の分だけ') : fail('http.cache-clear', `一般の鍵の /cache/clear が、自分の分だけではない（HTTP ${clear.status} scope ${String(clear.body?.scope)}）`, '全員分を消せるのは、管理者の鍵だけ'));

  // ブラウザ: ネットワークなしで、Chromium を、このコンテナの設定で起動する（サンドボックス・uid・seccomp が、本物の環境で通るか）
  const browser = await api(base, 'POST', '/browser/action', keys.a, { url: 'data:text/html,<title>vps-check</title><p>vps-check</p>', extract: { markdown: true } }, 120_000);
  out.push(browser.status === 200 ? pass('http.browser', 'Chromium が、この環境で起動して、ページを開けた') : fail('http.browser', `Chromium を起動して、ページを開けない（HTTP ${browser.status}）`, 'seccomp（Docker は deploy/seccomp-sora.json）・AppArmor・capability・/tmp の書き込みを確かめる'));

  if (offline) {
    out.push(skip('http.public-page', '公開のページを読める', '--offline'), skip('http.public-pdf', '公開の PDF を読める', '--offline'), skip('http.isolation-watch', '利用者ごとにウォッチが分かれる', '--offline'));
    return out;
  }

  // 公開のページ・PDF（出口のゲートウェイ・DNS・Chromium・PDF の解析が、この VPS で、通しで動く）
  const page = await api(base, 'POST', '/scrape', keys.a, { url: PUBLIC_PAGE.url, mode: 'fast', noCache: true });
  out.push(page.status === 200 && pageHas(page.body, PUBLIC_PAGE.text) ? pass('http.public-page', '公開のページを、静的な取得で読めた') : fail('http.public-page', `公開のページを、静的な取得で読めない（HTTP ${page.status}）`, '出口のゲートウェイ・DNS・外向きの通信を確かめる'));
  const rendered = await api(base, 'POST', '/scrape', keys.a, { url: PUBLIC_PAGE.url, mode: 'browser', noCache: true }, 120_000);
  out.push(rendered.status === 200 && pageHas(rendered.body, PUBLIC_PAGE.text) ? pass('http.public-browser', '公開のページを、ブラウザで読めた') : fail('http.public-browser', `公開のページを、ブラウザで読めない（HTTP ${rendered.status}）`, 'Chromium の出口（プロキシ・ゲートウェイ）を確かめる'));
  const pdf = await api(base, 'POST', '/scrape', keys.a, { url: PUBLIC_PDF.url, noCache: true }, 120_000);
  out.push(pdf.status === 200 && pageHas(pdf.body, PUBLIC_PDF.text) ? pass('http.public-pdf', '公開の PDF を読めた（別プロセスの解析）') : fail('http.public-pdf', `公開の PDF を読めない（HTTP ${pdf.status}）`, 'PDF の解析の別プロセス（uid を落とす capability・起動用バイナリ）を確かめる'));

  // 利用者ごとに分かれる: A が登録したウォッチは、B の一覧に出ず、B は消せない
  if (!keys.b) {
    out.push(skip('http.isolation-watch', '利用者ごとにウォッチが分かれる', '2 つ目の一般の鍵（VPS_CHECK_KEY_B）が無い'));
  } else {
    const registered = await api(base, 'POST', '/watch/register', keys.a, { url: PUBLIC_PAGE.url, title: 'vps-check' }, 120_000);
    const id = registered.body?.id ?? registered.body?.target?.id;
    if (registered.status !== 200 || typeof id !== 'string') {
      out.push(warn('http.isolation-watch', `ウォッチを登録できず、分離を確かめられなかった（HTTP ${registered.status}）`));
    } else {
      const listB = await api(base, 'GET', '/watch/list', keys.b);
      const seen = JSON.stringify(listB.body?.targets ?? []).includes(id);
      const deleteB = await api(base, 'DELETE', `/watch/${encodeURIComponent(id)}`, keys.b);
      const stillThere = JSON.stringify((await api(base, 'GET', '/watch/list', keys.a)).body?.targets ?? []).includes(id);
      await api(base, 'DELETE', `/watch/${encodeURIComponent(id)}`, keys.a);
      out.push(
        !seen && deleteB.body?.success !== true && stillThere
          ? pass('http.isolation-watch', 'A のウォッチは、B の一覧に出ず、B は消せない')
          : fail('http.isolation-watch', 'A のウォッチが、B に見える・B が消せる', `一覧に出た: ${seen}・B が消せた: ${deleteB.body?.success === true}`),
      );
    }
  }
  return out;
}

/** 同じ PID の名前空間のプロセスを、/proc から読む */
function readProcesses(): ProcInfo[] {
  const list: ProcInfo[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = parseProcStatus(readFileSync(`/proc/${name}/status`, 'utf8'));
      if (!status) continue;
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
      list.push({ pid: Number(name), cmdline, status });
    } catch {
      // 読む間に終わったプロセス
    }
  }
  return list;
}

/** host:port に TCP でつなぐ。つながる・拒否・到達できない・時間切れ（時間切れは、パケットを捨てられた = 断たれている） */
export function tryConnect(host: string, port: number, timeoutMs: number): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: ConnectResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED' ? 'refused' : error.code === 'ENETUNREACH' || error.code === 'EHOSTUNREACH' ? 'unreachable' : 'timeout'));
  });
}

async function checkNetwork(): Promise<Finding[]> {
  const out: Finding[] = [classifyConnect('metadata', await tryConnect('169.254.169.254', 80, 3000))];
  let route = '';
  try {
    route = readFileSync('/proc/net/route', 'utf8');
  } catch {}
  const gateway = defaultGateway(route);
  if (!gateway) {
    out.push(skip('net.host-service', 'コンテナから、ホスト（ゲートウェイ）のサービスにつながらない', '既定の経路（ゲートウェイ）が無い'));
  } else {
    const results = await Promise.all([22, 80, 443].map((port) => tryConnect(gateway, port, 3000)));
    out.push(classifyConnect('host-service', results.includes('connected') ? 'connected' : 'refused'));
  }
  return out;
}

async function checkPublicUrl(url: string): Promise<Finding[]> {
  const base = url.replace(/\/+$/, '');
  const [health, metrics, scrape] = await Promise.all([
    api(base, 'GET', '/health', undefined, undefined, 20_000),
    api(base, 'GET', '/metrics', undefined, undefined, 20_000),
    api(base, 'POST', '/scrape', undefined, { url: 'https://example.com', mode: 'fast' }, 20_000),
  ]);
  return auditPublicUrl({ health: health.status, metricsWithoutKey: metrics.status, scrapeWithoutKey: scrape.status });
}

/** 標準入力は、inspect の JSON のあとに、この行、そのあとに起動のログを続けたもの（ファイルで渡すと、確認用のコンテナが capability を持たないとき、所有者でなければ読めない） */
export const LOGS_MARKER = '=====sora-vps-check-logs=====';

/** 標準入力を、inspect の JSON と、起動のログ（マーカーがあれば）に分ける。JSON が壊れていれば inspect は undefined。最初のマーカーで分ける */
export function splitBundle(text: string): { inspect: unknown; logs?: string } {
  const marker = `\n${LOGS_MARKER}\n`;
  const at = text.indexOf(marker);
  let inspect: unknown;
  try {
    inspect = JSON.parse(at >= 0 ? text.slice(0, at) : text);
  } catch {}
  return at >= 0 ? { inspect, logs: text.slice(at + marker.length) } : { inspect };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** 使い方: bun vps-check.ts [--inspect-stdin（標準入力: inspect の JSON〔と、マーカーのあとに起動のログ〕）] [--port <ポート>] [--url <公開の URL>] [--offline] [--skip-network]。鍵は環境変数（VPS_CHECK_ADMIN_KEY・VPS_CHECK_KEY_A・VPS_CHECK_KEY_B） */
export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const option = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const offline = argv.includes('--offline');
  const keys: Keys = { admin: env.VPS_CHECK_ADMIN_KEY || undefined, a: env.VPS_CHECK_KEY_A || undefined, b: env.VPS_CHECK_KEY_B || undefined };
  const sections: Array<[string, Finding[]]> = [];

  let port = Number(option('--port') ?? 0);
  if (argv.includes('--inspect-stdin')) {
    const { inspect, logs } = splitBundle(await readStdin());
    sections.push(['コンテナの起動の設定（inspect）', auditInspect(inspect)]);
    if (logs !== undefined) sections.push(['起動のログ', auditLogs(logs)]);
    if (!port && Array.isArray(inspect) && isRecord(inspect[0]) && isRecord(inspect[0].Config)) port = Number(envTable(inspect[0].Config.Env).get('PORT') ?? 0);
  }
  if (!port) port = 8000;

  sections.push(['HTTP（このコンテナのネットワークから）', await checkHttp(`http://127.0.0.1:${port}`, port, keys, offline)]);
  sections.push(['コンテナの中のプロセス（/proc）', auditProcesses(readProcesses(), process.pid)]);
  if (!argv.includes('--skip-network')) sections.push(['外向きの通信（コンテナの外側の制限）', await checkNetwork()]);
  const url = option('--url');
  if (url) sections.push([`公開の URL（${url}）`, await checkPublicUrl(url)]);

  const all = sections.flatMap(([, findings]) => findings);
  for (const [title, findings] of sections) console.log(`\n## ${title}\n${renderFindings(findings)}`);
  const total = summarize(all);
  console.log(`\n結果: PASS ${total.pass}・WARN ${total.warn}・FAIL ${total.fail}・SKIP ${total.skip}`);
  if (total.fail > 0) console.log('FAIL を直してください（docs/operations/strict.md・vps.md）。');
  return total.exitCode;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env));
