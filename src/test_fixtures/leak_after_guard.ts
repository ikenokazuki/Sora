/**
 * 入口の配線の確認（process_guard.test.ts）で --preload に入れる。受け皿が付くのを待ってから、受け止めない失敗を 1 つ起こす。
 * 受け皿が付かなければ、何も起こさない（入口を終了させる失敗は起こさない）。出力は標準エラーだけ（stdio の標準出力は JSON-RPC の流れ）
 */
let tries = 0;
const wait = setInterval(() => {
  const listeners = process.listenerCount('unhandledRejection');
  if (listeners === 0 && ++tries < 200) return;
  clearInterval(wait);
  console.error(`probe: listeners=${listeners}`);
  if (listeners > 0) void Promise.reject(new Error('probe-entry-leak'));
}, 100);
