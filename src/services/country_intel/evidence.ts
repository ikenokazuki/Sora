import { createHash } from 'node:crypto';
import type { CountryEvidence, RegionIdentity } from './types.js';

export type EvidenceInput = Omit<CountryEvidence, 'id' | 'regionId' | 'retrievedAt' | 'contentHash'> & {
  content?: string;
};

export function canonicalizeEvidenceUrl(url: string): string {
  const canonical = new URL(url);
  const parameters = [...canonical.searchParams]
    .filter(([name]) => {
      const normalizedName = name.toLowerCase();
      return !normalizedName.startsWith('utm_') && normalizedName !== 'fbclid' && normalizedName !== 'gclid';
    })
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName < rightName ? -1 : leftName > rightName ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0);

  canonical.search = '';
  for (const [name, value] of parameters) canonical.searchParams.append(name, value);
  canonical.hash = '';
  return canonical.toString();
}

export function hashEvidenceContent(text: string): string {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export function normalizeEvidence(
  input: EvidenceInput,
  region: RegionIdentity,
  now: Date,
): CountryEvidence {
  const { content: inputContent, url, ...evidence } = input;
  const canonicalUrl = canonicalizeEvidenceUrl(url);
  const content = inputContent ?? input.excerpt;
  const contentHash = content === undefined ? undefined : hashEvidenceContent(content);
  const idMaterial = [region.id, canonicalUrl, input.publishedAt ?? '', contentHash ?? ''].join('\n');

  return {
    ...evidence,
    id: `evd_${createHash('sha256').update(idMaterial).digest('hex').slice(0, 20)}`,
    regionId: region.id,
    url: canonicalUrl,
    retrievedAt: now.toISOString(),
    contentHash,
  };
}

export function deduplicateEvidence(items: CountryEvidence[]): CountryEvidence[] {
  const urls = new Set<string>();
  const contentHashes = new Set<string>();

  return items.filter((item) => {
    const canonicalUrl = canonicalizeEvidenceUrl(item.url);
    if (urls.has(canonicalUrl) || (item.contentHash !== undefined && contentHashes.has(item.contentHash))) {
      return false;
    }

    urls.add(canonicalUrl);
    if (item.contentHash !== undefined) contentHashes.add(item.contentHash);
    return true;
  });
}
