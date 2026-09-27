import { extractQueryHighlightsRhoV2 } from '../src/rho_select_v2_adapter.js';
function chrN(): string { return String.fromCharCode(10); }
function buildDoc(blocks: number): string {
  const parts: string[] = [];
  for (let i = 0; i < blocks; i++) {
    parts.push('# S' + i);
    parts.push('');
    parts.push('価格について解説します。参考情報その' + i + '。仕様の詳細は下記の通りです。');
    parts.push('');
  }
  parts.push('# 回答');
  parts.push('');
  parts.push('Astra Phone Xの価格は159,800円です。重量は199gです。');
  parts.push('');
  return parts.join(chrN());
}
function pct(values: number[], p: number): number {
  const a = values.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.floor((p / 100) * a.length));
  return a[i];
}
async function bench(blocks: number, runs: number, adaptive: boolean): Promise<void> {
  const doc = buildDoc(blocks);
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    extractQueryHighlightsRhoV2(doc, 'Astra Phone X 価格', { requirements: ['価格'], adaptiveCandidate: adaptive });
    times.push(performance.now() - t0);
  }
  times.shift();
  const med = pct(times, 50);
  const p95 = pct(times, 95);
  console.log('blocks=' + blocks + ' adaptive=' + adaptive + ' n=' + times.length + ' median=' + med.toFixed(2) + 'ms p95=' + p95.toFixed(2) + 'ms');
}
const sizes = [100, 200, 500, 800];
for (const s of sizes) {
  await bench(s, 21, true);
}
await bench(800, 21, false);
