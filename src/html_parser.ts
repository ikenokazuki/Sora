import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import type {
  FieldEvidence,
  ImageItem,
  MediaInfo,
  TableData,
} from './types.js';
import {
  calculateContentQuality,
  calculateExtractionCompleteness,
  cleanMarkdownTokens,
  collectFieldEvidence,
  detectPageType,
  estimateTokens,
  safeTruncateMarkdown,
} from './enrichment.js';

// ==========================================
// 1. TurndownService インスタンス & GFM 拡張
// ==========================================
export const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  strongDelimiter: '**',
});

// GFM Table サポート (HTML table -> Markdown table)
turndown.addRule('gfmTable', {
  filter: 'table',
  replacement: function (_content, node: any) {
    const rows = Array.from((node as any).querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const matrix: string[][] = [];
    for (const row of rows as any[]) {
      const cells = Array.from((row as any).querySelectorAll('th, td')).map((c: any) =>
        (c.textContent || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim(),
      );
      if (cells.length > 0) matrix.push(cells);
    }
    if (matrix.length === 0) return '';

    const maxCols = Math.max(...matrix.map((r) => r.length));
    const normalizedMatrix = matrix.map((r) => {
      while (r.length < maxCols) r.push('');
      return r;
    });

    const header = '| ' + normalizedMatrix[0].join(' | ') + ' |';
    const separator = '| ' + normalizedMatrix[0].map(() => '---').join(' | ') + ' |';
    const body = normalizedMatrix
      .slice(1)
      .map((r) => '| ' + r.join(' | ') + ' |')
      .join('\n');

    return `\n\n${header}\n${separator}${body ? '\n' + body : ''}\n\n`;
  },
});

// GFM Codeblock 言語指定保持 (<pre><code class="language-python">)
turndown.addRule('fencedCodeBlock', {
  filter: function (node: any, options: any) {
    if (node.nodeName !== 'PRE') return false;
    const hasCode = Boolean(
      (node.querySelector && node.querySelector('code')) ||
      (node.firstChild && node.firstChild.nodeName === 'CODE')
    );
    return options.codeBlockStyle === 'fenced' && hasCode;
  },
  replacement: function (_content, node: any) {
    const codeEl = (node.querySelector && node.querySelector('code')) || node.firstChild || node;
    const lang =
      codeEl?.getAttribute?.('data-language') ||
      node.getAttribute?.('data-language') ||
      (codeEl?.getAttribute?.('class') || '').match(/(?:language|lang|highlight)-([a-zA-Z0-9_+-]+)/i)?.[1] ||
      (node.getAttribute?.('class') || '').match(/(?:language|lang|highlight)-([a-zA-Z0-9_+-]+)/i)?.[1] ||
      '';
    const code = (codeEl?.textContent || node.textContent || '').replace(/\r\n/g, '\n');
    return `\n\n\`\`\`${lang.toLowerCase()}\n${code.replace(/\n+$/, '')}\n\`\`\`\n\n`;
  },
});

// ==========================================
// 2. メタデータ & セレクタ抽出ヘルパー
// ==========================================

export interface JsonLdMetadata {
  publishedTime?: string;
  author?: string;
  siteName?: string;
  description?: string;
  ogImage?: string;
  productName?: string;
  availability?: 'InStock' | 'OutOfStock' | 'PreOrder' | string;
  price?: string;
  priceCurrency?: string;
  brand?: string;
  sku?: string;
}

function normalizeAvailability(val: any): string | undefined {
  if (typeof val !== 'string') return undefined;
  const lower = val.toLowerCase();
  if (lower.includes('instock')) return 'InStock';
  if (lower.includes('outofstock') || lower.includes('soldout')) return 'OutOfStock';
  if (lower.includes('preorder')) return 'PreOrder';
  if (lower.includes('discontinued')) return 'Discontinued';
  if (lower.includes('limitedavailability')) return 'LimitedAvailability';
  return val.replace(/^https?:\/\/schema\.org\//i, '');
}

/** JSON-LD からのメタデータ（Schema.org）抽出（再帰深度ガード付き） */
export function extractMetadataFromJsonLd(items: any[]): JsonLdMetadata {
  const result: JsonLdMetadata = {};

  const flatObjects: any[] = [];
  function flatten(obj: any, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => flatten(item, depth + 1));
    } else {
      flatObjects.push(obj);
      if (obj['@graph'] && Array.isArray(obj['@graph'])) {
        obj['@graph'].forEach((item: any) => flatten(item, depth + 1));
      }
    }
  }
  items.forEach((item) => flatten(item, 0));

  for (const item of flatObjects) {
    if (!result.publishedTime) {
      if (typeof item.datePublished === 'string') result.publishedTime = item.datePublished;
      else if (typeof item.dateCreated === 'string') result.publishedTime = item.dateCreated;
      else if (typeof item.dateModified === 'string') result.publishedTime = item.dateModified;
    }

    if (!result.author) {
      if (typeof item.author === 'string') {
        result.author = item.author;
      } else if (item.author && typeof item.author === 'object') {
        if (typeof item.author.name === 'string') result.author = item.author.name;
        else if (Array.isArray(item.author) && typeof item.author[0]?.name === 'string') {
          result.author = item.author[0].name;
        }
      } else if (typeof item.creator === 'string') {
        result.author = item.creator;
      } else if (item.creator && typeof item.creator.name === 'string') {
        result.author = item.creator.name;
      }
    }

    if (!result.siteName) {
      if (item.publisher && typeof item.publisher.name === 'string') {
        result.siteName = item.publisher.name;
      } else if (item.isPartOf && typeof item.isPartOf.name === 'string') {
        result.siteName = item.isPartOf.name;
      }
    }

    if (!result.description && typeof item.description === 'string') {
      result.description = item.description;
    }

    if (!result.ogImage) {
      if (typeof item.image === 'string') {
        result.ogImage = item.image;
      } else if (item.image && typeof item.image === 'object') {
        if (typeof item.image.url === 'string') result.ogImage = item.image.url;
        else if (Array.isArray(item.image) && typeof item.image[0] === 'string') {
          result.ogImage = item.image[0];
        } else if (Array.isArray(item.image) && typeof item.image[0]?.url === 'string') {
          result.ogImage = item.image[0].url;
        }
      }
    }

    // 商品 (Schema.org Product / Offer) の解析
    const typeStr = Array.isArray(item['@type']) ? item['@type'].join(' ') : String(item['@type'] || '');
    const isProduct = /Product/i.test(typeStr);
    const isOffer = /Offer/i.test(typeStr);

    if (isProduct) {
      if (!result.productName && typeof item.name === 'string') {
        result.productName = item.name;
      }
      if (!result.brand) {
        if (typeof item.brand === 'string') result.brand = item.brand;
        else if (item.brand && typeof item.brand.name === 'string') result.brand = item.brand.name;
      }
      if (!result.sku && typeof item.sku === 'string') {
        result.sku = item.sku;
      }
      if (item.offers) {
        const offersList = Array.isArray(item.offers) ? item.offers : [item.offers];
        for (const offer of offersList) {
          if (!result.availability && offer.availability) {
            result.availability = normalizeAvailability(offer.availability);
          }
          if (!result.price && (offer.price !== undefined || offer.lowPrice !== undefined)) {
            result.price = String(offer.price ?? offer.lowPrice);
          }
          if (!result.priceCurrency && typeof offer.priceCurrency === 'string') {
            result.priceCurrency = offer.priceCurrency;
          }
        }
      }
    }

    if (isOffer) {
      if (!result.availability && item.availability) {
        result.availability = normalizeAvailability(item.availability);
      }
      if (!result.price && (item.price !== undefined || item.lowPrice !== undefined)) {
        result.price = String(item.price ?? item.lowPrice);
      }
      if (!result.priceCurrency && typeof item.priceCurrency === 'string') {
        result.priceCurrency = item.priceCurrency;
      }
    }
  }

  return result;
}

/** CSS セレクタまたは属性指定によるキーバリュー抽出 */
export function extractWithSelectors(
  $: cheerio.CheerioAPI,
  selectors?: Record<string, string>,
  baseUrl?: string,
): Record<string, string | null> | undefined {
  if (!selectors || Object.keys(selectors).length === 0) return undefined;
  const result: Record<string, string | null> = {};

  for (const [key, selectorExpr] of Object.entries(selectors)) {
    try {
      if (!selectorExpr || typeof selectorExpr !== 'string') continue;

      const attrMatch = selectorExpr.match(/^(.*?)@([a-zA-Z0-9_\-]+)$/);
      if (attrMatch) {
        const cssSel = attrMatch[1].trim();
        const attrName = attrMatch[2].trim();
        const el = cssSel ? $(cssSel).first() : $('*').first();
        let val = el.attr(attrName) || null;
        if (val && baseUrl && ['href', 'src', 'data-src'].includes(attrName.toLowerCase())) {
          try {
            val = new URL(val, baseUrl).href;
          } catch {}
        }
        result[key] = val;
      } else {
        const el = $(selectorExpr).first();
        if (el.length > 0) {
          result[key] = el.text().replace(/\s+/g, ' ').trim();
        } else {
          result[key] = null;
        }
      }
    } catch {
      result[key] = null;
    }
  }

  return result;
}

/** HTML から <table> データを抽出して構造化 JSON に変換 */
export function extractTablesFromHtml($: cheerio.CheerioAPI): TableData[] {
  const tables: TableData[] = [];
  $('table').each((_, tableEl) => {
    const $t = $(tableEl);
    const id = $t.attr('id') || undefined;
    const caption = $t.find('caption').first().text().trim() || undefined;

    const headers: string[] = [];
    $t.find('tr').first().find('th, td').each((_, cell) => {
      headers.push($(cell).text().replace(/\s+/g, ' ').trim());
    });

    if (headers.length === 0) return;

    const rows: Record<string, string>[] = [];
    $t.find('tr').slice(1).each((_, tr) => {
      const rowObj: Record<string, string> = {};
      let hasData = false;
      $(tr).find('td, th').each((cIdx, cell) => {
        const colName = headers[cIdx] || `col_${cIdx + 1}`;
        const cellText = $(cell).text().replace(/\s+/g, ' ').trim();
        if (cellText) hasData = true;
        rowObj[colName] = cellText;
      });
      if (hasData) rows.push(rowObj);
    });

    if (rows.length > 0) {
      tables.push({ id, caption, headers, rows });
    }
  });
  return tables;
}

/** YouTube / 動画メディアメタデータ & チャプター抽出 */
export function extractMediaInfo(
  $: cheerio.CheerioAPI,
  targetUrl: string,
  rawHtml?: string,
): MediaInfo | undefined {
  try {
    const urlObj = new URL(targetUrl);
    const host = urlObj.hostname.toLowerCase();

    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      let videoId: string | undefined;
      if (host.includes('youtu.be')) {
        videoId = urlObj.pathname.slice(1).split('?')[0];
      } else {
        videoId = urlObj.searchParams.get('v') || undefined;
      }

      if (videoId) {
        const thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
        const duration = $('meta[itemprop="duration"]').attr('content') || undefined;

        const chapters: Array<{ title: string; time: string; seconds: number }> = [];
        const fullText = (rawHtml || '') + '\n' + $('body').text();
        const timestampRegex = /(?:^|\n)[ \t]*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[ \t]+([^\r\n]+)/g;
        let match;
        const seenTimes = new Set<string>();

        while ((match = timestampRegex.exec(fullText)) !== null) {
          const hours = match[1] ? parseInt(match[1], 10) : 0;
          const mins = parseInt(match[2], 10);
          const secs = parseInt(match[3], 10);
          const title = match[4].replace(/\s+/g, ' ').trim();
          const timeStr = match[1] ? `${match[1]}:${match[2]}:${match[3]}` : `${match[2]}:${match[3]}`;

          if (!seenTimes.has(timeStr) && title.length >= 2 && title.length <= 80) {
            seenTimes.add(timeStr);
            const totalSeconds = hours * 3600 + mins * 60 + secs;
            chapters.push({ title, time: timeStr, seconds: totalSeconds });
          }
        }

        return {
          type: 'youtube',
          videoId,
          thumbnail,
          duration,
          chapters: chapters.length > 0 ? chapters.sort((a, b) => a.seconds - b.seconds) : undefined,
        };
      }
    }

    const videoSrc = $('video source, video').attr('src');
    const ogVideo = $('meta[property="og:video"]').attr('content');
    if (videoSrc || ogVideo) {
      return {
        type: 'video',
        thumbnail: $('meta[property="og:image"]').attr('content') || undefined,
      };
    }
  } catch {}

  return undefined;
}

/** URL パターンマッチング (includePatterns / excludePatterns 用ワイルドカード対応) */
export function matchUrlPattern(targetUrl: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  let pathname = '';
  let filename = '';
  try {
    const u = new URL(targetUrl);
    pathname = u.pathname;
    filename = pathname.split('/').pop() || '';
  } catch {
    pathname = targetUrl;
    filename = targetUrl;
  }

  return patterns.some((pattern) => {
    let esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    esc = esc.replace(/\*\*/g, '___DOUBLE_STAR___');
    esc = esc.replace(/\*/g, '[^/]*');
    esc = esc.replace(/___DOUBLE_STAR___/g, '.*');
    const regexStr = '^' + esc + '$';
    try {
      const reg = new RegExp(regexStr);
      return reg.test(pathname) || reg.test(targetUrl) || reg.test(filename);
    } catch {
      return pathname.includes(pattern) || targetUrl.includes(pattern) || filename.includes(pattern);
    }
  });
}

// ==========================================
// 3. HTML -> Markdown 変換 (Readability & Token 最適化)
// ==========================================
export function convertHtmlToMarkdown(
  rawHtml: string,
  targetUrl: string,
  maxChars: number,
  isRendered = false,
  onlyMainContent = true,
  selectors?: Record<string, string>,
  removeSelectors?: string[],
  stripLinks?: boolean,
  filterLinkDensity?: boolean,
): {
  title: string;
  markdown: string;
  ogImage?: string;
  description?: string;
  publishedTime?: string;
  author?: string;
  siteName?: string;
  availability?: 'InStock' | 'OutOfStock' | 'PreOrder' | string;
  price?: string;
  priceCurrency?: string;
  brand?: string;
  sku?: string;
  isTruncated: boolean;
  links: string[];
  images?: ImageItem[];
  jsonLd?: any[];
  tables?: TableData[];
  extracted?: Record<string, string | null>;
  media?: MediaInfo;
  html?: string;
  estimatedTokens: number;
  quality?: number;
  completeness?: number;
  pageType?: 'article' | 'product' | 'qa' | 'generic';
  qualityReasons?: string[];
  missingFields?: string[];
  evidence?: Record<string, FieldEvidence>;
} {
  const $ = cheerio.load(rawHtml);

  // 1. JSON-LD の先行抽出 (script タグ削除前)
  const jsonLd: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const text = $(el).text().trim();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed) jsonLd.push(parsed);
      }
    } catch {}
  });

  // JSON-LD からのメタデータ（Schema.org）抽出
  const jsonLdMeta = extractMetadataFromJsonLd(jsonLd);

  // 2. メタデータの抽出 (OGP / JSON-LD / Standard Meta)
  const title =
    $('title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    targetUrl;

  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    jsonLdMeta.description ||
    undefined;

  const ogImage =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    jsonLdMeta.ogImage ||
    undefined;

  const publishedTime =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="pubdate"]').attr('content') ||
    $('meta[name="publish-date"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    jsonLdMeta.publishedTime ||
    undefined;

  const author =
    $('meta[name="author"]').attr('content') ||
    $('meta[property="article:author"]').attr('content') ||
    jsonLdMeta.author ||
    undefined;

  const siteName =
    $('meta[property="og:site_name"]').attr('content') ||
    jsonLdMeta.siteName ||
    undefined;

  const availability =
    jsonLdMeta.availability ||
    ($('meta[property="og:availability"]').attr('content')?.toLowerCase().includes('instock') ? 'InStock' : undefined);

  const price =
    jsonLdMeta.price ||
    $('meta[property="og:price:amount"]').attr('content') ||
    $('meta[property="product:price:amount"]').attr('content') ||
    undefined;

  const priceCurrency =
    jsonLdMeta.priceCurrency ||
    $('meta[property="og:price:currency"]').attr('content') ||
    $('meta[property="product:price:currency"]').attr('content') ||
    undefined;

  const brand = jsonLdMeta.brand || $('meta[property="og:brand"]').attr('content') || undefined;
  const sku = jsonLdMeta.sku || undefined;

  // 3. リンク一覧の抽出
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      try {
        const absUrl = new URL(href, targetUrl).href;
        if (absUrl.startsWith('http') && !links.includes(absUrl)) {
          links.push(absUrl);
        }
      } catch {}
    }
  });

  // 4. 画像一覧 & キャプション・メタデータの抽出
  const images: ImageItem[] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) {
      try {
        const absUrl = new URL(src, targetUrl).href;
        if (absUrl.startsWith('http') && !images.some((img) => img.url === absUrl)) {
          const $img = $(el);
          const alt = $img.attr('alt')?.trim() || undefined;
          const imgTitle = $img.attr('title')?.trim() || undefined;
          const widthStr = $img.attr('width');
          const heightStr = $img.attr('height');
          const width = widthStr ? parseInt(widthStr, 10) : undefined;
          const height = heightStr ? parseInt(heightStr, 10) : undefined;

          let caption: string | undefined = undefined;
          const figure = $img.closest('figure');
          if (figure.length > 0) {
            const figcaption = figure.find('figcaption').first().text().trim();
            if (figcaption) caption = figcaption;
          }

          const isMainImage = (ogImage && absUrl === ogImage) || images.length === 0;

          images.push({
            url: absUrl,
            alt,
            title: imgTitle,
            caption,
            isMainImage: isMainImage ? true : undefined,
            width: !isNaN(width as number) ? width : undefined,
            height: !isNaN(height as number) ? height : undefined,
          });
        }
      } catch {}
    }
  });

  // 5. 構造化テーブルの抽出
  const tables = extractTablesFromHtml($);

  // 6. YouTube / 動画メディアの抽出
  const media = extractMediaInfo($, targetUrl, rawHtml);

  // 7. ピンポイント セレクタ抽出
  const extracted = extractWithSelectors($, selectors, targetUrl);

  // 8. ノイズ要素 & Cookie 同意バナー & 不可視要素等のパージ
  const noiseSelectors = [
    'script',
    'style',
    'noscript',
    'iframe',
    'svg',
    '.ads',
    '.advertisement',
    '#cookie-banner',
    '.cookie-consent',
    '.onetrust-pc-dark-filter',
    '#onetrust-consent-sdk',
    '#CybotCookiebotDialog',
    '[hidden]',
    '[aria-hidden="true"]',
    '[style*="display:none"]',
    '[style*="display: none"]',
    '[style*="visibility:hidden"]',
    '[style*="visibility: hidden"]',
    '[style*="font-size:0"]',
    '[style*="font-size: 0"]',
    '[style*="opacity:0"]',
    '[style*="opacity: 0"]',
  ];
  if (removeSelectors && removeSelectors.length > 0) {
    noiseSelectors.push(...removeSelectors);
  }
  $(noiseSelectors.join(', ')).remove();

  // 8.1 構造化データ（InStock / OutOfStock）および CSS セマンティクスに基づく非表示バッジの剪定
  if (availability === 'InStock') {
    $(
      '.price__badge-sold-out, .badge--sold-out, [class*="badge-sold-out" i], [class*="badge--soldout" i], [class*="sold-out" i], [class*="out-of-stock" i], .sold-out-badge, .out-of-stock-badge'
    ).remove();
  } else if (availability === 'OutOfStock') {
    $(
      '.price__badge-sale, .badge--sale, [class*="badge-sale" i], .on-sale-badge'
    ).remove();
  }

  $('.price:not(.price--sold-out) .price__badge-sold-out, .price:not([class*="sold-out"]) [class*="sold-out"]').remove();
  $('.price.price--sold-out .price__badge-sale, .price[class*="sold-out"] [class*="sale"]').remove();

  // 8.5 コードブロックの言語情報保持
  $('pre code, pre').each((_, el) => {
    const cls = $(el).attr('class') || '';
    const match = cls.match(/(?:language|lang|highlight)-([a-zA-Z0-9_+-]+)/i);
    if (match) {
      $(el).attr('data-language', match[1]);
    }
  });

  // 9. Mozilla Readability による本文抽出
  let contentHtml = '';
  if (onlyMainContent) {
    try {
      const { document } = parseHTML($.html());
      const reader = new Readability(document);
      const article = reader.parse();
      if (article && article.content) {
        const bodyTextLen = $('body').text().replace(/\s+/g, ' ').trim().length;
        const articleTextLen = $(article.content).text().replace(/\s+/g, ' ').trim().length;
        const hasStructuredGrid = $('[role="grid"], [role="gridcell"], table, [class*="calendar"], [id*="calendar"], [data-test-id*="calendar"]').length > 0;

        if (hasStructuredGrid && articleTextLen < bodyTextLen * 0.4 && bodyTextLen > 200) {
          contentHtml = $('main').html() || $('article').html() || $('#content').html() || $('body').html() || '';
        } else {
          contentHtml = article.content;
        }
      }
    } catch {}
    if (!contentHtml) {
      contentHtml = $('main').html() || $('article').html() || $('#content').html() || $('body').html() || '';
    }
  } else {
    contentHtml = $('body').html() || $.html() || '';
  }

  // 10. Frontmatter の組み立て
  const frontmatterLines: string[] = [];
  if (publishedTime) frontmatterLines.push(`publishedTime: "${publishedTime}"`);
  if (author) frontmatterLines.push(`author: "${author}"`);
  if (siteName) frontmatterLines.push(`siteName: "${siteName}"`);
  if (availability) frontmatterLines.push(`availability: "${availability}"`);
  if (price) frontmatterLines.push(`price: "${price}${priceCurrency ? ' ' + priceCurrency : ''}"`);
  if (brand) frontmatterLines.push(`brand: "${brand}"`);
  if (sku) frontmatterLines.push(`sku: "${sku}"`);
  const header = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : '';

  // 11. HTML -> Markdown 変換 & クレンジング
  let markdown = header + turndown.turndown(contentHtml);
  markdown = cleanMarkdownTokens(markdown);

  if (stripLinks) {
    markdown = markdown.replace(/(?<!\!)\[([^\]]+)\]\([^)]+\)/g, '$1');
  }

  if (filterLinkDensity) {
    const blocks = markdown.split(/\n{2,}/);
    const filteredBlocks = blocks.filter((block) => {
      const trimmed = block.trim();
      if (trimmed.length === 0) return true;
      const linkMatches = trimmed.match(/\[([^\]]+)\]\([^)]+\)/g) || [];
      const linkLen = linkMatches.reduce((acc, m) => acc + m.length, 0);
      return linkLen / trimmed.length < 0.75;
    });
    markdown = filteredBlocks.join('\n\n');
  }

  const isTruncated = markdown.length > maxChars;
  const truncatedMarkdown = safeTruncateMarkdown(markdown, maxChars);
  const estimatedTokens = estimateTokens(truncatedMarkdown);

  // 品質・ページ種別・充足度・Evidence の算出
  const qualityRes = calculateContentQuality({
    markdown: truncatedMarkdown,
    title,
    description,
    jsonLd,
    html: rawHtml,
  });

  const pageType = detectPageType({
    jsonLd,
    meta: {
      'og:type': $('meta[property="og:type"]').attr('content') || '',
      'og:title': $('meta[property="og:title"]').attr('content') || '',
    },
    url: targetUrl,
    markdown: truncatedMarkdown,
  });

  const completenessRes = calculateExtractionCompleteness({
    pageType,
    title,
    content: truncatedMarkdown,
    publishedTime,
    author,
    price,
    availability,
    images,
    description,
  });

  const evidence = collectFieldEvidence({
    jsonLd,
    meta: {
      title,
      description,
      publishedTime,
      author,
      price,
      availability,
      siteName,
    },
    title,
    description,
    publishedTime,
    author,
    price,
    availability,
    siteName,
  });

  return {
    title,
    markdown: truncatedMarkdown,
    ogImage,
    description,
    publishedTime,
    author,
    siteName,
    availability,
    price,
    priceCurrency,
    brand,
    sku,
    isTruncated,
    links,
    images: images.length > 0 ? images : undefined,
    jsonLd: jsonLd.length > 0 ? jsonLd : undefined,
    tables: tables.length > 0 ? tables : undefined,
    extracted,
    media,
    html: rawHtml,
    estimatedTokens,
    quality: qualityRes.score,
    completeness: completenessRes.completeness,
    pageType,
    qualityReasons: qualityRes.reasons,
    missingFields: completenessRes.missingFields,
    evidence,
  };
}
