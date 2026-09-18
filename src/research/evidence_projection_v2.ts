/**
 * Sora Evidence Compiler Research — Response Projection v2
 *
 * NOTE: This is a research-only module.
 * Production integrated_search_host_response.ts behavior is NOT modified.
 */

import {
  type IntegratedSearchHostResponseOptions,
} from '../integrated_search_host_response.js';

export type EvidenceOrigin = 'body' | 'supplemental';

export interface ResearchHighlightItem {
  text: string;
  score?: number;
  cost?: number;
  evidenceScores?: number[];
  heading?: string;
  evidenceOrigin?: EvidenceOrigin;
}

/**
 * Deterministic text normalization for redundancy detection.
 * - Unicode NFKC normalization
 * - Markdown decoration removal (headings, bold, italics, quotes, list markers, code backticks)
 * - Whitespace & newline collapse
 * - Lowercase normalization
 */
export function normalizeEvidenceText(text: string): string {
  if (!text || typeof text !== 'string') return '';

  return (
    text
      .normalize('NFKC')
      // Remove code fence backticks and inline backticks
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      // Remove image and link markdown syntax, keeping link text
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove HTML tags
      .replace(/<[^>]+>/g, ' ')
      // Remove blockquote markers, list markers, headings
      .replace(/^[>#\s\-*+]+(?=\s)/gm, ' ')
      .replace(/^[0-9]+\.\s+/gm, ' ')
      // Remove markdown emphasis / strike
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      // Collapse whitespace and trim
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim()
  );
}

/**
 * Checks whether candidate text is completely contained within the combined highlights.
 *
 * CRITICAL SAFETY RULES:
 * 1. candidate must NOT be empty.
 * 2. normalized(candidate) must be fully contained (includes) within normalized(highlights).
 * 3. The inverse (highlights inside candidate) MUST NOT trigger pruning,
 *    as candidate may contain substantial unique text.
 */
export function isRedundantWithHighlights(
  candidateText: string,
  highlights: string[],
): boolean {
  const normCandidate = normalizeEvidenceText(candidateText);
  if (!normCandidate || normCandidate.length < 5) {
    // Too short or empty: do not assume redundant
    return false;
  }

  const combinedHighlights = highlights.join('\n');
  const normHighlights = normalizeEvidenceText(combinedHighlights);

  // Complete containment check
  return normHighlights.includes(normCandidate);
}

/**
 * Detects whether any highlight originates from supplemental snippets or fallback evidence.
 */
export function hasSupplementalHighlight(highlights: string[]): boolean {
  if (!Array.isArray(highlights)) return false;
  return highlights.some(
    (h) =>
      typeof h === 'string' &&
      (h.includes('補完証拠') ||
        h.includes('📌') ||
        h.startsWith('> 📌 **補完証拠')),
  );
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

export type ProjectionVariant = 'P0' | 'P1' | 'P2' | 'P3';

export interface EvidenceProjectionV2Options extends IntegratedSearchHostResponseOptions {
  variant?: ProjectionVariant;
}

/**
 * Experimental Projection v2 item projection.
 *
 * Variants:
 * - P0: Full raw item (no deletion)
 * - P1: Baseline Evidence v1 (safe markdown elision only)
 * - P2: Markdown elision + conservative redundant description/snippet pruning
 * - P3: P2 + lean metadata projection (research-only metadata pruning)
 */
export function projectIntegratedSearchEvidenceItemV2(
  sourceItem: Record<string, any>,
  options: EvidenceProjectionV2Options = {},
): Record<string, any> {
  const variant = options.variant ?? 'P2';
  const item = { ...sourceItem };

  if (variant === 'P0') {
    return item;
  }

  // Safety checks identical to baseline P1
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

  if (variant === 'P1') {
    // P1 only elides markdown
    return item;
  }

  // P2: Conservative redundancy pruning
  const highlights = Array.isArray(item.highlights) ? item.highlights : [];
  const supplementalInHighlights = hasSupplementalHighlight(highlights);

  // Check description redundancy
  if (typeof item.description === 'string' && item.description.trim().length > 0) {
    if (isRedundantWithHighlights(item.description, highlights)) {
      delete item.description;
    }
  }

  // Check snippet redundancy
  // SAFEGUARD: Never delete snippet if isSnippetFallback is true, or if supplemental evidence is in highlights
  if (
    !hasFallbackRisk &&
    !supplementalInHighlights &&
    typeof item.snippet === 'string' &&
    item.snippet.trim().length > 0
  ) {
    if (isRedundantWithHighlights(item.snippet, highlights)) {
      delete item.snippet;
    }
  }

  if (variant === 'P2') {
    return item;
  }

  // P3: Lean metadata projection (benchmark only)
  // Prune presentation/social metadata while preserving canonical core
  delete item.ogImage;
  delete item.socialLinks;
  delete item.twitterHandle;
  delete item.pageType;
  delete item.site;
  // textFragmentUrl is measured in P3, but noted as citation-relevant in analysis
  delete item.textFragmentUrl;

  return item;
}

/**
 * Projects an entire search response under a given variant.
 */
export function projectIntegratedSearchResponseV2(
  response: Record<string, any>,
  variant: ProjectionVariant,
  options: IntegratedSearchHostResponseOptions = {},
): Record<string, any> {
  if (variant === 'P0') {
    return response;
  }

  return {
    ...response,
    responseMode: 'evidence',
    results: Array.isArray(response?.results)
      ? response.results.map((item: Record<string, any>) =>
          projectIntegratedSearchEvidenceItemV2(item, { ...options, variant }),
        )
      : response?.results,
  };
}
