import type { ScrapeFormat } from './types.js';

export interface SearchFormatProjectionOptions {
  markdownFallback?: string;
  minMarkdownChars?: number;
}

/** Host-facing projection only. Retrieval/ranking/source content is untouched. */
export function projectRequestedScrapeFormats(
  scrape: Record<string, any>,
  formats: readonly ScrapeFormat[] | undefined,
  options: SearchFormatProjectionOptions = {},
): Record<string, any> {
  const requested: readonly ScrapeFormat[] = formats && formats.length > 0 ? formats : ['markdown'];
  const out: Record<string, any> = {};
  if (requested.includes('markdown')) {
    const content = typeof scrape?.content === 'string' ? scrape.content : typeof scrape?.markdown === 'string' ? scrape.markdown : '';
    const minChars = Math.max(0, options.minMarkdownChars ?? 0);
    if (content.trim().length >= minChars) out.markdown = content;
    else if (options.markdownFallback) { out.markdown = options.markdownFallback; out.isSnippetFallback = true; }
    else out.markdown = content;
  }
  if (requested.includes('html') && (scrape?.html ?? scrape?.rawHtml)) out.html = scrape.html ?? scrape.rawHtml;
  if (requested.includes('rawHtml') && scrape?.rawHtml) out.rawHtml = scrape.rawHtml;
  if (requested.includes('links') && scrape?.links) out.links = scrape.links;
  if (requested.includes('screenshot') && scrape?.screenshot) out.screenshot = scrape.screenshot;
  if (requested.includes('jsonLd') && scrape?.jsonLd) out.jsonLd = scrape.jsonLd;
  if (requested.includes('images') && scrape?.images) out.images = scrape.images;
  if (requested.includes('tables') && scrape?.tables) out.tables = scrape.tables;
  return out;
}
