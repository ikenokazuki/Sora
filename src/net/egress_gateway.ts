/**
 * 出口のゲートウェイ（設計: docs/superpowers/specs/2026-11-12-isolation-design.md の設計 1）。
 *
 * Sora のプロセスの中の、ループバックだけで待ち受ける HTTP プロキシ。ブラウザ・静的取得などの外向きの通信を、ここだけから出す。
 * 名前の解決を**ここで 1 回だけ**行い、答えの IP がすべて公開の宛先であることを確かめ、**検査した IP に接続を固定する**
 * （検査と接続の間に、別の解決が入らない。DNS rebinding で、検査のあとに宛先を内部へ替えられない）。
 * 名前が解決できないときは、通さずに閉じる。宛先のポートは、許したものだけ（既定は 80・443）。
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { errorMessage } from '../errors.js';
import { incrementSecurityCounter } from '../security/metrics.js';
import { isBlockedHostname, isPrivateIp as defaultIsPrivateIp } from './ip_policy.js';

/** 拒否の理由。カウンター `sora_egress_denied_<理由>_total` の名前になる */
export type DenyReason = 'bad_request' | 'port' | 'blocked_host' | 'private_ip' | 'dns' | 'limit';

export interface EgressGatewayOptions {
  /** 許す宛先ポート。既定は 80・443 */
  allowedPorts?: readonly number[];
  /** 名前を、IP（数値）の一覧に解決する。失敗か空なら、閉じる。既定は dns.lookup */
  resolve?: (host: string) => Promise<string[]>;
  /** 宛先の IP が、公開でない（内部・予約・メタデータなど）か。true なら拒否する。既定は ip_policy の isPrivateIp */
  isPrivateIp?: (ip: string) => boolean;
  /** 要求の頭部（空行まで）を待つ時間。これを過ぎた接続は閉じる */
  headTimeoutMs?: number;
  /** 要求の頭部の大きさの上限 */
  maxHeadBytes?: number;
  /** 名前の解決を待つ時間 */
  resolveTimeoutMs?: number;
  /** 宛先への接続を待つ時間（アドレスごと）。上流のプロキシの応答を待つ時間にも使う */
  connectTimeoutMs?: number;
  /** 中継中の接続の、無通信の時間切れ（どちら向きの通信もないまま、この時間が過ぎたら、両側を閉じる） */
  idleTimeoutMs?: number;
  /** 同時に受ける、クライアントの接続数の上限。超えたら 503 */
  maxConnections?: number;
  /**
   * 運用者の上流の http プロキシ（SORA_PROXY_*）。あれば、すべての宛先を、ここへの CONNECT・絶対 URI の要求にする。
   * 名前の解決は上流が行うので、ここでの検査は、名前・IP リテラル・ポートまで（答えの IP は見えない。上流が内部に届かないことは、運用者が保証する）。
   */
  upstream?: { host: string; port: number; username?: string; password?: string };
}

/** 検査を通した宛先への接続。leftover は、上流のプロキシの 200 の頭部と同じ送信に混じっていた、トンネルのバイト */
interface Opened {
  socket: net.Socket;
  leftover: Buffer;
}

const DEFAULT_PORTS: readonly number[] = [80, 443];
const DEFAULTS = {
  headTimeoutMs: 10_000,
  maxHeadBytes: 16 * 1024,
  resolveTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 5 * 60_000,
  maxConnections: 512,
};

/** 拒否・失敗を、応答（状態コードと、拒否の理由）にして運ぶ */
class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 方針による拒否の理由。接続の失敗など、方針でないものは undefined */
    readonly reason?: DenyReason,
  ) {
    super(message);
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  431: 'Request Header Fields Too Large',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

const REQUEST_LINE = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/;
// ホストは、名前・IPv4 の各書き方（数字・16 進・ドット）か、角括弧つきの IPv6。それ以外の文字は通さない
const AUTHORITY = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9._-]+)):(\d{1,5})$/;
// http:// の絶対 URI。資格情報（user:pw@）や、ホストの後ろの余計な文字は、ここで落ちる
const ABSOLUTE_HTTP_URI = /^http:\/\/(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9._-]+))(?::(\d{1,5}))?([/?][^\s#]*)?$/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** 転送側で付け直す、またはプロキシの向きだけのヘッダー */
const NOT_FORWARDED_HEADERS: ReadonlySet<string> = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization']);

/** ヘッダーの値に使えない文字（タブ以外の制御文字と DEL）を含むか */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

/** IPv6 リテラルは、URI・CONNECT の宛先では角括弧で囲む */
const formatHost = (host: string): string => (net.isIPv6(host) ? `[${host}]` : host);

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class EgressGateway {
  private readonly allowedPorts: ReadonlySet<number>;
  private readonly resolveName: (host: string) => Promise<string[]>;
  private readonly isPrivateIp: (ip: string) => boolean;
  private readonly limits: typeof DEFAULTS;
  private readonly upstream: { host: string; port: number; authorization?: string } | undefined;
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();
  /** 受けているクライアントの接続の数（maxConnections の判定に使う） */
  private activeClients = 0;

  constructor(options: EgressGatewayOptions = {}) {
    this.allowedPorts = new Set(options.allowedPorts ?? DEFAULT_PORTS);
    this.resolveName =
      options.resolve ?? (async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address));
    this.isPrivateIp = options.isPrivateIp ?? defaultIsPrivateIp;
    const upstream = options.upstream;
    this.upstream = upstream && {
      host: upstream.host,
      port: upstream.port,
      authorization:
        upstream.username === undefined ? undefined : `Basic ${Buffer.from(`${upstream.username}:${upstream.password ?? ''}`).toString('base64')}`,
    };
    this.limits = {
      headTimeoutMs: options.headTimeoutMs ?? DEFAULTS.headTimeoutMs,
      maxHeadBytes: options.maxHeadBytes ?? DEFAULTS.maxHeadBytes,
      resolveTimeoutMs: options.resolveTimeoutMs ?? DEFAULTS.resolveTimeoutMs,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      maxConnections: options.maxConnections ?? DEFAULTS.maxConnections,
    };
  }

  /** ループバックの空きポートで待ち受けを始め、そのポートを返す */
  async start(): Promise<number> {
    if (this.server) throw new Error('出口のゲートウェイは、すでに始まっている');
    // allowHalfOpen: 片側が送信を終えても（FIN）、反対向きの転送を続ける（応答を待つ前に要求を閉じるクライアントがある）
    const server = net.createServer({ allowHalfOpen: true }, (client) => this.accept(client));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    return (server.address() as net.AddressInfo).port;
  }

  /** 待ち受けをやめ、中継中の接続もすべて切る */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  private accept(client: net.Socket): void {
    this.track(client);
    client.on('error', () => client.destroy());
    if (this.activeClients >= this.limits.maxConnections) {
      this.deny(client, new GatewayError(503, '同時の接続数の上限', 'limit'));
      return;
    }
    this.activeClients++;
    client.once('close', () => this.activeClients--);
    client.setNoDelay(true);
    const headTimer = setTimeout(() => client.destroy(), this.limits.headTimeoutMs);
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end < 0) {
        if (received.length > this.limits.maxHeadBytes) {
          clearTimeout(headTimer);
          client.off('data', onData);
          this.deny(client, new GatewayError(431, '要求の頭部が大きすぎる', 'bad_request'));
        }
        return;
      }
      clearTimeout(headTimer);
      client.off('data', onData);
      client.pause(); // 転送を始めるまで、頭部のあとのバイトを読まない（読んだ分は rest で渡す）
      const head = received.subarray(0, end).toString('latin1');
      const rest = received.subarray(end + 4);
      this.handle(client, head, rest).catch((error) => {
        if (error instanceof GatewayError) return this.deny(client, error);
        // 想定外（実装の誤り）。応答は返さず、接続を切る。黙って落とさず、警告を残す
        console.warn(`[Sora] 出口のゲートウェイで想定外のエラー: ${errorMessage(error)}`);
        client.destroy();
      });
    };
    client.on('data', onData);
  }

  /** 拒否・失敗の応答を返して、閉じる。方針による拒否は、数える */
  private deny(client: net.Socket, error: GatewayError): void {
    if (error.reason) incrementSecurityCounter(`sora_egress_denied_${error.reason}_total`);
    const header = error.reason ? `X-Sora-Egress-Deny: ${error.reason}\r\n` : '';
    client.end(`HTTP/1.1 ${error.status} ${STATUS_TEXT[error.status] ?? 'Error'}\r\n${header}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  }

  private async handle(client: net.Socket, head: string, rest: Buffer): Promise<void> {
    const [requestLine, ...headerLines] = head.split('\r\n');
    const match = REQUEST_LINE.exec(requestLine);
    if (!match) throw new GatewayError(400, '要求行を読めない', 'bad_request');
    const [, method, target] = match;
    if (method === 'CONNECT') {
      const { host, port } = this.parseAuthority(target);
      const opened = await this.open(client, host, port, 'tunnel');
      if (!opened) return;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (opened.leftover.length > 0) client.write(opened.leftover);
      this.relay(client, opened.socket, rest);
      return;
    }
    // http:// の絶対 URI の要求を転送する。直接つなぐときは、宛先への origin-form に直す。上流のプロキシへは、絶対 URI のまま送る
    const destination = this.parseAbsoluteUri(target);
    const headers = this.parseHeaders(headerLines);
    const bodyLength = this.bodyLength(headers);
    // 頭部と同じ送信に、枠（Content-Length）を超えるバイト（続けて送られた別の要求など）が混じっていたら、何も転送しない
    if (rest.length > bodyLength) throw new GatewayError(400, '要求の枠（Content-Length）を超えたバイトがある', 'bad_request');
    const opened = await this.open(client, destination.host, destination.port, 'forward');
    if (!opened) return;
    const authority = formatHost(destination.host) + (destination.port === 80 ? '' : `:${destination.port}`);
    const forwarded = [
      `${method} ${this.upstream ? `http://${authority}${destination.path}` : destination.path} HTTP/1.1`,
      `Host: ${authority}`,
      ...headers.map(([name, value]) => `${name}: ${value}`),
      ...(this.upstream?.authorization ? [`Proxy-Authorization: ${this.upstream.authorization}`] : []),
      'Connection: close',
    ];
    opened.socket.write(`${forwarded.join('\r\n')}\r\n\r\n`);
    this.relayRequest(client, opened.socket, rest, bodyLength);
  }

  /**
   * 宛先を検査して、接続する（上流のプロキシがあれば、そこを経由する）。
   * 接続を待つ間にクライアントが切れていたら、宛先への接続を残さず、undefined を返す。
   */
  private async open(client: net.Socket, host: string, port: number, purpose: 'tunnel' | 'forward'): Promise<Opened | undefined> {
    this.checkDestination(host, port);
    const opened = this.upstream
      ? await this.dialUpstream(this.upstream, host, port, purpose)
      : { socket: await this.dialDirect(host, port), leftover: Buffer.alloc(0) };
    if (client.destroyed) {
      opened.socket.destroy();
      return undefined;
    }
    return opened;
  }

  /** `http://host[:port][/path][?query]` を読む。ポートは省略なら 80。資格情報・http 以外・余計な文字は 400 */
  private parseAbsoluteUri(target: string): { host: string; port: number; path: string } {
    const match = ABSOLUTE_HTTP_URI.exec(target);
    if (!match) throw new GatewayError(400, 'http:// の絶対 URI だけ対応（TLS は CONNECT）', 'bad_request');
    const port = match[3] === undefined ? 80 : Number(match[3]);
    if (port < 1 || port > 65535) throw new GatewayError(400, 'ポートが範囲外', 'bad_request');
    const host = (match[1] ?? match[2]).toLowerCase().replace(/\.+$/, '');
    if (!host) throw new GatewayError(400, 'ホストが空', 'bad_request');
    const rest = match[4] ?? '/';
    return { host, port, path: rest.startsWith('?') ? `/${rest}` : rest };
  }

  /**
   * 要求の頭部を読み、転送するヘッダーだけを返す。Host・Connection・プロキシ向けのヘッダーは、転送側で付け直すので外す。
   * コロンのない行・不正な名前（折り返しの行は、先頭の空白で名前が不正になる）・不正な値、Upgrade は 400（WebSocket は CONNECT で）。
   */
  private parseHeaders(lines: readonly string[]): Array<[string, string]> {
    const headers: Array<[string, string]> = [];
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon <= 0) throw new GatewayError(400, '頭部の行を読めない', 'bad_request');
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (!HEADER_NAME.test(name) || hasControlCharacter(value)) throw new GatewayError(400, '頭部の名前か値が不正', 'bad_request');
      const lower = name.toLowerCase();
      if (lower === 'upgrade') throw new GatewayError(400, 'Upgrade は CONNECT で', 'bad_request');
      if (!NOT_FORWARDED_HEADERS.has(lower)) headers.push([name, value]);
    }
    return headers;
  }

  /**
   * 要求本文の長さ。枠を決められるのは Content-Length だけ（同じ値の重複は可。無ければ 0）。
   * Transfer-Encoding（chunked）・数でない値・食い違う値は 400（枠を決められないと、続けて送られた別の要求を、見分けられない）。
   */
  private bodyLength(headers: ReadonlyArray<[string, string]>): number {
    if (headers.some(([name]) => name.toLowerCase() === 'transfer-encoding')) {
      throw new GatewayError(400, 'Transfer-Encoding の要求本文は未対応', 'bad_request');
    }
    const lengths = new Set(headers.filter(([name]) => name.toLowerCase() === 'content-length').map(([, value]) => value));
    if (lengths.size === 0) return 0;
    const [value] = lengths;
    if (lengths.size > 1 || !/^\d{1,15}$/.test(value)) throw new GatewayError(400, 'Content-Length が不正', 'bad_request');
    return Number(value);
  }

  /** CONNECT の宛先 `host:port` を読む。書式の誤りは 400 */
  private parseAuthority(authority: string): { host: string; port: number } {
    const match = AUTHORITY.exec(authority);
    if (!match) throw new GatewayError(400, '宛先を読めない', 'bad_request');
    const port = Number(match[3]);
    if (port < 1 || port > 65535) throw new GatewayError(400, 'ポートが範囲外', 'bad_request');
    // 末尾のドット（FQDN）は外し、名前は小文字にして、以降の判定と解決に使う
    const host = (match[1] ?? match[2]).toLowerCase().replace(/\.+$/, '');
    if (!host) throw new GatewayError(400, 'ホストが空', 'bad_request');
    return { host, port };
  }

  /** 解決の前の検査（安いものから）: ポート → 名前・IP リテラルが非公開でないか → 遮断する名前でないか */
  private checkDestination(host: string, port: number): void {
    if (!this.allowedPorts.has(port)) throw new GatewayError(403, `許していないポート: ${port}`, 'port');
    if (this.isPrivateIp(host)) throw new GatewayError(403, `非公開の宛先: ${host}`, 'private_ip');
    if (isBlockedHostname(host)) throw new GatewayError(403, `遮断する名前: ${host}`, 'blocked_host');
  }

  /** 名前を 1 回だけ解決し、答えの IP がすべて公開であることを確かめ、検査した IP に接続する */
  private async dialDirect(host: string, port: number): Promise<net.Socket> {
    const addresses = await this.addressesOf(host);
    // 1 つでも非公開なら、全体を拒否する（公開の IP だけを選んで通すことはしない）
    for (const address of addresses) {
      if (this.isPrivateIp(address)) throw new GatewayError(403, `非公開の IP に解決された: ${host} -> ${address}`, 'private_ip');
    }
    return this.connectFirst(addresses, port);
  }

  /** 運用者の上流プロキシに接続する。トンネルなら、CONNECT を送って 200 を確かめる（名前の解決は、上流が行う） */
  private async dialUpstream(
    upstream: { host: string; port: number; authorization?: string },
    host: string,
    port: number,
    purpose: 'tunnel' | 'forward',
  ): Promise<Opened> {
    const socket = await this.connectFirst([upstream.host], upstream.port);
    if (purpose === 'forward') return { socket, leftover: Buffer.alloc(0) };
    const authority = `${formatHost(host)}:${port}`;
    const request = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, ...(upstream.authorization ? [`Proxy-Authorization: ${upstream.authorization}`] : [])];
    socket.write(`${request.join('\r\n')}\r\n\r\n`);
    try {
      const response = await this.readHead(socket);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(response.head)?.[1];
      if (status !== '200') throw new GatewayError(502, `上流のプロキシが CONNECT を断った: ${status ?? '読めない応答'}`);
      return { socket, leftover: response.rest };
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  /** ソケットから、空行までの頭部を読む（大きさの上限・時間切れつき）。読んだあとは一時停止し、頭部のあとのバイトは rest で返す */
  private readHead(socket: net.Socket): Promise<{ head: string; rest: Buffer }> {
    return new Promise((resolve, reject) => {
      let received = Buffer.alloc(0);
      const finish = (action: () => void) => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('close', onGone);
        socket.off('error', onGone);
        action();
      };
      const onGone = () => finish(() => reject(new GatewayError(502, '上流のプロキシの応答の頭部を読めない')));
      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const end = received.indexOf('\r\n\r\n');
        if (end >= 0) {
          socket.pause();
          finish(() => resolve({ head: received.subarray(0, end).toString('latin1'), rest: received.subarray(end + 4) }));
        } else if (received.length > this.limits.maxHeadBytes) onGone();
      };
      const timer = setTimeout(onGone, this.limits.connectTimeoutMs);
      socket.on('data', onData);
      socket.once('close', onGone);
      socket.once('error', onGone);
    });
  }

  /** 名前を解決する。IP リテラルは、そのまま。失敗・空・時間切れは、閉じる（502） */
  private async addressesOf(host: string): Promise<string[]> {
    if (net.isIP(host)) return [host];
    let addresses: string[];
    try {
      addresses = await withTimeout(this.resolveName(host), this.limits.resolveTimeoutMs, () => new Error('解決の時間切れ'));
    } catch {
      throw new GatewayError(502, `名前を解決できない: ${host}`, 'dns');
    }
    if (addresses.length === 0) throw new GatewayError(502, `名前の答えが空: ${host}`, 'dns');
    return addresses;
  }

  /** 検査した IP に、順に接続を試みる（名前では接続しない）。どれにも接続できなければ 502 */
  private async connectFirst(addresses: readonly string[], port: number): Promise<net.Socket> {
    for (const address of addresses) {
      const socket = await new Promise<net.Socket | undefined>((resolve) => {
        const candidate = net.connect({ host: address, port, allowHalfOpen: true });
        const fail = () => {
          candidate.destroy();
          resolve(undefined);
        };
        candidate.setTimeout(this.limits.connectTimeoutMs, fail);
        candidate.once('error', fail);
        candidate.once('connect', () => {
          candidate.setTimeout(0);
          candidate.off('error', fail);
          resolve(candidate);
        });
      });
      if (socket) {
        this.track(socket);
        return socket;
      }
    }
    throw new GatewayError(502, '宛先に接続できない');
  }

  /** トンネル（CONNECT）を、双方向にそのまま中継する。片側が送信を終えたら（FIN）、反対側へ伝え、反対向きは続ける */
  private relay(client: net.Socket, upstream: net.Socket, rest: Buffer): void {
    if (rest.length > 0) upstream.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
    this.watch(client, upstream);
  }

  /**
   * 1 つの要求だけを転送し、応答を返す。本文は Content-Length の長さまで流す。
   * それを超えて届いたバイト（続けて送られた別の要求など）は流さず、枠までの分を送り終えてから、両側を切る。
   * 宛先側へ、クライアントの送信終了（FIN）は伝えない（要求の途中で閉じられたと見て、応答をやめるサーバーがあるため）。
   */
  private relayRequest(client: net.Socket, upstream: net.Socket, rest: Buffer, bodyLength: number): void {
    if (rest.length > 0) upstream.write(rest);
    let remaining = bodyLength - rest.length;
    let blocked = false;
    client.on('data', (chunk: Buffer) => {
      if (blocked) return;
      const part = chunk.subarray(0, remaining);
      if (part.length > 0) {
        remaining -= part.length;
        if (!upstream.write(part)) {
          client.pause();
          upstream.once('drain', () => client.resume());
        }
      }
      if (part.length < chunk.length) {
        blocked = true;
        incrementSecurityCounter('sora_egress_denied_bad_request_total');
        upstream.end(() => {
          client.destroy();
          upstream.destroy();
        });
      }
    });
    upstream.pipe(client);
    this.watch(client, upstream);
    client.resume(); // 頭部を読んだあと、一時停止していた
  }

  /** 無通信の時間切れと、エラー・全閉じで、両側を切る（片側だけが残らないように） */
  private watch(client: net.Socket, upstream: net.Socket): void {
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.setTimeout(this.limits.idleTimeoutMs, closeBoth); // 無通信が続いた接続を残さない
      socket.on('error', closeBoth);
      socket.once('close', closeBoth);
    }
  }
}
