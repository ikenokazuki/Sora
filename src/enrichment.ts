import type {
  Citation,
  MarkdownChunk,
  LinkStatus,
  ScrapeResult,
  TableData,
  MediaInfo,
} from './types.js';

/** テキストの推定トークン数を算出（日本語は1.3文字/トークン、英語は4文字/トークン） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  const nonCjkChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 0.77 + nonCjkChars * 0.25);
}

/** Markdown 構文（コードブロックやテーブル）を壊さずに安全に切り詰める */
export function safeTruncateMarkdown(markdown: string, maxChars: number): string {
  if (!markdown || markdown.length <= maxChars) return markdown;

  let sliced = markdown.slice(0, maxChars);

  // 1. コードブロック (```) の開始・終了バランスを調整
  const codeBlockCount = (sliced.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    sliced += '\n```';
  }

  // 2. テーブル行の途中で切れた場合の補正
  const lines = sliced.split('\n');
  const lastLine = lines[lines.length - 1];
  if (lastLine.trim().startsWith('|') && !lastLine.trim().endsWith('|')) {
    lines.pop();
    sliced = lines.join('\n');
  }

  return sliced;
}

/** 不要な空リンク、無効な JavaScript リンク、連続空行をパージしてトークンを削減 */
export function cleanMarkdownTokens(markdown: string): string {
  if (!markdown) return '';
  return markdown
    // 1. 空の Markdown リンクの除去: [](url), [ ](url), [&nbsp;](url)
    .replace(/\[(?:\s|&nbsp;)*\]\([^)]*\)/g, '')
    // 2. javascript: 疑似リンクのテキスト化: [Click](javascript:void(0)) -> Click
    .replace(/\[([^\]]+)\]\(javascript:[^)]*\)/gi, '$1')
    // 3. 空の画像タグの除去: ![](url), ![] (url)
    .replace(/!\[(?:\s|&nbsp;)*\]\s*\([^)]*\)/g, '')
    // 4. 空白のみの行を完全な空行に統一
    .replace(/^[ \t]+$/gm, '')
    // 5. 3連続以上の空行を2行に圧縮
    .replace(/\n{3,}/g, '\n\n')
    // 6. 行末の不要な半角スペースを除去
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** 超高速 抽出型自動要約 (重要文抽出 / TL;DR) */
export function generateExtractiveSummary(text: string, maxSentences = 4): string[] {
  if (!text || text.trim().length === 0) return [];
  const rawSentences = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？\n])|(?<=\.\s+)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 15 && s.length <= 250 && !s.startsWith('#') && !s.startsWith('|') && !s.startsWith('```'));

  if (rawSentences.length <= maxSentences) return rawSentences;

  const wordFreq = new Map<string, number>();
  const words = text.toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\w]{2,}/gu) || [];
  for (const w of words) {
    wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
  }

  const scored = rawSentences.map((sentence, idx) => {
    const sWords = sentence.toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\w]{2,}/gu) || [];
    let score = 0;
    for (const w of sWords) {
      score += wordFreq.get(w) || 0;
    }
    const positionBoost = idx < 3 ? 1.5 : idx > rawSentences.length - 3 ? 1.2 : 1.0;
    const finalScore = (score / Math.max(sWords.length, 1)) * positionBoost;
    return { sentence, idx, score: finalScore };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.sentence);
}

/** N-gram Jaccard 類似度による検索結果の重複排除 */
export function dedupSearchResults<T>(
  items: T[],
  getText: (item: T) => string,
  threshold = 0.65,
): T[] {
  if (!items || items.length <= 1) return items;

  const getBigrams = (str: string): Set<string> => {
    const s = str.toLowerCase().replace(/\s+/g, '');
    const grams = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      grams.add(s.slice(i, i + 2));
    }
    return grams;
  };

  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const g of a) {
      if (b.has(g)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  };

  const result: T[] = [];
  const gramList: Array<Set<string>> = [];

  for (const item of items) {
    const text = getText(item);
    const itemGrams = getBigrams(text);
    let isDuplicate = false;

    for (const existingGrams of gramList) {
      if (jaccard(itemGrams, existingGrams) >= threshold) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      result.push(item);
      gramList.push(itemGrams);
    }
  }

  return result;
}

/** Luhn アルゴリズムによるクレジットカード番号チェック */
function isValidCreditCardNumber(numStr: string): boolean {
  const digits = numStr.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let isEven = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }
  return sum % 10 === 0;
}

/** PII (個人情報・機密情報) の自動マスキング */
export function maskPiiInText(text: string): string {
  if (!text) return text;
  let masked = text;

  // 1. メールアドレス
  masked = masked.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[EMAIL]');

  // 2. クレジットカード番号 (13〜19桁, Luhn 検証または一般的な4桁x4ブロック)
  masked = masked.replace(/\b(?:\d{4}[ -]?){3}\d{4}\b|\b\d{4}[ -]?\d{6}[ -]?\d{5}\b/g, (match) => {
    return isValidCreditCardNumber(match) ? '[CREDIT_CARD]' : match;
  });

  // 3. 日本の電話番号 (携帯・固定)
  masked = masked.replace(/\b(?:\+?81[- ]?|0)(?:[789]0[- ]?\d{4}[- ]?\d{4}|[1-9]\d{0,3}[- ]?\d{1,4}[- ]?\d{4})\b/g, '[PHONE]');

  return masked;
}

/** LLM 最適化プロンプトコンテキスト XML 生成 */
export function generatePromptContext(result: ScrapeResult): string {
  const attrs: string[] = [
    `url="${result.url}"`,
    `title="${result.title.replace(/"/g, '&quot;')}"`,
  ];
  if (result.siteName) attrs.push(`site_name="${result.siteName.replace(/"/g, '&quot;')}"`);
  if (result.publishedTime) attrs.push(`published_time="${result.publishedTime}"`);
  if (result.author) attrs.push(`author="${result.author.replace(/"/g, '&quot;')}"`);

  let context = `<web_page ${attrs.join(' ')}>\n`;
  if (result.summary && result.summary.length > 0) {
    context += `<summary>\n${result.summary.map((s) => `- ${s}`).join('\n')}\n</summary>\n\n`;
  }
  context += `${result.content}\n</web_page>`;
  return context;
}

/** 検索キーワードの Markdown 本文自動強調 (<mark>単語</mark>) */
export function highlightQueryMatchesInMarkdown(markdown: string, query: string): string {
  if (!markdown || !query) return markdown;
  const terms = query
    .toLowerCase()
    .replace(/[+&|()!^"~*?:\\/]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  if (terms.length === 0) return markdown;

  let inCodeBlock = false;
  const lines = markdown.split('\n');

  const highlightedLines = lines.map((line) => {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (inCodeBlock || line.trim().startsWith('---') || line.trim().startsWith('http')) {
      return line;
    }

    let modified = line;
    for (const term of terms) {
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?<!<[^>]*)(?<!\\[[^\\]]*)(?<!\\([^\\)]*)(${esc})(?![^<]*>)(?![^\\[]*\\])(?![^\\(]*\\))`, 'gi');
      modified = modified.replace(regex, '<mark>$1</mark>');
    }
    return modified;
  });

  return highlightedLines.join('\n');
}

/** 本文の文字数・単語数・推定読了時間 (分) の算出 */
export function calculateContentStats(text: string): {
  characterCount: number;
  wordCount: number;
  readingTimeMin: number;
} {
  if (!text) return { characterCount: 0, wordCount: 0, readingTimeMin: 1 };
  const characterCount = text.length;

  // 英単語と日本語文字をカウント
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // 日本語 500文字/分、英語 200単語/分換算
  const isMainlyJapanese = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
  const estimatedMin = isMainlyJapanese
    ? Math.ceil(characterCount / 500)
    : Math.ceil(wordCount / 200);

  return {
    characterCount,
    wordCount,
    readingTimeMin: Math.max(1, estimatedMin),
  };
}

/** 本文内 出典・引用リンク (Citations) の構造化抽出 */
export function extractCitationsFromMarkdown(markdown: string, baseUrl?: string): Citation[] {
  if (!markdown) return [];
  const citations: Citation[] = [];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g;
  const seenUrls = new Set<string>();

  // 段落単位で走査し、コンテキスト文を取得
  const paragraphs = markdown.split(/\n\s*\n/);

  for (const para of paragraphs) {
    let match;
    while ((match = linkRegex.exec(para)) !== null) {
      const text = match[1].trim();
      const url = match[2].trim();

      // 画像リンクや同ドメイン内アンカーを除外
      if (text.startsWith('!') || text.length === 0 || seenUrls.has(url)) continue;

      seenUrls.add(url);
      const context = para.replace(/\s+/g, ' ').trim().slice(0, 150);

      citations.push({
        text,
        url,
        context: context.length > 0 ? context : undefined,
      });
    }
  }

  return citations;
}

/** Webhook URL の SSRF 安全性検証 */
function isBlockedWebhookUrl(urlStr: string): boolean {
  if (process.env.ALLOW_LOCAL_FETCH === 'true') return false;
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return true;
    const h = u.hostname.toLowerCase().trim();
    if (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      h === '::' ||
      h === '0.0.0.0' ||
      h.endsWith('.localhost') ||
      h.endsWith('.local') ||
      h.endsWith('.internal') ||
      h === '169.254.169.254' ||
      h === 'metadata.google.internal'
    ) {
      return true;
    }
    if (h.startsWith('10.') || h.startsWith('192.168.') || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) {
      return true;
    }
    if (h.startsWith('169.254.') || h.startsWith('fc') || h.startsWith('fe80:')) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** 長時間ジョブ完了時の Webhook コールバック非同期送信 (Fire-and-forget & SSRF Protected) */
export async function sendWebhookNotification(webhookUrl?: string, payload?: any): Promise<void> {
  if (!webhookUrl || typeof webhookUrl !== 'string') return;

  if (isBlockedWebhookUrl(webhookUrl)) {
    console.warn(`[web-fetcher/webhook] Blocked SSRF attempt to private/internal webhook destination: ${webhookUrl}`);
    return;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Sora-Webhook-Notifier/1.0',
      },
      body: JSON.stringify({
        event: 'scrape.completed',
        timestamp: new Date().toISOString(),
        data: payload,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[web-fetcher/webhook] Failed to send webhook to ${webhookUrl}: HTTP ${res.status}`);
    }
  } catch (err: any) {
    console.warn(`[web-fetcher/webhook] Error sending webhook to ${webhookUrl}:`, err?.message);
  }
}

/** RAG 最適化セマンティック・チャンキング */
export function chunkMarkdownContent(markdown: string, maxChunkChars = 1000): MarkdownChunk[] {
  if (!markdown) return [];
  const lines = markdown.split('\n');
  const chunks: MarkdownChunk[] = [];

  let chunkHeading: string | undefined = undefined;
  let activeHeading: string | undefined = undefined;
  let currentChunkLines: string[] = [];
  let currentChunkLen = 0;

  const flushChunk = () => {
    if (currentChunkLines.length === 0) return;
    const content = currentChunkLines.join('\n').trim();
    if (content.length > 0) {
      chunks.push({
        index: chunks.length,
        heading: chunkHeading,
        content,
        estimatedTokens: estimateTokens(content),
      });
    }
    currentChunkLines = [];
    currentChunkLen = 0;
    chunkHeading = activeHeading;
  };

  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    const headingMatch = !inCodeBlock ? line.match(/^(#{1,4})\s+(.+)/) : null;
    if (headingMatch) {
      if (currentChunkLines.length > 0) {
        flushChunk();
      }
      activeHeading = headingMatch[2].trim();
      chunkHeading = activeHeading;
    }

    currentChunkLines.push(line);
    currentChunkLen += line.length + 1;

    if (currentChunkLen >= maxChunkChars && !inCodeBlock && line.trim() === '') {
      flushChunk();
    }
  }

  flushChunk();
  return chunks;
}

/** リンクの健全性・到達性並行検証 (HEAD / GET) */
export async function validateExtractedLinks(links: string[], timeoutMs = 3000, limit = 15): Promise<LinkStatus[]> {
  if (!links || links.length === 0) return [];
  const targetLinks = links.slice(0, limit);

  const results = await Promise.all(
    targetLinks.map(async (url) => {
      try {
        let res = await fetch(url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Sora-LinkValidator/1.0)' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 405 || res.status === 501) {
          res = await fetch(url, {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Sora-LinkValidator/1.0)' },
            signal: AbortSignal.timeout(timeoutMs),
          });
        }
        return {
          url,
          status: res.status,
          ok: res.ok,
        };
      } catch {
        return {
          url,
          status: 0,
          ok: false,
        };
      }
    }),
  );

  return results;
}

/** クエリ関連ハイライト抽出 (Structure & Proximity-Aware BM25+) */
export function extractQueryHighlights(content: string, query: string, maxHighlights = 3): string[] {
  if (!query || !content) return [];

  const cleanQuery = query.toLowerCase().trim();
  const rawTerms = cleanQuery.split(/\s+/).filter((t) => t.length >= 2);

  const termSet = new Set<string>();
  for (const t of rawTerms) termSet.add(t);

  try {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    for (const segment of segmenter.segment(query)) {
      if (segment.isWordLike) {
        const word = segment.segment.toLowerCase().trim();
        if (word.length >= 2) {
          termSet.add(word);
        }
      }
    }
  } catch {}

  const terms = Array.from(termSet);
  if (terms.length === 0) return [];

  const lines = content.split(/\r?\n/);
  let currentHeading = '';
  const parsedSections: { text: string; heading: string; index: number }[] = [];
  let currentParagraphLines: string[] = [];
  let sectionIndex = 0;

  const flushParagraph = () => {
    if (currentParagraphLines.length > 0) {
      const text = currentParagraphLines.join('\n').trim();
      if (text.length >= 10 && !text.startsWith('---')) {
        parsedSections.push({ text, heading: currentHeading, index: sectionIndex++ });
      }
      currentParagraphLines = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,6}\s+/.test(line)) {
      flushParagraph();
      currentHeading = line.replace(/^#{1,6}\s+/, '').trim();
    } else if (line === '') {
      flushParagraph();
    } else {
      currentParagraphLines.push(line);
    }
  }
  flushParagraph();

  if (parsedSections.length === 0) return [];

  const avgParaLength = parsedSections.reduce((acc, s) => acc + s.text.length, 0) / parsedSections.length;
  const scored: { text: string; score: number }[] = [];

  for (const section of parsedSections) {
    const para = section.text;
    const lowerPara = para.toLowerCase();
    const lowerHeading = section.heading.toLowerCase();

    let termMatchCount = 0;
    let distinctTermsMatched = 0;
    const termPositions: number[] = [];

    for (const term of terms) {
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      let match: RegExpExecArray | null;
      let count = 0;
      while ((match = regex.exec(lowerPara)) !== null) {
        count++;
        termPositions.push(match.index);
      }

      if (count > 0) {
        const weight = term.length >= 4 ? 1.8 : 1.0;
        termMatchCount += count * weight;
        distinctTermsMatched++;
      }
    }

    if (termMatchCount === 0 && !terms.some((t) => lowerHeading.includes(t))) {
      continue;
    }

    const k1 = 1.2;
    const b = 0.75;
    const delta = 0.5;
    const lenNorm = 1 - b + b * (para.length / Math.max(avgParaLength, 50));
    let baseScore = ((termMatchCount * (k1 + 1)) / (termMatchCount + k1 * lenNorm)) + delta;

    if (distinctTermsMatched > 1) {
      baseScore *= Math.pow(distinctTermsMatched, 1.5);
    }

    if (lowerHeading) {
      let headingMatches = 0;
      for (const term of terms) {
        if (lowerHeading.includes(term)) headingMatches++;
      }
      if (headingMatches > 0) {
        baseScore += headingMatches * 2.5;
      }
    }

    if (cleanQuery.length >= 4 && lowerPara.includes(cleanQuery)) {
      baseScore += 4.0;
    }

    if (termPositions.length >= 2) {
      termPositions.sort((a, b) => a - b);
      const minSpan = termPositions[termPositions.length - 1] - termPositions[0];
      if (minSpan < 150) {
        baseScore += 2.0 * (1 - minSpan / 150);
      }
    }

    const positionWeight = Math.max(1.0, 1.25 - (section.index / parsedSections.length) * 0.25);
    const finalScore = baseScore * positionWeight;

    let snippet = para;
    if (para.length > 320 && termPositions.length > 0) {
      const medianPos = termPositions[Math.floor(termPositions.length / 2)];
      const start = Math.max(0, medianPos - 120);
      const end = Math.min(para.length, medianPos + 180);

      snippet = (start > 0 ? '...' : '') +
        para.slice(start, end).trim() +
        (end < para.length ? '...' : '');
    } else if (para.length > 320) {
      snippet = para.slice(0, 320) + '...';
    }

    scored.push({ text: snippet, score: finalScore });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxHighlights).map((s) => s.text);
}

/** ドメインフィルタリング (includeDomains / excludeDomains) */
export function filterByDomains(
  items: any[],
  includeDomains?: string[],
  excludeDomains?: string[],
): any[] {
  let filtered = items;

  if (includeDomains && includeDomains.length > 0) {
    const normalizedInc = includeDomains.map((d) => d.toLowerCase().trim());
    filtered = filtered.filter((item) => {
      const itemUrl = item.url || item.link;
      if (!itemUrl) return false;
      try {
        const host = new URL(itemUrl).hostname.toLowerCase();
        return normalizedInc.some((inc) => host === inc || host.endsWith('.' + inc));
      } catch {
        return false;
      }
    });
  }

  if (excludeDomains && excludeDomains.length > 0) {
    const normalizedExc = excludeDomains.map((d) => d.toLowerCase().trim());
    filtered = filtered.filter((item) => {
      const itemUrl = item.url || item.link;
      if (!itemUrl) return true;
      try {
        const host = new URL(itemUrl).hostname.toLowerCase();
        return !normalizedExc.some((exc) => host === exc || host.endsWith('.' + exc));
      } catch {
        return true;
      }
    });
  }

  return filtered;
}
