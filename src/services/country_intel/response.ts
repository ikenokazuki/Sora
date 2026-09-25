import type { CountryContextReport, Fact } from './types.js';

/** 収集・保存は全件。通常応答だけ分野横断の代表証拠へ絞る。verbose=true は全件。 */
export function compactCountryReport(report: CountryContextReport): CountryContextReport {
  const evidenceById = new Map(report.evidence.map((item) => [item.id, item]));
  const detailsById = new Map((report.evidenceDetails ?? []).map((item) => [item.evidenceId, item]));
  const score = (fact: Fact): number => {
    const item = evidenceById.get(fact.evidenceIds[0]);
    const detail = detailsById.get(fact.evidenceIds[0]);
    const published = Date.parse(item?.publishedAt ?? '');
    return (detail?.contentKind === 'extracted_text' ? 1e15 : 0)
      + (item?.primarySource ? 1e14 : 0)
      + (Number.isFinite(published) ? published : 0);
  };
  const sample = (facts: readonly Fact[], limit: number, preferred: readonly string[] = []): Fact[] => {
    const groups = new Map<string, Fact[]>();
    const seen = new Set<string>();
    for (const fact of facts) {
      const id = fact.evidenceIds[0];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const group = groups.get(fact.topic) ?? [];
      group.push(fact);
      groups.set(fact.topic, group);
    }
    for (const group of groups.values()) group.sort((a, b) => score(b) - score(a));
    const selected: Fact[] = [];
    const ordered = [...groups.entries()]
      .sort(([a], [b]) => (preferred.includes(a) ? preferred.indexOf(a) : preferred.length)
        - (preferred.includes(b) ? preferred.indexOf(b) : preferred.length))
      .map(([, group]) => group);
    const focused = [...groups.entries()].filter(([topic]) => preferred.includes(topic)).map(([, group]) => group);
    const take = (from: Fact[][], target: number) => {
      while (selected.length < target && from.some((group) => group.length > 0)) {
        for (const group of from) {
          const next = group.shift();
          if (next) selected.push(next);
          if (selected.length >= target) break;
        }
      }
    };
    if (focused.length > 0) take(focused, limit);
    take(ordered, limit);
    return selected;
  };
  const preferredByDomain: Record<string, readonly string[]> = {
    content: ['politics', 'disasters', 'health', 'social_observations'],
    marketing: ['economy', 'tourism', 'health', 'social_observations'],
    finance: ['economy'],
    tourism: ['tourism', 'disasters', 'health'],
    travel: ['tourism', 'disasters', 'health'],
  };
  const domainContext = report.domainContext ? Object.fromEntries(
    Object.entries(report.domainContext).map(([name, domain]) => [name, domain ? {
      ...domain,
      factors: sample(domain.factors, name === 'general' ? 24 : 8, preferredByDomain[name]),
      ...(domain.candidateFactors ? { candidateFactors: sample(domain.candidateFactors, 6) } : {}),
    } : domain]),
  ) as CountryContextReport['domainContext'] : undefined;

  const required = new Set<string>();
  const collectRefs = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collectRefs); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'evidenceId' && typeof child === 'string') required.add(child);
      else if (key === 'evidenceIds' && Array.isArray(child)) child.forEach((id) => { if (typeof id === 'string') required.add(id); });
      else collectRefs(child);
    }
  };
  for (const [key, value] of Object.entries(report)) {
    if (key !== 'evidence' && key !== 'evidenceDetails' && key !== 'domainContext') collectRefs(value);
  }
  collectRefs(domainContext);
  const socialCounts = new Map<string, number>();
  for (const item of report.evidence
    .filter((item) => item.sourceType === 'social' && item.regionLink !== 'unrelated' && !required.has(item.id))
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))) {
    if ([...socialCounts.values()].reduce((sum, count) => sum + count, 0) >= 12) break;
    const provider = item.acquisition?.providerId ?? 'unknown';
    const count = socialCounts.get(provider) ?? 0;
    if (count >= 10) continue;
    socialCounts.set(provider, count + 1);
    required.add(item.id);
  }
  const evidence = report.evidence.filter((item) => required.has(item.id)).map((item) => ({
    ...item,
    ...(item.excerpt && item.excerpt.length > 400 ? { excerpt: item.excerpt.slice(0, 400) } : {}),
  }));
  const selectedDetails = (report.evidenceDetails ?? [])
    .filter((detail) => required.has(detail.evidenceId))
    .sort((a, b) => Number(b.contentKind === 'extracted_text') - Number(a.contentKind === 'extracted_text'))
    .slice(0, 40)
    .map((detail) => {
      if (detail.contentKind !== 'extracted_text') return detail;
      let remaining = 4000;
      const blocks = detail.blocks.flatMap((block) => {
        if (remaining <= 0) return [];
        const text = block.text.slice(0, remaining);
        remaining -= text.length;
        return [{ ...block, text }];
      });
      const shortened = detail.blocks.reduce((sum, block) => sum + block.text.length, 0) > 4000;
      return { ...detail, blocks, contentTruncated: detail.contentTruncated || shortened };
    });
  const sampled = evidence.length < report.evidence.length
    || selectedDetails.length < (report.evidenceDetails?.length ?? 0)
    || report.evidence.some((item) => (item.excerpt?.length ?? 0) > 400)
    || selectedDetails.some((detail) => (detailsById.get(detail.evidenceId)?.blocks.reduce((sum, block) => sum + block.text.length, 0) ?? 0) > 4000)
    || Object.entries(report.domainContext ?? {}).some(([name, domain]) => {
      const selected = domainContext?.[name as keyof NonNullable<typeof domainContext>];
      return (selected?.factors.length ?? 0) < (domain?.factors.length ?? 0);
    });
  if (!sampled) return report;
  return {
    ...report,
    evidence,
    evidenceDetails: selectedDetails,
    ...(domainContext ? { domainContext } : {}),
    ...(report.enrichment ? { enrichment: { ...report.enrichment, omittedDetails: report.enrichment.omittedDetails + (report.evidenceDetails?.length ?? 0) - selectedDetails.length } } : {}),
    limitations: [...(report.limitations ?? []), {
      code: 'response_sampled', area: 'general',
      message: `Initial response shows ${evidence.length}/${report.evidence.length} evidence records and ${selectedDetails.length}/${report.evidenceDetails?.length ?? 0} details. Full context: get_country_context or GET /intelligence/context/${report.contextId}; details: get_country_context_evidence or GET /intelligence/context/${report.contextId}/evidence.`,
      evidenceIds: [],
    }],
  };
}
