import type {
  ActionType,
  CountryEvidence,
  IntelEntity,
  IntelTarget,
  RegionIdentity,
} from './types.js';

export interface IntelEventDraft {
  evidenceId: string;
  regionId: string;
  type: ActionType;
  title: string;
  occurredAt?: string;
  location?: { name?: string; countryCode?: string };
  actors: IntelEntity[];
  targets: IntelTarget[];
  firstSeenAt: string;
  lastSeenAt: string;
}

const ACTION_PATTERNS: readonly [RegExp, ActionType][] = [
  [/\b(?:boycott|boycotts?)\b|不買/iu, 'boycott'],
  [/\b(?:memorial|commemoration|anniversary)\b|記念日|追悼/iu, 'memorial_event'],
  [/\b(?:earthquake|tsunami|flood|wildfire|disaster)\b|大?地震|津波|洪水|災害/iu, 'disaster_response'],
  [/\b(?:protest|demonstration|rally)\b|抗議|デモ/iu, 'protest'],
  [/\b(?:sanction|sanctions)\b|制裁/iu, 'sanction'],
  [/\b(?:arrest|arrested)\b|逮捕/iu, 'arrest'],
  [/\b(?:election|elected)\b|選挙/iu, 'election'],
  [/\b(?:legislation|bill|law)\b|法案|立法/iu, 'legislation'],
  [/\b(?:meeting|met with)\b|会談/iu, 'meeting'],
  [/\b(?:agreement|accord|deal)\b|合意/iu, 'agreement'],
  [/\b(?:strike|striking)\b|ストライキ/iu, 'strike'],
  [/\b(?:threat|threatened)\b|脅迫/iu, 'threat'],
  [/\b(?:violence|violent|attack)\b|暴力|襲撃/iu, 'violence'],
  [/\b(?:military|troops|naval)\b|軍事|部隊/iu, 'military_activity'],
  [/\b(?:trade restriction|export ban|import ban)\b|輸出規制|輸入規制/iu, 'trade_restriction'],
  [/\b(?:cultural event|festival|exhibition)\b|文化イベント|祭り|展覧会/iu, 'cultural_event'],
  [/\b(?:celebration|celebrate)\b|祝賀/iu, 'celebration'],
  [/\b(?:critic(?:ize|ise|ism)|said|statement|quoted)\b|批判|引用|発言/iu, 'statement'],
];

const ACTOR_PATTERNS: readonly [RegExp, IntelEntity['type'], string][] = [
  [/\bpolitician\b|政治家/iu, 'politician', 'politician'],
  [/\bforeign ministry\b|外務省/iu, 'foreign_ministry', 'foreign ministry'],
  [/\bgovernment\b|政府/iu, 'government', 'government'],
  [/\b(?:protesters?|demonstrators?)\b|抗議者/iu, 'protester', 'protesters'],
  [/\b(?:activists?)\b|活動家/iu, 'activist', 'activists'],
  [/\b(?:police)\b|警察/iu, 'police', 'police'],
  [/\b(?:military|army)\b|軍/iu, 'military', 'military'],
];

function actionType(text: string): ActionType {
  return ACTION_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? 'other';
}

function uniqueByKey<T extends IntelEntity | IntelTarget>(items: T[]): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const key = [item.canonicalId, item.countryCode, item.type, item.name].join('\u0000');
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function actors(text: string): IntelEntity[] {
  return uniqueByKey(ACTOR_PATTERNS
    .filter(([pattern]) => pattern.test(text))
    .map(([, type, name]) => ({ name, type })));
}

function japaneseTargetType(region: RegionIdentity): 'foreign_government' | 'domestic_government' {
  return region.countryCode === 'JP' ? 'domestic_government' : 'foreign_government';
}

function targets(text: string, region: RegionIdentity): IntelTarget[] {
  const found: IntelTarget[] = [];
  if (/\b(?:Japanese|Japan) government\b|日本政府/iu.test(text)) {
    found.push({ name: 'Japanese government', type: japaneseTargetType(region), countryCode: 'JP' });
  }
  if (/\bJapanese (?:people|nationals)\b|日本人|日本国民/iu.test(text)) {
    found.push({ name: 'Japanese people', type: 'people_nationality', countryCode: 'JP' });
  }
  if (/\bJapanese products?\b|日本製品/iu.test(text)) {
    found.push({ name: 'Japanese products', type: 'product', countryCode: 'JP' });
  }
  if (/\bJapan\b|日本(?!政府|人|国民|製品)/iu.test(text)) {
    found.push({ name: 'Japan', type: 'country', countryCode: 'JP' });
  }
  return uniqueByKey(found);
}

function normalizedText(text: string | undefined): string | undefined {
  const normalized = text?.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized || undefined;
}

function normalizedTimestamp(timestamp: string | undefined): string | undefined {
  const epoch = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : undefined;
}

function locationName(text: string): string | undefined {
  const place = text.match(/\b(Seoul|Busan|Tokyo)\b|ソウル|釜山|東京/iu)?.[0];
  return place ? place.normalize('NFKC') : undefined;
}

export function extractEvent(
  evidence: CountryEvidence,
  region: RegionIdentity,
  now: Date,
): IntelEventDraft | undefined {
  const title = normalizedText(evidence.title) ?? normalizedText(evidence.excerpt);
  if (!title) return undefined;
  const excerpt = normalizedText(evidence.excerpt);
  const titleAction = actionType(title);
  const details = excerpt && excerpt !== title ? excerpt : undefined;
  const location = {
    ...(evidence.eventCountry ? { countryCode: evidence.eventCountry } : {}),
    ...(locationName([title, details].filter(Boolean).join(' ')) ? { name: locationName([title, details].filter(Boolean).join(' ')) } : {}),
  };
  const seenAt = normalizedTimestamp(evidence.retrievedAt) ?? now.toISOString();

  return {
    evidenceId: evidence.id,
    regionId: evidence.regionId,
    type: titleAction === 'other' && details ? actionType(details) : titleAction,
    title,
    occurredAt: normalizedTimestamp(evidence.publishedAt),
    location: Object.keys(location).length ? location : undefined,
    actors: uniqueByKey([actors(title), details ? actors(details) : []].flat()),
    targets: uniqueByKey([targets(title, region), details ? targets(details, region) : []].flat()),
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  };
}
