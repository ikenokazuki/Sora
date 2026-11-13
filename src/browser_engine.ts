import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { promises as dnsPromises } from 'dns';
import { totalmem } from 'os';
import { envBool, envInt, envPath, envRaw, envStr, type Env } from './config.js';
import {
  browserProxyArgs,
  createProfileDir,
  DEFAULT_LAUNCHER,
  missingDropCapabilities,
  planBrowserLaunch,
  removeProfileDir,
  SandboxFallback,
  withoutNoSandbox,
} from './browser_launch_plan.js';
import { type QueuePolicy, SimpleSemaphore } from './browser_semaphore.js';
import { childEnv } from './security/child_env.js';
import { isSensitiveHeaderName } from './security/credential_scope.js';
import { limits } from './security/limits.js';
import { isBlockedHostname, isPrivateIp } from './net/ip_policy.js';
import { browserResolvesLocally, getEgressGateway, isEgressGatewayEnabled } from './net/egress.js';
import { getProxyConfig } from './net/proxy_config.js';

// 判定の本体は net/ip_policy.ts に移した。ここからも、これまでどおり import できるようにしておく
export { isBlockedHostname, isPrivateIp, isPrivateIpUint32, parseIpv4ToUint32 } from './net/ip_policy.js';
export { getProxyConfig } from './net/proxy_config.js';
// 枠の本体は browser_semaphore.ts に移した（tenant ごとの公平な待ち行列。設計 6）。ここからも、これまでどおり import できるようにしておく
export { type Lease, type QueuePolicy, SimpleSemaphore } from './browser_semaphore.js';

/** Chromium 実行バイナリパスの自動検出 */
export function resolveChromiumPath(): string | undefined {
  const envPaths = [envPath('CHROME_PATH'), envPath('CHROME_BIN'), envPath('PUPPETEER_EXECUTABLE_PATH')];
  for (const p of envPaths) {
    if (p && existsSync(p)) return p;
  }

  const standardPaths = [
    '/usr/lib/chromium/chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  if (process.env.LOCALAPPDATA) {
    standardPaths.push(`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`);
    standardPaths.push(`${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`);
  }
  for (const p of standardPaths) {
    if (existsSync(p)) return p;
  }

  // PATH 環境変数の走査 (NixOS / Custom distros / Windows)
  const pathEnv = process.env.PATH || '';
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const pathDirs = pathEnv.split(pathSeparator);
  const binaries = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe', 'msedge.exe']
    : ['chromium', 'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chrome'];
  for (const dir of pathDirs) {
    for (const bin of binaries) {
      const fullPath = `${dir}/${bin}`;
      if (existsSync(fullPath)) return fullPath;
    }
  }

  return undefined;
}

export const CHROME_EXECUTABLE_PATH = resolveChromiumPath();

let cachedChromiumMajorVersion: number | undefined | null = null;

/**
 * 実行に使う Chromium のメジャーバージョンを取得する（結果はキャッシュ）。
 * 静的fetch(wreq)側のプロファイル選択を、ブラウザ経路が名乗るバージョンと一致させるために使う。
 * 両経路は Cookie を共有するため、バージョンがずれると「同じセッションのブラウザが
 * 別バージョンに変わる」矛盾になる（実測で Chrome 141 と 148 の食い違いを確認済み）。
 */
export function getChromiumMajorVersion(): number | undefined {
  if (cachedChromiumMajorVersion !== null) return cachedChromiumMajorVersion;
  cachedChromiumMajorVersion = CHROME_EXECUTABLE_PATH ? readChromiumMajorVersion(CHROME_EXECUTABLE_PATH) : undefined;
  return cachedChromiumMajorVersion;
}

/**
 * `chromium --version` の出力（例: "Chromium 156.0.8078.79 built on Debian 12.12"、"Google Chrome 149.0.7827.155"）から、
 * メジャーバージョンを取り出す。
 */
export function parseChromiumMajorVersion(output: string): number | undefined {
  const major = output.match(/\b(\d+)\.\d+\.\d+/)?.[1];
  return major ? parseInt(major, 10) : undefined;
}

/**
 * 実行ファイルに --version を問い合わせて、メジャーバージョンを返す。取れなければ undefined。
 * シェルを経由しない（execFileSync）。以前の execSync は /bin/sh を使うので、シェルの無い distroless のイメージでは
 * 起動できず、版が取れないまま wreq の最大のプロファイルに落ちていた。
 */
export function readChromiumMajorVersion(executablePath: string): number | undefined {
  try {
    const out = execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() });
    return parseChromiumMajorVersion(out);
  } catch {
    return undefined;
  }
}

let sharedBrowserInstance: Browser | null = null;
/**
 * 共有ブラウザを起動している最中の Promise。無操作終了の直後などに getBrowser() が同時に呼ばれても、
 * 起動は 1 回だけにして全員が同じブラウザを受け取る。共有しないと、呼び出しの数だけ Chromium が起動し、
 * 最後に代入された 1 つ以外は参照を失って閉じられないまま残る（1 つあたり数百 MB）。
 */
let sharedBrowserLaunch: Promise<Browser> | null = null;

/** 共有または専用 Chromium ブラウザインスタンスの取得 */
export async function getBrowser(overrideProxyUrl?: string): Promise<{ browser: Browser; isDedicated: boolean }> {
  // ゲートウェイを使うときは、すべての通信が、1 つのゲートウェイ（と、その上流の運用者のプロキシ）を通る。ブラウザごとの別のプロキシは、
  // 黙って無視すると、ゲートウェイを迂回したと思わせるので、エラーにする
  if (overrideProxyUrl && isEgressGatewayEnabled()) {
    throw new Error('SORA_EGRESS_GATEWAY=on のときは、ブラウザごとのプロキシの指定は使えない（すべての通信が、出口のゲートウェイを通る）');
  }
  const config = getProxyConfig();
  const effectiveProxy = overrideProxyUrl?.trim() || config.proxyServer;
  const effectiveBypass = config.proxyBypassList;

  // overrideProxyUrl が明示的に指定され、かつ環境変数の設定と異なる場合のみ専用インスタンスを起動
  if (overrideProxyUrl && overrideProxyUrl.trim() !== config.proxyServer) {
    if (!CHROME_EXECUTABLE_PATH) {
      throw new Error('Chromium/Chrome が見つからないためブラウザを起動できません');
    }
    const dedicated = await launchStealthChromium(effectiveProxy, effectiveBypass);
    return { browser: dedicated, isDedicated: true };
  }

  // 共有ブラウザ: 起動済みならそれを、起動中ならその完了を待って受け取る（同時に複数起動しない）。
  // 待っている間に閉じられた場合に備え、起動の完了後は状態を見直す。
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = sharedBrowserInstance;
    if (existing?.connected) {
      try {
        await existing.version();
        // 疎通確認の await 中に閉じられた・差し替えられた場合は渡さず、次の周回で取り直す
        if (sharedBrowserInstance === existing) {
          markSharedBrowserUsed();
          return { browser: existing, isDedicated: false };
        }
      } catch {
        if (sharedBrowserInstance === existing) sharedBrowserInstance = null;
      }
    }

    if (!CHROME_EXECUTABLE_PATH) {
      throw new Error('Chromium/Chrome が見つからないためブラウザを起動できません');
    }

    if (!sharedBrowserLaunch) {
      sharedBrowserLaunch = launchSharedBrowser(effectiveProxy, effectiveBypass);
    }
    // 失敗したときは待っている全員に同じエラーが伝わり、次の呼び出しで起動をやり直せる
    await sharedBrowserLaunch;
  }
  throw new Error('共有ブラウザを起動できませんでした');
}

/** ブラウザが名乗るタイムゾーン。ロケール（ja-JP）と、日本の IP に合わせる。 */
export const STEALTH_TIMEZONE = 'Asia/Tokyo';

/** Bun の版（`1.4.4` など。canary の接尾辞は無視）が、最小の版以上か。読めなければ false。 */
export function bunAtLeast(min: readonly [number, number, number], version: string = Bun.version): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== min[i]) return actual[i] > min[i];
  }
  return true;
}

/**
 * CDP（Chromium を操作する口）の繋ぎ方。パイプなら TCP のデバッグポートを開かない（127.0.0.1 で待ち受けず、DNS rebinding や、
 * 同じコンテナのほかのプロセスから届かない）。既定は、Bun 1.4.4 以上ならパイプ。Bun 1.3.3 は、起動と終了を繰り返したあとに、
 * パイプの接続が閉じる・応答が返らなくなることがある（2026-11-12 に確認。1.4.4 では、起動と終了 15 回・5 並行・強制終了の検知まで通る）ので、
 * それ未満はポートのまま。SORA_BROWSER_PIPE=false（0・off・no）で、版によらずポートに戻せる。true（1・on・yes）で、版によらずパイプにする。
 */
export function browserCdpMode(env?: Env, bunVersion: string = Bun.version): 'pipe' | 'port' {
  const chosen = envBool('SORA_BROWSER_PIPE', env);
  if (chosen !== undefined) return chosen ? 'pipe' : 'port';
  return bunAtLeast([1, 4, 4], bunVersion) ? 'pipe' : 'port';
}

/** Chromium に渡す環境変数。運用者の秘密（API キーなど）は渡さない（security/child_env.ts）。TZ は、ブラウザが名乗るタイムゾーン。 */
export function chromiumEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  return childEnv({ TZ: STEALTH_TIMEZONE }, source);
}

/**
 * 起動時に --user-agent へ渡す UA。ページごとの CDP の上書きは、Service Worker などには届かず
 * "HeadlessChrome" と本物の OS が見える（実測で CreepJS の headless 判定が 33% → 0%）。
 * browser_stealth.ts と循環するので、起動のときに読み込む。
 */
async function stealthUserAgent(): Promise<string | undefined> {
  try {
    return (await import('./browser_stealth.js')).getFallbackUserAgent();
  } catch {
    return undefined;
  }
}

/** 両経路が名乗る Chrome の版（静的取得のプロファイルの版）。取れなければ 0（wreqAlignDisabledFeatures はすべて止める側に倒れる）。 */
async function alignedProfileMajor(): Promise<number> {
  try {
    return Number((await import('./browser_stealth.js')).getAlignedChromeMajorVersion()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Chromium が TLS の ClientHello や Accept に足す、wreq-js のプロファイル（静的取得側）には無い項目を止める機能名。
 * 静的取得とブラウザは Cookie を共有する「同じ Chrome」なので、ここが食い違うと、Chrome を名乗る UA のまま別物の指紋を送る形になる。
 * 実測では、Debian・Google 公式の Chromium 148 以降が ClientHello に足す拡張 51764 だけで、Cloudflare 系（Indeed）に
 * 403 で弾かれた（プロファイルが 51764 を持たない版のとき。止めると通る）。名前の無い版（CI の Chrome for Testing 141 など）では無視される。
 * emulatedFrom は、wreq のプロファイルがその項目を送り始める Chrome の版。プロファイルがそれ以上なら、止めずに、ブラウザが自然に送るままにする
 * （止めると、今度はプロファイルにだけ項目がある差になる）。null は、どのプロファイルにも、まだ無い。
 * 上流の wreq-util（main）のプロファイルは、Chrome 152 から、拡張 51764 と署名アルゴリズムの GREASE を送る（2026-11-12 に、Debian の
 * Chromium 156 を起動引数なしで動かした ClientHello と、全項目が同じことを確かめた。scripts/tls-fingerprint）。
 * - TLSTrustAnchorIDs / NonMtcTrustAnchorIDs: ClientHello の拡張 51764（Trust Anchor IDs）。どちらを止めても消える
 * - TlsGreaseSigalgs: 署名アルゴリズムへ足す GREASE（Chromium 150 以降）
 * - JXLImageFormat: Accept の image/jxl（Chromium 156 以降）。wreq-util の 154 までのプロファイルの Accept には無い
 * 署名アルゴリズムの ML-DSA（Chromium 150 以降）と、Google 公式ビルドだけの拡張 4832 は、止める機能名が無い（前者）か、
 * Debian の Chromium には無い（後者）ので、ここには含めない。ML-DSA は、wreq のプロファイルが 150 以上なら、同じになる。
 */
const WREQ_ALIGN_FEATURES: ReadonlyArray<{ features: readonly string[]; emulatedFrom: number | null }> = [
  { features: ['TLSTrustAnchorIDs', 'NonMtcTrustAnchorIDs'], emulatedFrom: 152 },
  { features: ['TlsGreaseSigalgs'], emulatedFrom: 152 },
  { features: ['JXLImageFormat'], emulatedFrom: null },
];

/** 静的取得が使うプロファイル（Chrome の版）に合わせるために、ブラウザの起動で止める機能名。 */
export function wreqAlignDisabledFeatures(profileMajor: number): string[] {
  return WREQ_ALIGN_FEATURES.filter((f) => f.emulatedFrom === null || profileMajor < f.emulatedFrom).flatMap((f) => [...f.features]);
}

/**
 * SORA_BROWSER_LOW_MEMORY（既定は無効。呼び出しのたびに読む）。true・1・on・yes（大文字小文字・前後の空白は問わない）で、Chromium を
 * 低メモリ端末のモード（--enable-low-end-device-mode）で起動する。描画中のピークの PSS 合計が、ページを 1 つずつ開いて
 * 約 18%・3 ページ同時で約 14% 下がる（同梱の Chromium 156 で実測）。待機中の常駐量は変わらない。
 * 指紋で変わるのは navigator.deviceMemory（8 → 2）だけだが、既定は変えない（使うかどうかは運用者が決める）。
 * それ以外の値（不正な値を含む）は無効。
 */
export function isBrowserLowMemory(env?: Env): boolean {
  return envBool('SORA_BROWSER_LOW_MEMORY', env);
}

/** サンドボックスを試した結果を、プロセスで 1 回だけ決める（browser_launch_plan.ts の SandboxFallback）。 */
const sandboxFallback = new SandboxFallback();

/** 直近に起動した Chromium のサンドボックスの状態。起動する前は unknown。 */
export function browserSandboxStatus(): 'on' | 'off' | 'unknown' {
  return sandboxFallback.status();
}

const warnedLaunchMessages = new Set<string>();
function warnLaunchOnce(message: string): void {
  if (warnedLaunchMessages.has(message)) return;
  warnedLaunchMessages.add(message);
  console.warn(`[Sora] ${message}`);
}

function readSelfStatus(): string | undefined {
  try {
    return readFileSync('/proc/self/status', 'utf8');
  } catch {
    return undefined; // Linux 以外
  }
}

/** 共有・専用のどちらの Chromium も、ここで起動する。 */
async function launchStealthChromium(proxy: string | undefined, bypass: string | undefined): Promise<Browser> {
  const userAgent = await stealthUserAgent();
  const profileMajor = await alignedProfileMajor();
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    // --disable-gpu は付けない: WebGLコンテキスト自体が取得不能になり
    // (canvas.getContext('webgl') が null)、bot対策サイトの検出項目になる。
    // SwiftShaderソフトウェアレンダリングで代替され、実測でパフォーマンス
    // 悪化もない（誤差範囲でむしろ僅かに高速）。
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    // WebRTCがSTUN経由で実IPを漏らす対策（プロキシ運用時に致命的、実測でIP露出を確認済み）。
    // 非プロキシ経由のUDP直接通信を無効化する。
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    // navigator.language(s)・Worker・別オリジンの iframe・Accept-Language（Chrome と同じ位置）まで Chromium 自身が揃える。
    // JS で上書きすると getter が native でなくなり、Worker や iframe には届かない。静的取得の ACCEPT_LANGUAGE と同じ並び。
    '--accept-lang=ja-JP,ja,en-US,en',
    // ヘッドレスは hover / pointer が none になる。デスクトップのマウスに揃える。
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    // TLS の ClientHello と Accept を、静的取得（wreq-js の、名乗る版のプロファイル）に揃える。理由は WREQ_ALIGN_FEATURES。
    `--disable-features=${wreqAlignDisabledFeatures(profileMajor).join(',')}`,
  ];
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  // 出口のゲートウェイを使うときは、すべての通信を、ゲートウェイに通す（使うときに、初めて起動する）。使わないときは、運用者のプロキシを、そのまま渡す
  const gateway = isEgressGatewayEnabled() ? await getEgressGateway() : undefined;
  args.push(...browserProxyArgs({ gateway, proxy, bypass }));
  if (isBrowserLowMemory()) args.push('--enable-low-end-device-mode');

  // root の Sora 本体から、別の uid に落として起動するか・Chromium のサンドボックスを使うか（browser_launch_plan.ts）。
  // 落とすには、起動用バイナリに伝える、本物の Chromium の場所が要る
  const chromePath = CHROME_EXECUTABLE_PATH;
  const { plan, warnings } = planBrowserLaunch({
    currentUid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    launcherExists: chromePath !== undefined && existsSync(DEFAULT_LAUNCHER),
    nodeEnv: envStr('NODE_ENV'),
    // --cap-drop=ALL のコンテナでは、uid を落とせない（chown・setuid が EPERM）。落とせないときは、従来どおり起動する
    missingCapabilities: missingDropCapabilities(readSelfStatus()),
  });
  for (const warning of warnings) warnLaunchOnce(warning);
  const drop = plan.drop && chromePath ? { ...plan.drop, chromePath } : null;

  const launchOnce = async (sandbox: boolean): Promise<Browser> => {
    // puppeteer は、userDataDir を渡さないと、起動した側（root）の所有で作るので、落とした Chromium は書けない。自分で作る
    const profile = drop ? createProfileDir(drop) : undefined;
    try {
      const browser = await puppeteer.launch({
        executablePath: drop ? drop.launcher : chromePath,
        headless: true,
        // CDP の繋ぎ方（パイプか TCP のデバッグポートか）は browserCdpMode を参照。
        pipe: browserCdpMode() === 'pipe',
        args: sandbox ? withoutNoSandbox(args) : args,
        // Puppeteerがデフォルト付与するフラグのうち、一般ユーザー環境に不自然な差分を除去
        // （Patchright方式に倣った近似化）。--enable-automation は navigator.webdriver を
        // true にする一因（実測で確認済み）。--disable-popup-blocking/--disable-default-apps
        // は通常のブラウザでは有効な設定で、無効化されていること自体が検出材料になりうる。
        ignoreDefaultArgs: ['--enable-automation', '--disable-popup-blocking', '--disable-default-apps'],
        ...(profile ? { userDataDir: profile } : {}),
        // コンテナは UTC のため、ロケールが ja-JP でも時刻が UTC になる。日本の IP と ja-JP に合わせる（Worker にも届く）。
        // 落とすときは、起動用バイナリに、本物の Chromium と落とし先を伝える（起動用バイナリが消してから Chromium を exec する）。HOME は、書ける場所にする
        env:
          drop && profile
            ? {
                ...chromiumEnv(),
                HOME: profile,
                SORA_LAUNCH_EXEC: drop.chromePath,
                SORA_LAUNCH_UID: String(drop.uid),
                SORA_LAUNCH_GID: String(drop.gid),
              }
            : chromiumEnv(),
      });
      // プロファイルは、Chromium が終わってから消す（終わる途中で書き込まれると、消し損なう）
      if (profile) {
        const child = browser.process();
        if (!child || child.exitCode !== null || child.signalCode !== null) removeProfileDir(profile);
        else child.once('exit', () => removeProfileDir(profile));
      }
      return browser;
    } catch (error) {
      if (profile) removeProfileDir(profile);
      throw error;
    }
  };
  return sandboxFallback.launch(plan.sandbox, launchOnce, warnLaunchOnce);
}

/** 共有 Chromium を 1 つ起動する。成功したら sharedBrowserInstance に登録し、終わったら起動中の印を外す。 */
function launchSharedBrowser(effectiveProxy: string | undefined, effectiveBypass: string | undefined): Promise<Browser> {
  const launched = launchStealthChromium(effectiveProxy, effectiveBypass)
    .then((browser) => {
      sharedBrowserInstance = browser;
      markSharedBrowserUsed();
      return browser;
    });
  const tracked: Promise<Browser> = launched.finally(() => {
    if (sharedBrowserLaunch === tracked) sharedBrowserLaunch = null;
  });
  return tracked;
}

export function isSharedBrowserConnected(): boolean {
  return sharedBrowserInstance?.connected === true;
}

export async function closeSharedBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  // 起動の最中なら、完了を待ってから閉じる（起動途中のまま放置すると、管理されない Chromium が残る）
  const launching = sharedBrowserLaunch;
  if (launching) {
    try {
      await launching;
    } catch {}
  }
  // 閉じる前に共有インスタンスを外し、閉じかけのブラウザを getBrowser() が渡さないようにする
  const browser = sharedBrowserInstance;
  sharedBrowserInstance = null;
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
}

/**
 * 共有 Chromium の無操作終了。常駐させると約700MB（実測、7プロセス）を占有し続けるため、最後に取得されてから
 * SORA_BROWSER_IDLE_TTL_MS（既定 5 分、0 で無効）使われなければ閉じる。次回の getBrowser() で自動再起動する。
 * 開いているコンテキスト/ページ（ブラウザセッション・追跡・SNS 取得）やセマフォ保持中は使用中とみなす。
 */
let lastSharedBrowserUse = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

/** 呼び出しのたびに読む。不正な値は既定の 5 分（以前は 0 = 閉じない、になっていた）。 */
export function browserIdleTtlMs(): number {
  return envInt('SORA_BROWSER_IDLE_TTL_MS');
}

function markSharedBrowserUsed(): void {
  lastSharedBrowserUse = Date.now();
  armIdleTimer(browserIdleTtlMs());
}

function armIdleTimer(delayMs: number): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (delayMs <= 0) return;
  idleTimer = setTimeout(() => void closeIfIdle(), delayMs);
  idleTimer.unref?.();
}

async function closeIfIdle(): Promise<void> {
  idleTimer = undefined;
  const browser = sharedBrowserInstance;
  const ttl = browserIdleTtlMs();
  if (!browser || ttl <= 0) return;
  const remaining = ttl - (Date.now() - lastSharedBrowserUse);
  if (remaining > 0) return armIdleTimer(remaining);
  const checkedUse = lastSharedBrowserUse;
  let busy = browserSemaphore.activeCount > 0 || browserSemaphore.pendingCount > 0;
  if (!busy) {
    try {
      busy = browser.browserContexts().length > 1 || (await browser.pages()).length > 1;
    } catch {
      busy = false; // 接続が壊れている場合は閉じてよい
    }
  }
  // 判定の await 中に getBrowser() で渡されていたら閉じない（その呼び出しがタイマーを張り直している）
  if (lastSharedBrowserUse !== checkedUse) return;
  if (busy) return armIdleTimer(ttl);
  if (browser === sharedBrowserInstance) await closeSharedBrowser();
}

let sharedBrowserUsageCount = 0;
const MAX_SHARED_BROWSER_USES = 200;

export function recordBrowserUsage(): void {
  sharedBrowserUsageCount++;
}

export function maybeRotateSharedBrowser(): void {
  if (browserSemaphore.activeCount === 0 && sharedBrowserUsageCount >= MAX_SHARED_BROWSER_USES) {
    sharedBrowserUsageCount = 0;
    void closeSharedBrowser();
  }
}

/**
 * ブラウザ同時実行数の既定値。bun 本体 + Chromium の常駐に約700MB、1ページあたり約300MB を見込み、
 * 利用可能メモリから導く（1〜5）。メモリ不明なら従来の 5。SORA_BROWSER_MAX_CONCURRENCY 明示時はそちらが優先。
 * ponytail: 1ページ300MBは目安。実測で外れるなら係数を調整する。
 */
export function defaultBrowserConcurrency(memBytes: number | undefined): number {
  if (memBytes === undefined) return 5;
  const MB = 1024 * 1024;
  return Math.max(1, Math.min(5, Math.floor((memBytes / MB - 700) / 300)));
}

/** cgroup (v2/v1) のメモリ上限と搭載メモリの小さい方。取得できなければ undefined。 */
export function detectMemoryLimitBytes(): number | undefined {
  let limit = totalmem() || undefined;
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const n = Number(readFileSync(path, 'utf8').trim());
      if (Number.isFinite(n) && n > 0) limit = limit === undefined ? n : Math.min(limit, n);
    } catch {}
  }
  return limit;
}

/**
 * SORA_BROWSER_MAX_CONCURRENCY の解釈。正の整数ならそれ（50 を超える値は 50。頭打ちは登録簿の cap）、それ以外（未設定・数値でない・0 以下）はメモリからの既定値。
 * 数値でない値をそのまま使うとセマフォの上限が NaN になり、ブラウザ描画が永久に待つため。
 */
export function resolveBrowserConcurrency(raw: string | undefined, memBytes: number | undefined): number {
  return envInt('SORA_BROWSER_MAX_CONCURRENCY', { SORA_BROWSER_MAX_CONCURRENCY: raw }) ?? defaultBrowserConcurrency(memBytes);
}

/** 枠の待ち行列の方針。水準（SORA_ISOLATION）の値を、枠を取るたびに読む（設計 6。穴 25） */
export function browserQueuePolicy(): QueuePolicy {
  const lim = limits();
  return { perTenant: lim.browserQueuePerTenant, total: lim.browserQueueTotal, waitMs: lim.browserQueueWaitMs, sharePercent: lim.browserTenantSharePercent };
}

/** 同時に動かすブラウザの数（モジュールの読み込み時に決める）。使い終わったら、共有ブラウザを入れ替える */
export const browserSemaphore = new SimpleSemaphore(resolveBrowserConcurrency(envRaw('SORA_BROWSER_MAX_CONCURRENCY'), detectMemoryLimitBytes()), {
  policy: browserQueuePolicy,
  onIdle: maybeRotateSharedBrowser,
});

const dnsValidationCache = new Map<string, { addresses: string[]; expiresAt: number }>();
const DNS_CACHE_TTL_MS = 60_000;

export const BLOCKED_TRACKER_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'appsflyer.com',
  'sentry.io',
  'cookieyes.com',
  'facebook.net',
  'clarity.ms',
  'adservice.google.',
  'pagead2.googlesyndication.com',
];

/**
 * DNS 解決後の実 IP アドレスを検証（DNS Rebinding 攻撃対策＋インメモリキャッシュ）。
 * 名前を解決できないとき（失敗か、答えが空）は、これまでどおり、空を返して通す（接続のときの解決に任せる）。failClosed: true なら、遮断する。
 * Sora の手元で名前を引いて接続するとき（プロキシもゲートウェイも通さないとき）は、true にする。攻撃者が、自分の DNS で、検査のときだけ失敗させ、
 * 接続のときに内部の IP を答えると、検査を抜けられるため。名前を相手（運用者のプロキシ・出口のゲートウェイ）が解決するときは、手元の DNS が失敗するのは普通なので、通す。
 */
export async function validateHostIpDns(hostname: string, options: { failClosed?: boolean } = {}): Promise<string[]> {
  if (envBool('SORA_FETCH_ALLOW_PRIVATE_NETWORK')) return [];

  const cleanHost = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (isBlockedHostname(cleanHost) || isPrivateIp(cleanHost)) {
    throw new Error(`プライベートネットワークまたは安全でないホストへのアクセスは遮断されています: ${hostname}`);
  }

  const now = Date.now();
  const cached = dnsValidationCache.get(cleanHost);
  if (cached && cached.expiresAt > now) {
    return cached.addresses;
  }

  const addresses = await dnsPromises.lookup(cleanHost, { all: true }).catch(() => []);
  if (addresses.length === 0) {
    if (options.failClosed) throw new Error(`名前を解決できないため、宛先の IP を確かめられず、遮断されました: ${hostname}`);
    return [];
  }
  for (const addr of addresses) {
    if (isBlockedHostname(addr.address) || isPrivateIp(addr.address)) {
      throw new Error(`DNS Rebinding 攻撃（プライベート IP への解決）が検知されたため遮断されました: ${hostname} -> ${addr.address}`);
    }
  }
  const result = addresses.map((a) => a.address);
  dnsValidationCache.set(cleanHost, { addresses: result, expiresAt: now + DNS_CACHE_TTL_MS });
  return result;
}

/** Headless Chromium のページ内サブリクエストに対する SSRF 防御 & 不要リソース高速遮断 */
export async function setupPageSecurity(
  page: Page,
  /** true なら画像・Web フォントも遮断する。関数なら要求のたびに呼ぶ（セッションで、あとから画像が要るようになる場合） */
  blockMedia: boolean | (() => boolean) = false,
  /**
   * 呼び出し側が指定したヘッダー。origin と同じオリジンへの要求には全部付ける。
   * 別のオリジンには、本体のページの移動（転送・遷移）だけに、資格情報でないものを付ける（資格情報のヘッダーと、ほかのオリジンへの副要求には付けない）。
   * User-Agent は付けない（navigator.userAgent と sec-ch-ua はステルスの値のままなので、要求のヘッダーだけ替えると食い違い、ボット対策に見分けられる）
   */
  scopedHeaders?: { origin: string; headers: Record<string, string> },
): Promise<void> {
  const lowercased = (headers: [string, string][]) => Object.fromEntries(headers.map(([name, value]) => [name.toLowerCase(), value]));
  const callerHeaders = Object.entries(scopedHeaders?.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'user-agent');
  const allHeaders = scopedHeaders && lowercased(callerHeaders);
  const navigationHeaders = scopedHeaders && lowercased(callerHeaders.filter(([name]) => !isSensitiveHeaderName(name)));
  try {
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      try {
        const reqUrlStr = req.url();
        const resourceType = req.resourceType();
        const sameOrigin = scopedHeaders !== undefined && URL.canParse(reqUrlStr) && new URL(reqUrlStr).origin === scopedHeaders.origin;
        const extra = sameOrigin ? allHeaders : req.isNavigationRequest() && req.frame() === page.mainFrame() ? navigationHeaders : undefined;
        const proceed = () => req.continue(extra && Object.keys(extra).length > 0 ? { headers: { ...req.headers(), ...extra } } : undefined);

        // 動画・音声・3Dモデル・広告トラッカーは帯域・メモリ保護のため常時高速遮断
        if (
          ['media'].includes(resourceType) ||
          /\.(gltf|glb|obj|fbx|mp4|webm|m4v|m4a|mp3|ogg|wav|flac)(\?.*)?$/i.test(reqUrlStr) ||
          BLOCKED_TRACKER_DOMAINS.some((d) => reqUrlStr.includes(d))
        ) {
          return req.abort('blockedbyclient');
        }

        // スクリーンショット非要求時 (blockMedia=true) は画像・Webフォントも追加遮断
        if ((typeof blockMedia === 'function' ? blockMedia() : blockMedia) && ['image', 'font'].includes(resourceType)) {
          return req.abort('blockedbyclient');
        }

        if (envBool('SORA_FETCH_ALLOW_PRIVATE_NETWORK')) {
          return proceed();
        }

        if (reqUrlStr.startsWith('data:') || reqUrlStr.startsWith('blob:') || reqUrlStr.startsWith('about:')) {
          return proceed();
        }
        let reqUrl: URL;
        try {
          reqUrl = new URL(reqUrlStr);
        } catch {
          return req.abort('blockedbyclient');
        }
        if (!['http:', 'https:'].includes(reqUrl.protocol)) {
          return req.abort('blockedbyclient');
        }
        const host = reqUrl.hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
        if (isBlockedHostname(host) || isPrivateIp(host)) {
          return req.abort('accessdenied');
        }

        // キャッシュ付きホスト検証
        const now = Date.now();
        const cached = dnsValidationCache.get(host);
        if (cached && cached.expiresAt > now) {
          return proceed();
        }

        const addresses = await dnsPromises.lookup(host, { all: true }).catch(() => []);
        if (addresses.length === 0) {
          // 名前を解決できない（失敗か、答えが空）。ブラウザが、手元で名前を引いて直接つなぐときは、検査を抜けさせない
          if (browserResolvesLocally(host)) return req.abort('namenotresolved');
          return proceed();
        }
        for (const addr of addresses) {
          if (isBlockedHostname(addr.address) || isPrivateIp(addr.address)) {
            return req.abort('accessdenied');
          }
        }
        dnsValidationCache.set(host, {
          addresses: addresses.map((a) => a.address),
          expiresAt: now + DNS_CACHE_TTL_MS,
        });
        proceed();
      } catch {
        req.abort('failed');
      }
    });
  } catch (err) {
    console.warn('[Sora] Warning: Failed to set request interception for page security:', err);
  }
}

/**
 * 画面上に非表示となっている不要ノード（CSS display:none, visibility:hidden, hidden属性, aria-hidden等）を
 * DOMツリーから安全に剪定（Prune）し、LLM誤読・ハルシネーションを防ぐ。
 */
export async function pruneInvisibleElements(page: Page, cloneOnly = false): Promise<string | undefined> {
  try {
    if (page.isClosed()) return;
    return await page
      .evaluate((cloneOnly: boolean) => {
        try {
          const root = cloneOnly ? document.documentElement.cloneNode(true) as HTMLElement : document.documentElement;
          const allElements = Array.from(document.body?.querySelectorAll('*') ?? []);
          const outputElements = cloneOnly ? Array.from(root.querySelector('body')?.querySelectorAll('*') ?? []) : allElements;
          // 1. 標準的な不可視・テンプレート要素の先行除去
          const staticTags = root.querySelectorAll('noscript, template, [hidden]');
          staticTags.forEach((el) => {
            try {
              el.remove();
            } catch {}
          });

          // 2. DOMツリーの走査とComputed Styleによる不可視要素の剪定
          if (!document.body) return;
          for (const [index, el] of allElements.entries()) {
            const output = outputElements[index];
            if (!output || !root.contains(output)) continue;

            const tag = el.tagName.toLowerCase();
            // script, style, link, meta 等はパーサー処理（JSON-LD等）のために維持
            if (['script', 'style', 'meta', 'link', 'title'].includes(tag)) continue;

            try {
              const style = window.getComputedStyle(el);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse'
              ) {
                output.remove();
                continue;
              }

              if (el.getAttribute('aria-hidden') === 'true' && el.classList.contains('visually-hidden')) {
                output.remove();
              }
            } catch {}
          }
          if (cloneOnly) return `<!DOCTYPE html>${root.outerHTML}`;
        } catch {}
      }, cloneOnly)
      .catch(() => undefined);
  } catch {}
}
