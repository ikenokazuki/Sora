/**
 * 起動時の検査（設計メモの「起動時の検査」）。呼ぶのは起動の処理だけ（index.ts の import.meta.main と stdio.ts の main()）。
 * 出力は標準エラーだけ（stdio では標準出力が MCP の JSON-RPC の流れ）。秘密の値は checkEnv が「設定済み、長さ N」にする。
 */
import { existsSync } from 'node:fs';
import { checkEnv, envPath, type Env } from './config.js';

/** 同梱の実行ファイルのパスと、ファイルが無いときに起きること。 */
const BUNDLED = {
  SORA_YAHOO_MCP_PATH: '代わりに既定の場所（/usr/local/bin・リポジトリの bin・PATH）を探します',
  SORA_RS_TRAFILATURA_PATH: '本文は Readability で取り出します',
} as const;

const PREFIX = '[Sora/Config]';

/** checkEnv の結果と、同梱の実行ファイルの有無を出す。警告は出して続け、エラーがあれば exit(1)。 */
export function checkStartupEnv({
  env = process.env,
  stderr = (line: string) => void process.stderr.write(`${line}\n`),
  exit = (code: number) => process.exit(code),
  exists = existsSync,
}: { env?: Env; stderr?: (line: string) => void; exit?: (code: number) => void; exists?: (path: string) => boolean } = {}): void {
  const { errors, warnings } = checkEnv(env);
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
