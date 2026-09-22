import { createHash } from 'node:crypto';
import { canonicalPublisherDomain, canonicalizeEvidenceUrl } from './evidence.js';
import type { CountryEvidence, IntelEntity, IntelEvent, IntelTarget } from './types.js';
import type { IntelEventDraft } from './event_extract.js';

const WIRE_BYLINE = /^\s*(?:\(\s*(reuters|associated press|ap|afp)\s*\)(?:\s+|\s*[-–—,:])|(reuters|associated press|ap|afp)\s*[-–—,:])/iu;
const WIRE_DATELINE = /^(?:[A-Z][A-Z .'-]{1,60}|[A-Z][A-Za-z .'-]{1,60},\s*[A-Z][A-Za-z.]*\s+\d{1,2})\s*\(\s*(Reuters|REUTERS|reuters|Associated Press|ASSOCIATED PRESS|associated press|AP|ap|AFP|afp)\s*\)\s*[-–—,:]/u;
const WIRE_NAMES: Record<string, string> = {
  reuters: 'reuters',
  'associated press': 'ap',
  ap: 'ap',
  afp: 'afp',
};
const NEAR_TIME_MS = 72 * 60 * 60 * 1000;

function wireProvider(evidence: CountryEvidence): string | undefined {
  const publisher = evidence.publisher?.normalize('NFKC').trim().toLowerCase();
  if (publisher && WIRE_NAMES[publisher]) return WIRE_NAMES[publisher];
  const byline = [evidence.title, evidence.excerpt]
    .map((text) => text?.match(WIRE_BYLINE)?.[1] ?? text?.match(WIRE_BYLINE)?.[2] ?? text?.match(WIRE_DATELINE)?.[1])
    .map((provider) => provider?.toLowerCase())
    .find(Boolean);
  return byline ? WIRE_NAMES[byline] : undefined;
}

export function sourceFamily(evidence: CountryEvidence): string {
  const wire = wireProvider(evidence);
  if (wire) return `wire:${wire}`;
  if (evidence.contentHash) return `content:${evidence.contentHash}`;
  return `domain:${canonicalPublisherDomain(evidence.url) ?? `unknown:${evidence.id}`}`;
}

function titleTokens(title: string): Set<string> {
  const normalized = title.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length > 1) return new Set(words);
  const compact = words[0] ?? '';
  return new Set(Array.from({ length: Math.max(compact.length - 1, 0) }, (_, index) => compact.slice(index, index + 2)));
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared++;
  return shared / (leftTokens.size + rightTokens.size - shared);
}

function locationsCompatible(left: IntelEventDraft, right: IntelEventDraft): boolean {
  const leftLocation = left.location;
  const rightLocation = right.location;
  if (!leftLocation || !rightLocation) return true;
  if (leftLocation.countryCode && rightLocation.countryCode && leftLocation.countryCode !== rightLocation.countryCode) return false;
  if (leftLocation.name && rightLocation.name && leftLocation.name !== rightLocation.name) return false;
  return true;
}

function sameLocation(left: IntelEventDraft, right: IntelEventDraft): boolean {
  const leftLocation = left.location;
  const rightLocation = right.location;
  if (!leftLocation || !rightLocation || !locationsCompatible(left, right)) return false;
  return Boolean(
    (leftLocation.countryCode && leftLocation.countryCode === rightLocation.countryCode)
    || (leftLocation.name && leftLocation.name === rightLocation.name),
  );
}

function sameSpecificPlace(left: IntelEventDraft, right: IntelEventDraft): boolean {
  return Boolean(left.location?.name && left.location.name === right.location?.name);
}

function timestamp(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nearTime(left: IntelEventDraft, right: IntelEventDraft): boolean {
  const leftTime = timestamp(left.occurredAt);
  const rightTime = timestamp(right.occurredAt);
  return leftTime !== undefined && rightTime !== undefined && Math.abs(leftTime - rightTime) <= NEAR_TIME_MS;
}

function specificEntityKeys(draft: IntelEventDraft): Set<string> {
  return new Set(
    [...draft.actors, ...draft.targets]
      .flatMap((entity) => {
        if (entity.canonicalId) return [`id:${entity.canonicalId.normalize('NFKC').toLocaleLowerCase('en-US')}`];
        const name = entity.name.normalize('NFKC').toLocaleLowerCase('en-US');
        return !['country', 'people_nationality', 'unknown', 'none'].includes(entity.type ?? 'unknown')
          && !['activist', 'activists', 'foreign ministry', 'government', 'japanese government', 'japanese products', 'military', 'politician', 'police', 'protester', 'protesters'].includes(name)
          ? [`name:${name}`]
          : [];
      }),
  );
}

function hasSpecificEntityOverlap(left: IntelEventDraft, right: IntelEventDraft): boolean {
  const leftKeys = specificEntityKeys(left);
  return [...specificEntityKeys(right)].some((key) => leftKeys.has(key));
}

function shouldMerge(
  left: IntelEventDraft,
  right: IntelEventDraft,
  leftEvidence: CountryEvidence | undefined,
  rightEvidence: CountryEvidence | undefined,
): boolean {
  if (left.regionId !== right.regionId || left.type !== right.type || !locationsCompatible(left, right)) return false;
  const sameCanonicalUrl = Boolean(leftEvidence && rightEvidence
    && canonicalizeEvidenceUrl(leftEvidence.url) === canonicalizeEvidenceUrl(rightEvidence.url));
  const leftFamily = leftEvidence && sourceFamily(leftEvidence);
  const rightFamily = rightEvidence && sourceFamily(rightEvidence);
  const sameWireFamily = Boolean(leftFamily && leftFamily === rightFamily && leftFamily.startsWith('wire:'));
  const sameContentHash = Boolean(leftEvidence?.contentHash && leftEvidence.contentHash === rightEvidence?.contentHash);
  const strongSignals = [
    titleSimilarity(left.title, right.title) >= 0.72,
    sameCanonicalUrl,
    sameContentHash,
    hasSpecificEntityOverlap(left, right),
    sameSpecificPlace(left, right),
  ].filter(Boolean).length;
  const supportingSignals = [sameLocation(left, right), nearTime(left, right), sameWireFamily].filter(Boolean).length;
  return strongSignals > 0 && strongSignals + supportingSignals >= 2;
}

function uniqueByKey<T extends IntelEntity | IntelTarget>(items: T[]): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const key = [item.canonicalId, item.countryCode, item.type, item.name].join('\u0000');
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function normalizedBounds(values: string[]): { first?: string; last?: string } {
  const timestamps = values
    .map((value) => timestamp(value))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  return timestamps.length
    ? { first: new Date(timestamps[0]).toISOString(), last: new Date(timestamps.at(-1)!).toISOString() }
    : {};
}

function consensusLocation(drafts: IntelEventDraft[]): IntelEventDraft['location'] | undefined {
  const known = drafts.map((draft) => draft.location).filter((location): location is NonNullable<IntelEventDraft['location']> => Boolean(location));
  if (!known.length) return undefined;
  const candidate = known[0];
  if (known.some((location) => (
    (candidate.countryCode && location.countryCode && candidate.countryCode !== location.countryCode)
    || (candidate.name && location.name && candidate.name !== location.name)
  ))) return undefined;
  const countryCode = known.find((location) => location.countryCode)?.countryCode;
  const name = known.find((location) => location.name)?.name;
  return { ...(countryCode ? { countryCode } : {}), ...(name ? { name } : {}) };
}

function toEvent(cluster: IntelEventDraft[], evidenceById: Map<string, CountryEvidence>): IntelEvent {
  const drafts = [...cluster].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const evidence = drafts.map((draft) => evidenceById.get(draft.evidenceId)).filter((item): item is CountryEvidence => Boolean(item));
  const evidenceIds = drafts.map((draft) => draft.evidenceId);
  const occurred = normalizedBounds(drafts.map((draft) => draft.occurredAt).filter((value): value is string => Boolean(value)));
  const seen = normalizedBounds(drafts.flatMap((draft) => [draft.firstSeenAt, draft.lastSeenAt]));
  const sourceFamilies = new Set(evidence.map(sourceFamily));
  const title = drafts.map((draft) => draft.title).sort()[0];
  const excerpt = evidence.map((item) => item.excerpt?.normalize('NFKC').replace(/\s+/gu, ' ').trim()).find((itemText) => itemText)?.slice(0, 500);
  const confidence = sourceFamilies.size >= 2 ? 'high' : evidence.some((item) => item.primarySource) || drafts.length > 1 ? 'medium' : 'low';
  const idMaterial = [drafts[0].regionId, drafts[0].type, title, occurred.first ?? '', ...evidenceIds].join('\n');

  return {
    id: `evt_${createHash('sha256').update(idMaterial).digest('hex').slice(0, 20)}`,
    regionId: drafts[0].regionId,
    type: drafts[0].type,
    title,
    ...(excerpt ? { excerpt } : {}),
    occurredAt: occurred.first,
    location: consensusLocation(drafts),
    actors: uniqueByKey(drafts.flatMap((draft) => draft.actors)),
    targets: uniqueByKey(drafts.flatMap((draft) => draft.targets)),
    evidenceIds,
    evidenceCount: evidenceIds.length,
    independentSourceCount: sourceFamilies.size || evidenceIds.length,
    primarySourceCount: evidence.filter((item) => item.primarySource).length,
    firstSeenAt: seen.first ?? new Date(0).toISOString(),
    lastSeenAt: seen.last ?? new Date(0).toISOString(),
    confidence,
  };
}

export function clusterEvents(drafts: IntelEventDraft[], evidence: CountryEvidence[]): IntelEvent[] {
  const orderedDrafts = [...drafts].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const parents = orderedDrafts.map((_, index) => index);
  const find = (index: number): number => {
    if (parents[index] !== index) parents[index] = find(parents[index]);
    return parents[index];
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const componentsCompatible = (left: number, right: number): boolean => {
    const regions = new Set<string>();
    const countries = new Set<string>();
    const names = new Set<string>();
    for (const [index, draft] of orderedDrafts.entries()) {
      const root = find(index);
      if (root !== left && root !== right) continue;
      if (draft.regionId) regions.add(draft.regionId);
      if (draft.location?.countryCode) countries.add(draft.location.countryCode);
      if (draft.location?.name) names.add(draft.location.name);
    }
    return regions.size <= 1 && countries.size <= 1 && names.size <= 1;
  };

  for (let left = 0; left < orderedDrafts.length; left++) {
    for (let right = left + 1; right < orderedDrafts.length; right++) {
      if (shouldMerge(
        orderedDrafts[left], orderedDrafts[right],
        evidenceById.get(orderedDrafts[left].evidenceId), evidenceById.get(orderedDrafts[right].evidenceId),
      ) && componentsCompatible(find(left), find(right))) union(left, right);
    }
  }

  const clusters = new Map<number, IntelEventDraft[]>();
  for (const [index, draft] of orderedDrafts.entries()) {
    const root = find(index);
    const cluster = clusters.get(root);
    if (cluster) cluster.push(draft);
    else clusters.set(root, [draft]);
  }
  return [...clusters.values()].map((cluster) => toEvent(cluster, evidenceById)).sort((left, right) => left.id.localeCompare(right.id));
}
