// Report writers + secret redaction (Task 9).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseResult, HealthStatus } from './types.js';

export interface RunMeta {
  startedAt: string;
  finishedAt?: string;
  commit: string;
  image: string;
  imageId: string;
  lane: 'standard';
  runner: string;
  overall: 'pass' | 'fail';
}

export interface HealthReport {
  meta: RunMeta;
  results: CaseResult[];
  counts: Record<HealthStatus, number>;
  missing: string[];
}

const KNOWN_SECRETS: string[] = [];

export function registerSecrets(values: Array<string | undefined>): void {
  for (const v of values) {
    if (v && v.length >= 4 && !KNOWN_SECRETS.includes(v)) KNOWN_SECRETS.push(v);
  }
}

export function redact(text: string): string {
  let out = text;
  for (const s of KNOWN_SECRETS) out = out.split(s).join('[redacted]');
  return out;
}

/** 通らなかったケースを1行ずつ（ケース名・状態・理由）。CI のログだけで原因を読めるようにする。理由は秘密情報を伏せ、200文字まで。 */
export function nonPassLines(results: CaseResult[]): string[] {
  return results
    .filter((r) => r.status !== 'pass' && r.status !== 'pass_empty' && r.status !== 'not_applicable')
    .map((r) => `  ${r.caseId} ${r.status}: ${redact(r.reason).replace(/\s+/g, ' ').slice(0, 200)}`);
}

export function summarize(results: CaseResult[]): Record<HealthStatus, number> {
  const counts: Record<HealthStatus, number> = {
    pass: 0, pass_empty: 0, fail: 0, unavailable: 0, blocked: 0, unverified: 0, not_applicable: 0,
  };
  for (const r of results) counts[r.status] += 1;
  return counts;
}

/** これを超える割合のケースが unavailable なら、外部の偶然ではなくこちら側（候補イメージ）の問題とみなす。 */
export const MAX_UNAVAILABLE_RATIO = 0.25;

export function tooManyUnavailable(counts: Record<HealthStatus, number>): boolean {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return total > 0 && counts.unavailable / total > MAX_UNAVAILABLE_RATIO;
}

/** Publish-gate exit mapping. 0 = all green, 1 = hard fail, 3 = soft hold.
 * 公開を止める（1）のは、取得できたのに中身が壊れている（fail: 構造変化・解析失敗）か、確認できないツールがある
 * （missing）か、unavailable が多すぎる（こちら側の問題）ときだけ。外部の一時的な不調（unavailable）・ブロック
 * （blocked）・テストデータ未設定や静かな取得元（unverified）だけなら公開は進め（3）、レポートに残す。 */
export function gateExit(counts: Record<HealthStatus, number>, missing: string[]): 0 | 1 | 3 {
  if (isGatePass(counts, missing)) return 0;
  if (counts.fail === 0 && missing.length === 0 && !tooManyUnavailable(counts)) return 3;
  return 1;
}

export function isGatePass(counts: Record<HealthStatus, number>, missing: string[]): boolean {
  return counts.fail === 0 && counts.unavailable === 0 && counts.blocked === 0 && counts.unverified === 0 && missing.length === 0;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toJUnit(report: HealthReport): string {
  const cases = report.results.map((r) => {
    const ok = r.status === 'pass' || r.status === 'pass_empty' || r.status === 'not_applicable';
    const inner = ok ? '' : `<failure message="${escapeXml(r.status)}: ${escapeXml(r.reason.slice(0, 300))}"/>`;
    return `  <testcase classname="tool-health" name="${escapeXml(r.caseId)}" time="${(r.durationMs / 1000).toFixed(2)}">${inner}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="tool-health-${report.meta.lane}" tests="${report.results.length}" failures="${report.meta.overall === 'pass' ? 0 : 1}">\n${cases}\n</testsuite>\n`;
}

export function toMarkdown(report: HealthReport): string {
  const lines = [
    `# tool-health ${report.meta.lane} (${report.meta.overall})`,
    '',
    `- started: ${report.meta.startedAt}`,
    `- commit: ${report.meta.commit}`,
    `- image: ${report.meta.image} (${report.meta.imageId.slice(0, 12)})`,
    `- counts: ${Object.entries(report.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    `- missing: ${report.missing.length ? report.missing.join(', ') : 'none'}`,
    '',
    '| case | tools | status | reason |',
    '|---|---|---|---|',
  ];
  for (const r of report.results) {
    lines.push(`| ${r.caseId} | ${r.toolNames.join(',')} | ${r.status} | ${redact(r.reason).slice(0, 160).replace(/\|/g, '/')} |`);
  }
  return lines.join('\n') + '\n';
}

export function writeReports(outDir: string, report: HealthReport): { json: string; md: string; junit: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, `tool-health-${report.meta.lane}.json`);
  const md = join(outDir, `tool-health-${report.meta.lane}.md`);
  const junit = join(outDir, `tool-health-${report.meta.lane}.junit.xml`);
  const safe: HealthReport = JSON.parse(redact(JSON.stringify(report)));
  writeFileSync(json, JSON.stringify(safe, null, 2));
  writeFileSync(md, toMarkdown(safe));
  writeFileSync(junit, toJUnit(safe));
  return { json, md, junit };
}

// ---------- SORA_TOOL_HEALTH_CASES_JSON validation ----------
const ALLOWED_CASE_KEYS = new Set(['trackingNumber', 'url', 'query', 'expectedText', 'text', 'checkIn', 'checkOut']);

export interface ValidatedSecrets {
  cases: Record<string, Record<string, string>>;
}

export function validateCasesJson(raw: string | undefined, knownIds: Set<string>): ValidatedSecrets {
  if (!raw) return { cases: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SORA_TOOL_HEALTH_CASES_JSON is not valid JSON');
  }
  const record = parsed as { version?: unknown; cases?: unknown };
  if (record.version !== 1 || typeof record.cases !== 'object' || record.cases === null) {
    throw new Error('SORA_TOOL_HEALTH_CASES_JSON must be {version:1, cases:{...}}');
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [id, value] of Object.entries(record.cases as Record<string, unknown>)) {
    if (!knownIds.has(id)) throw new Error(`SORA_TOOL_HEALTH_CASES_JSON has unknown case id: ${id}`);
    if (typeof value !== 'object' || value === null) throw new Error(`case ${id} must be an object`);
    const fields: Record<string, string> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (!ALLOWED_CASE_KEYS.has(key)) throw new Error(`case ${id} has unknown key: ${key}`);
      if (typeof val !== 'string') throw new Error(`case ${id} key ${key} must be a string`);
      fields[key] = val;
    }
    out[id] = fields;
  }
  return { cases: out };
}

export function collectKnownCaseIds(toolCaseIds: string[]): Set<string> {
  const ids = new Set<string>();
  for (const id of toolCaseIds) {
    if (id.startsWith('track.')) ids.add(`tracking.${id.slice('track.'.length)}.positive`);
  }
  for (const platform of ['weibo', 'threads', 'instagram', 'facebook']) ids.add(`social.${platform}.post`);
  ids.add('x.post');
  return ids;
}
