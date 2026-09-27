// 公開SNS取得の再現プローブ。Cookie値・トークンは出力しない。
// 使い方: SORA_DB_PATH=:memory: bun run scripts/probe-social.ts [--live-session]
import { createSocialService } from '../src/services/social/index.js';
import { createProdMetaHttp, createProdWebSearch, createProdWeiboHttp, createProdSessionOpener } from '../src/services/social/transport.js';

const liveSession = process.argv.includes('--live-session');
const svc = createSocialService({
  weiboHttp: createProdWeiboHttp(),
  sessionOpener: liveSession ? createProdSessionOpener() : { openWeiboSession: async () => { throw new Error('session probe skipped (no --live-session)'); } },
  metaHttp: createProdMetaHttp(),
  webSearch: createProdWebSearch(),
});
const out: unknown[] = [];
const at = new Date().toISOString();
for (const url of ['https://m.weibo.cn/status/5337192269873720', 'https://www.threads.com/@threads/post/DWjTI0cgH5O/']) {
  try {
    const r = await svc.fetch({ url, commentLimit: 2 }, { signal: AbortSignal.timeout(30000), deadlineAt: Date.now() + 30000 });
    out.push({ at, kind: 'fetch', url, status: r.status, textChars: r.post?.text.length, publishedAt: r.post?.publishedAt, timeStatus: r.post?.timeStatus, failures: r.failures });
  } catch (e) {
    out.push({ at, kind: 'fetch', url, error: String(e).slice(0, 160) });
  }
}
if (liveSession) {
  try {
    const r = await svc.search({ platform: 'weibo', query: '中秋', limit: 5, lookbackHours: 24 }, { signal: AbortSignal.timeout(55000), deadlineAt: Date.now() + 55000 });
    out.push({ at, kind: 'search', status: r.status, items: r.items.map((p) => ({ id: p.id, publishedAt: p.publishedAt, author: p.author })), failures: r.failures });
  } catch (e) {
    out.push({ at, kind: 'search', error: String(e).slice(0, 160) });
  }
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
