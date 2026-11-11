/**
 * Sora が読む環境変数の登録簿と、読み取りの関数（設計: docs/superpowers/specs/2026-11-11-env-vars-design.md）。
 *
 * - 読み取り（envBool など）は、呼び出しのたびに env を読む（覚えない）。空・空白だけの値は未設定とみなし、
 *   不正な値は既定値（無ければ undefined）を返す（列は正しい要素を残す）。例外は投げない。
 * - 不正な値と旧名を止めるのは、起動時の checkEnv だけ。旧名は別名として読まない。
 * - README §4.3 の表は renderEnvTable() で作る（この登録簿が正本）。
 */
import { EXPLICIT_ONLY_MODULES, MODULE_NAMES } from './modules.js';
import { normalizeHost, normalizeOrigin } from './security/host_origin.js';

export type Env = Record<string, string | undefined>;

/** 領域（命名の決まりの順。README の表の順と見出し）。 */
export const AREAS = {
  core: '全体',
  auth: '認証',
  log: 'ログ',
  alert: '通知',
  mcp: 'MCP',
  browser: 'ブラウザ',
  fetch: '静的取得',
  proxy: 'プロキシ',
  search: '検索',
  yahoo: 'Yahoo',
  x: 'X',
  openpoi: 'OpenPOI',
  address: '住所',
  hts: 'HTS',
  gcc: 'GCC',
  tracking: '追跡',
  intel: '国・地域の情報',
} as const;
export type Area = keyof typeof AREAS;

export interface Setting {
  area: Area;
  kind: 'bool' | 'int' | 'enum' | 'list' | 'url' | 'path' | 'str' | 'json';
  /** README §4.3 の説明（1 行） */
  doc: string;
  /** 未設定・不正のときに読み取りが返す値（無ければ undefined。bool は false） */
  default?: boolean | number | string | readonly string[];
  /** README の既定の欄（default を書くだけでは足りないとき） */
  defaultDoc?: string;
  /** int の範囲（min の既定は 0、max は無し）。範囲の外は不正 */
  min?: number;
  max?: number;
  /** int の頭打ち。これを超える値は不正でなく、この値に読む */
  cap?: number;
  /** int・str の値の全体の形 */
  pattern?: RegExp;
  /** enum の値（大文字小文字を問わずに比べ、返すのはこの綴り） */
  values?: readonly string[];
  /** url の scheme（既定は http・https） */
  schemes?: readonly string[];
  /** list の要素の検査と正規化（不正なら undefined） */
  item?: (value: string) => string | undefined;
  /** list で `all` を許す */
  allowAll?: boolean;
  /** json の形の検査 */
  shape?: (value: unknown) => boolean;
  /** エラー文の「正しい形」（種類から作れないとき: list・json・pattern つき） */
  form?: string;
  /** 値を表示しない（「設定済み、長さ N」とだけ出す） */
  secret?: boolean;
  /** 旧名（別名としては読まない。checkEnv が知らせる） */
  legacy?: readonly string[];
  /** 旧名だけが設定されていて、この名前が無いとき。error は起動を拒否、warn は警告 */
  legacyOnly?: 'error' | 'warn';
}

const HTTP = ['http', 'https'] as const;
const PROXY_SCHEMES = ['http', 'https', 'socks5'] as const;

/** new URL() で読めて、scheme が許されたもの。末尾の `/` は外す（正規表現でなく線形に）。 */
function url(value: string, schemes: readonly string[]): string | undefined {
  try {
    const u = new URL(value);
    if (!schemes.includes(u.protocol.slice(0, -1)) || (u.protocol !== 'file:' && !u.host)) return undefined;
  } catch {
    return undefined;
  }
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

const moduleName = (value: string) => {
  const m = value.toLowerCase();
  return m === '*' ? 'all' : (MODULE_NAMES as readonly string[]).includes(m) ? m : undefined;
};

const prefecture = (value: string) => (/^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 47 ? value.padStart(2, '0') : undefined);
const providerId = (value: string) => (/^[a-z0-9_-]+$/.test(value) ? value : undefined);
const did = (value: string) => (/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value) ? value : undefined);

const PARTY_FIELDS = ['name', 'street', 'city', 'state', 'country', 'email', 'phone'];
const isParty = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && PARTY_FIELDS.every((f) => (value as Record<string, unknown>)[f] === undefined || typeof (value as Record<string, unknown>)[f] === 'string');
const PARTY_FORM = 'JSON のオブジェクト（`name`・`street`・`city`・`state`・`country`・`email`・`phone` の文字列）';

const MODULES_IN_ALL = MODULE_NAMES.filter((m) => !EXPLICIT_ONLY_MODULES.includes(m)).join(',');

/** Sora 固有の設定（設計メモの KEEP・RENAME・MERGE の新名 53 個と、そのあとに増えた 3 個）。 */
export const SETTINGS = {
  // --- 全体 ---
  SORA_API_KEY: {
    area: 'core', kind: 'str', secret: true, legacy: ['WEB_FETCHER_API_KEY', 'API_KEY'], legacyOnly: 'error',
    defaultDoc: '*(未設定 = 認証なし)*',
    doc: 'サーバーの API 認証キー。設定すると `Authorization: Bearer <key>` か `X-API-Key` ヘッダーでの認証が要ります。未設定なら認証なしで使えます（Fail-Open。キー無しの警告を 1 回出します）',
  },
  SORA_ALLOW_ANONYMOUS: {
    area: 'core', kind: 'bool', default: false,
    doc: '`true` で匿名の利用を認めます。キーが未設定なら、値によらず認証なしで使えます（`true` はキー無しの警告を止めるだけ）。キーを設定していて `true` のときは、キー無しの要求も誤ったキーの要求も匿名として通します（`401` で断るのは `false` のときだけ）',
  },
  SORA_MODULES: {
    area: 'core', kind: 'list', default: ['all'], allowAll: true, item: moduleName, legacy: ['ENABLED_MODULES'], legacyOnly: 'error',
    form: `カンマ区切りのモジュール名（${MODULE_NAMES.join('・')}）か all`,
    doc: `有効にするモジュール（カンマ区切り: \`${MODULES_IN_ALL}\` または \`all\`）。自己責任の \`lyrics\`・楽曲認識の \`shazam\`・HTS の版の保存の \`hts-archive\` は \`all\` に含まれず、\`all,lyrics\` のように名前を挙げたときだけ有効。知らない名前があると起動しません`,
  },
  SORA_DB_PATH: {
    area: 'core', kind: 'path',
    defaultDoc: '`./data/sora.db`（`NODE_ENV=test` なら `:memory:`）',
    doc: 'SQLite データベースファイルのパス（キャッシュ・監視対象・ドメイン別 Cookie / localStorage を格納。ファイルは自動で `0600` に制限されます。ブラウザで開いたページが HTTP 400 以上を返したとき、または待っても確認の画面（ボット対策）のままだったときは、そのサイトの Cookie / localStorage を保存せず、保存していた分を消して、戻さずに 1 回だけ開き直します）',
  },
  SORA_PUBLIC_URL: {
    area: 'core', kind: 'url',
    doc: '利用者がブラウザで開く Sora の公開 URL（例: `https://sora.example.com`）。荷物ごとの表示ページの `pageUrl` の組み立てに使います',
  },
  SORA_ALLOWED_HOSTS: {
    area: 'core', kind: 'list', item: normalizeHost,
    form: 'カンマ区切りの Host（例: `sora.example.com,localhost:3016`。scheme やパスは付けない）',
    defaultDoc: '*(未設定 = `localhost`・`127.0.0.1`・`[::1]` をポート不問)*',
    doc: 'MCP エンドポイント（`/mcp`・`/sse`・`/message`）と、ブラウザ上のページから来る REST 要求が受け付ける Host のカンマ区切りリスト（例: `sora.example.com,localhost:3016`）。未設定なら `localhost`・`127.0.0.1`・`[::1]` を**ポート不問**で許可します（`-p 3016:8000` のようなポート割り当てでもそのまま接続できます）。設定した場合は、書いた Host だけをポート込みで厳密に照合します。LAN・公開ホスト名・リバースプロキシ経由で使うときは設定してください。ブラウザを介さない REST 要求（curl・サーバー間通信）は Host を検査しません',
  },
  SORA_ALLOWED_ORIGINS: {
    area: 'core', kind: 'list', item: normalizeOrigin,
    form: 'カンマ区切りの Origin（例: `http://localhost:3016`。http・https で、パスは付けない）',
    defaultDoc: '`localhost`・`127.0.0.1`・`[::1]`（ポート無し／`PORT` 付き）',
    doc: 'MCP と REST に接続してよいブラウザの Origin のカンマ区切りリスト（例: `http://localhost:3016,http://localhost:5173`）。Origin ヘッダーを送らない通常の MCP クライアント（Claude Desktop・Cursor・CLI など）や、REST の curl・サーバー間通信には影響しません。REST は、サーバー自身のページ（`/docs` など）からの同一オリジンの呼び出しを、この設定によらず許可します。別の Origin のページから呼ぶときに設定します。許可外の Origin は `403`（`code: ORIGIN_NOT_ALLOWED`）で、`/health`・`/metrics`・`/openapi.json`・`/docs`・`/swagger` と荷物ごとの表示ページ（`/t/...`）は、どの Origin からでも読めます。拒否の回数は `/metrics` の `sora_rest_origin_rejected_total` で確認できます',
  },

  // --- 認証 ---
  SORA_AUTH_LOOPBACK_NO_KEY: {
    area: 'auth', kind: 'bool', default: false, legacy: ['ALLOW_LOCAL_NO_AUTH'], legacyOnly: 'warn',
    doc: '`true` の場合、`X-Forwarded-For` / `X-Real-IP` が付かない直接のループバック接続に限り、API キー無しでのアクセスを許可します。**リバースプロキシ配下では有効化しないでください**',
  },
  SORA_AUTH_TRUST_PROXY: {
    area: 'auth', kind: 'bool', default: false, legacy: ['TRUST_PROXY'], legacyOnly: 'warn',
    doc: '`true` で `X-Forwarded-For` の先頭のアドレスを接続元として信頼します（`SORA_AUTH_LOOPBACK_NO_KEY` の判定に使います）。リバースプロキシ配下でのみ設定してください',
  },
  SORA_AUTH_DAILY_LIMIT: {
    area: 'auth', kind: 'int', min: 1, legacy: ['DAILY_REQUEST_LIMIT'], legacyOnly: 'error',
    defaultDoc: '*(無制限)*',
    doc: 'API キーごとの 1 日（UTC）の最大リクエスト数。超えると `429` を返します。キー無しの匿名の要求は、まとめて 1 つの枠で数えます',
  },

  // --- ログ・通知 ---
  SORA_LOG_FORMAT: {
    area: 'log', kind: 'enum', values: ['text', 'json'], default: 'text', legacy: ['LOG_FORMAT'], legacyOnly: 'warn',
    doc: '`json` でリクエストログを構造化 JSON で出力します',
  },
  SORA_ALERT_WEBHOOK_URL: {
    area: 'alert', kind: 'url', secret: true, legacy: ['ADMIN_ALERT_WEBHOOK_URL'], legacyOnly: 'warn',
    doc: '`GET /health?detailed=true` が degraded（SQLite 障害）の場合に送信する管理者アラートの Webhook URL（Slack・Discord など）。プライベートなネットワークの宛先には送りません',
  },

  // --- MCP ---
  SORA_MCP_DEFER_TOOLS: {
    area: 'mcp', kind: 'bool', default: true, legacy: ['SORA_DEFER_TOOLS'], legacyOnly: 'error',
    doc: '包括ツール初期公開ハイブリッドモード（12 コアツール＋`search_tools` 常時露出＋特殊ツール遅延発見）を有効化するか。`false` で全 33 ツール静的一括ロード。stdio では常に無効です',
  },
  SORA_MCP_OUTPUT_SCHEMA: {
    area: 'mcp', kind: 'bool', default: false, legacy: ['SORA_TOOL_OUTPUT_SCHEMA'], legacyOnly: 'warn',
    doc: '`true` で `tools/list` に各ツールの `outputSchema` を含めます。既定では省略してツール定義のサイズを抑えます（`tools/call` の `structuredContent` 検証は変わりません）',
  },
  SORA_MCP_MAX_SESSIONS: {
    area: 'mcp', kind: 'int', min: 1, default: 100,
    doc: '同時に保持する MCP セッション数の上限（正の整数）。1 セッションは JS ヒープを約 3〜4MB 使います（v4 の見積もり）。上限に達すると、30 秒以上使われていないセッションのうち最も古いものを閉じて新しい接続を受け入れ、すべてが直近まで使われている場合は `503`（`Retry-After: 5`）で断ります。小さな VPS では小さく設定してください。発生は `/metrics` の `sora_mcp_session_evicted_total`・`sora_mcp_session_rejected_total` で確認できます',
  },

  // --- ブラウザ ---
  SORA_BROWSER_MAX_CONCURRENCY: {
    area: 'browser', kind: 'int', min: 1, cap: 50, legacy: ['MAX_CONCURRENT_BROWSERS'], legacyOnly: 'warn',
    defaultDoc: '*(メモリから自動: 1〜5)*',
    doc: '同時に起動・実行を許可する Chromium ブラウザセッションの上限数（1 以上。50 を超える値は 50 にします）。未設定なら cgroup のメモリ上限（無ければ搭載メモリ）から `(メモリMB − 700) ÷ 300` を 1〜5 に丸めて決めます（1GB→1、2GB→4、4GB以上→5）。起動のときに読みます',
  },
  SORA_BROWSER_IDLE_TTL_MS: {
    area: 'browser', kind: 'int', min: 0, default: 300_000, legacy: ['BROWSER_IDLE_TTL_MS'], legacyOnly: 'warn',
    doc: '共有 Chromium が無操作のまま経過したら閉じるまでの時間（ms）。`0` で無効。次回のブラウザ利用時に自動で再起動します（実測: 常駐時 約925MB → 終了後 約197MB）。開いているブラウザセッションがある間は閉じません',
  },
  SORA_BROWSER_ALLOW_EVALUATE: {
    area: 'browser', kind: 'bool', default: false, legacy: ['ALLOW_BROWSER_EVALUATE'], legacyOnly: 'warn',
    doc: '`true` のときだけ、`/browser/action` と MCP `browser_action` の `evaluate`（任意 JS の実行）が動きます。既定は遮断',
  },
  SORA_BROWSER_LOW_MEMORY: {
    area: 'browser', kind: 'bool', default: false,
    doc: '`true` で、Chromium を低メモリ端末のモード（`--enable-low-end-device-mode`）で起動します。ブラウザ描画中のピークが下がります（同梱の Chromium 156 で実測、Chromium 全プロセスの PSS 合計・3 回の平均: ページを 1 つずつ開いて 約910MB → 約740MB（−18%）、3 ページ同時で 約1,210MB → 約1,040MB（−14%））。待機中の常駐量と、取得にかかる時間（25 サイトの通ったものの中央値 5.5 秒と 5.3 秒）は変わりません。副作用は `navigator.deviceMemory` が 8 から 2 になることで、ほかの指紋の項目と、検出サイト 5 つの判定は変わりませんでした。起動のたびに読みます（変えたら次の Chromium の起動から効きます）。`SORA_BROWSER_IDLE_TTL_MS` を短くして使わない間の常駐を減らす設定とも併用できます',
  },

  // --- 静的取得 ---
  SORA_FETCH_ALLOW_PRIVATE_NETWORK: {
    area: 'fetch', kind: 'bool', default: false, legacy: ['ALLOW_LOCAL_FETCH'], legacyOnly: 'warn',
    doc: '`true` の場合、`localhost` / プライベート IP への取得を許可します（SSRF の防御（DNS の検査・ブラウザの要求・遷移・Webhook）をすべて外します。**テスト用途のみ**）',
  },
  SORA_FETCH_DEFAULT_REFERER: {
    area: 'fetch', kind: 'bool', default: true, legacy: ['SORA_DEFAULT_REFERER'], legacyOnly: 'error',
    doc: '`scrape` の静的取得の 1 回目に、検索経由の閲覧に見せる `Referer: https://www.google.com/`（と `Sec-Fetch-Site: cross-site`）を付ける。`off` で無効。呼び出し側が `Referer` を指定したとき、Cookie などの資格情報を運ぶときは付けない。robots.txt・sitemap・画像・JSON API には付けない。有料記事の「Google 経由は無料」を装う形になり、アクセス解析には検索流入として数えられるため、気になる場合は `off`',
  },
  SORA_RS_TRAFILATURA_PATH: {
    area: 'fetch', kind: 'path', legacy: ['RS_TRAFILATURA_PATH'], legacyOnly: 'warn',
    defaultDoc: '*(未設定。公開イメージは `/usr/local/bin/rs-trafilatura`)*',
    doc: '本文の取り出しに使う [rs-trafilatura](https://github.com/Murrough-Foley/rs-trafilatura)（MIT OR Apache-2.0。イメージにはライセンスを `/usr/share/licenses/rs-trafilatura/` に同梱）の `extract_stdin` のパス。未設定・失敗のときは Readability で取り出します（`docs/search-scrape-mechanics.md`）',
  },
  SORA_FETCH_TRUST_STORE: {
    area: 'fetch', kind: 'enum', values: ['combined', 'mozilla', 'defaultPaths'],
    defaultDoc: '*(未設定 = wreq-js の既定)*',
    doc: '静的取得（wreq-js）が TLS の検証に使う root。`combined`（同梱の Mozilla の root + システムの root。wreq-js の既定）・`mozilla`（同梱の root だけ）・`defaultPaths`（システムの root だけ。`SSL_CERT_FILE` か `/etc/ssl/certs/ca-certificates.crt` など）。**公開イメージは `defaultPaths`** で、`/etc/ssl/certs/ca-certificates.crt` を、イメージのビルドで作った一覧（Debian の root と、Bun の最新の root から、信頼を外した root を除いたもの）に置き換えてあります。理由: wreq-js の同梱の root は、wreq-js を作った時点（3.2.0 は 2026-08）のままで、2026-10 に秘密鍵が漏れた eMudhra の中間 CA に連なる `emSign ECC Root CA - G3` を信頼します（経路上の攻撃者が、どのサーバーにもなりすませる）。自分でビルドする場合は、`bun scripts/build-ca-bundle.ts <システムの root の PEM の束> <出力>` で一覧を作り、`SSL_CERT_FILE` で渡して、この変数を `defaultPaths` にします（native の読む環境変数は起動時に決まるので、プロセスの起動前に設定します）。ブラウザ（Chromium）の root は、この設定の対象外です',
  },
  SORA_FETCH_MAX_CHROME_PROFILE: {
    area: 'fetch', kind: 'int', pattern: /^\d{3}$/, min: 136, default: 149,
    form: '3 桁の Chrome の版（136 以上）',
    defaultDoc: '`149`（公開イメージは `154`）',
    doc: '静的取得が使う Chrome プロファイル（`chrome_<版>`）の上限。ブラウザも、この版までしか名乗りません（UA・TLS・ヘッダを、静的取得と同じにするため）。実際の Chromium がこれより新しければ、この版になります。3 桁の Chrome の版（136 以上）で、未設定は 149（npm の wreq-js の native が持つ最新）。公開イメージは、Containerfile で自前にビルドした native（上流の wreq-util の Chrome 150〜154 のプロファイルを持つ）に合わせて 154 にしています。**値を下げれば、UA・TLS・ヘッダがその版のものに戻ります**（例: `149`。イメージの作り直しは要りません）。native が持たない版を指定すると、最初の静的取得で、native が持つ最大まで下げて警告を出します。起動のときに読みます',
  },

  // --- プロキシ ---
  SORA_PROXY_URL: {
    area: 'proxy', kind: 'url', schemes: PROXY_SCHEMES, secret: true,
    doc: 'Sora 専用のプロキシ URL（`http://`・`https://`・`socks5://`）。ブラウザ（Chromium）と静的取得の両方に効き、標準の `HTTPS_PROXY` などより優先します（静的取得では `SORA_PROXY_LIST` がさらに優先）',
  },
  SORA_PROXY_LIST: {
    area: 'proxy', kind: 'list', item: (value: string) => url(value, PROXY_SCHEMES), secret: true,
    form: 'カンマ区切りのプロキシ URL（http・https・socks5）',
    doc: '静的取得だけに使うプロキシ URL のカンマ区切りリスト。設定時はリクエストごとにランダムでローテーションします（`SORA_PROXY_URL` より優先。ブラウザには効きません）。SSRF 対策のため、MCP・REST のリクエストの引数からは指定できません',
  },

  // --- 検索 ---
  SORA_SEARCH_SCRAPE_DEADLINE_MS: {
    area: 'search', kind: 'int', min: 0, default: 0, legacy: ['SORA_SCRAPE_DEADLINE_MS'], legacyOnly: 'warn',
    defaultDoc: '`0`（打ち切り無し）',
    doc: '深層検索（`search_deep`）の本文取得の既定の打ち切り上限（ms）。`0` で打ち切り無し。リクエストの `scrapeDeadlineMs` が優先されます。`scrape` ツールには効きません',
  },

  // --- Yahoo ---
  SORA_YAHOO_MCP_PATH: {
    area: 'yahoo', kind: 'path', legacy: ['YAHOO_MCP_PATH'], legacyOnly: 'warn',
    defaultDoc: '*(自動検出。公開イメージは `/app/yahoo-search-mcp`)*',
    doc: '同梱の Yahoo 検索の実行ファイル（`yahoo-search-mcp`）のパス。未設定なら `/usr/local/bin/yahoo-search-mcp`・リポジトリの `bin/yahoo-search-mcp`・`PATH` の順に探します。起動のときに読みます',
  },
  SORA_YAHOO_MIN_INTERVAL_MS: {
    area: 'yahoo', kind: 'int', min: 0, default: 500,
    doc: 'Yahoo プロバイダ呼び出しの最小間隔（ms）。共有ゲートでバーストを抑制します',
  },
  SORA_YAHOO_BREAKER_COOLDOWN_MS: {
    area: 'yahoo', kind: 'int', min: 0, default: 120_000,
    doc: '429 検出後のブレーカー冷却期間（ms）。期間中は即時失敗して `throttled` を返します',
  },

  // --- X ---
  SORA_X_DETAIL_PROVIDER: {
    area: 'x', kind: 'bool', default: true,
    doc: '`off` で FxTwitter/FxEmbed による X の投稿の詳細の補完を無効化します（失敗しても検索は続きます）',
  },
  SORA_X_DETAIL_BASE_URL: {
    area: 'x', kind: 'url', default: 'https://api.fxtwitter.com', legacy: ['FXTWITTER_API_BASE'], legacyOnly: 'error',
    doc: 'X の投稿の詳細を取る FxTwitter 互換の API（自前の FxEmbed など）の URL。起動のときに読みます',
  },
  SORA_X_DETAIL_TIMEOUT_MS: {
    area: 'x', kind: 'int', min: 1, default: 1500, legacy: ['FXTWITTER_TIMEOUT_MS'], legacyOnly: 'warn',
    doc: 'X の投稿の詳細の取得 1 件の待ち時間の上限（ms）。起動のときに読みます',
  },

  // --- OpenPOI ---
  SORA_OPENPOI_BASE_URL: {
    area: 'openpoi', kind: 'url', default: 'https://api.openpoiapi.com',
    doc: '`search_poi` が呼ぶ OpenPOI API の URL',
  },

  // --- 住所 ---
  SORA_ADDRESS_MODE: {
    area: 'address', kind: 'enum', values: ['lazy', 'eager', 'off'], default: 'lazy', legacy: ['SORA_ADDRESS'], legacyOnly: 'error',
    doc: '住所データ機能の動作モード。`lazy`: `lookup_address`（REST は `/geo/postal-code` / `/geo/address/normalize` / `/geo/reverse`）が呼ばれたときだけ必要な市区町村を取得する（`get_place_info` / `search_poi` の座標解決は、取得済みのデータだけをローカル優先で使い、取得は頼まない）。`eager`: `lazy` に加えて、座標解決でデータが無い地域を見つけたとき、待たずに裏で取得を始める。`off`: `lookup_address` を登録せず、REST は 404 `ADDRESS_DISABLED`（取得も子プロセスも起こさない）',
  },
  SORA_ADDRESS_DIR: {
    area: 'address', kind: 'path',
    defaultDoc: '`<SORA_DB_PATH のあるディレクトリ>/address`',
    doc: '住所データ（ABR/郵便番号/索引）の保存先ディレクトリ。`SORA_DB_PATH` が `:memory:` のときは一時ディレクトリ',
  },
  SORA_ADDRESS_MAX_MB: {
    area: 'address', kind: 'int', min: 64, max: 1_048_576, default: 2048,
    doc: '住所データのディスク容量予算（MB）。上限超過時は古い市区町村データから自動 evict',
  },
  SORA_ADDRESS_WAIT_MS: {
    area: 'address', kind: 'int', min: 1000, max: 120_000, default: 20_000,
    doc: '初回データ構築の待機上限（ms）。超過時は暫定結果（`incomplete: true`）を返し裏で継続',
  },
  SORA_ADDRESS_BUILD_CONCURRENCY: {
    area: 'address', kind: 'int', min: 1, max: 4, default: 1,
    doc: '住所データ構築子プロセスの並行実行数（1〜4）',
  },
  SORA_ADDRESS_PRELOAD: {
    area: 'address', kind: 'list', allowAll: true, item: prefecture,
    form: 'カンマ区切りの都道府県コード（1〜47。例: `13,14`）か all',
    doc: '事前取得する範囲。都道府県コードのカンマ区切り（例: `13,14`）または `all`。指定したときだけ、起動の10秒後から、範囲内の市区町村を低優先度で順に取得して残す（予算を超えても破棄しない。再起動で続きから進む。進み具合は保存先の `preload.json`）。未設定なら起動時に何もしない。詳細は運用手引 `docs/operations/address-data.md` の §4',
  },

  // --- HTS ---
  SORA_HTS_DIR: {
    area: 'hts', kind: 'path',
    defaultDoc: '`<SORA_DB_PATH のあるディレクトリ>/hts`',
    doc: '米国 HTS（関税率表）全件のローカルコピー（`hts.sqlite`、約 21MB）の保存先。`/trade/hts-predict`・`/trade/hts-verify`・`/trade/compliance` が初めて呼ばれたときに USITC から取得し（約 12MB・初回のみ約 20 秒）、7 日を過ぎると次の利用時に裏で更新します（失敗時は古いコピーのまま答えます）。起動時の取得・常駐処理はありません。`SORA_DB_PATH` が `:memory:` のときはメモリ上にだけ置きます。`hts-archive` モジュールを有効にすると、保存した HTS の版も `releases/` に置きます（Module 15）',
  },
  SORA_HTS_CROSS_SOURCE: {
    area: 'hts', kind: 'enum', values: ['local', 'api'], default: 'local', legacy: ['CROSS_SOURCE'], legacyOnly: 'warn',
    doc: 'HTS の推測が引く CBP の分類判例の照会先。`local` は手元の判例の索引（`SORA_HTS_DIR` の `cross.sqlite`。`/trade/hts-predict`・`/trade/compliance` が初めて呼ばれたときに Sora の GitHub のリリースから約 6MB を取得し、SHA-256 を確かめて作ります。起動時の取得はありません）。`api` は CBP の判例検索の API（2026 年 11 月から 403 で使えません）',
  },
  SORA_HTS_CROSS_INDEX_URL: {
    area: 'hts', kind: 'url', schemes: ['https', 'file'], legacy: ['SORA_CROSS_INDEX_URL'], legacyOnly: 'error',
    defaultDoc: '*(リリースの索引)*',
    doc: '自分で作った判例の索引（`scripts/cross-index/build_index.py`）を使うときの URL（`https://` か `file://`）。`SORA_HTS_CROSS_INDEX_SHA256` と両方を指定します',
  },
  SORA_HTS_CROSS_INDEX_SHA256: {
    area: 'hts', kind: 'str', pattern: /^[0-9a-f]{64}$/, legacy: ['SORA_CROSS_INDEX_SHA256'], legacyOnly: 'error',
    form: '16 進 64 字（小文字）',
    defaultDoc: '*(リリースの索引の値)*',
    doc: '`SORA_HTS_CROSS_INDEX_URL` の索引のファイルの SHA-256（16 進 64 字）。URL と両方を指定します',
  },

  // --- GCC ---
  SORA_GCC_CERTIFIER: {
    area: 'gcc', kind: 'json', shape: isParty, form: PARTY_FORM, secret: true,
    doc: '`generate_gcc_certificate`・`POST /trade/gcc-generate` の証明者の既定。JSON のオブジェクト `{"name","street","city","state","country","email","phone"}`。呼び出しに `certifier` が無い（中身が空の）ときだけ丸ごと使い、呼び出し側の値と項目ごとに混ぜることはありません。**共有のサーバーでは設定しないでください**（`certifier` を省いたすべての呼び出しの証明書に、この値が入ります）。読めない値は、GCC を作る品があるときだけエラーになります。見本・仮置きの確かめはしません',
  },
  SORA_GCC_CUSTODIAN: {
    area: 'gcc', kind: 'json', shape: isParty, form: PARTY_FORM, secret: true,
    doc: '同じ形で、試験の記録を持つ人（16 CFR 1110.11(a)(4)）の既定。`recordCustodian` が無いときだけ使います。共有のサーバーでは設定しないでください',
  },

  // --- 追跡 ---
  SORA_TRACKING_PAGE_SECRET: {
    area: 'tracking', kind: 'str', secret: true,
    doc: '荷物ごとの表示ページ（照会結果の `pageUrl`、`GET /t/:carrier/:number`）の署名に使う秘密鍵。`SORA_PUBLIC_URL` と両方を設定したときだけ表示ページが有効になり、照会結果に `pageUrl` が付きます。未設定なら表示ページは `404` で、起動時の処理もありません。値を変えると、発行済みの URL はすべて無効になります',
  },
  SORA_TRACKING_UPS_CLIENT_ID: {
    area: 'tracking', kind: 'str', secret: true, legacy: ['UPS_CLIENT_ID'], legacyOnly: 'warn',
    doc: 'UPS の追跡 API（OAuth）のクライアント ID。`SORA_TRACKING_UPS_CLIENT_SECRET` と組で設定します。無いときは API を使わずにブラウザで照会します',
  },
  SORA_TRACKING_UPS_CLIENT_SECRET: {
    area: 'tracking', kind: 'str', secret: true, legacy: ['UPS_CLIENT_SECRET'], legacyOnly: 'warn',
    doc: 'UPS の追跡 API（OAuth）のクライアントシークレット。`SORA_TRACKING_UPS_CLIENT_ID` と組で設定します',
  },
  SORA_TRACKING_FEDEX_CLIENT_ID: {
    area: 'tracking', kind: 'str', secret: true, legacy: ['FEDEX_API_KEY', 'FEDEX_CLIENT_ID'], legacyOnly: 'warn',
    doc: 'FedEx の追跡 API（OAuth）のクライアント ID（API キー）。`SORA_TRACKING_FEDEX_CLIENT_SECRET` と組で設定します。無いときは API を使わずにブラウザで照会します',
  },
  SORA_TRACKING_FEDEX_CLIENT_SECRET: {
    area: 'tracking', kind: 'str', secret: true, legacy: ['FEDEX_API_SECRET', 'FEDEX_CLIENT_SECRET'], legacyOnly: 'warn',
    doc: 'FedEx の追跡 API（OAuth）のクライアントシークレット。`SORA_TRACKING_FEDEX_CLIENT_ID` と組で設定します',
  },
  SORA_TRACKING_DHL_API_KEY: {
    area: 'tracking', kind: 'str', secret: true, legacy: ['DHL_EXPRESS_API_KEY', 'DHL_API_KEY'], legacyOnly: 'warn',
    doc: 'DHL の統合の追跡 API（Shipment Tracking - Unified）の API キー。無いときは API を使わずにブラウザで照会します',
  },

  // --- 国・地域の情報 ---
  SORA_INTEL_DISABLED: {
    area: 'intel', kind: 'list', item: providerId,
    form: 'カンマ区切りの取得先の ID（英小文字・数字・`_`・`-`。例: `usgs,eonet`）',
    doc: '国・地域の情報（`research_country_context`）で止める取得先の ID のカンマ区切り（例: `usgs,eonet`）',
  },
  SORA_INTEL_SCRAPE: {
    area: 'intel', kind: 'bool', default: true,
    doc: '`off` で、国・地域の情報の記事の本文の取得（内蔵のスクレイパ、ブラウザなし）を止めます',
  },
  SORA_INTEL_WEB_SEARCH: {
    area: 'intel', kind: 'bool', default: true,
    doc: '`off` で、国・地域の情報の公式の Web 検索（Yahoo）を止めます（取得先は残り、結果が空になります）',
  },
  SORA_INTEL_BLUESKY_DIDS: {
    area: 'intel', kind: 'list', item: did, legacy: ['SORA_BLUESKY_DIDS'], legacyOnly: 'warn',
    form: 'カンマ区切りの DID（例: `did:plc:abc123`）',
    defaultDoc: '*(未設定 = 全員)*',
    doc: '設定すると、Bluesky の取得先は、この DID のアカウントの投稿だけを残します（カンマ区切り）',
  },
} as const satisfies Record<string, Setting>;

/** 業界の標準の名前（変えない。同じ形で読めるよう、別の表で持つ）。 */
export const EXTERNAL = {
  PORT: { area: 'core', kind: 'int', min: 1, max: 65_535, default: 8000, doc: 'HTTP / MCP サーバーのリッスンポート（1〜65535）。起動のときに読みます' },
  NODE_ENV: {
    area: 'core', kind: 'str',
    doc: 'プロセス環境の表示用（`bun test` は `test`。`test` のときは、`SORA_DB_PATH` が未設定なら DB をメモリ上に置くなど、テスト用の既定になります）。認証の判断には使いません（bun build がビルド時にインライン化するため）。キーが未設定なら、環境を問わず認証なしで使えます',
  },
  CHROME_PATH: { area: 'browser', kind: 'path', defaultDoc: '*(自動検出)*', doc: 'Chromium 実行バイナリのパスを明示指定します（未指定時は標準パスと `PATH` を自動探索）' },
  CHROME_BIN: { area: 'browser', kind: 'path', defaultDoc: '*(自動検出)*', doc: '`CHROME_PATH` と同じ（`CHROME_PATH` が無いか、そのファイルが無いときに見ます）' },
  PUPPETEER_EXECUTABLE_PATH: { area: 'browser', kind: 'path', defaultDoc: '*(自動検出)*', doc: '`CHROME_PATH` と同じ（`CHROME_PATH`・`CHROME_BIN` の次に見ます）' },
  HTTPS_PROXY: { area: 'proxy', kind: 'str', doc: '標準の HTTPS プロキシ URL。`SORA_PROXY_URL` が無いとき、ブラウザ（Chromium）と静的取得に使います（優先順は `HTTPS_PROXY`・`HTTP_PROXY`・`ALL_PROXY`）' },
  https_proxy: { area: 'proxy', kind: 'str', doc: '`HTTPS_PROXY` の小文字の綴り（`HTTPS_PROXY` が無いときに見ます）' },
  HTTP_PROXY: { area: 'proxy', kind: 'str', doc: '標準の HTTP プロキシ URL（`HTTPS_PROXY` が無いときに見ます）' },
  http_proxy: { area: 'proxy', kind: 'str', doc: '`HTTP_PROXY` の小文字の綴り（`HTTP_PROXY` が無いときに見ます）' },
  ALL_PROXY: { area: 'proxy', kind: 'str', doc: '標準の汎用プロキシ URL（SOCKS5 など。`HTTP_PROXY` が無いときに見ます）' },
  all_proxy: { area: 'proxy', kind: 'str', doc: '`ALL_PROXY` の小文字の綴り（`ALL_PROXY` が無いときに見ます）' },
  NO_PROXY: { area: 'proxy', kind: 'str', doc: 'プロキシを通さないホストのカンマ区切り（例: `localhost,127.0.0.1,.local`）。ブラウザと静的取得に効きます' },
  no_proxy: { area: 'proxy', kind: 'str', doc: '`NO_PROXY` の小文字の綴り（`NO_PROXY` が無いときに見ます）' },
} as const satisfies Record<string, Setting>;

export type SettingName = keyof typeof SETTINGS;
type Table = typeof SETTINGS & typeof EXTERNAL;
export type EnvName = keyof Table;
type NameOf<K extends Setting['kind']> = { [N in EnvName]: Table[N]['kind'] extends K ? N : never }[EnvName];
/** 既定値のある名前は T、無い名前は T | undefined。 */
type Read<N extends EnvName, T> = Table[N] extends { default: unknown } ? T : T | undefined;
type Values<N extends EnvName> = Table[N] extends { values: readonly (infer V)[] } ? V : never;

const TABLE: Readonly<Record<string, Setting>> = { ...SETTINGS, ...EXTERNAL };

/** 廃止した名前（置き換え先は無い。旧名だけのときは警告）。 */
const REMOVED = ['SORA_YAHOO_THROTTLE', 'SORA_WEB_RETRY_WAIT_MS', 'SORA_WEB_NATIVE_RANKING', 'SORA_RRF_ENABLED', 'SORA_WEB_QUERY_UNION', 'SORA_X_SOURCE_ISOLATION', 'SORA_REALTIME_ANCHOR'];

/** 旧名 → 置き換え先（廃止は to が無い）と、旧名だけのときの扱い。checkEnv だけが使う（別名としては読まない）。 */
export const LEGACY: Readonly<Record<string, { to?: SettingName; policy: 'error' | 'warn' }>> = Object.fromEntries([
  ...Object.entries(SETTINGS as Record<string, Setting>).flatMap(([to, s]) => (s.legacy ?? []).map((old) => [old, { to, policy: s.legacyOnly ?? 'warn' }])),
  ...REMOVED.map((old) => [old, { policy: 'warn' }]),
]);

/** 設定でない名前（定数・OS・テストとスクリプト用）。checkEnv は未知の SORA_* として扱わない。`SORA_GCC_` で始まる名前も同じ。 */
export const NOT_SETTINGS: readonly string[] = ['SORA_VERSION', 'SORA_MCP_INSTRUCTIONS', 'PATH', 'LOCALAPPDATA', 'SORA_LIVE_TESTS', 'SORA_TOOL_HEALTH_CASES_JSON', 'SORA_URL'];
const NOT_SETTING_PREFIX = 'SORA_GCC_';

const BOOL = new Map([['true', true], ['1', true], ['on', true], ['yes', true], ['false', false], ['0', false], ['off', false], ['no', false]]);

/** 列の要素を検査・正規化する。items は正しい要素（重複なし）、bad は不正な要素。 */
function listItems(s: Setting, value: string): { items: string[]; bad: string[] } {
  const items = new Set<string>();
  const bad: string[] = [];
  for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const item = part.toLowerCase() === 'all' ? (s.allowAll ? 'all' : undefined) : s.item?.(part);
    if (item === undefined) bad.push(part);
    else items.add(item);
  }
  return { items: [...items], bad };
}

/** 空でない値を読む。不正なら undefined（列は、不正な要素が 1 つでもあれば不正）。 */
function parse(s: Setting, raw: string): unknown {
  const v = raw.trim();
  switch (s.kind) {
    case 'bool':
      return BOOL.get(v.toLowerCase());
    case 'int': {
      if (!/^\d+$/.test(v) || (s.pattern && !s.pattern.test(v))) return undefined;
      const n = Number(v);
      // cap のある設定は、上の側が不正にならない（桁の多い値も cap に丸める）
      const upper = s.max ?? (s.cap === undefined ? Number.MAX_SAFE_INTEGER : Infinity);
      if (n < (s.min ?? 0) || n > upper) return undefined;
      return s.cap === undefined ? n : Math.min(n, s.cap);
    }
    case 'enum':
      return s.values?.find((x) => x.toLowerCase() === v.toLowerCase());
    case 'list': {
      const { items, bad } = listItems(s, v);
      return bad.length > 0 ? undefined : items;
    }
    case 'url':
      return url(v, s.schemes ?? HTTP);
    case 'path':
      return v;
    case 'str':
      return s.pattern && !s.pattern.test(raw) ? undefined : raw;
    case 'json':
      try {
        const value: unknown = JSON.parse(v);
        return !s.shape || s.shape(value) ? value : undefined;
      } catch {
        return undefined;
      }
  }
}

/** 未設定（文字列でない値・空・空白だけ）。テストなどが env に文字列でない値を入れても例外にしない。 */
const isBlank = (raw: unknown) => typeof raw !== 'string' || raw.trim() === '';

/** 登録されていない名前はプログラムの誤り（型で防ぐ。実行時に来たら、分かる文で止める）。 */
function settingOf(name: string): Setting {
  if (!Object.hasOwn(TABLE, name)) throw new Error(`Unknown setting: ${name}`);
  return TABLE[name];
}

/**
 * 呼び出しのたびの読み取り。不正な値は既定値（無ければ undefined）。
 * 列だけは、正しい要素を残す（`web,weeb` は `web`。既定の `all` に戻すと、絞った設定が開くため）。正しい要素が無ければ既定値。
 */
function read(name: string, env: Env): unknown {
  const s = settingOf(name);
  const raw = env[name];
  if (!isBlank(raw)) {
    const value = s.kind === 'list' ? listItems(s, raw as string).items : parse(s, raw as string);
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) return value;
  }
  return Array.isArray(s.default) ? [...s.default] : s.default;
}

/** 真偽値（`true`・`false`・`1`・`0`・`on`・`off`・`yes`・`no`、大文字小文字は問わない）。 */
export function envBool(name: NameOf<'bool'>, env: Env = process.env): boolean {
  return (read(name, env) as boolean | undefined) ?? false;
}

/** 整数（`^\d+$` と、変数ごとの最小・最大）。 */
export function envInt<N extends NameOf<'int'>>(name: N, env: Env = process.env): Read<N, number> {
  return read(name, env) as Read<N, number>;
}

/** 列挙（小文字で比べ、登録簿の綴りを返す）。 */
export function envEnum<N extends NameOf<'enum'>>(name: N, env: Env = process.env): Read<N, Values<N>> {
  return read(name, env) as Read<N, Values<N>>;
}

/** カンマ区切りの列（要素ごとに検査・正規化し、空の要素・不正な要素・重複を除く）。正しい要素が無ければ既定値（無ければ空の配列）。 */
export function envList(name: NameOf<'list'>, env: Env = process.env): string[] {
  return (read(name, env) as string[] | undefined) ?? [];
}

/** URL（new URL() で読めて、scheme が許されたもの。末尾の `/` は外す）。 */
export function envUrl<N extends NameOf<'url'>>(name: N, env: Env = process.env): Read<N, string> {
  return read(name, env) as Read<N, string>;
}

/** パス（前後の空白を除く）。 */
export function envPath<N extends NameOf<'path'>>(name: N, env: Env = process.env): Read<N, string> {
  return read(name, env) as Read<N, string>;
}

/** 文字列（値をそのまま返す。空白だけは未設定）。 */
export function envStr<N extends NameOf<'str'>>(name: N, env: Env = process.env): Read<N, string> {
  return read(name, env) as Read<N, string>;
}

/** JSON（読んで、形を検査する）。 */
export function envJson(name: NameOf<'json'>, env: Env = process.env): unknown {
  return read(name, env);
}

function formOf(s: Setting): string {
  if (s.form) return s.form;
  switch (s.kind) {
    case 'bool':
      return 'true・false・1・0・on・off・yes・no のどれか（大文字小文字は問わない）';
    case 'int':
      if (s.cap !== undefined) return `${s.min ?? 0} 以上の整数（${s.cap} を超える値は ${s.cap} にします）`;
      return s.max === undefined ? `${s.min ?? 0} 以上の整数` : `${s.min ?? 0}〜${s.max} の整数`;
    case 'enum':
      return `${s.values?.join('・')} のどれか`;
    case 'url':
      return `${(s.schemes ?? HTTP).join('・')} の URL`;
    default:
      return '';
  }
}

/** エラー文に出す値。秘密は長さだけ。URL は資格情報・問い合わせ・断片を伏せ、読めない URL は長さだけ。 */
function shown(s: Setting, raw: string): string {
  if (s.secret) return `設定済み、長さ ${raw.length}`;
  if (s.kind !== 'url') return JSON.stringify(raw);
  try {
    const u = new URL(raw.trim());
    const hidden = `${u.search ? '?…' : ''}${u.hash ? '#…' : ''}`;
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    u.search = '';
    u.hash = '';
    return JSON.stringify(u.href + hidden);
  } catch {
    return `読めない値、長さ ${raw.length}`;
  }
}

/** 1 つの変数の値が不正なら、checkEnv が出すのと同じエラー文。正しい値・未設定なら undefined。 */
export function envError(name: EnvName, env: Env = process.env): string | undefined {
  const s = settingOf(name);
  const raw = env[name];
  if (isBlank(raw) || parse(s, raw as string) !== undefined) return undefined;
  return `${name} の値（${shown(s, raw as string)}）は不正です。正しい形: ${formOf(s)}`;
}

/** 旧名のうち、SORA_ の付かない汎用の名前に添える文（ほかのプログラムの設定かもしれない）。 */
const OTHER_PROGRAMS = 'ほかのプログラムのものなら、そのままで構いません';

/**
 * 起動時の検査（純粋な関数）。errors があれば起動を止める（呼ぶのは起動の処理だけ）。
 * (a) 未知の SORA_* は警告 (b) 旧名は警告（置き換え先つき。新名があれば旧名は無視）
 * (c) 旧名だけで新名が無いとき、拒否の 10 個は errors (d) 不正な値は errors（秘密は「設定済み、長さ N」）。
 * キーも SORA_ALLOW_ANONYMOUS も無いのはエラーにしない（Fail-Open）。
 */
export function checkEnv(env: Env = process.env): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const name of Object.keys(TABLE)) {
    const error = envError(name as EnvName, env);
    if (error) errors.push(error);
  }

  // 空の値は未設定（Fail-Open）。旧い実装はキーの名前があれば認証を掛けていたので、黙って外れないよう知らせる
  if (typeof env.SORA_API_KEY === 'string' && env.SORA_API_KEY.trim() === '') warnings.push('SORA_API_KEY が空です。未設定として扱い、認証は無効になります');

  for (const [old, { to, policy }] of Object.entries(LEGACY)) {
    if (isBlank(env[old])) continue;
    const generic = !old.startsWith('SORA_');
    if (!to) warnings.push(`${old} は v5.0.0 で廃止しました（読みません）。設定を消してください`);
    else if (!isBlank(env[to])) {
      warnings.push(`${old} は ${to} に変わりました。${to} が設定されているので、${old} は無視します。${generic ? `Sora のための設定なら消してください（${OTHER_PROGRAMS}）` : `${old} を消してください`}`);
    } else if (old === 'API_KEY') {
      errors.push('API_KEY は v5.0.0 から読みません（Sora の認証キーは SORA_API_KEY）。このままでは認証が掛からないので、起動しません。ほかのプログラムのための値なら unset してください。Sora の認証キーなら SORA_API_KEY を設定してください');
    } else if (policy === 'error') {
      errors.push(`${old} は ${to} に変わりました（旧名は読みません）。このままでは設定が効かないので、起動しません。${to} を設定してください`);
    } else {
      warnings.push(`${old} は ${to} に変わりました（旧名は読まないので、この設定は効いていません）。${to} に変えてください${generic ? `（${OTHER_PROGRAMS}）` : ''}`);
    }
  }

  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith('SORA_') || isBlank(env[name]) || Object.hasOwn(TABLE, name) || Object.hasOwn(LEGACY, name)) continue;
    if (NOT_SETTINGS.includes(name) || name.startsWith(NOT_SETTING_PREFIX)) continue;
    warnings.push(`${name} は Sora の設定にありません（綴りを確かめてください）`);
  }

  return { errors, warnings };
}

const byName = (a: string, b: string) => {
  const [x, y] = [a.toUpperCase(), b.toUpperCase()];
  return x === y ? (a < b ? -1 : 1) : x < y ? -1 : 1;
};
const cell = (text: string) => text.replaceAll('|', '\\|');

function defaultCell(s: Setting): string {
  if (s.defaultDoc) return s.defaultDoc;
  if (s.default === undefined) return '*(未設定)*';
  return `\`${Array.isArray(s.default) ? s.default.join(',') : String(s.default)}\``;
}

/** README §4.3 の表（領域ごと。名前・既定・説明）。 */
export function renderEnvTable(): string {
  const entries = Object.entries(TABLE);
  return Object.entries(AREAS).flatMap(([area, label]) => {
    const rows = entries.filter(([, s]) => s.area === area).sort(([a], [b]) => byName(a, b));
    if (rows.length === 0) return [];
    return [
      `**${label}**`,
      '',
      '| 環境変数名 | デフォルト値 | 説明 |',
      '|---|---|---|',
      ...rows.map(([name, s]) => `| \`${name}\` | ${cell(defaultCell(s))} | ${cell(s.doc)} |`),
      '',
    ];
  }).join('\n');
}
