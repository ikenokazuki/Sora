import {
  type ScrapeFormat,
  IntegratedSearchResponseModeSchema,
  type IntegratedSearchResponseMode,
} from './types.js';

export { IntegratedSearchResponseModeSchema, type IntegratedSearchResponseMode };

export interface IntegratedSearchHostResponseOptions {
  responseMode?: IntegratedSearchResponseMode;
  explicitFormats?: readonly ScrapeFormat[];
  extractHighlights?: boolean;
  verbose?: boolean;
}

function hasCanonicalHighlights(item: Record<string, any>): boolean {
  return (
    Array.isArray(item?.highlights) &&
    item.highlights.some(
      (value: unknown) =>
        typeof value === 'string' && value.trim().length > 0,
    )
  );
}

function isXItem(item: Record<string, any>): boolean {
  if (item?.source === 'x') return true;

  const rawUrl =
    typeof item?.url === 'string'
      ? item.url
      : typeof item?.link === 'string'
        ? item.link
        : '';

  if (!rawUrl) return false;

  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'x.com' ||
      host.endsWith('.x.com') ||
      host === 'twitter.com' ||
      host.endsWith('.twitter.com')
    );
  } catch {
    return false;
  }
}

/**
 * A conservative, Host-facing evidence projection for one integrated-search item.
 *
 * This function deliberately preserves the existing JSON properties and only
 * considers removing `markdown`.
 *
 * `markdown` is NEVER overwritten with highlights.
 * `highlights` is NEVER removed.
 */
export function projectIntegratedSearchEvidenceItem(
  sourceItem: Record<string, any>,
  options: IntegratedSearchHostResponseOptions = {},
): Record<string, any> {
  const item = { ...sourceItem };

  const markdownWasExplicitlyRequested =
    options.explicitFormats?.includes('markdown') === true;

  const highlightExtractionWasExplicitlyDisabled =
    options.extractHighlights === false;

  const hasFallbackRisk =
    Boolean(item?.scrapeError) || item?.isSnippetFallback === true;

  const mayElideMarkdown =
    !markdownWasExplicitlyRequested &&
    !highlightExtractionWasExplicitlyDisabled &&
    !hasFallbackRisk &&
    !isXItem(item) &&
    hasCanonicalHighlights(item);

  if (mayElideMarkdown) {
    delete item.markdown;
  }

  return item;
}

/**
 * Host-facing boundary for integrated search.
 *
 * `full` is the default and returns the original object by identity.
 * `verbose` always forces full.
 *
 * `evidence` is explicit opt-in and is intentionally query-selective.
 * It preserves the existing JSON envelope/properties and only removes
 * per-result `markdown` when conservative safety conditions allow it.
 */
export function formatIntegratedSearchHostResponse(
  result: Record<string, any>,
  options: IntegratedSearchHostResponseOptions = {},
): Record<string, any> {
  const mode = options.responseMode ?? 'full';

  if (mode === 'full' || options.verbose === true) {
    return result;
  }

  return {
    ...result,
    responseMode: 'evidence',
    results: Array.isArray(result?.results)
      ? result.results.map((item: Record<string, any>) =>
          projectIntegratedSearchEvidenceItem(item, options),
        )
      : result?.results,
  };
}

export function serializeIntegratedSearchMcpResponse(
  result: Record<string, any>,
  options: IntegratedSearchHostResponseOptions = {},
): string {
  const formatted = formatIntegratedSearchHostResponse(result, options);

  // Preserve legacy pretty JSON for the default/full path.
  // Evidence mode uses compact JSON because the caller explicitly requested
  // a token-conscious Host surface.
  return options.responseMode === 'evidence' && options.verbose !== true
    ? JSON.stringify(formatted)
    : JSON.stringify(formatted, null, 2);
}
