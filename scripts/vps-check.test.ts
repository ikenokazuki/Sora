import { describe, expect, test } from 'bun:test';
import {
  auditInspect,
  auditIsolation,
  auditLogs,
  auditProcesses,
  auditPublicUrl,
  capNames,
  classifyConnect,
  defaultGateway,
  type Finding,
  type Level,
  pageHas,
  parseProcStatus,
  type ProcInfo,
  renderFindings,
  scrapeOutcome,
  summarize,
} from './vps-check.js';

/**
 * 実機の VPS で `strict` を確かめるスクリプト（scripts/vps-check.sh から、同じイメージの使い捨てのコンテナで動く）の、判定の部分。
 * 実際の確認（Docker・Podman の inspect・/proc・HTTP・ネットワーク）は、CI の verify-image（15）で、本物の strict のコンテナに当てる。
 */

const of = (findings: Finding[], level: Level): string[] => findings.filter((f) => f.level === level).map((f) => f.id);

/** 推奨の運用（strict.md・vps.md）の docker inspect。違反も注意もない */
function compliant(): any[] {
  return [
    {
      State: { Running: true, OOMKilled: false },
      Config: {
        User: '',
        Image: 'ghcr.io/ikenokazuki/sora:sha-abcdef0',
        Env: ['PORT=8000', 'SORA_ISOLATION=strict', 'SORA_BROWSER_SANDBOX=on', 'SORA_EGRESS_GATEWAY=on', 'SORA_AUTH_KEYS_FILE=/run/secrets/sora-keys/keys.json', 'SORA_ALLOWED_HOSTS=sora.example.com'],
      },
      HostConfig: {
        Privileged: false,
        CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'KILL', 'SETGID', 'SETUID'],
        CapDrop: ['ALL'],
        SecurityOpt: ['seccomp={"defaultAction":"SCMP_ACT_ERRNO"}', 'no-new-privileges'],
        Memory: 2_147_483_648,
        PidsLimit: 512,
        NetworkMode: 'bridge',
        PidMode: '',
        IpcMode: 'private',
        ReadonlyRootfs: true,
        RestartPolicy: { Name: 'unless-stopped' },
        PortBindings: { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3016' }] },
      },
      Mounts: [{ Type: 'bind', Source: '/srv/sora/keys', Destination: '/run/secrets/sora-keys', RW: false }],
    },
  ];
}

/** 推奨の運用から、1 つだけ替えた docker inspect */
function changed(edit: (container: any) => void): any[] {
  const inspect = compliant();
  edit(inspect[0]);
  return inspect;
}

describe('auditInspect（コンテナの起動の設定。docker inspect・podman inspect の JSON）', () => {
  test('推奨の運用は、FAIL も WARN も出ない', () => {
    const findings = auditInspect(compliant());
    expect(of(findings, 'FAIL')).toEqual([]);
    expect(of(findings, 'WARN')).toEqual([]);
    expect(of(findings, 'PASS').length).toBeGreaterThan(10);
    expect(findings.find((f) => f.id === 'container.memory')?.title).toContain('2048 MB');
    expect(findings.find((f) => f.id === 'container.pids')?.title).toContain('512');
  });

  test('JSON の形が違えば（配列でない・空・コンテナが無い）、FAIL を 1 つだけ返す', () => {
    for (const bad of [null, {}, [], 'x', [null]]) expect(of(auditInspect(bad), 'FAIL')).toEqual(['container.inspect']);
  });

  test('動いていないコンテナは FAIL。メモリで止まったことがあれば WARN', () => {
    expect(of(auditInspect(changed((c) => (c.State.Running = false))), 'FAIL')).toContain('container.running');
    expect(of(auditInspect(changed((c) => (c.State.OOMKilled = true))), 'WARN')).toContain('container.oom');
  });

  test('特権コンテナ・ホストのネットワーク・ホストの PID・IPC は FAIL', () => {
    expect(of(auditInspect(changed((c) => (c.HostConfig.Privileged = true))), 'FAIL')).toContain('container.privileged');
    expect(of(auditInspect(changed((c) => (c.HostConfig.NetworkMode = 'host'))), 'FAIL')).toContain('container.network');
    expect(of(auditInspect(changed((c) => (c.HostConfig.PidMode = 'host'))), 'FAIL')).toContain('container.namespaces');
    expect(of(auditInspect(changed((c) => (c.HostConfig.IpcMode = 'host'))), 'FAIL')).toContain('container.namespaces');
  });

  test('メモリの上限と PID の上限が無ければ FAIL（0・null・-1 は無し）', () => {
    for (const none of [0, null, undefined, -1]) {
      expect(of(auditInspect(changed((c) => (c.HostConfig.Memory = none))), 'FAIL')).toContain('container.memory');
      expect(of(auditInspect(changed((c) => (c.HostConfig.PidsLimit = none))), 'FAIL')).toContain('container.pids');
    }
  });

  test('seccomp が unconfined なら FAIL。指定なし（既定）は PASS。AppArmor が unconfined も FAIL', () => {
    expect(of(auditInspect(changed((c) => (c.HostConfig.SecurityOpt = ['seccomp=unconfined', 'no-new-privileges']))), 'FAIL')).toContain('container.seccomp');
    const defaultSeccomp = auditInspect(changed((c) => (c.HostConfig.SecurityOpt = ['no-new-privileges'])));
    expect(of(defaultSeccomp, 'FAIL')).toEqual([]);
    expect(of(defaultSeccomp, 'PASS')).toContain('container.seccomp');
    expect(of(auditInspect(changed((c) => (c.HostConfig.SecurityOpt = ['seccomp={}', 'apparmor=unconfined', 'no-new-privileges']))), 'FAIL')).toContain('container.apparmor');
  });

  test('SecurityOpt が null でも落ちない（no-new-privileges が無いので WARN）', () => {
    const findings = auditInspect(changed((c) => (c.HostConfig.SecurityOpt = null)));
    expect(of(findings, 'FAIL')).toEqual([]);
    expect(of(findings, 'WARN')).toContain('container.no-new-privileges');
  });

  test('no-new-privileges:false は、効いていないので WARN', () => {
    expect(of(auditInspect(changed((c) => (c.HostConfig.SecurityOpt = ['seccomp={}', 'no-new-privileges:false']))), 'WARN')).toContain('container.no-new-privileges');
    expect(of(auditInspect(changed((c) => (c.HostConfig.SecurityOpt = ['seccomp={}', 'no-new-privileges:true']))), 'WARN')).not.toContain('container.no-new-privileges');
  });

  test('capability は inspect では見ない（docker は足した・落としたの一覧、podman は既定との差で持つので、実効の capability は /proc で見る）', () => {
    const findings = auditInspect(changed((c) => {
      c.HostConfig.CapDrop = ['CAP_FOWNER', 'CAP_FSETID', 'CAP_SETFCAP'];
      c.HostConfig.CapAdd = [];
    }));
    expect(of(findings, 'FAIL')).toEqual([]);
    expect(of(findings, 'WARN')).toEqual([]);
    expect(findings.some((f) => f.id === 'container.caps')).toBe(false);
  });

  test('公開するポート: 127.0.0.1 だけなら PASS。0.0.0.0・空・:: は WARN（プロキシの手前を想定）。公開なしは PASS', () => {
    for (const host of ['0.0.0.0', '', '::']) {
      expect(of(auditInspect(changed((c) => (c.HostConfig.PortBindings = { '8000/tcp': [{ HostIp: host, HostPort: '8000' }] }))), 'WARN')).toContain('container.ports');
    }
    expect(of(auditInspect(changed((c) => (c.HostConfig.PortBindings = { '8000/tcp': [{ HostIp: '::1', HostPort: '8000' }] }))), 'WARN')).not.toContain('container.ports');
    expect(of(auditInspect(changed((c) => (c.HostConfig.PortBindings = {}))), 'WARN')).not.toContain('container.ports');
  });

  test('マウント: コンテナのランタイムのソケットや、ホストの / は FAIL。鍵のディレクトリが書き込み可なら WARN', () => {
    expect(of(auditInspect(changed((c) => c.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }))), 'FAIL')).toContain('container.mounts');
    expect(of(auditInspect(changed((c) => c.Mounts.push({ Type: 'bind', Source: '/run/podman/podman.sock', Destination: '/x', RW: false }))), 'FAIL')).toContain('container.mounts');
    expect(of(auditInspect(changed((c) => c.Mounts.push({ Type: 'bind', Source: '/', Destination: '/host', RW: false }))), 'FAIL')).toContain('container.mounts');
    expect(of(auditInspect(changed((c) => (c.Mounts[0].RW = true))), 'WARN')).toContain('container.keys-mount');
  });

  test('ユーザー: root（空・0・root）は PASS。ほかは FAIL（strict は root で起動して、Chromium だけを落とす）', () => {
    for (const user of ['', '0', 'root', '0:0']) expect(of(auditInspect(changed((c) => (c.Config.User = user))), 'FAIL')).not.toContain('container.user');
    expect(of(auditInspect(changed((c) => (c.Config.User = '65532'))), 'FAIL')).toContain('container.user');
  });

  test('ルートファイルシステムが書き込み可なら WARN。再起動の設定が無ければ WARN', () => {
    expect(of(auditInspect(changed((c) => (c.HostConfig.ReadonlyRootfs = false))), 'WARN')).toContain('container.readonly-rootfs');
    expect(of(auditInspect(changed((c) => (c.HostConfig.RestartPolicy = { Name: 'no' }))), 'WARN')).toContain('container.restart');
    expect(of(auditInspect(changed((c) => (c.HostConfig.RestartPolicy = { Name: '' }))), 'WARN')).toContain('container.restart');
  });

  test('環境変数: strict の必須（水準・サンドボックス on・ゲートウェイ on・鍵ファイル）が無ければ FAIL', () => {
    const without = (name: string) => changed((c) => (c.Config.Env = c.Config.Env.filter((e: string) => !e.startsWith(`${name}=`))));
    expect(of(auditInspect(without('SORA_ISOLATION')), 'FAIL')).toContain('config.isolation');
    expect(of(auditInspect(without('SORA_BROWSER_SANDBOX')), 'FAIL')).toContain('config.sandbox');
    expect(of(auditInspect(without('SORA_EGRESS_GATEWAY')), 'FAIL')).toContain('config.gateway');
    expect(of(auditInspect(without('SORA_AUTH_KEYS_FILE')), 'FAIL')).toContain('config.keys-file');
    expect(of(auditInspect(changed((c) => c.Config.Env.push('SORA_FETCH_ALLOW_PRIVATE_NETWORK=true'))), 'FAIL')).toContain('config.private-network');
    expect(of(auditInspect(changed((c) => c.Config.Env.push('SORA_BROWSER_UID=off'))), 'FAIL')).toContain('config.uid-off');
    expect(of(auditInspect(changed((c) => c.Config.Env.push('SORA_PDF_UID=off'))), 'FAIL')).toContain('config.uid-off');
  });

  test('環境変数の書き方（大文字・on の別名・前後の空白）は、Sora と同じに読む', () => {
    const edit = changed((c) => (c.Config.Env = c.Config.Env.map((e: string) => (e.startsWith('SORA_BROWSER_SANDBOX=') ? 'SORA_BROWSER_SANDBOX= ON ' : e.startsWith('SORA_EGRESS_GATEWAY=') ? 'SORA_EGRESS_GATEWAY=true' : e))));
    expect(of(auditInspect(edit), 'FAIL')).toEqual([]);
  });

  test('SORA_ALLOWED_HOSTS が無ければ WARN。単一の鍵 SORA_API_KEY があれば WARN（利用者を分けられない）', () => {
    expect(of(auditInspect(changed((c) => (c.Config.Env = c.Config.Env.filter((e: string) => !e.startsWith('SORA_ALLOWED_HOSTS='))))), 'WARN')).toContain('config.allowed-hosts');
    expect(of(auditInspect(changed((c) => c.Config.Env.push('SORA_API_KEY=secret-single-key'))), 'WARN')).toContain('config.single-key');
  });

  test('出力に、環境変数の値（秘密）を入れない', () => {
    const findings = auditInspect(changed((c) => c.Config.Env.push('SORA_API_KEY=very-secret-value-123', 'OPENAI_API_KEY=sk-never-print')));
    const text = JSON.stringify(findings);
    expect(text).not.toContain('very-secret-value-123');
    expect(text).not.toContain('sk-never-print');
  });
});

describe('auditIsolation（/health?detailed=true の isolation。管理者の鍵で読む）', () => {
  const ok = () => ({
    status: 'ok',
    isolation: {
      level: 'strict',
      browser: { sandbox: 'on', connection: 'pipe', processes: { active: 1, max: 4 } },
      egressGateway: { enabled: true, started: true },
      authKeys: { stale: false, staleSeconds: 0 },
    },
  });

  test('推奨の状態は、すべて PASS', () => {
    const findings = auditIsolation(200, ok());
    expect(of(findings, 'FAIL')).toEqual([]);
    expect(of(findings, 'WARN')).toEqual([]);
    expect(of(findings, 'PASS')).toEqual(expect.arrayContaining(['strict.level', 'strict.sandbox', 'strict.connection', 'strict.gateway', 'strict.keys-fresh']));
  });

  test('応答が 200 でない・isolation が無い（standard）なら、FAIL を 1 つ', () => {
    expect(of(auditIsolation(401, { error: 'x' }), 'FAIL')).toEqual(['strict.detailed']);
    expect(of(auditIsolation(200, { status: 'ok' }), 'FAIL')).toEqual(['strict.level']);
    expect(of(auditIsolation(200, null), 'FAIL')).toEqual(['strict.detailed']);
  });

  test('isolation があっても、水準が strict でなければ FAIL', () => {
    const body = ok();
    (body.isolation as any).level = 'standard';
    expect(of(auditIsolation(200, body), 'FAIL')).toEqual(['strict.level']);
  });

  test('サンドボックスが off なら FAIL。unknown（まだ起動していない）は WARN', () => {
    const edit = (sandbox: string) => {
      const body = ok();
      body.isolation.browser.sandbox = sandbox;
      return auditIsolation(200, body);
    };
    expect(of(edit('off'), 'FAIL')).toContain('strict.sandbox');
    expect(of(edit('unknown'), 'WARN')).toContain('strict.sandbox');
  });

  test('ブラウザとの接続がポート（または pipe 以外のもの）なら FAIL', () => {
    for (const connection of ['port', 'socket', '']) {
      const body = ok();
      body.isolation.browser.connection = connection;
      expect(of(auditIsolation(200, body), 'FAIL'), connection).toContain('strict.connection');
    }
  });

  test('ゲートウェイ: 使わない設定は FAIL。まだ始めていなければ WARN', () => {
    const disabled = ok();
    disabled.isolation.egressGateway = { enabled: false, started: false };
    expect(of(auditIsolation(200, disabled), 'FAIL')).toContain('strict.gateway');
    const idle = ok();
    idle.isolation.egressGateway = { enabled: true, started: false };
    expect(of(auditIsolation(200, idle), 'WARN')).toContain('strict.gateway');
  });

  test('鍵の表: 前の鍵で動いている（stale）なら FAIL（消した鍵が有効のまま）。表の項目が無ければ WARN', () => {
    const stale = ok();
    stale.isolation.authKeys = { stale: true, staleSeconds: 120 };
    const findings = auditIsolation(200, stale);
    expect(of(findings, 'FAIL')).toContain('strict.keys-fresh');
    expect(findings.find((f) => f.id === 'strict.keys-fresh')?.detail).toContain('120');
    const missing = ok() as any;
    delete missing.isolation.authKeys;
    expect(of(auditIsolation(200, missing), 'WARN')).toContain('strict.keys-fresh');
  });
});

describe('auditLogs（コンテナのログ。起動のときの strict の確認の記録）', () => {
  const good = [
    '[Sora/Strict] PDF の解析を、別の uid に落とした別プロセスで動かせることを確かめました',
    '[Sora/Strict] 起動の確認が通りました（Chromium を、サンドボックス有効・別の uid で起動できました）',
    'Starting Sora service on port 8000...',
  ].join('\n');

  test('起動の確認が通った記録と、PDF の解析を別の uid に落とした記録があれば、PASS', () => {
    const findings = auditLogs(good);
    expect(of(findings, 'FAIL')).toEqual([]);
    expect(of(findings, 'WARN')).toEqual([]);
    expect(of(findings, 'PASS')).toEqual(['log.strict-startup', 'log.pdf-uid', 'log.warnings']);
  });

  test('起動の確認の失敗の行（起動しません）は、通った記録ではない', () => {
    expect(of(auditLogs('[Sora/Strict] SORA_ISOLATION=strict の起動の確認に失敗したので、起動しません'), 'FAIL')).toEqual(['log.strict-startup']);
  });

  test('起動の確認が通った記録が無ければ FAIL（strict の起動の確認が通っていない、またはログが流れて消えた）', () => {
    expect(of(auditLogs('Starting Sora service on port 8000...'), 'FAIL')).toEqual(['log.strict-startup']);
    expect(of(auditLogs(''), 'FAIL')).toEqual(['log.strict-startup']);
  });

  test('PDF の記録: 別の uid に落とす前の版の記録（別プロセスだけ）は WARN。記録が無いのも WARN', () => {
    const old = good.replace('別の uid に落とした別プロセス', '別プロセス');
    expect(of(auditLogs(old), 'WARN')).toContain('log.pdf-uid');
    expect(of(auditLogs('[Sora/Strict] 起動の確認が通りました'), 'WARN')).toContain('log.pdf-uid');
  });

  test('起動のときの警告（設定・capability・uid）があれば WARN。最初の数行を詳細に出す。ほかの行の値は出さない', () => {
    const noisy = `${good}\n[Sora/Config] 警告: SORA_ALLOWED_HOSTS が無い\n[Sora/PDF] PDF の解析の別プロセスを別の uid に落とせない: capability が足りない\nrequest sk-secret-token-9999 handled`;
    const findings = auditLogs(noisy);
    expect(of(findings, 'WARN')).toContain('log.warnings');
    const detail = findings.find((f) => f.id === 'log.warnings')?.detail ?? '';
    expect(detail).toContain('SORA_ALLOWED_HOSTS');
    expect(detail).toContain('capability');
    expect(JSON.stringify(findings)).not.toContain('sk-secret-token-9999');
  });
});

describe('parseProcStatus（/proc/<pid>/status）', () => {
  const text = 'Name:\tbun\nState:\tS (sleeping)\nPPid:\t1\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t\nNSpid:\t172\t3\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\n';

  test('名前・状態・親・uid・gid・NSpid・capability・NoNewPrivs・Seccomp を読む', () => {
    expect(parseProcStatus(text)).toEqual({ name: 'bun', state: 'S', ppid: 1, uid: [0, 0, 0, 0], gid: [0, 0, 0, 0], nspid: [172, 3], capEff: '0000000000000000', noNewPrivs: 1, seccomp: 2 });
  });

  test('欄が無い（古いカーネル・途中で消えた）ときは、安全でない側（NoNewPrivs 0・Seccomp 0）として読む', () => {
    const parsed = parseProcStatus('Name:\tx\nState:\tZ (zombie)\nPPid:\t5\nUid:\t1\t1\t1\t1\nGid:\t1\t1\t1\t1\n');
    expect(parsed).toMatchObject({ noNewPrivs: 0, seccomp: 0, capEff: '', state: 'Z', nspid: [] });
  });

  test('uid の行が読めなければ undefined', () => {
    expect(parseProcStatus('Name:\tx\n')).toBeUndefined();
  });
});

describe('auditProcesses（Sora のコンテナの中のプロセス。同じ PID の名前空間で見る）', () => {
  const proc = (pid: number, ppid: number, uid: number, cmdline: string, extra: Partial<ProcInfo['status']> = {}): ProcInfo => ({
    pid,
    cmdline,
    status: { name: 'x', state: 'S', ppid, uid: [uid, uid, uid, uid], gid: [uid, uid, uid, uid], nspid: [pid], capEff: uid === 0 ? '00000000000000e3' : '0000000000000000', noNewPrivs: 1, seccomp: 2, ...extra },
  });
  const main = () => proc(7, 1, 0, '/usr/local/bin/bun /app/server.js');
  const tini = () => proc(1, 0, 0, '/usr/bin/tini -- /usr/local/bin/bun /app/server.js');
  const chromium = (pid: number, uid: number, extra = '') => proc(pid, 7, uid, `/usr/bin/chromium --headless ${extra} --user-data-dir=/tmp/sora-chromium-abc123`);

  test('推奨の状態（本体は seccomp 付き・Chromium は root でなく、権限なし、サンドボックスあり）は、FAIL も WARN も出ない', () => {
    const findings = auditProcesses([tini(), main(), chromium(20, 65532), chromium(21, 65532)], 999);
    expect(of(findings, 'FAIL')).toEqual([]);
    expect(of(findings, 'WARN')).toEqual([]);
    expect(of(findings, 'PASS')).toEqual(expect.arrayContaining(['proc.main-seccomp', 'proc.main-caps', 'proc.chromium-uid', 'proc.chromium-sandbox', 'proc.chromium-caps']));
  });

  test('Chromium が動いていなければ、Chromium の確認は SKIP（失敗にしない）', () => {
    const findings = auditProcesses([tini(), main()], 999);
    expect(of(findings, 'SKIP')).toEqual(expect.arrayContaining(['proc.chromium-uid']));
    expect(of(findings, 'FAIL')).toEqual([]);
  });

  test('Chromium が root で動いていれば FAIL', () => {
    expect(of(auditProcesses([tini(), main(), chromium(20, 0)], 999), 'FAIL')).toContain('proc.chromium-uid');
  });

  test('Chromium の uid・gid の 4 つの欄のどれかが root でも FAIL', () => {
    const oddUid = chromium(20, 65532);
    oddUid.status.uid = [65532, 65532, 0, 65532];
    expect(of(auditProcesses([tini(), main(), oddUid], 999), 'FAIL')).toContain('proc.chromium-uid');
    const oddGid = chromium(21, 65532);
    oddGid.status.gid = [65532, 0, 65532, 65532];
    expect(of(auditProcesses([tini(), main(), oddGid], 999), 'FAIL')).toContain('proc.chromium-uid');
  });

  test('ゾンビ（終わったが、まだ刈られていない）は、数えない', () => {
    const deadRoot = proc(31, 7, 0, '/bin/sh -c gone', { state: 'Z' });
    const deadChromium = chromium(22, 0);
    deadChromium.status.state = 'Z';
    const findings = auditProcesses([tini(), main(), deadRoot, deadChromium], 999);
    expect(of(findings, 'WARN')).toEqual([]);
    expect(of(findings, 'FAIL')).toEqual([]);
    expect(of(findings, 'SKIP')).toContain('proc.chromium-uid');
  });

  test('--no-sandbox で動いていれば FAIL', () => {
    expect(of(auditProcesses([tini(), main(), chromium(20, 65532, '--no-sandbox')], 999), 'FAIL')).toContain('proc.chromium-sandbox');
  });

  test('Chromium が capability を持っていれば WARN', () => {
    const capable = chromium(20, 65532);
    capable.status.capEff = '0000000000000400';
    expect(of(auditProcesses([tini(), main(), capable], 999), 'WARN')).toContain('proc.chromium-caps');
  });

  test('本体の seccomp が効いていなければ FAIL。NoNewPrivs が無ければ WARN', () => {
    for (const mode of [0, 1]) {
      const noFilter = main();
      noFilter.status.seccomp = mode; // 0: 無し・1: strict モード（フィルタではない）
      expect(of(auditProcesses([tini(), noFilter], 999), 'FAIL'), String(mode)).toContain('proc.main-seccomp');
    }
    const privs = main();
    privs.status.noNewPrivs = 0;
    expect(of(auditProcesses([tini(), privs], 999), 'WARN')).toContain('proc.main-nonewprivs');
  });

  test('本体の capability: 5 つだけなら PASS。ほかを持っていれば WARN（既定のまま）。危ないもの（SYS_ADMIN など）は FAIL。5 つが足りなければ FAIL', () => {
    const withCaps = (hex: string) => {
      const m = main();
      m.status.capEff = hex;
      return auditProcesses([tini(), m], 999);
    };
    expect(of(withCaps('00000000000000e3'), 'PASS')).toContain('proc.main-caps');
    // docker の既定: 5 つに、FOWNER・FSETID・SETPCAP・NET_BIND_SERVICE・SYS_CHROOT・MKNOD・NET_RAW・AUDIT_WRITE・SETFCAP が足される
    const dockerDefault = withCaps('00000000a80425fb');
    expect(of(dockerDefault, 'WARN')).toContain('proc.main-caps');
    expect(of(dockerDefault, 'FAIL')).not.toContain('proc.main-caps');
    expect(of(withCaps('00000000002000e3'), 'FAIL')).toContain('proc.main-caps'); // SYS_ADMIN（ビット 21）
    expect(of(withCaps('00000000000a00e3'), 'FAIL')).toContain('proc.main-caps'); // SYS_RAWIO（17）・SYS_PTRACE（19）
    expect(of(withCaps('00000000000004e3'), 'WARN')).toContain('proc.main-caps'); // 5 つに NET_BIND_SERVICE が 1 つだけ多い
    expect(of(withCaps('0000000000000003'), 'FAIL')).toContain('proc.main-caps'); // CHOWN・DAC_OVERRIDE だけ
    expect(of(withCaps('0000000000000000'), 'FAIL')).toContain('proc.main-caps');
  });

  test('capability の欄が読めなければ、本体の capability は WARN（分からない）', () => {
    const m = main();
    m.status.capEff = '';
    expect(of(auditProcesses([tini(), m], 999), 'WARN')).toContain('proc.main-caps');
  });

  test('Chromium のサンドボックスの中（入れ子の PID の名前空間。zygote）の capability は、その名前空間の中だけのものなので、数えない', () => {
    const nested = chromium(20, 65532);
    nested.status.capEff = '0000000000200000'; // CAP_SYS_ADMIN（入れ子のユーザー名前空間の中）
    nested.status.nspid = [20, 3];
    expect(of(auditProcesses([tini(), main(), nested], 999), 'WARN')).toEqual([]);
    const outer = chromium(21, 65532);
    outer.status.capEff = '0000000000200000';
    expect(of(auditProcesses([tini(), main(), outer], 999), 'WARN')).toContain('proc.chromium-caps');
  });

  test('本体が見つからなければ WARN（PID の名前空間を共有していない）', () => {
    expect(of(auditProcesses([tini()], 999), 'WARN')).toContain('proc.main-seccomp');
  });

  test('確認する側のプロセス（自分）は、数えない。ほかの root のプロセスがあれば WARN', () => {
    const self = proc(999, 1, 0, '/usr/local/bin/bun /check.ts');
    expect(of(auditProcesses([tini(), main(), self], 999), 'WARN')).toEqual([]);
    const shell = proc(30, 7, 0, '/bin/sh -c something');
    expect(of(auditProcesses([tini(), main(), shell], 999), 'WARN')).toContain('proc.unexpected-root');
  });

  test('PDF の解析の別プロセス（pdf-parse.js・pdf_child_main.ts）は、本体の子の root でなければ PASS。root なら FAIL', () => {
    const pdf = (uid: number) => proc(40, 7, uid, '/usr/local/bin/bun --no-env-file /app/pdf-parse.js --params {}');
    expect(of(auditProcesses([tini(), main(), pdf(65530)], 999), 'FAIL')).toEqual([]);
    expect(of(auditProcesses([tini(), main(), pdf(65530)], 999), 'PASS')).toContain('proc.pdf-uid');
    expect(of(auditProcesses([tini(), main(), pdf(0)], 999), 'FAIL')).toContain('proc.pdf-uid');
  });
});

describe('capNames（CapEff の 16 進 → capability の名前）', () => {
  test('ビットの番号を、名前にする', () => {
    expect(capNames('00000000000000e3')).toEqual(['CHOWN', 'DAC_OVERRIDE', 'KILL', 'SETGID', 'SETUID']);
    expect(capNames('0000000000200000')).toEqual(['SYS_ADMIN']);
    expect(capNames('0000000000000000')).toEqual([]);
    expect(capNames('')).toEqual([]);
  });

  test('名前の無いビットは CAP_<番号>。大きい値（64 ビット）も読める', () => {
    expect(capNames('0000020000000000')).toEqual(['CAP_41']);
    expect(capNames('000001ffffffffff')).toHaveLength(41);
  });
});

describe('pageHas（公開のページを読めたかの判定）', () => {
  test('title か content のどちらかに、文字列があれば true（本文の先頭の見出しは、title に入る）', () => {
    expect(pageHas({ title: 'Example Domain', content: 'This domain is for use' }, 'Example Domain')).toBe(true);
    expect(pageHas({ title: 'x', content: 'a Dummy PDF file b' }, 'Dummy PDF file')).toBe(true);
  });

  test('どちらにも無い・文字列でない・応答が無ければ false', () => {
    expect(pageHas({ title: 'other', content: 'text' }, 'Example Domain')).toBe(false);
    expect(pageHas({ title: 1, content: null }, 'Example Domain')).toBe(false);
    expect(pageHas(undefined, 'Example Domain')).toBe(false);
  });
});

describe('scrapeOutcome（内部の宛先を取得させたときの応答の見方）', () => {
  test('403（静的な取得の断り）は denied', () => {
    expect(scrapeOutcome({ status: 403, body: { code: 'SSRF_BLOCKED' } })).toBe('denied');
  });

  test('200 でも、Chromium のエラーページ（chrome-error://）なら denied（ブラウザは、要求を止めて、エラーページを返す）', () => {
    expect(scrapeOutcome({ status: 200, body: { url: 'chrome-error://chromewebdata/', content: 'The webpage might be temporarily down' } })).toBe('denied');
  });

  test('200 で、実際の URL のページが返ったら allowed（取得できてしまった）', () => {
    expect(scrapeOutcome({ status: 200, body: { url: 'http://127.0.0.1:8000/health', content: '{"status":"ok"}' } })).toBe('allowed');
    expect(scrapeOutcome({ status: 200, body: undefined })).toBe('allowed');
  });

  test('ほかの応答（500・つながらない 0）は other', () => {
    expect(scrapeOutcome({ status: 500, body: {} })).toBe('other');
    expect(scrapeOutcome({ status: 0, body: undefined })).toBe('other');
  });
});

describe('外向きの通信の判定', () => {
  test('classifyConnect: つながったら FAIL（コンテナから出られる）。拒否・時間切れ・到達できないは PASS', () => {
    expect(classifyConnect('metadata', 'connected').level).toBe('FAIL');
    for (const result of ['refused', 'timeout', 'unreachable'] as const) expect(classifyConnect('metadata', result).level).toBe('PASS');
  });

  test('classifyConnect: ホストのサービス（ゲートウェイの IP）は、つながったら WARN（FAIL ではない）', () => {
    expect(classifyConnect('host-service', 'connected').level).toBe('WARN');
    expect(classifyConnect('host-service', 'refused').level).toBe('PASS');
  });

  test('defaultGateway: /proc/net/route の既定の経路の gateway（リトルエンディアンの 16 進）を、IP にする', () => {
    const route = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';
    expect(defaultGateway(route)).toBe('172.17.0.1');
  });

  test('defaultGateway: 既定の経路に gateway が無い（00000000。直接つながる経路）なら undefined', () => {
    const route = 'Iface\tDestination\tGateway\tFlags\neth0\t00000000\t00000000\t0001\n';
    expect(defaultGateway(route)).toBeUndefined();
  });

  test('defaultGateway: 既定の経路が無ければ undefined', () => {
    expect(defaultGateway('Iface\tDestination\tGateway\tFlags\n')).toBeUndefined();
    expect(defaultGateway('')).toBeUndefined();
  });
});

describe('auditPublicUrl（リバースプロキシの外から）', () => {
  test('/health が 200、/metrics は 200 でない（隠れている・鍵が要る）、鍵なしの /scrape は 401 なら、すべて PASS', () => {
    const findings = auditPublicUrl({ health: 200, metricsWithoutKey: 401, scrapeWithoutKey: 401 });
    expect(of(findings, 'FAIL')).toEqual([]);
    expect(of(findings, 'PASS')).toEqual(['public.health', 'public.metrics', 'public.auth']);
  });

  test('/metrics が鍵なしで 200 なら FAIL。鍵なしの /scrape が 401 でなければ FAIL。/health が 200 でなければ FAIL', () => {
    expect(of(auditPublicUrl({ health: 200, metricsWithoutKey: 200, scrapeWithoutKey: 401 }), 'FAIL')).toEqual(['public.metrics']);
    expect(of(auditPublicUrl({ health: 200, metricsWithoutKey: 401, scrapeWithoutKey: 200 }), 'FAIL')).toEqual(['public.auth']);
    expect(of(auditPublicUrl({ health: 502, metricsWithoutKey: 401, scrapeWithoutKey: 401 }), 'FAIL')).toEqual(['public.health']);
  });

  test('鍵なしの /scrape は、401 だけを通す（403・404 は、Sora が断ったのではない）', () => {
    for (const status of [403, 404, 500]) expect(of(auditPublicUrl({ health: 200, metricsWithoutKey: 401, scrapeWithoutKey: status }), 'FAIL'), String(status)).toEqual(['public.auth']);
  });

  test('つながらなければ（status 0）、FAIL', () => {
    expect(of(auditPublicUrl({ health: 0, metricsWithoutKey: 0, scrapeWithoutKey: 0 }), 'FAIL')).toEqual(['public.health', 'public.metrics', 'public.auth']);
  });
});

describe('summarize・renderFindings', () => {
  const findings: Finding[] = [
    { level: 'PASS', id: 'a', title: '通った' },
    { level: 'WARN', id: 'b', title: '注意', detail: '詳しい説明' },
    { level: 'FAIL', id: 'c', title: '失敗' },
    { level: 'SKIP', id: 'd', title: '省いた' },
    { level: 'PASS', id: 'e', title: '通った 2' },
  ];

  test('件数と、終了コード（FAIL があれば 1。WARN だけなら 0）', () => {
    expect(summarize(findings)).toEqual({ pass: 2, warn: 1, fail: 1, skip: 1, exitCode: 1 });
    expect(summarize(findings.filter((f) => f.level !== 'FAIL')).exitCode).toBe(0);
    expect(summarize([]).exitCode).toBe(0);
  });

  test('1 件 1 行（レベル・id・題）。詳細は次の行。レベルは同じ幅', () => {
    const lines = renderFindings(findings).split('\n');
    expect(lines[0]).toBe('[PASS] a  通った');
    expect(lines[1]).toBe('[WARN] b  注意');
    expect(lines[2]).toBe('       詳しい説明');
    expect(lines[3]).toBe('[FAIL] c  失敗');
    expect(lines[4]).toBe('[SKIP] d  省いた');
  });
});
