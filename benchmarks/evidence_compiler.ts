/**
 * Sora Evidence Compiler Phase 1 — Benchmark Runner
 *
 * Runs end-to-end evaluation for:
 * 1. Arm A vs Arm B vs Arm C (Accuracy × Token Efficiency × Latency × Memory)
 * 2. Document size scaling (small 2KB, medium 20KB, large 100KB, xlarge 500KB)
 * 3. Response Projection benchmark (P0, P1, P2, P3) & Realtime/X size contribution
 * 4. Outputs structured research tables and answers to the 5 core research questions.
 */

import {
  getAllBenchmarkTestCases,
  generateSyntheticMarkdown,
  type BenchmarkTestCase,
} from '../src/research/evidence_benchmark_fixtures.js';
import {
  evaluateTestCaseUnderArm,
  aggregateArmMetrics,
  type AtomArm,
  type ArmSummaryMetrics,
} from '../src/research/evidence_evaluator.js';
import {
  projectIntegratedSearchResponseV2,
  type ProjectionVariant,
} from '../src/research/evidence_projection_v2.js';

// -----------------------------------------------------------------------------
// Sample Integrated Search Response for Projection Benchmarking
// Models actual Sora production multi-source responses (web + X/realtime)
// -----------------------------------------------------------------------------

function createSampleIntegratedSearchResponse(): Record<string, any> {
  const webMarkdown = `# ソライロ コール表 詳細解説

君と見るそらの代表曲「ソライロ」のライブコール一覧です。
会場全体で一体となるコール＆レスポンスが特徴です。

## イントロコール
澄み渡る空へと手を伸ばした瞬間に、超絶可愛い！優花！のコールが入ります。

## サビ
ソライロの風に乗ってどこまでも飛べるよ (イエッタイガー！)

## 特記事項
声出し可能公演でのみ適用されます。ルールを守って応援しましょう。
`.repeat(10); // expand to realistic size

  const webItem = {
    title: '君と見るそら 楽曲コール表・ライブ情報まとめ',
    url: 'https://example.com/kimi-sora/call-guide',
    link: 'https://example.com/kimi-sora/call-guide',
    source: 'web',
    markdown: webMarkdown,
    description: '君と見るそらの代表曲「ソライロ」のライブコール一覧です。会場全体で一体となるコール＆レスポンスが特徴です。',
    snippet: '君と見るそらの代表曲「ソライロ」のライブコール一覧です。会場全体で一体となるコール＆レスポンスが特徴です。',
    highlights: [
      '## イントロコール\n\n澄み渡る空へと手を伸ばした瞬間に、超絶可愛い！優花！のコールが入ります。',
      '## サビ\n\nソライロの風に乗ってどこまでも飛べるよ (イエッタイガー！)',
    ],
    textFragmentUrl: 'https://example.com/kimi-sora/call-guide#:~:text=澄み渡る空へと-,超絶可愛い！優花！',
    ogImage: 'https://example.com/assets/og-image-solairo-large-banner.jpg',
    site: '君と見るそらファンポータル',
    pageType: 'article',
    twitterHandle: '@kimi_sora_fan',
    socialLinks: ['https://x.com/kimi_sora_fan', 'https://instagram.com/kimi_sora'],
    author: 'そらサポ編集部',
    publishedTime: '2025-06-01T10:00:00Z',
  };

  const xItem = {
    title: '君と見るそら公式 on X: "【ソライロ コール動画公開】"',
    url: 'https://x.com/kimi_sora_official/status/1789012345678901234',
    link: 'https://x.com/kimi_sora_official/status/1789012345678901234',
    source: 'x',
    author: '君と見るそら公式',
    author_name: '君と見るそら公式',
    author_handle: '@kimi_sora_official',
    author_url: 'https://x.com/kimi_sora_official',
    created_at: '2025-05-30T18:00:00Z',
    publishedTime: '2025-05-30T18:00:00Z',
    siteName: 'X (formerly Twitter)',
    markdown: '【ソライロ コール動画公開】本日の山中湖SPARKでも大盛り上がりだった「ソライロ」の公式コール動画です！ぜひ覚えてライブで一緒に叫びましょう！ #君と見るそら #ソライロ',
    snippet: '【ソライロ コール動画公開】本日の山中湖SPARKでも大盛り上がりだった「ソライロ」の公式コール動画です！',
    highlights: [
      '【ソライロ コール動画公開】本日の山中湖SPARKでも大盛り上がりだった「ソライロ」の公式コール動画です！ぜひ覚えてライブで一緒に叫びましょう！',
    ],
    engagement: {
      likes: 1240,
      retweets: 380,
      replies: 45,
    },
    media: [
      { type: 'video', url: 'https://video.twimg.com/ext_tw_video/17890123456/pu/vid/1280x720/sample.mp4' },
    ],
  };

  return {
    query: '君と見るそら ソライロ コール',
    responseMode: 'full',
    results: [webItem, xItem],
    realtime: [xItem],
    diagnostics: {
      engine: 'integrated-search-host',
      totalResults: 2,
    },
  };
}

// -----------------------------------------------------------------------------
// Benchmark Runner
// -----------------------------------------------------------------------------

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('⚡ Sora Evidence Compiler Phase 1 — Benchmark Suite');
  console.log('='.repeat(80));

  const allFixtures = getAllBenchmarkTestCases();
  console.log(`Loaded ${allFixtures.length} corpus test cases (Precision, Structural, Adversarial).`);

  const arms: AtomArm[] = ['ArmA', 'ArmB', 'ArmC'];
  const armSummaries: Record<AtomArm, ArmSummaryMetrics> = {} as any;

  const WARMUP_ROUNDS = 20;
  const MEASURED_ROUNDS = 100;

  for (const arm of arms) {
    console.log(`\nEvaluating ${arm}...`);

    // 1. Warmup
    for (let w = 0; w < WARMUP_ROUNDS; w++) {
      for (const tc of allFixtures) {
        evaluateTestCaseUnderArm(tc, arm);
      }
    }

    // 2. Measure quality and baseline execution
    const executionResults = allFixtures.map((tc) => evaluateTestCaseUnderArm(tc, arm));

    // 3. Measure repeated latencies for median/p95
    const latencies: number[] = [];
    for (let m = 0; m < MEASURED_ROUNDS; m++) {
      // Pick first test case from each category to form representative loop
      const tc = allFixtures[m % allFixtures.length];
      const start = performance.now();
      evaluateTestCaseUnderArm(tc, arm);
      latencies.push(performance.now() - start);
    }

    armSummaries[arm] = aggregateArmMetrics(executionResults, latencies);
  }

  // ---------------------------------------------------------------------------
  // Document Size Scaling (Small, Medium, Large, XLarge)
  // ---------------------------------------------------------------------------
  console.log('\nMeasuring Synthetic Document Size Scaling...');
  const sizeConfigs = [
    { label: 'Small (~2 KB)', bytes: 2 * 1024 },
    { label: 'Medium (~20 KB)', bytes: 20 * 1024 },
    { label: 'Large (~100 KB)', bytes: 100 * 1024 },
    { label: 'XLarge (~500 KB)', bytes: 500 * 1024 },
  ];

  interface SizeScalingRow {
    sizeLabel: string;
    arm: AtomArm;
    candidateCount: number;
    atomizeMs: number;
    rhoSelectMs: number;
    totalMs: number;
    heapDeltaKb: number;
  }

  const scalingRows: SizeScalingRow[] = [];

  for (const cfg of sizeConfigs) {
    const synth = generateSyntheticMarkdown(cfg.bytes);
    const tc: BenchmarkTestCase = {
      id: `synthetic-${cfg.bytes}`,
      category: 'synthetic',
      title: `Synthetic ${cfg.label}`,
      query: synth.targetQuery,
      markdown: synth.markdown,
      requiredKeywords: [synth.targetAnswer],
    };

    for (const arm of arms) {
      // 5 warmup rounds
      for (let i = 0; i < 5; i++) {
        evaluateTestCaseUnderArm(tc, arm);
      }
      // 10 measured rounds
      const iters: number[] = [];
      let lastRes: any;
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        lastRes = evaluateTestCaseUnderArm(tc, arm);
        iters.push(performance.now() - start);
      }
      iters.sort((a, b) => a - b);
      const median = iters[Math.floor(iters.length * 0.5)];

      scalingRows.push({
        sizeLabel: cfg.label,
        arm,
        candidateCount: lastRes.candidateCount,
        atomizeMs: Number(lastRes.atomizeMs.toFixed(3)),
        rhoSelectMs: Number(lastRes.rhoSelectMs.toFixed(3)),
        totalMs: Number(median.toFixed(3)),
        heapDeltaKb: Math.round(lastRes.heapUsedDelta / 1024),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Response Projection Benchmark (P0, P1, P2, P3)
  // ---------------------------------------------------------------------------
  console.log('\nMeasuring Response Projection (P0 vs P1 vs P2 vs P3)...');
  const sampleResponse = createSampleIntegratedSearchResponse();
  const variants: ProjectionVariant[] = ['P0', 'P1', 'P2', 'P3'];
  const projectionResults: Record<ProjectionVariant, { chars: number; bytes: number; reduction: string }> = {} as any;

  const p0Json = JSON.stringify(sampleResponse);
  const p0Chars = p0Json.length;
  const p0Bytes = Buffer.byteLength(p0Json, 'utf8');

  for (const variant of variants) {
    const projected = projectIntegratedSearchResponseV2(sampleResponse, variant);
    const jsonStr = JSON.stringify(projected);
    const chars = jsonStr.length;
    const bytes = Buffer.byteLength(jsonStr, 'utf8');
    const reduction = variant === 'P0' ? '0.0%' : `${(((p0Bytes - bytes) / p0Bytes) * 100).toFixed(1)}%`;

    projectionResults[variant] = { chars, bytes, reduction };
  }

  // Measure realtime / X size contribution
  const webOnly = { ...sampleResponse, realtime: [], results: [sampleResponse.results[0]] };
  const xOnly = { ...sampleResponse, results: [sampleResponse.results[1]] };
  const webBytes = Buffer.byteLength(JSON.stringify(webOnly), 'utf8');
  const xBytes = Buffer.byteLength(JSON.stringify(xOnly), 'utf8');
  const realtimeContribution = `${(((xBytes) / (webBytes + xBytes)) * 100).toFixed(1)}%`;

  // ---------------------------------------------------------------------------
  // Print Benchmark Markdown Report
  // ---------------------------------------------------------------------------
  console.log('\n' + '='.repeat(80));
  console.log('📊 BENCHMARK RESULTS (Markdown Format)');
  console.log('='.repeat(80) + '\n');

  console.log('### 1. Evidence Atomizer Comparison Table\n');
  console.log('| Arm | Quality Recall | Distractor Inclusion | Structural Closure | Selected Chars/Tokens | Candidate Count | Median ms | p95 ms | Memory delta |');
  console.log('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');

  for (const arm of arms) {
    const s = armSummaries[arm];
    const recallPct = `${(s.requiredEvidenceRecallRate * 100).toFixed(1)}%`;
    const distractorPct = `${(s.distractorInclusionRate * 100).toFixed(1)}%`;
    const closurePct = `${(s.structuralClosureRate * 100).toFixed(1)}%`;
    const charsTokens = `${s.avgSelectedChars} / ~${s.avgSelectedTokens} tok`;
    const cands = `${s.avgCandidateCount} (sel ${s.avgSelectedCount})`;
    const mem = `${Math.round(s.avgHeapDeltaBytes / 1024)} KB`;

    console.log(`| **${arm}** | ${recallPct} | ${distractorPct} | ${closurePct} | ${charsTokens} | ${cands} | ${s.medianMs} ms | ${s.p95Ms} ms | ${mem} |`);
  }

  console.log('\n### 2. Document Size Scaling (Synthetic Corpus)\n');
  console.log('| Document Size | Arm | Candidates | Atomize ms | ρSelect Solver ms | Total Median ms | Heap Delta |');
  console.log('| :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const row of scalingRows) {
    console.log(`| ${row.sizeLabel} | ${row.arm} | ${row.candidateCount} | ${row.atomizeMs} ms | ${row.rhoSelectMs} ms | ${row.totalMs} ms | ${row.heapDeltaKb} KB |`);
  }

  console.log('\n### 3. Response Projection Benchmark\n');
  console.log('| Projection Variant | Characters | UTF-8 Bytes | Token / Byte Reduction vs P0 |');
  console.log('| :--- | :--- | :--- | :--- |');
  for (const v of variants) {
    const p = projectionResults[v];
    console.log(`| **${v}** | ${p.chars.toLocaleString()} chars | ${p.bytes.toLocaleString()} bytes | ${p.reduction} |`);
  }
  console.log(`\n> **X / Realtime Size Contribution**: Entire response payload contains approx **${realtimeContribution}** X / Realtime objects.`);

  console.log('\n' + '='.repeat(80));
  console.log('🏁 Benchmark execution complete.');
  console.log('='.repeat(80));
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
