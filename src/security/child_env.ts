/**
 * 子プロセス（ブラウザ・同梱のバイナリ）に渡す環境変数の許可リスト。
 *
 * Sora の環境変数には、運用者の秘密（API キー・署名の秘密・各社の資格情報・通知先の URL）が入っている。子プロセスは、
 * 乗っ取られうる（ブラウザはページの内容を、バイナリは外部の応答を読む）ので、必要なものだけを渡す。
 * 許可リストにない名前は、秘密らしくなくても渡さない（新しい秘密を足したときに、渡し忘れではなく、渡さない側に倒れる）。
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 2・7）。
 */

const ALLOWED_NAMES: ReadonlySet<string> = new Set([
  // 実行ファイルとライブラリの場所・一時ファイル・時刻・ロケール
  'PATH',
  'HOME',
  'TMPDIR',
  'TZ',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LD_LIBRARY_PATH',
  // フォントと、Chromium が使う XDG の置き場所
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  // 外向きのプロキシと証明書。運用者が、子プロセスの通信にも使わせたいもの
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Go のランタイムの調整（Yahoo のバイナリ）
  'GODEBUG',
  'GOGC',
  'GOMAXPROCS',
  'GOMEMLIMIT',
]);

/** `LC_TIME` など、ロケールの個別の指定。 */
const ALLOWED_PREFIXES: readonly string[] = ['LC_'];

/**
 * 子プロセスに渡す環境変数を作る。`source`（既定は `process.env`）から、許可リストのものだけを取り、`extra` で上書き・追加する
 * （値が undefined の名前は消す）。`source` は書き換えない。
 */
export function childEnv(extra: Record<string, string | undefined> = {}, source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (ALLOWED_NAMES.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix)))) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}
