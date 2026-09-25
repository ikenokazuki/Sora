// A/B比較の集計スクリプト（保存済み結果専用）
//
// 最終計画 §4.3 の指標を、保存済み run JSON から集計する。モデル呼び出しは含めない。
// 評価用アダプター（ライブ実行）は別途用意し、このスクリプトから呼ばない。
// 使い方:
//   bun scripts/eval-research.ts --selftest
//   bun scripts/eval-research.ts results/ab-*.json
//
// run JSON の形式:
// {
//   "caseId": "JP-finance-01", "arm": "A" | "B", "plan": "fixed" | "free",
//   "model": "muse-spark-1.3", "startedAt": "ISO", "endedAt": "ISO",
//   "requirements": [{ "id": "value", "supported": true, "evidenceIds": ["evd_.."],
//     "unattainable": false }],
//   "claimsChecked": 10, "claimsSupported": 9,
//   "primaryEvidence": 8, "primaryEvidenceFitting": 7,
//   "criticalErrors": 0,
//   "httpCalls": 12, "elapsedMs": 25000, "dbBytesDelta": 1024
// }
// - requirements[].supported: 根拠で支持された確認事項だけ true。欠落通知だけでは true にしない。
// - unattainable: 公開情報では解決不能と採点者が判断した場合 true（分母から黙って除外せず別掲）。
// - claimsChecked/claimsSupported: 根拠支持率の分子分母。検査は原文照合（自己採点のみ不可）。

type RequirementResult = {
  id: string;
  supported: boolean;
  evidenceIds?: string[];
  notes?: string;
  unattainable?: boolean;
};

type RunRecord = {
  caseId: string;
  arm: 'A' | 'B';
  plan: 'fixed' | 'free';
  model: string;
  startedAt: string;
  endedAt: string;
  requirements: RequirementResult[];
  claimsChecked: number;
  claimsSupported: number;
  primaryEvidence: number;
  primaryEvidenceFitting: number;
  criticalErrors: number;
  httpCalls?: number;
  elapsedMs?: number;
  dbBytesDelta?: number;
  notes?: string;
};

type Aggregate = {
  runs: number;
  reqSupported: number;
  reqTotal: number;
  reqUnattainable: number;
  claimsSupported: number;
  claimsChecked: number;
  evFitting: number;
  evTotal: number;
  criticalErrors: number;
};

function emptyAggregate(): Aggregate {
  return {
    runs: 0, reqSupported: 0, reqTotal: 0, reqUnattainable: 0,
    claimsSupported: 0, claimsChecked: 0, evFitting: 0, evTotal: 0, criticalErrors: 0,
  };
}

function addRun(agg: Aggregate, run: RunRecord): void {
  agg.runs += 1;
  for (const req of run.requirements) {
    if (req.unattainable) {
      agg.reqUnattainable += 1;
      continue;
    }
    agg.reqTotal += 1;
    if (req.supported) agg.reqSupported += 1;
  }
  agg.claimsChecked += run.claimsChecked;
  agg.claimsSupported += run.claimsSupported;
  agg.evTotal += run.primaryEvidence;
  agg.evFitting += run.primaryEvidenceFitting;
  agg.criticalErrors += run.criticalErrors;
}

function ratio(num: number, den: number): string {
  if (den === 0) return 'n/a (0/0)';
  return num + '/' + den + ' = ' + (num / den).toFixed(3);
}

function reportLine(label: string, agg: Aggregate): string {
  return [
    '## ' + label + '（' + agg.runs + ' runs）',
    '- 必須事項充足率: ' + ratio(agg.reqSupported, agg.reqTotal),
    '- 解決不能として別掲: ' + agg.reqUnattainable + ' 件',
    '- 根拠支持率: ' + ratio(agg.claimsSupported, agg.claimsChecked),
    '- 地域/問い適合率: ' + ratio(agg.evFitting, agg.evTotal),
    '- 重大な誤り: ' + agg.criticalErrors + ' 件',
  ].join('\n');
}

export function aggregateRuns(runs: RunRecord[]): string {
  const byArm: Record<string, Aggregate> = { A: emptyAggregate(), B: emptyAggregate() };
  const byCaseModel: Record<string, Aggregate> = {};
  for (const run of runs) {
    if (run.arm !== 'A' && run.arm !== 'B') throw new Error('unknown arm: ' + run.caseId);
    addRun(byArm[run.arm], run);
    const key = run.caseId + ' / ' + run.model + ' / ' + run.plan;
    byCaseModel[key] = byCaseModel[key] ?? emptyAggregate();
    addRun(byCaseModel[key], run);
  }
  const lines = [reportLine('A: 既存検索＋スキル', byArm.A), '', reportLine('B: A＋専用収集', byArm.B), ''];
  lines.push('## ケース×モデル×計画別');
  for (const key of Object.keys(byCaseModel).sort()) {
    const agg = byCaseModel[key];
    lines.push(
      '- ' + key + ': 充足 ' + ratio(agg.reqSupported, agg.reqTotal) +
      '、支持 ' + ratio(agg.claimsSupported, agg.claimsChecked) +
      '、重大誤り ' + agg.criticalErrors,
    );
  }
  lines.push('', '注意: 24件では精密な統計を主張しない。未達の閾値は理由と再試験を記録する。');
  return lines.join('\n');
}

function selftest(): void {
  const fixture: RunRecord[] = [
    {
      caseId: 'JP-finance-01', arm: 'A', plan: 'fixed', model: 'muse-spark-1.3',
      startedAt: '2026-09-24T00:00:00Z', endedAt: '2026-09-24T00:00:20Z',
      requirements: [
        { id: 'value', supported: true }, { id: 'change', supported: true },
        { id: 'time', supported: false }, { id: 'meaning', supported: true },
      ],
      claimsChecked: 4, claimsSupported: 3, primaryEvidence: 3, primaryEvidenceFitting: 3,
      criticalErrors: 0, httpCalls: 5, elapsedMs: 20000, dbBytesDelta: 0,
    },
    {
      caseId: 'JP-finance-01', arm: 'B', plan: 'fixed', model: 'muse-spark-1.3',
      startedAt: '2026-09-24T00:01:00Z', endedAt: '2026-09-24T00:01:25Z',
      requirements: [
        { id: 'value', supported: true }, { id: 'change', supported: true },
        { id: 'time', supported: true }, { id: 'meaning', supported: true },
      ],
      claimsChecked: 4, claimsSupported: 4, primaryEvidence: 4, primaryEvidenceFitting: 4,
      criticalErrors: 0, httpCalls: 9, elapsedMs: 25000, dbBytesDelta: 512,
    },
  ];
  const out = aggregateRuns(fixture);
  const expected = ['3/4 = 0.750', '4/4 = 1.000', '重大な誤り: 0'];
  for (const fragment of expected) {
    if (!out.includes(fragment)) throw new Error('selftest mismatch, missing: ' + fragment);
  }
  console.log(out);
  console.log('\nSELFTEST OK');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    selftest();
    return;
  }
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: bun scripts/eval-research.ts [--selftest] results/ab-*.json');
    process.exit(1);
  }
  const runs: RunRecord[] = [];
  for (const file of files) {
    const data = await Bun.file(file).json();
    if (Array.isArray(data)) runs.push(...(data as RunRecord[]));
    else runs.push(data as RunRecord);
  }
  console.log(aggregateRuns(runs));
}

await main();
