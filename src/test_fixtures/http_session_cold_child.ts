// src/http_session_cold_start.test.ts が子プロセスで走らせる。
// 起動したばかり（wreq-js をまだ読み込んでいない）のプロセスで、別々のドメインの最初の取得を同時に出し、受けたセッションの種類を出力する。
import { getOrCreateHttpSession } from '../http_fetcher.js';

const sessions = await Promise.all(
  ['a', 'b', 'c', 'd'].map((name) => getOrCreateHttpSession(`cold-${name}.example`, 'chrome_142', undefined, 'tenantCold')),
);
console.log(`RESULT ${sessions.map((session) => session.constructor.name).join(',')}`);
process.exit(0);
