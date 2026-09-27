/** 手動ライブ検証: 新JSON providerと旧MCPバイナリの比較測定。
 * 通常の bun test からは実行しない: `bun scripts/verify-yahoo-realtime.ts`
 * 実測ID・件数は索引変動のため固定期待値にしない。
 */
import { callYahooMcp, searchYahooRealtime } from '../src/services/yahoo';
import { searchYahooRealtimePage } from '../src/services/yahoo_realtime_api';

const TARGET = '2101660418129494169';
const QUERIES = [
  'SPARK id:kimisora_JPN',
  '君と見るそら ライブ 出演 id:kimisora_JPN',
  '(SPARK ライブ) id:kimisora_JPN',
  'SPARK -出演辞退 id:kimisora_JPN',
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(label: string, fn: () => Promise<{ ids: string[] }>): Promise<void> {
  await fn().catch(() => ({ ids: [] as string[] }));
  const samples: Array<{ ms: number; count: number; target: boolean }> = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    try {
      const res = await fn();
      samples.push({
        ms: performance.now() - start,
        count: res.ids.length,
        target: res.ids.includes(TARGET),
      });
    } catch (err: any) {
      samples.push({ ms: performance.now() - start, count: -1, target: false });
      console.log(JSON.stringify({ label, attempt: i + 1, error: err?.message || String(err) }));
    }
  }
  console.log(JSON.stringify({
    label,
    medianMs: Math.round(median(samples.map((s) => s.ms)) * 10) / 10,
    maxMs: Math.round(Math.max(...samples.map((s) => s.ms)) * 10) / 10,
    counts: samples.map((s) => s.count),
    targetHits: samples.filter((s) => s.target).length,
  }));
}

const query = process.argv[2] || 'all';
const selected = query === 'all' ? QUERIES : [query];
for (const q of selected) {
  const opts = { query: q, sort: 'recent' as const, limit: 40, page: 1 as const };
  await measure(`new-provider:${q}`, async () => ({
    ids: (await searchYahooRealtimePage(opts)).items.map((i) => i.id),
  }));
  await measure(`old-mcp:${q}`, async () => {
    const res = await callYahooMcp('yahoo_realtime_search', { query: q, sort: 'recent', limit: 40 });
    const parsed = JSON.parse(res.content[0].text);
    const items = Array.isArray(parsed) ? parsed : parsed.items || [];
    return { ids: items.map((i: any) => String(i.id)) };
  });
  await measure(`new-sora:${q}`, async () => ({
    ids: (await searchYahooRealtime({ query: q, limit: 40, noCache: true } as any)).items.map((i: any) => String(i.id)),
  }));
}
