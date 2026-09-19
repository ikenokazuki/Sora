import { createHash } from 'node:crypto';
import { canonicalizeEvidenceUrl } from './evidence.js';
import type { IntelEvent, IntelEntity, IntelTarget } from './types.js';
import type { CountryEvidence } from './types.js';
import type { IntelEventDraft } from './event_extract.js';

const WIRE_PROVIDER = /^(?:\s*[\[(])?\s*(reuters|associated press|ap|afp)\s*(?:[\])]|[-,:])/iu;
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
    .find((text) => text && WIRE_PROVIDER.test(text))
    ?.match(WIRE_PROVIDER)?.[1]?.toLowerCase();
  return byline ? WIRE_NAMES[byline] : undefined;
}

export function sourceFamily(evidence: CountryEvidence): string {
  const wire = wireProvider(evidence);
  if (wire) return `wire:${wire}`;
  if (evidence.contentHash) return `content:${evidence.contentHash}`;

  try {
    return `domain:${new URL(canonicalizeEvidenceUrl(evidence.url)).hostname.toLowerCase().replace(/^www\./u, '')}`;
  } catch {
    return `unknown:${evidence.id}`;
  }
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

function entityKeys(draft: IntelEventDraft): Set<string> {
  return new Set(
    [...draft.actors, ...draft.targets]
      .flatMap((entity) => [entity.canonicalId, entity.countryCode, entity.name])
      .filter((value): value is string => Boolean(value))
      .map((value) => value.normalize('NFKC').toLocaleLowerCase('en-US')),
  );
}

function hasEntityOverlap(left: IntelEventDraft, right: IntelEventDraft): boolean {
  const leftKeys = entityKeys(left);
  return [...entityKeys(right)].some((key) => leftKeys.has(key));
}

function sameLocation(left: IntelEventDraft, right: IntelEventDraft): boolean {
  const leftLocation = left.location;
  const rightLocation = right.location;
  if (!leftLocation || !rightLocation) return false;
  return Boolean(
    (leftLocation.countryCode && leftLocation.countryCode === rightLocation.countryCode)
    || (leftLocation.name && leftLocation.name === rightLocation.name),
  );
}

function nearTime(left: IntelEventDraft, right: IntelEventDraft): boolean {
  if (!left.occurredAt || !right.occurredAt) return false;
  const difference = Math.abs(Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  return Number.isFinite(difference) && difference <= NEAR_TIME_MS;
}

function shouldMerge(
  left: IntelEventDraft,
  right: IntelEventDraft,
  leftEvidence: CountryEvidence | undefined,
  rightEvidence: CountryEvidence | undefined,
): boolean {
  if (left.type !== right.type) return false;
  const sameCanonicalUrl = Boolean(leftEvidence && rightEvidence
    && canonicalizeEvidenceUrl(leftEvidence.url) === canonicalizeEvidenceUrl(rightEvidence.url));
  const leftFamily = leftEvidence && sourceFamily(leftEvidence);
  const rightFamily = rightEvidence && sourceFamily(rightEvidence);
  const sameWireFamily = Boolean(leftFamily && leftFamily === rightFamily && leftFamily.startsWith('wire:'));
  const sameCanonicalOrWireFamily = Boolean(leftEvidence && rightEvidence
    && (sameCanonicalUrl || sameWireFamily));
  const sameContentHash = Boolean(leftEvidence?.contentHash && leftEvidence.contentHash === rightEvidence?.contentHash);
  const matches = [
    hasEntityOverlap(left, right),
    sameLocation(left, right),
    nearTime(left, right),
    titleSimilarity(left.title, right.title) >= 0.72,
    sameCanonicalOrWireFamily,
    sameContentHash,
  ].filter(Boolean).length;
  return matches >= 2;
}

function uniqueByKey<T extends IntelEntity | IntelTarget>(items: T[]): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const key = [item.canonicalId, item.countryCode, item.type, item.name].join('\u0000');
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function earliest(values: string[]): string {
  return [...values].sort()[0];
}

function latest(values: string[]): string {
  return [...values].sort().at(-1)!;
}

function toEvent(cluster: IntelEventDraft[], evidenceById: Map<string, CountryEvidence>): IntelEvent {
  const drafts = [...cluster].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const evidence = drafts.map((draft) => evidenceById.get(draft.evidenceId)).filter((item): item is CountryEvidence => Boolean(item));
  const evidenceIds = drafts.map((draft) => draft.evidenceId);
  const sourceFamilies = new Set(evidence.map(sourceFamily));
  const occurredAt = drafts.map((draft) => draft.occurredAt).filter((value): value is string => Boolean(value));
  const firstSeenAt = earliest(drafts.map((draft) => draft.firstSeenAt));
  const lastSeenAt = latest(drafts.map((draft) => draft.lastSeenAt));
  const title = drafts.map((draft) => draft.title).sort()[0];
  const confidence = sourceFamilies.size >= 2 ? 'high' : evidence.some((item) => item.primarySource) || drafts.length > 1 ? 'medium' : 'low';
  const idMaterial = [drafts[0].regionId, drafts[0].type, title, occurredAt[0] ?? '', ...evidenceIds].join('\n');

  return {
    id: `evt_${createHash('sha256').update(idMaterial).digest('hex').slice(0, 20)}`,
    regionId: drafts[0].regionId,
    type: drafts[0].type,
    title,
    occurredAt: occurredAt.length ? earliest(occurredAt) : undefined,
    location: drafts[0].location,
    actors: uniqueByKey(drafts.flatMap((draft) => draft.actors)),
    targets: uniqueByKey(drafts.flatMap((draft) => draft.targets)),
    evidenceIds,
    evidenceCount: evidenceIds.length,
    independentSourceCount: sourceFamilies.size || evidenceIds.length,
    primarySourceCount: evidence.filter((item) => item.primarySource).length,
    firstSeenAt,
    lastSeenAt,
    confidence,
  };
}

export function clusterEvents(drafts: IntelEventDraft[], evidence: CountryEvidence[]): IntelEvent[] {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const clusters: IntelEventDraft[][] = [];

  for (const draft of [...drafts].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))) {
    const matchingCluster = clusters.find((cluster) => shouldMerge(
      cluster[0], draft, evidenceById.get(cluster[0].evidenceId), evidenceById.get(draft.evidenceId),
    ));
    if (matchingCluster) matchingCluster.push(draft);
    else clusters.push([draft]);
  }

  return clusters.map((cluster) => toEvent(cluster, evidenceById)).sort((left, right) => left.id.localeCompare(right.id));
}
