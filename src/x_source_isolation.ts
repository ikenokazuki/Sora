// X の URL（投稿・アカウント）を読む。投稿の本文の取得（x_detail.ts の fetchXPostDetail）が使う
export type XDiscoveryKind = 'status' | 'profile';

export interface XDiscoverySeed {
  url: string;
  kind: XDiscoveryKind;
  handle?: string;
  statusId?: string;
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
