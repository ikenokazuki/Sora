import { extractText, getMeta } from 'unpdf';
import { safeTruncateMarkdown, estimateTokens } from './enrichment.js';
import type { ScrapeResult } from './types.js';

export const DEFAULT_MAX_CHARS = 30_000;

/** PDF バッファからテキスト・メタデータを抽出し Markdown へ構造化 */
export async function parsePdfToMarkdown(
  buffer: ArrayBuffer | Uint8Array,
  targetUrl: string,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<ScrapeResult> {
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const { text, totalPages } = await extractText(uint8, { mergePages: true });
  let pdfMetadata: any = {};
  try {
    const meta = await getMeta(uint8);
    pdfMetadata = meta?.info || {};
  } catch {}

  const title = pdfMetadata.Title || targetUrl.split('/').pop() || 'PDF Document';
  const author = pdfMetadata.Author || undefined;
  const rawText = Array.isArray(text) ? text.join('\n\n') : (text || '');
  const markdown = rawText.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

  const isTruncated = markdown.length > maxChars;
  const truncatedContent = safeTruncateMarkdown(markdown, maxChars);
  const estimatedTokens = estimateTokens(truncatedContent);

  return {
    url: targetUrl,
    title,
    author,
    content: truncatedContent,
    isTruncated,
    contentType: 'application/pdf',
    source: 'web',
    metadata: { ...pdfMetadata, totalPages },
    estimatedTokens,
  };
}
