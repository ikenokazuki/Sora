import { promises as dnsPromises } from 'dns';
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
    // 7. ゼロ幅文字・不可視制御文字の除去 (間接プロンプトインジェクション緩和)
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060]/g, '')
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

/** Webhook URL の SSRF 安全性検証 (ホスト名 & DNS 解決後 IP の二重チェック) */
async function isSafeWebhookUrl(urlStr: string): Promise<boolean> {
  if (process.env.ALLOW_LOCAL_FETCH === 'true') return true;
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const h = u.hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
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
      h === 'metadata.google.internal' ||
      h === 'metadata.internal' ||
      h === 'instance-data' ||
      h.startsWith('10.') ||
      h.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h) ||
      h.startsWith('169.254.') ||
      h.startsWith('fc') ||
      h.startsWith('fd') ||
      h.startsWith('fe80:') ||
      h.startsWith('ff')
    ) {
      return false;
    }
    const addresses = await dnsPromises.lookup(h, { all: true });
    for (const addr of addresses) {
      const a = addr.address.toLowerCase().trim().replace(/^\[|\]$/g, '');
      if (
        a === '127.0.0.1' ||
        a === '::1' ||
        a === '0.0.0.0' ||
        a === '::' ||
        a === '169.254.169.254' ||
        a.startsWith('10.') ||
        a.startsWith('192.168.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(a) ||
        a.startsWith('169.254.') ||
        a.startsWith('fc') ||
        a.startsWith('fd') ||
        a.startsWith('fe80:') ||
        a.startsWith('ff')
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** 長時間ジョブ完了時の Webhook コールバック非同期送信 (Fire-and-forget & SSRF Protected) */
export async function sendWebhookNotification(webhookUrl?: string, payload?: any): Promise<void> {
  if (!webhookUrl || typeof webhookUrl !== 'string') return;

  const isSafe = await isSafeWebhookUrl(webhookUrl);
  if (!isSafe) {
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

/** リンクの健全性・到達性並行検証 (HEAD / GET & SSRF Protected) */
export async function validateExtractedLinks(links: string[], timeoutMs = 3000, limit = 15): Promise<LinkStatus[]> {
  if (!links || links.length === 0) return [];
  const targetLinks = links.slice(0, limit);

  const results = await Promise.all(
    targetLinks.map(async (url) => {
      try {
        const isSafe = await isSafeWebhookUrl(url);
        if (!isSafe) {
          return {
            url,
            status: 403,
            ok: false,
          };
        }
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

export interface ParsedSection {
  rawHeading: string;
  heading: string;
  headingLevel: number;
  paragraphs: string[];
  fullText: string;
  charLength: number;
  startIndex: number;
}

/** クエリ関連ハイライト抽出 (Fielded BM25F + BM25+ & Adaptive Section Cohesion) */
export function extractQueryHighlights(content: string, query: string, maxHighlights = 3): string[] {
  if (!query || !content) return [];

  const cleanQuery = query.toLowerCase().trim();
  const rawTerms = cleanQuery.split(/\s+/).filter((t) => t.length >= 2);

  const termSet = new Set<string>();
  for (const t of rawTerms) termSet.add(t);

  // 日本語形態素単語分割 (Intl.Segmenter)
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

  // 1. Markdown をセクション（見出し階層）と段落ツリーに構造化パース
  const lines = content.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let currentRawHeading = '';
  let currentHeading = '';
  let currentHeadingLevel = 0;
  let currentParagraphLines: string[] = [];
  let currentSectionParagraphs: string[] = [];
  let sectionStartIndex = 0;

  const flushParagraph = () => {
    if (currentParagraphLines.length > 0) {
      const text = currentParagraphLines.join('\n').trim();
      if (text.length > 0 && !text.startsWith('---')) {
        currentSectionParagraphs.push(text);
      }
      currentParagraphLines = [];
    }
  };

  const flushSection = () => {
    flushParagraph();
    if (currentSectionParagraphs.length > 0 || currentHeading.length > 0) {
      const fullText = currentSectionParagraphs.join('\n\n').trim();
      if (fullText.length > 0) {
        sections.push({
          rawHeading: currentRawHeading,
          heading: currentHeading,
          headingLevel: currentHeadingLevel,
          paragraphs: [...currentSectionParagraphs],
          fullText,
          charLength: fullText.length,
          startIndex: sectionStartIndex++,
        });
      }
      currentSectionParagraphs = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushSection();
      currentHeadingLevel = headingMatch[1].length;
      currentRawHeading = line;
      currentHeading = headingMatch[2].trim();
    } else if (line === '') {
      flushParagraph();
    } else {
      currentParagraphLines.push(rawLine);
    }
  }
  flushSection();

  if (sections.length === 0) return [];

  const avgBodyLen = sections.reduce((acc, s) => acc + s.charLength, 0) / sections.length || 100;
  const avgHeadingLen = sections.filter((s) => s.heading.length > 0).reduce((acc, s) => acc + s.heading.length, 0) / Math.max(sections.length, 1) || 10;

  // BM25F パラメータ
  const k1 = 1.2;
  const delta = 0.8; // BM25+ 長文過剰ペナルティ防止
  const wHeading = 3.5;
  const bHeading = 0.5;
  const wBody = 1.0;
  const bBody = 0.75;

  interface CandidateHighlight {
    text: string;
    score: number;
    heading: string;
    sectionIndex: number;
  }

  const candidates: CandidateHighlight[] = [];

  for (const section of sections) {
    const lowerHeading = section.heading.toLowerCase();
    const lowerBody = section.fullText.toLowerCase();

    // 各単語の重み付きフィールド頻度 (BM25F)
    let totalWeightedTf = 0;
    let distinctTermsMatched = 0;
    const allTermPositions: number[] = [];

    for (const term of terms) {
      const termRegex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      
      // Heading Field
      let countHeading = 0;
      if (lowerHeading.length > 0) {
        const matchesH = lowerHeading.match(termRegex);
        if (matchesH) countHeading = matchesH.length;
      }

      // Body Field
      let countBody = 0;
      let m: RegExpExecArray | null;
      while ((m = termRegex.exec(lowerBody)) !== null) {
        countBody++;
        allTermPositions.push(m.index);
      }

      if (countHeading > 0 || countBody > 0) {
        distinctTermsMatched++;
        const normH = countHeading > 0 ? (countHeading / (1 - bHeading + bHeading * (lowerHeading.length / Math.max(avgHeadingLen, 5)))) : 0;
        const normB = countBody > 0 ? (countBody / (1 - bBody + bBody * (section.charLength / Math.max(avgBodyLen, 50)))) : 0;
        const termLengthWeight = term.length >= 4 ? 1.5 : 1.0;
        const weightedTf = (wHeading * normH + wBody * normB) * termLengthWeight;
        totalWeightedTf += weightedTf;
      }
    }

    if (totalWeightedTf === 0) continue;

    // BM25F + BM25+ スコア算出
    let score = ((totalWeightedTf * (k1 + 1)) / (totalWeightedTf + k1)) + delta;

    // 複数単語一致の幾何級数ブースト
    if (distinctTermsMatched > 1) {
      score *= Math.pow(distinctTermsMatched, 1.4);
    }

    // クエリフレーズ完全一致ボーナス
    if (cleanQuery.length >= 4 && (lowerHeading.includes(cleanQuery) || lowerBody.includes(cleanQuery))) {
      score += 6.0;
    }

    // 複合語・フレーズ一致ボーナス
    for (const rawT of rawTerms) {
      if (rawT.length >= 3 && lowerHeading.includes(rawT)) {
        score += 3.5;
      }
    }

    // 語順・隣接度ボーナス (Left-to-Right Word Order Consistency)
    if (rawTerms.length >= 2) {
      let orderBonus = 0;
      for (let i = 0; i < rawTerms.length - 1; i++) {
        const t1 = rawTerms[i];
        const t2 = rawTerms[i + 1];
        const p1 = lowerBody.indexOf(t1);
        const p2 = lowerBody.indexOf(t2, p1 >= 0 ? p1 : 0);
        if (p1 >= 0 && p2 > p1) {
          const dist = p2 - (p1 + t1.length);
          if (dist < 50) {
            orderBonus += 2.5 * (1 - dist / 50);
          }
        }
      }
      score += orderBonus;
    }

    // 鮮度バイアス (年号・日付検知)
    const currentYear = new Date().getFullYear();
    const hasRecentYear = lowerBody.includes(String(currentYear)) || lowerBody.includes(String(currentYear + 1));
    if (hasRecentYear) {
      score += 0.8;
    }

    // 近接度ボーナス (Proximity Span)
    if (allTermPositions.length >= 2) {
      allTermPositions.sort((a, b) => a - b);
      const span = allTermPositions[allTermPositions.length - 1] - allTermPositions[0];
      if (span < 200) {
        score += 2.5 * (1 - span / 200);
      }
    }

    // スニペット構築: 適応型セクション集約 & 文境界スナッピング (Sentence Boundary Snapping)
    let snippetText = '';
    const headingPrefix = section.rawHeading ? `${section.rawHeading}\n\n` : '';

    // セクション長が適正（〜800文字）または見出しが直接マッチしている場合（〜1200文字まで）は完全抽出
    const isHeadingMatched = rawTerms.some((t) => lowerHeading.includes(t));
    if (section.charLength <= 800 || (isHeadingMatched && section.charLength <= 1200)) {
      snippetText = headingPrefix + section.fullText;
    } else {
      // 長文セクションの場合: マッチ密度の最も高い段落クラスタ（KWIC ウィンドウ）を文境界で自然に抽出
      if (allTermPositions.length > 0) {
        const medianPos = allTermPositions[Math.floor(allTermPositions.length / 2)];
        let start = Math.max(0, medianPos - 180);
        let end = Math.min(section.fullText.length, medianPos + 250);

        // 句読点・文境界スナッピング（文の途中でのブツ切りを防止）
        const boundaryChars = /[\n。！？!?]/;
        for (let i = start; i >= Math.max(0, start - 60); i--) {
          if (boundaryChars.test(section.fullText[i])) {
            start = i + 1;
            break;
          }
        }
        for (let i = end; i < Math.min(section.fullText.length, end + 80); i++) {
          if (boundaryChars.test(section.fullText[i])) {
            end = i + 1;
            break;
          }
        }

        const sliced = (start > 0 ? '...' : '') +
          section.fullText.slice(start, end).trim() +
          (end < section.fullText.length ? '...' : '');
        snippetText = headingPrefix + sliced;
      } else {
        snippetText = headingPrefix + section.fullText.slice(0, 400) + '...';
      }
    }

    candidates.push({
      text: snippetText.trim(),
      score,
      heading: section.heading,
      sectionIndex: section.startIndex,
    });
  }

  if (candidates.length === 0) return [];

  // スコア順にソート
  candidates.sort((a, b) => b.score - a.score);

  // MMR (Maximal Marginal Relevance) + Information Gain (情報獲得量) による多様性選択
  const selected: CandidateHighlight[] = [];
  const selectedHeadings = new Set<string>();
  const coveredWords = new Set<string>();

  for (const cand of candidates) {
    if (selected.length >= maxHighlights) break;

    // 1. 同一見出しからの重複ペナルティ
    const isHeadingDuplicate = cand.heading && selectedHeadings.has(cand.heading);
    if (isHeadingDuplicate && candidates.some((c) => c.heading && !selectedHeadings.has(c.heading) && c.score > cand.score * 0.4)) {
      continue;
    }

    // 2. Information Gain (新規語の保有量)
    const candWords = (cand.text.toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\w]{2,}/gu) || []);
    let newWordCount = 0;
    for (const w of candWords) {
      if (!coveredWords.has(w)) newWordCount++;
    }

    // 既出情報との重複が85%を超える場合はスキップ (Information Gain < 15%)
    if (selected.length > 0 && candWords.length >= 10 && (newWordCount / candWords.length) < 0.15) {
      continue;
    }

    selected.push(cand);
    if (cand.heading) selectedHeadings.add(cand.heading);
    for (const w of candWords) coveredWords.add(w);
  }

  // 枠に余りがある場合は残りの高スコア候補で埋める
  if (selected.length < maxHighlights) {
    for (const cand of candidates) {
      if (selected.length >= maxHighlights) break;
      if (!selected.includes(cand)) {
        selected.push(cand);
      }
    }
  }

  return selected.map((s) => s.text);
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

/** 検索結果アイテムの BM25+ 多信号リランキング (Title, Snippet, Exact Match, Domain Trust) */
export function rerankSearchResults<T extends { title?: string; snippet?: string; url?: string; content?: string }>(
  items: T[],
  query: string,
): T[] {
  if (!items || items.length <= 1 || !query) return items;

  const termSet = new Set<string>();
  try {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    for (const segment of segmenter.segment(query)) {
      if (segment.isWordLike) {
        const word = segment.segment.toLowerCase().trim();
        if (word.length >= 2) termSet.add(word);
      }
    }
  } catch {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    for (const w of words) termSet.add(w);
  }

  const terms = Array.from(termSet);
  if (terms.length === 0) return items;

  const lowerQuery = query.toLowerCase().trim();

  const scored = items.map((item, originalIndex) => {
    const title = (item.title || '').toLowerCase();
    const snippet = (item.snippet || item.content || '').toLowerCase();
    const urlStr = (item.url || '').toLowerCase();

    let score = 0;

    // 1. 完全一致ボーナス
    if (title.includes(lowerQuery)) score += 5.0;
    if (snippet.includes(lowerQuery)) score += 2.5;

    // 2. 単語マッチング (タイトル加重 3.0, 本文加重 1.0)
    let titleMatches = 0;
    let snippetMatches = 0;

    for (const term of terms) {
      if (title.includes(term)) {
        titleMatches++;
        score += term.length >= 4 ? 3.5 : 2.0;
      }
      if (snippet.includes(term)) {
        snippetMatches++;
        score += term.length >= 4 ? 1.5 : 0.8;
      }
    }

    // 3. ドメイン信頼度スコア (.gov, .go.jp, .ac.jp, .org ブースト)
    if (urlStr.includes('.go.jp/') || urlStr.includes('.gov/')) score += 2.0;
    if (urlStr.includes('.ac.jp/') || urlStr.includes('.edu/')) score += 1.5;
    if (urlStr.includes('.org/')) score += 0.5;

    // 4. 語順整合ボーナス (Word Order Consistency)
    if (terms.length >= 2) {
      for (let i = 0; i < terms.length - 1; i++) {
        const t1 = terms[i];
        const t2 = terms[i + 1];
        const p1 = title.indexOf(t1);
        const p2 = title.indexOf(t2, p1 >= 0 ? p1 : 0);
        if (p1 >= 0 && p2 > p1 && (p2 - p1) < 40) {
          score += 2.0;
        }
      }
    }

    // 5. 元の検索エンジンの初期順位の僅かなバイアス (同点時の順序維持)
    score += (items.length - originalIndex) * 0.05;

    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/**
 * W3C Scroll to Text Fragment URL 生成 (Chromium / Google 標準)
 * 形式: https://example.com/page#:~:text=[prefix-,]textStart[,textEnd][,-suffix]
 */
export function generateTextFragmentUrl(baseUrl: string, snippet: string): string {
  if (!baseUrl || !snippet) return baseUrl;

  // 1. Markdown 記法・見出し・装飾文字・制御文字をパージ
  const cleanSnippet = snippet
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~[\]()]/g, ' ')
    .replace(/〈|〉|■|・|👏|×\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanSnippet.length < 5) return baseUrl;

  // 2. 句点・改行・記号で文を分割し、意味のある開始フレーズと終了フレーズを抽出
  const sentences = cleanSnippet
    .split(/[。！？!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);

  let textStart = '';
  let textEnd = '';

  if (sentences.length === 0) {
    textStart = cleanSnippet.slice(0, 30).trim();
  } else if (sentences.length === 1) {
    const s = sentences[0];
    if (s.length <= 40) {
      textStart = s;
    } else {
      textStart = s.slice(0, 20).trim();
      textEnd = s.slice(-20).trim();
    }
  } else {
    textStart = sentences[0].slice(0, 25).trim();
    textEnd = sentences[sentences.length - 1].slice(-25).trim();
  }

  try {
    const urlObj = new URL(baseUrl);
    urlObj.hash = '';

    const startEncoded = encodeURIComponent(textStart);
    let fragment = `#:~:text=${startEncoded}`;
    if (textEnd && textEnd !== textStart) {
      const endEncoded = encodeURIComponent(textEnd);
      fragment += `,${endEncoded}`;
    }

    return `${urlObj.href}${fragment}`;
  } catch {
    return baseUrl;
  }
}

/**
 * Meta Description vs Dynamic Snippet Arbiter (Google 流 最適説明文選定)
 * meta.description がクエリ主要語を含まない固定定型文である場合、本文から抽出した動的ハイライトを優先
 */
export function chooseBestDescription(
  metaDesc: string | undefined,
  dynamicSnippet: string | undefined,
  query: string,
): string | undefined {
  if (!metaDesc && !dynamicSnippet) return undefined;
  if (!dynamicSnippet) return metaDesc;
  if (!metaDesc) {
    return dynamicSnippet
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\s+/g, ' ')
      .slice(0, 250)
      .trim();
  }
  if (!query) return metaDesc;

  const cleanQuery = query.toLowerCase().trim();
  const rawTerms = cleanQuery.split(/\s+/).filter((t) => t.length >= 2);
  const lowerMeta = metaDesc.toLowerCase();

  // Meta Description 内のクエリ単語カバー率を計算
  let metaMatchedCount = 0;
  for (const term of rawTerms) {
    if (lowerMeta.includes(term)) metaMatchedCount++;
  }

  // Meta Description がクエリの半分以上の単語をカバーしており、かつ適正長の場合は著者の Meta を尊重
  const coverage = rawTerms.length > 0 ? metaMatchedCount / rawTerms.length : 1;
  if (coverage >= 0.66 && metaDesc.length >= 40 && metaDesc.length <= 300) {
    return metaDesc;
  }

  // クエリ単語が不足している、またはサイト共通ボイラープレートの疑いがある場合は本文動的スニペットを採用
  return dynamicSnippet
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .slice(0, 250)
    .trim();
}
