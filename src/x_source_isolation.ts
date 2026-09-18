import type { XPostDetail } from './services/x_detail.js';

export type XDiscoveryKind = 'status' | 'profile';
export type XEvidenceRelation =
  | 'exact_status'
  | 'related_posts'
  | 'account_posts'
  | 'discovery_only';

export interface XDiscoverySeed {
  url: string;
  kind: XDiscoveryKind;
  handle?: string;
  statusId?: string;
}

export interface XRetrievalPlanEntry {
  key: string;
  seed: XDiscoverySeed;
  itemIndexes: number[];
}

export interface XIsolatedEvidence {
  relation: XEvidenceRelation;
  markdown?: string;
  selectedItems: Array<Record<string, any>>;
  relatedItems: Array<Record<string, any>>;
  exactStatusMatched: boolean;
  eligibleForPrimaryEvidence: boolean;
}

const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com']);
const RESERVED = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'i',
  'settings',
  'search',
]);

function normalizeHandle(raw?: string): string | undefined {
  const value = (raw || '').replace(/^@/, '').trim();
  return /^[a-zA-Z0-9_]{1,30}$/.test(value) ? value : undefined;
}

export function parseXDiscoverySeed(url: string): XDiscoverySeed | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!X_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const s = parsed.pathname.split('/').filter(Boolean);

  if (
    s.length >= 3 &&
    s[1]?.toLowerCase() === 'status' &&
    /^\d+$/.test(s[2] || '')
  ) {
    const handle = normalizeHandle(s[0]);
    if (!handle) return null;
    return {
      url,
      kind: 'status',
      handle,
      statusId: s[2],
    };
  }

  if (
    s[0]?.toLowerCase() === 'i' &&
    s[1]?.toLowerCase() === 'web' &&
    s[2]?.toLowerCase() === 'status' &&
    /^\d+$/.test(s[3] || '')
  ) {
    return {
      url,
      kind: 'status',
      statusId: s[3],
    };
  }

  if (
    s[0]?.toLowerCase() === 'i' &&
    s[1]?.toLowerCase() === 'status' &&
    /^\d+$/.test(s[2] || '')
  ) {
    return {
      url,
      kind: 'status',
      statusId: s[2],
    };
  }

  const handle = normalizeHandle(s[0]);
  if (
    handle &&
    s.length === 1 &&
    !RESERVED.has(handle.toLowerCase())
  ) {
    return {
      url,
      kind: 'profile',
      handle,
    };
  }

  return null;
}

export function xRetrievalKey(seed: XDiscoverySeed): string {
  if (seed.kind === 'profile' && seed.handle) {
    return `profile:${seed.handle.toLowerCase()}`;
  }
  if (seed.statusId) {
    return `status:${seed.statusId}`;
  }
  return `url:${seed.url}`;
}

/**
 * Build a bounded/deduplicated retrieval plan before any X network call.
 * Duplicate X results never multiply dedicated retrieval calls.
 */
export function buildXRetrievalPlan(
  items: Array<Record<string, any>>,
  maxUniqueRetrievals = 2,
): XRetrievalPlanEntry[] {
  const byKey = new Map<string, XRetrievalPlanEntry>();

  for (let index = 0; index < items.length; index++) {
    const url = items[index]?.url || items[index]?.link;
    if (typeof url !== 'string') continue;
    const seed = parseXDiscoverySeed(url);
    if (!seed) continue;

    const key = xRetrievalKey(seed);
    const existing = byKey.get(key);
    if (existing) {
      existing.itemIndexes.push(index);
      continue;
    }
    if (byKey.size >= maxUniqueRetrievals) continue;

    byKey.set(key, {
      key,
      seed,
      itemIndexes: [index],
    });
  }

  return [...byKey.values()];
}

export function stripXWebDiscoveryText(
  item: Record<string, any>,
): Record<string, any> {
  const {
    snippet: _snippet,
    description: _description,
    ...safe
  } = item;
  return safe;
}

export function extractXStatusIdFromItem(
  item: Record<string, any>,
): string | undefined {
  const direct: unknown[] = [
    item.statusId,
    item.status_id,
    item.tweetId,
    item.tweet_id,
    item.id_str,
  ];
  if (typeof item.id === 'string' && /^\d{10,}$/.test(item.id)) {
    direct.push(item.id);
  }

  for (const candidate of direct) {
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
      return candidate;
    }
  }

  for (const field of [
    item.url,
    item.link,
    item.permalink,
    item.status_url,
    item.tweet_url,
  ]) {
    if (typeof field !== 'string') continue;
    const match = field.match(
      /\/(?:i\/web\/status|i\/status|[a-zA-Z0-9_]+\/status)\/(\d+)/i,
    );
    if (match) return match[1];
  }
  return undefined;
}

function itemText(item: Record<string, any>): string {
  return typeof item.text === 'string'
    ? item.text.trim()
    : typeof item.content === 'string'
      ? item.content.trim()
      : '';
}

function author(item: Record<string, any>): string {
  if (typeof item.author === 'string' && item.author.trim()) {
    return item.author.trim();
  }
  const name =
    typeof item.author_name === 'string' ? item.author_name.trim() : '';
  const handle =
    typeof item.author_handle === 'string'
      ? item.author_handle.replace(/^@/, '').trim()
      : '';
  if (name && handle) return `${name} (@${handle})`;
  if (name) return name;
  if (handle) return `@${handle}`;
  return 'X post';
}

function formatMarkdown(
  title: string,
  items: Array<Record<string, any>>,
): string {
  const blocks = items.map((item, index) => {
    const statusId = extractXStatusIdFromItem(item);
    return [
      `## ${index + 1}. ${author(item)}`,
      statusId ? `statusId: ${statusId}` : '',
      itemText(item),
    ]
      .filter(Boolean)
      .join('\n');
  });

  return `${title}\n\n${blocks.join('\n\n')}`.trim();
}

/**
 * Builds isolated exact primary evidence directly from a verified XPostDetail.
 * Used for Direct X status URLs where status ID is known upfront.
 */
export function buildXIsolatedEvidenceFromDirectStatus(
  seed: XDiscoverySeed,
  detail: XPostDetail,
): XIsolatedEvidence {
  const authorName = seed.handle ? `@${seed.handle}` : 'X post';
  const item: Record<string, any> = {
    id: detail.statusId,
    statusId: detail.statusId,
    text: detail.text,
    content: detail.text,
    source: 'x',
    author: authorName,
    author_handle: seed.handle,
    url: seed.url,
    isNoteTweet: detail.isNoteTweet,
    media: detail.media,
  };

  const md = formatMarkdown('# X post — exact status verified', [item]);

  return {
    relation: 'exact_status',
    markdown: md,
    selectedItems: [item],
    relatedItems: [],
    exactStatusMatched: true,
    eligibleForPrimaryEvidence: true,
  };
}

/**
 * Precision-first evidence policy:
 *
 * - status URL:
 *   only exact status-id matches can become primary evidence.
 *   related posts are retained ONLY for diagnostics/corroboration.
 *
 * - profile URL:
 *   dedicated account-post retrieval can become primary evidence.
 *
 * Web snippets are never inputs here.
 */
export function buildXIsolatedEvidence(
  seed: XDiscoverySeed,
  realtimeItems: Array<Record<string, any>>,
  limit = 5,
): XIsolatedEvidence {
  const usable = realtimeItems.filter((item) => itemText(item).length > 0);

  if (seed.kind === 'status') {
    if (!seed.statusId) {
      return {
        relation: 'discovery_only',
        selectedItems: [],
        relatedItems: usable.slice(0, limit),
        exactStatusMatched: false,
        eligibleForPrimaryEvidence: false,
      };
    }

    const exact = usable.filter(
      (item) => extractXStatusIdFromItem(item) === seed.statusId,
    );

    if (exact.length > 0) {
      const selected = exact.slice(0, limit);
      return {
        relation: 'exact_status',
        markdown: formatMarkdown(
          '# X post — exact status verified',
          selected,
        ),
        selectedItems: selected,
        relatedItems: [],
        exactStatusMatched: true,
        eligibleForPrimaryEvidence: true,
      };
    }

    return {
      relation: usable.length > 0 ? 'related_posts' : 'discovery_only',
      selectedItems: [],
      relatedItems: usable.slice(0, limit),
      exactStatusMatched: false,
      eligibleForPrimaryEvidence: false,
    };
  }

  if (usable.length > 0) {
    const selected = usable.slice(0, limit);
    return {
      relation: 'account_posts',
      markdown: formatMarkdown(
        '# X posts — dedicated account retrieval',
        selected,
      ),
      selectedItems: selected,
      relatedItems: [],
      exactStatusMatched: false,
      eligibleForPrimaryEvidence: true,
    };
  }

  return {
    relation: 'discovery_only',
    selectedItems: [],
    relatedItems: [],
    exactStatusMatched: false,
    eligibleForPrimaryEvidence: false,
  };
}
