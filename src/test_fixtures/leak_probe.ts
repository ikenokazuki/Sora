/**
 * process_guard.test.ts の子プロセス。最上位で await しない（最上位の await の間は、Bun は受け止めない失敗で終了しないので、確かめにならない）。
 * 引数: guard | none、失敗の種類
 */
import { installUnhandledRejectionGuard } from '../process_guard.js';
import { getSecurityMetrics } from '../security/metrics.js';

const [guard, kind] = process.argv.slice(2);
if (guard === 'guard') installUnhandledRejectionGuard();

setTimeout(() => {
  // 確認のタイマーは、失敗を起こす回の中で登録する。2 つの期限が同じ回に重なると、Bun は受け止めない失敗を扱う前に、次のタイマーを動かす（実測）
  setTimeout(() => console.log(`alive ${getSecurityMetrics().sora_unhandled_rejection_total ?? 0}`), 500);
  if (kind === 'error') void Promise.reject(Object.assign(new Error('probe-leak'), { headers: { authorization: 'Bearer TOPSECRET' } }));
  if (kind === 'string') void Promise.reject('probe-string');
  if (kind === 'unprintable') void Promise.reject({ toString() { throw new Error('toString も失敗する'); } });
  if (kind === 'long') void Promise.reject(new Error(`probe-long ${'x'.repeat(100_000)}`));
  if (kind === 'sync-throw') throw new Error('probe-sync');
}, 20);
