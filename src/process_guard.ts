import { incrementSecurityCounter } from './security/metrics.js';

/** ログに書く失敗の文の長さの上限 */
const MAX_LOGGED_CHARS = 4000;

/**
 * 受け止められなかった失敗（unhandled rejection）の受け皿。Bun の既定は、1 件でプロセスを終了するので、1 つの呼び出しの受け止め忘れで、全員のサーバーが止まる。
 * 記録して、数え上げて（sora_unhandled_rejection_total）、動き続ける。受け止め忘れは不具合なので、ログと数え上げで見つけて直す。
 * 同期の例外（uncaughtException）は受けない。状態が壊れているおそれがある（Node.js の文書も、再開は安全でないとしている）ので、これまでどおり終了し、再起動は実行環境に任せる
 */
export function installUnhandledRejectionGuard(): void {
  process.on('unhandledRejection', (reason) => {
    try {
      incrementSecurityCounter('sora_unhandled_rejection_total');
      // 名前・文・呼び出し元だけを書く。失敗をそのまま書くと、失敗の持つ値（要求のヘッダーなど。呼んだ人の資格情報のことがある）も出る
      const text = reason instanceof Error ? (reason.stack ?? `${reason.name}: ${reason.message}`) : String(reason);
      console.error(`[Sora] 受け止められなかった失敗（不具合です。サーバーは動き続けます）: ${text.slice(0, MAX_LOGGED_CHARS)}`);
    } catch {
      // 失敗を文字にできないときも、受け皿からは何も投げない
    }
  });
}
