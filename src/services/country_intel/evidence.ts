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

const COUNTRY_SECOND_LEVEL_LABELS = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org', 'mil']);
const KNOWN_GENERIC_TLDS = new Set(['ai', 'app', 'biz', 'com', 'dev', 'edu', 'gov', 'info', 'int', 'io', 'mil', 'name', 'net', 'org', 'pro', 'test', 'xyz']);

export function canonicalPublisherDomain(url: string): string | undefined {
  try {
    const hostname = new URL(canonicalizeEvidenceUrl(url)).hostname.toLowerCase().replace(/^www\./u, '');
    const labels = hostname.split('.').filter(Boolean);
    if (labels.length < 3) return hostname || undefined;
    const topLevel = labels.at(-1)!;
    const secondLevel = labels.at(-2)!;
    if (topLevel.length === 2) {
      return COUNTRY_SECOND_LEVEL_LABELS.has(secondLevel) ? labels.slice(-3).join('.') : hostname;
    }
    return KNOWN_GENERIC_TLDS.has(topLevel) ? labels.slice(-2).join('.') : hostname;
  } catch {
    return undefined;
  }
}

export function hashEvidenceContent(text: string): string {
  const normalized = normalizeEvidenceContent(text) ?? '';
  return createHash('sha256').update(normalized).digest('hex');
}

function normalizeEvidenceContent(text: string | undefined): string | undefined {
  const normalized = text?.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized || undefined;
}

export function normalizeEvidence(
  input: EvidenceInput,
  region: RegionIdentity,
  now: Date,
): CountryEvidence {
  const { content: inputContent, url, ...evidence } = input;
  const canonicalUrl = canonicalizeEvidenceUrl(url);
  const content = normalizeEvidenceContent(inputContent) ?? normalizeEvidenceContent(input.excerpt);
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
  const parents = items.map((_, index) => index);
  const find = (index: number): number => {
    if (parents[index] !== index) parents[index] = find(parents[index]);
    return parents[index];
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const urls = new Map<string, number>();
  const contentHashes = new Map<string, number>();

  for (const [index, item] of items.entries()) {
    const canonicalUrl = canonicalizeEvidenceUrl(item.url);
    const matchingUrl = urls.get(canonicalUrl);
    if (matchingUrl !== undefined) union(matchingUrl, index);
    urls.set(canonicalUrl, index);

    if (item.contentHash !== undefined) {
      const contentKey = `${item.contentHash}\u0000${canonicalPublisherDomain(item.url) ?? 'unknown'}`;
      const matchingContent = contentHashes.get(contentKey);
      if (matchingContent !== undefined) union(matchingContent, index);
      contentHashes.set(contentKey, index);
    }
  }

  const firstByComponent = new Map<number, number>();
  for (const index of items.keys()) {
    const component = find(index);
    if (!firstByComponent.has(component)) firstByComponent.set(component, index);
  }

  return items.filter((_, index) => firstByComponent.get(find(index)) === index);
}
