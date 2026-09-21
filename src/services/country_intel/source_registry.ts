import type { CountrySource } from './types.js';

export type SourceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SourceVerificationDependencies {
  fetch?: SourceFetch;
  now?: () => number;
  officialLinks?: readonly string[];
  maxRedirects?: number;
  timeoutMs?: number;
}

function candidateUrl(domain: string): URL | undefined {
  try {
    const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function consistentHost(left: URL, right: URL): boolean {
  return normalizedHost(left) === normalizedHost(right);
}

function hasOfficialCrossLink(candidate: URL, officialLinks: readonly string[] | undefined): boolean {
  if (!officialLinks?.length) return true;
  return officialLinks.some((link) => {
    try {
      const url = new URL(link);
      return url.protocol === 'https:' && !url.username && !url.password && consistentHost(candidate, url);
    } catch {
      return false;
    }
  });
}

function unverified(source: CountrySource): CountrySource {
  return { ...source, verificationStatus: 'candidate', verifiedAt: undefined };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => rejectOnce(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolveOnce, rejectOnce);
    if (signal.aborted) onAbort();
  });
}

export async function verifyCountrySource(
  source: CountrySource,
  dependencies: SourceVerificationDependencies = {},
): Promise<CountrySource> {
  const initial = candidateUrl(source.domain);
  if (!initial || !hasOfficialCrossLink(initial, dependencies.officialLinks)) return unverified(source);

  const fetcher = dependencies.fetch ?? fetch;
  const signal = AbortSignal.timeout(dependencies.timeoutMs ?? 5_000);
  const visited = new Set<string>();
  let current = initial;

  try {
    for (let redirects = 0; redirects <= (dependencies.maxRedirects ?? 3); redirects++) {
      if (visited.has(current.href)) return unverified(source);
      visited.add(current.href);
      const response = await raceAbort(
        fetcher(current, { method: 'GET', redirect: 'manual', signal }),
        signal,
      );
      if (response.status >= 200 && response.status < 300) {
        return {
          ...source,
          verificationStatus: 'verified',
          verifiedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
        };
      }
      if (response.status < 300 || response.status >= 400) return unverified(source);
      const location = response.headers.get('location');
      if (!location) return unverified(source);
      const next = new URL(location, current);
      if (
        next.protocol !== 'https:'
        || next.username
        || next.password
        || !consistentHost(initial, next)
      ) return unverified(source);
      current = next;
    }
  } catch {
    return unverified(source);
  }

  return unverified(source);
}
