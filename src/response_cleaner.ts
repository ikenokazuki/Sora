import type { ScrapeResult } from './types.js';

export interface FormatCompactOptions {
  verbose?: boolean;
}

/**
 * ScrapeResult を LLM / API に最適化された高密度な Compact 形式に整形する。
 *
 * デフォルト (verbose !== true):
 * - 不要な内部メトリクス (quality, completeness, evidence, missingFields, qualityReasons 等) を除外
 * - 固定定数 (contentType, source, renderedWithBrowser, estimatedTokens 等) を除外
 * - isTruncated は true の時のみ出力 (false なら除外してトークン削減)
 * - pageType は LLM のタスク判断補助のために保持
 * - undefined や空のプロパティはキーごとパージ
 *
 * verbose === true:
 * - デバッグ・監査用に元の全プロパティをそのまま保持
 */
export function formatCompactScrapeResult(
  result: ScrapeResult,
  options?: FormatCompactOptions,
): Record<string, any> {
  if (!result) return result as any;
  if (options?.verbose) {
    return result;
  }

  const clean: Record<string, any> = {
    url: result.url,
    title: result.title,
    content: result.content,
  };

  if (result.description) clean.description = result.description;
  if (result.publishedTime) clean.publishedTime = result.publishedTime;
  if (result.author) clean.author = result.author;
  if (result.siteName) clean.siteName = result.siteName;
  if (result.pageType) clean.pageType = result.pageType;

  // 上限文字数超過で切り詰められた時のみ明示
  if (result.isTruncated) clean.isTruncated = true;

  // オプション要求時や存在時のみ付与
  if (result.highlights && result.highlights.length > 0) clean.highlights = result.highlights;
  if (result.summary && result.summary.length > 0) clean.summary = result.summary;
  if (result.textFragmentUrl) clean.textFragmentUrl = result.textFragmentUrl;
  if (result.citations && result.citations.length > 0) clean.citations = result.citations;
  if (result.chunks && result.chunks.length > 0) clean.chunks = result.chunks;
  if (result.media) clean.media = result.media;

  // EC系フィールド (値がある場合のみ)
  if (result.price) clean.price = result.price;
  if (result.priceCurrency) clean.priceCurrency = result.priceCurrency;
  if (result.availability) clean.availability = result.availability;
  if (result.brand) clean.brand = result.brand;
  if (result.sku) clean.sku = result.sku;

  // セレクタピンポイント抽出
  if (result.extracted && Object.keys(result.extracted).length > 0) {
    clean.extracted = result.extracted;
  }

  // formats で明示指定された場合
  if (result.images && result.images.length > 0) clean.images = result.images;
  if (result.links && result.links.length > 0) clean.links = result.links;
  if (result.linksWithStatus && result.linksWithStatus.length > 0) clean.linksWithStatus = result.linksWithStatus;
  if (result.tables && result.tables.length > 0) clean.tables = result.tables;
  if (result.events && result.events.length > 0) clean.events = result.events;
  if (result.breadcrumb && result.breadcrumb.length > 0) clean.breadcrumb = result.breadcrumb;
  if (result.jsonLd && result.jsonLd.length > 0) clean.jsonLd = result.jsonLd;
  if (result.html) clean.html = result.html;
  if (result.rawHtml) clean.rawHtml = result.rawHtml;
  if (result.screenshot) clean.screenshot = result.screenshot;
  if (result.promptContext) clean.promptContext = result.promptContext;
  if (result.highlightedContent) clean.highlightedContent = result.highlightedContent;
  if (result.cached !== undefined) clean.cached = result.cached;

  return clean;
}
