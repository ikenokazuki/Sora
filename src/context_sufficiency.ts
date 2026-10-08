import { extractQueryRequirements } from './retrieval/requirements.js';
import { computeEvidenceCoverage, entityTermsForQuery, kindsForFacet } from './retrieval/answerability.js';

export interface ContextSufficiency {
  level: 'no_gap_detected' | 'partial' | 'insufficient';
  reasons: string[];
}

/**
 * 応答に付ける「根拠は足りているか」の信号。応答内容は変えず、判断は上位エージェントに任せる。
 *
 * 既存の部品を束ねている。要件語は verbose 診断（searchDiagnostics.webRequirements）と同じ extractQueryRequirements の
 * entity+intent 語。証拠は各ページの ρSelect 選抜（highlights。無ければ本文）と X の投稿本文、判定は ρSelect v2 診断と同じ
 * computeEvidenceCoverage（要件ごとの言及・回答値の有無）。取得失敗・スニペット代替・締切超過のページは証拠に数えない。
 * ρSelect の要件選択（tokenizeAndSelectTerms）は語数超過時にコーパス内の出現で選別し、どのページにも無い語を落とすため、
 * 欠落の検出には使わない。
 * 語彙ベースの検出なので、partial/insufficient は不足の根拠になるが、no_gap_detected は十分の保証ではない。
 */
export function summarizeContextSufficiency(webItems: any[], realtimeItems: any[], query: string): ContextSufficiency {
  const attempted = webItems ?? [];
  const pages = attempted.filter((it) => it && !it.scrapeError && !it.isSnippetFallback && (it.markdown || it.highlights?.length));
  const posts: string[] = (realtimeItems ?? []).map((it) => it?.text).filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  if (pages.length === 0 && posts.length === 0) return { level: 'insufficient', reasons: ['no-usable-content'] };

  const reasons: string[] = [];
  if (pages.length < Math.min(3, attempted.length)) reasons.push('few-success');

  try {
    const { entityTerms, intentTerms } = extractQueryRequirements(query);
    const requirements = [...new Set([...entityTerms, ...intentTerms])];
    if (requirements.length > 0) {
      const evidence = [...pages.flatMap((p) => (p.highlights?.length ? p.highlights : [p.markdown])), ...posts];
      const coverage = computeEvidenceCoverage(evidence, entityTermsForQuery(query), requirements);
      const unmentioned = requirements.filter((r) => !coverage.coveredRequirements.includes(r));
      // 回答値（時刻・金額・日付など）を求める語だけ、値の有無を判定する
      const valueSeeking = requirements.filter((r) => (kindsForFacet(r) ?? []).length > 0);
      const unanswered = valueSeeking.filter((r) => !coverage.answeredRequirements.includes(r));
      if (unmentioned.length > 0) reasons.push(`unmentioned:${unmentioned.join(',')}`);
      if (unanswered.length > 0) reasons.push(`unanswered:${unanswered.join(',')}`);
    }
  } catch {
    // 判定に失敗しても不足扱いにしない
  }
  return { level: reasons.length === 0 ? 'no_gap_detected' : 'partial', reasons };
}
