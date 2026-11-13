/**
 * 起動時の検査（設計メモの「起動時の検査」）。呼ぶのは起動の処理だけ（index.ts の import.meta.main と stdio.ts の main()）。
 * 出力は標準エラーだけ（stdio では標準出力が MCP の JSON-RPC の流れ）。秘密の値は checkEnv が「設定済み、長さ N」にする。
 */
import { existsSync } from 'node:fs';
import { checkEnv, envList, envPath, LEGACY, type Env } from './config.js';
import { errorMessage } from './errors.js';
import { egressGatewayOptionsFromEnv, isEgressGatewayEnabled } from './net/egress.js';

/** 同梱の実行ファイルのパスと、ファイルが無いときに起きること。 */
const BUNDLED = {
  SORA_YAHOO_MCP_PATH: '代わりに既定の場所（/usr/local/bin・リポジトリの bin・PATH）を探します',
  SORA_RS_TRAFILATURA_PATH: '本文は Readability で取り出します',
} as const;

/**
 * stdio では検査しない名前: PORT と、認証の鍵・1 日の上限の旧名。stdio は待ち受けず、認証の中間層も通らないので使わない。
 * どれも SORA_ の付かない汎用の名前で、受け継いだシェルの環境では、ほかのプログラムの設定かもしれない（ほかの名前は stdio でも検査する）。
 * 旧名は登録簿の LEGACY から導く（名前をここに書き写さない）。
 */
const NOT_USED_BY_STDIO: readonly string[] = [
  'PORT',
  ...Object.entries(LEGACY)
    .filter(([, { to }]) => to === 'SORA_API_KEY' || to === 'SORA_AUTH_DAILY_LIMIT')
    .map(([old]) => old),
];

const PREFIX = '[Sora/Config]';

/** checkEnv の結果と、同梱の実行ファイルの有無を出す。警告は出して続け、エラーがあれば exit(1)。 */
export function checkStartupEnv({
  env: given = process.env,
  transport = 'http',
  stderr = (line: string) => void process.stderr.write(`${line}\n`),
  exit = (code: number) => process.exit(code),
  exists = existsSync,
}: {
  env?: Env;
  transport?: 'http' | 'stdio';
  stderr?: (line: string) => void;
  exit?: (code: number) => void;
  exists?: (path: string) => boolean;
} = {}): void {
  const env = transport === 'stdio' ? Object.fromEntries(Object.entries(given).filter(([name]) => !NOT_USED_BY_STDIO.includes(name))) : given;
  const { errors, warnings } = checkEnv(env);
  // 出口のゲートウェイを使うときの、ほかの設定との食い違い（SORA_PROXY_LIST との併用・対応していない上流のプロキシの方式）は、ゲートウェイを作るとき（最初の通信）にも分かるが、
  // そのときは、すべての外向きの通信（Bun の fetch・子プロセスを含む）が失敗する。起動で止める。書き方の誤りは、checkEnv が数えているので、重ねない
  if (errors.length === 0) {
    try {
      if (isEgressGatewayEnabled(env)) egressGatewayOptionsFromEnv(env);
      // 許す宛先の一覧は、ゲートウェイを使うときだけ効く（使わないなら、内部の宛先には、もともと直接つなぐ）。効かない設定を、黙って抱えさせない
      else if (envList('SORA_EGRESS_ALLOW_HOSTS', env).length > 0) {
        warnings.push('SORA_EGRESS_ALLOW_HOSTS は、出口のゲートウェイが有効なときだけ効きます。いまは、ゲートウェイを使わないので、効きません（SORA_EGRESS_GATEWAY=on にするか、この設定を外してください。SORA_FETCH_ALLOW_PRIVATE_NETWORK=true のときも、ゲートウェイは使いません）');
      }
    } catch (error) {
      errors.push(errorMessage(error) ?? String(error));
    }
  }
  for (const [name, effect] of Object.entries(BUNDLED) as [keyof typeof BUNDLED, string][]) {
    const path = envPath(name, env);
    if (path && !exists(path)) warnings.push(`${name} のファイル（${JSON.stringify(path)}）がありません。${effect}（パスを確かめてください）`);
  }
  for (const warning of warnings) stderr(`${PREFIX} 警告: ${warning}`);
  if (errors.length === 0) return;
  for (const error of errors) stderr(`${PREFIX} エラー: ${error}`);
  stderr(`${PREFIX} 環境変数の誤りが ${errors.length} 件あるので、起動しません`);
  exit(1);
}
