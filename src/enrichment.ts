import { promises as dnsPromises } from 'dns';
import { isBlockedHostname, isPrivateIp } from './browser_engine.js';
import { parseBlocks, scorePassage, extractTermsWithBigrams, dinkelbachOptimalPassage, type HeadingBlock } from './extractor/hierarchical_bm25.js';
import {
  assignBlockProvenance,
  formatBlockAnchor,
  computeEvidenceDiagnostics,
  detectDiscrepancies,
  normalizeSafeNumeric,
  type ProvenanceBlock,
} from './extractor/accessibility_compiler.js';
import {
  reorderLostInTheMiddle,
  selectMaximalMarginalRelevance,
  expandQueryWithPseudoRelevanceFeedback,
} from './extractor/information_retrieval.js';
import {
  extractTemporalAnchors,
  annotateTextWithTemporalAnchors,
  type TemporalAnchor,
} from './extractor/temporal_anchor.js';
import { extractQueryHighlightsRhoV2 } from './rho_select_v2_adapter.js';
export {
  normalizeSafeNumeric,
  assignBlockProvenance,
  formatBlockAnchor,
  computeEvidenceDiagnostics,
  detectDiscrepancies,
  reorderLostInTheMiddle,
  selectMaximalMarginalRelevance,
  expandQueryWithPseudoRelevanceFeedback,
  extractTemporalAnchors,
  annotateTextWithTemporalAnchors,
};
import type {
  Citation,
  MarkdownChunk,
  LinkStatus,
  ScrapeResult,
  TableData,
  MediaInfo,
  FieldEvidence,
  HighlightItem,
  EvidenceDiagnostics,
  CandidateDiscrepancy,
  DerivationTrace,
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

/** 不要な空リンク、無効な JavaScript リンク、連続空行、巨大な base64 インライン画像をパージしてトークンを削減 */
export function cleanMarkdownTokens(markdown: string, keepDataImages = false): string {
  if (!markdown) return '';
  let cleaned = markdown
    // 1. 空の Markdown リンクの除去: [](url), [ ](url), [&nbsp;](url)
    .replace(/\[(?:\s|&nbsp;)*\]\([^)]*\)/g, '')
    // 2. javascript: 疑似リンクのテキスト化: [Click](javascript:void(0)) -> Click
    .replace(/\[([^\]]+)\]\(javascript:[^)]*\)/gi, '$1')
    // 3. 空の画像タグの除去: ![](url), ![] (url)
    .replace(/!\[(?:\s|&nbsp;)*\]\s*\([^)]*\)/g, '');

  // 3.1. 巨大な base64 インライン画像の置換・パージ (LLM トークン浪費防止)
  // keepDataImages が false の場合、data:image/... を [画像: alt] に置換、alt が空なら完全除去
  if (!keepDataImages) {
    cleaned = cleaned.replace(/!\[([^\]]*)\]\(data:image\/[^)]+\)/g, (_, alt) => {
      const trimmedAlt = alt.trim();
      return trimmedAlt ? `[画像: ${trimmedAlt}]` : '';
    });
  }

  return cleaned
    // 4. 空白のみの行を完全な空行に統一
    .replace(/^[ \t]+$/gm, '')
    // 5. 3連続以上の空行を2行に圧縮
    .replace(/\n{3,}/g, '\n\n')
    // 6. 行末の不要な半角スペースを除去
    .replace(/[ \t]+$/gm, '')
    // 7. ゼロ幅文字・不可視制御文字の除去 (間接プロンプトインジェクション緩和)
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060]/g, '')
    // 8. LLM 特殊制御トークン・擬似システム命令タグの無害化 (間接プロンプトインジェクション防御)
    .replace(/<\|(?:im_start|im_end|endoftext|system|user|assistant|startoftext)\|>/gi, (m) => `[${m.slice(1, -1)}]`)
    .replace(/\[\/?(?:INST|SYS)\]/gi, (m) => `\\[${m.slice(1, -1)}\\]`)
    .replace(/<<\/?SYS>>/gi, (m) => `\\<\\<${m.slice(2, -2)}\\>\\>`)
    .replace(/\[(?:SYSTEM|SYSTEM[ _]MESSAGE|INSTRUCTION|DEVELOPER[ _]INSTRUCTION|PROMPT):/gi, (m) => `\\[${m.slice(1)}`)
    .replace(/<\/?(?:system|instruction|developer_instruction)>/gi, (m) => `\\<${m.slice(1, -1)}\\>`)
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
  const terms = extractTermsWithBigrams(query);
  if (terms.length === 0) return markdown;

  // 長い term から先に置換して部分一致の崩れを防ぐ（降順ソート）
  const sortedTerms = terms.slice().sort((a, b) => b.length - a.length);

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
    for (const term of sortedTerms) {
      if (term.length < 2) continue;
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
    if (isBlockedHostname(h) || isPrivateIp(h)) {
      return false;
    }
    const addresses = await dnsPromises.lookup(h, { all: true });
    for (const addr of addresses) {
      const a = addr.address.toLowerCase().trim().replace(/^\[|\]$/g, '');
      if (isBlockedHostname(a) || isPrivateIp(a)) {
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

export interface QueryHighlightDetailsOptions {
  sourceId?: string;
  url?: string;
  publishedTime?: string;
  evidenceMode?: 'full' | 'highlights' | 'contextual_highlights';
  maxHighlights?: number;
  reorderUFlat?: boolean;
  diversityWeight?: number;
  annotateTemporal?: boolean;
}

export interface QueryHighlightDetailsResult {
  highlights: string[];
  highlightItems: HighlightItem[];
  diagnostics: EvidenceDiagnostics;
  discrepancies: CandidateDiscrepancy[];
  temporalAnchors: TemporalAnchor[];
}

/** クエリ関連ハイライト詳細抽出 (Block Provenance・文脈保持パッセージ・証拠観測量・不一致候補・時間的文脈アンカーを統合) */
export function extractQueryHighlightDetails(
  content: string,
  query: string,
  options: QueryHighlightDetailsOptions = {},
): QueryHighlightDetailsResult {
  const maxHighlights = options.maxHighlights ?? 3;
  const sourceId = options.sourceId || 'S1';
  const evidenceMode = options.evidenceMode || 'highlights';

  if (!query || !content) {
    return {
      highlights: [],
      highlightItems: [],
      diagnostics: computeEvidenceDiagnostics(content || '', query || '', 0, 0),
      discrepancies: [],
      temporalAnchors: [],
    };
  }

  const terms = extractTermsWithBigrams(query);
  const rawBlocks = parseBlocks(content);
  if (terms.length === 0 || rawBlocks.length === 0) {
    return {
      highlights: [],
      highlightItems: [],
      diagnostics: computeEvidenceDiagnostics(content, query, 0, 0),
      discrepancies: [],
      temporalAnchors: [],
    };
  }

  // ブロック単位の出所識別 (Block Provenance)
  const blocks = assignBlockProvenance(rawBlocks, sourceId, options.url, options.publishedTime);

  interface ScoredCandidate {
    block: ProvenanceBlock;
    score: number;
    snippet: string;
    rawSnippetBody: string;
  }

  const scoredCandidates: ScoredCandidate[] = [];

  for (const block of blocks) {
    const score = scorePassage(block, terms, blocks);
    if (score <= 0) continue;

    let snippetBody = block.body;
    const isTableOrCode =
      (block.body.includes('|') && block.body.includes('---')) ||
      block.body.includes('```');

    if (block.body.length > 800 && !isTableOrCode) {
      snippetBody = dinkelbachOptimalPassage(block.body, terms, blocks);
    }

    const headingPrefix = block.headingPath.length > 0
      ? `## ${block.headingPath.join(' > ')}\n\n`
      : '';

    // contextual_highlights モードの場合はアンカーヘッダーを付与
    const anchorHeader = evidenceMode === 'contextual_highlights'
      ? `${formatBlockAnchor(block.ref)}\n`
      : '';

    scoredCandidates.push({
      block,
      score,
      snippet: `${anchorHeader}${headingPrefix}${snippetBody}`.trim(),
      rawSnippetBody: snippetBody,
    });
  }

  const topScore = scoredCandidates.length > 0
    ? Math.max(...scoredCandidates.map((c) => c.score))
    : 0;

  const diagnostics = computeEvidenceDiagnostics(
    content,
    query,
    scoredCandidates.length,
    topScore,
  );

  if (scoredCandidates.length === 0) {
    return {
      highlights: [],
      highlightItems: [],
      diagnostics,
      discrepancies: [],
      temporalAnchors: [],
    };
  }

  scoredCandidates.sort((a, b) => b.score - a.score);

  // 1. スコア閾値 (topScore * 0.35) を満たす候補にフィルタ
  const validCandidates = scoredCandidates.filter((c, idx) => idx === 0 || c.score >= topScore * 0.35);

  // 2. MMR (Maximal Marginal Relevance) による多様性選択 (同一内容・言い換えの重複排除)
  const diversityWeight = options.diversityWeight ?? 0.7;
  const mmrCandidates = selectMaximalMarginalRelevance(validCandidates, {
    getScore: (c) => c.score,
    getText: (c) => c.rawSnippetBody,
    limit: maxHighlights,
    lambda: diversityWeight,
  });

  // 3. Lost in the Middle 対策: U字型リオーダリング (先頭と末尾に重要パッセージを配置)
  const finalCandidates = options.reorderUFlat
    ? reorderLostInTheMiddle(mmrCandidates)
    : mmrCandidates;

  const selectedHighlights: string[] = [];
  const selectedItems: HighlightItem[] = [];
  const allTemporalAnchors: TemporalAnchor[] = [];

  for (const cand of finalCandidates) {
    let snippetText = cand.snippet;
    const itemAnchors = extractTemporalAnchors(snippetText, options.publishedTime);
    if (itemAnchors.length > 0) {
      allTemporalAnchors.push(...itemAnchors);
    }

    // annotateTemporal オプション指定時は決定論的インライン注記を埋め込む
    if (options.annotateTemporal && itemAnchors.length > 0) {
      snippetText = annotateTextWithTemporalAnchors(snippetText, options.publishedTime);
    }

    selectedHighlights.push(snippetText);
    selectedItems.push({
      text: snippetText,
      score: Number(cand.score.toFixed(4)),
      ref: cand.block.ref,
      anchor: formatBlockAnchor(cand.block.ref),
      ...(itemAnchors.length > 0 ? { temporalAnchors: itemAnchors } : {}),
    });
  }

  // 不一致候補 (Candidate Discrepancies) の検出
  const discrepancyItems = selectedItems.map((item) => ({
    text: item.text,
    sourceId: item.ref?.sourceId,
    blockId: item.ref?.blockId,
  }));
  const discrepancies = detectDiscrepancies(discrepancyItems);

  return {
    highlights: selectedHighlights,
    highlightItems: selectedItems,
    diagnostics,
    discrepancies,
    temporalAnchors: allTemporalAnchors,
  };
}

/** クエリ関連ハイライト抽出 (ρSelect への一本化ラッパー) */
export function extractQueryHighlights(
  content: string,
  query: string,
  maxHighlights = 3,
  _options?: QueryHighlightDetailsOptions,
): string[] {
  const result = extractQueryHighlightsRhoV2(content, query, {
    tau: 96,
  });
  if (maxHighlights && maxHighlights > 0 && result.highlights.length > maxHighlights) {
    return result.highlights.slice(0, maxHighlights);
  }
  return result.highlights;
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

/** 検索結果アイテムの BM25+ 多信号リランキング (Title BM25, Snippet BM25, Dynamic IDF, Bigram Matching, Exact Match, Domain Trust) */
export function rerankSearchResults<T extends { title?: string; snippet?: string; description?: string; url?: string; content?: string }>(
  items: T[],
  query: string,
): T[] {
  if (!items || items.length <= 1 || !query) return items;

  const terms = extractTermsWithBigrams(query);
  if (terms.length === 0) return items;

  const N = items.length;
  const lowerQuery = query.toLowerCase().trim();

  // 各アイテムのテキスト準備
  const itemDocs = items.map((item) => {
    const title = (item.title || '').toLowerCase();
    const snippet = (item.snippet || item.description || item.content || '').toLowerCase();
    const urlStr = (item.url || '').toLowerCase();
    return { title, snippet, urlStr };
  });

  // 長さ正規化用の平均長 (0除算ガード)
  let totalTitleLen = 0;
  let totalSnippetLen = 0;
  for (const doc of itemDocs) {
    totalTitleLen += doc.title.length;
    totalSnippetLen += doc.snippet.length;
  }
  const avgTitleLen = Math.max(1, totalTitleLen / N);
  const avgSnippetLen = Math.max(1, totalSnippetLen / N);

  // 動的 IDF の事前計算: term が出現する文書数 df(t)
  const dfMap = new Map<string, number>();
  for (const term of terms) {
    let df = 0;
    for (const doc of itemDocs) {
      if (doc.title.includes(term) || doc.snippet.includes(term)) {
        df++;
      }
    }
    dfMap.set(term, df);
  }

  // 出現回数カウント用ヘルパー
  const countOccurrences = (text: string, sub: string): number => {
    if (!text || !sub) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(sub, pos)) !== -1) {
      count++;
      pos += sub.length;
    }
    return count;
  };

  // BM25 パラメータ
  const k1 = 1.2;
  const b = 0.75;
  const wTitle = 3.0;
  const wSnippet = 1.0;

  const scored = items.map((item, originalIndex) => {
    const doc = itemDocs[originalIndex];
    let score = 0;

    // 1. 完全一致ボーナス
    if (doc.title.includes(lowerQuery)) score += 5.0;
    if (doc.snippet.includes(lowerQuery)) score += 2.5;

    // 前方一致ボーナス (タイトル先頭の一致)
    if (doc.title.startsWith(lowerQuery)) score += 2.0;

    // 2. アイテム間 BM25 (TF飽和 × 長さ正規化 × 動的IDF)
    const normTitle = 1 - b + b * (doc.title.length / avgTitleLen);
    const normSnippet = 1 - b + b * (doc.snippet.length / avgSnippetLen);

    for (const term of terms) {
      const df = dfMap.get(term) || 0;
      if (df === 0) continue;

      // Robertson-Spärck Jones BM25 IDF (下限保護付き)
      const termIdf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      const tfTitle = countOccurrences(doc.title, term);
      const tfSnippet = countOccurrences(doc.snippet, term);

      if (tfTitle > 0 || tfSnippet > 0) {
        const bm25Title = tfTitle > 0 ? (tfTitle * (k1 + 1)) / (tfTitle + k1 * normTitle) : 0;
        const bm25Snippet = tfSnippet > 0 ? (tfSnippet * (k1 + 1)) / (tfSnippet + k1 * normSnippet) : 0;

        // バイグラム・複合語（3文字以上）はより特異度が高いため重みブースト
        const lengthBonus = term.length >= 4 ? 1.4 : term.length >= 3 ? 1.2 : 1.0;
        score += termIdf * (wTitle * bm25Title + wSnippet * bm25Snippet) * lengthBonus;
      }
    }

    // 3. ドメイン信頼度スコア (.gov, .go.jp, .ac.jp, .org ブースト)
    if (doc.urlStr.includes('.go.jp/') || doc.urlStr.includes('.gov/')) score += 2.0;
    if (doc.urlStr.includes('.ac.jp/') || doc.urlStr.includes('.edu/')) score += 1.5;
    if (doc.urlStr.includes('.org/')) score += 0.5;

    // 4. 語順整合ボーナス (Word Order Consistency)
    if (terms.length >= 2) {
      for (let i = 0; i < terms.length - 1; i++) {
        const t1 = terms[i];
        const t2 = terms[i + 1];
        const p1 = doc.title.indexOf(t1);
        const p2 = doc.title.indexOf(t2, p1 >= 0 ? p1 : 0);
        if (p1 >= 0 && p2 > p1 && (p2 - p1) < 40) {
          score += 2.0;
        }
      }
    }

    // 5. 元の検索エンジンの初期順位の僅かなバイアス (同点時の順序維持)
    score += (N - originalIndex) * 0.05;

    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

export interface DeepEvidenceRerankOptions {
  requirements?: string[];
  enableRhoFeature?: boolean;
}

/**
 * 一般的な検索ストップワード（日本語・英語）
 */
const COMMON_STOPWORDS = new Set([
  'について', 'とは', '一覧', 'まとめ', '情報', '詳細', '公式', 'サイト', 'ページ',
  '最新', 'おすすめ', '比較', 'ランキング', '紹介', '方法', 'やり方', '使い方',
  'の', 'に', 'は', 'を', 'と', 'が', 'で', 'から', 'まで', 'より',
  'how', 'what', 'who', 'where', 'when', 'why', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for',
]);

/**
 * 意図・属性を表すキーフレーズ（Intent Attribute Terms）
 * ユーザーが具体的な事実やメタデータを求めていることを示す属性語群
 */
const INTENT_ATTRIBUTE_TERMS = new Set([
  '作詞', '作詞者', '作曲', '作曲者', '編曲', '編曲者', '作編曲', 'アーティスト', '歌手', 'ボーカル',
  '発売日', '公開日', '配信日', 'リリース', '誕生日', '生年月日', '出身', '出身地', '本名', '年齢',
  '営業時間', '定休日', '料金', '価格', '値段', '所在地', '住所', '電話番号', 'アクセス', '最寄り駅',
  'キャスト', '声優', '出演者', '監督', '脚本', '原作', '著者', '作者', '執筆者', '監修',
  '資本金', '代表者', '代表取締役', '設立', '創業', '従業員数',
]);

/**
 * 深層スクレイピング後のエビデンス駆動リランキング (Evidence-Aware Deep Reranking)
 *
 * 【位置づけ】
 * 本機能は ρSelect のオプティマイザ本体（Optimizer Core）ではなく、
 * 「Production Retrieval-Verification Layer（検索検証レイヤー）」として動作する。
 *
 * 【解決する課題】
 * スニペット段階のBM25+リランキングでは、検索インデックスが合成した断片スニペットに
 * たまたま別文脈で単語（例: 「作詞」）が含まれていた場合、偽陽性（False Positive）として
 * 本文中にユーザーの求める回答根拠が一切存在しないページが上位に来てしまう。
 *
 * 【評価プロトコル v0.1 準拠の実装】
 * 1. 堅牢なターム分解: extractTermsWithBigrams により日本語無空白クエリでも正確にタームを抽出
 * 2. Intent Anchor 自動選定: 固定末尾語依存を廃止し、属性語辞書またはコーパス稀少語（低DF語）から意図語を同定
 * 3. 有界な Rank Prior: (N-index) 依存を廃止し、alpha / sqrt(rank) による正規化事前確率を採用
 * 4. 校正済み ρSelect エビデンス: ハイライト存在基礎点と相対スケーリングによる頑健な証拠加算（Ablation対応）
 */
export function rerankByDeepEvidence<T extends {
  title?: string;
  snippet?: string;
  description?: string;
  url?: string;
  content?: string;
  markdown?: string;
  highlights?: string[];
  highlightItems?: Array<{ text: string; score: number }>;
  isSnippetFallback?: boolean;
  scrapeError?: string;
  rank?: number;
}>(items: T[], query: string, options?: DeepEvidenceRerankOptions): T[] {
  if (!items || items.length <= 1 || !query) return items;

  // 1. クエリタームの分解（日本語無空白クエリ & 空白区切りクエリ両対応: 第4.1項）
  let queryTerms: string[] = [];
  if (options?.requirements && options.requirements.length > 0) {
    queryTerms = options.requirements.map((r) => r.toLowerCase().trim()).filter((r) => r.length > 0);
  } else {
    // 共通の extractTermsWithBigrams を使用し、空白の有無に関わらず形態素・複合語・Bigram を抽出
    const extracted = extractTermsWithBigrams(query);
    const whitespaceWords = query.toLowerCase().trim().split(/[\s　]+/).map((w) => w.trim()).filter((w) => w.length > 0);
    const termSet = new Set<string>();
    for (const t of whitespaceWords) {
      if (t.length >= 2 && !COMMON_STOPWORDS.has(t)) termSet.add(t);
    }
    for (const t of extracted) {
      if (t.length >= 2 && !COMMON_STOPWORDS.has(t)) termSet.add(t);
    }
    queryTerms = Array.from(termSet);
  }

  if (queryTerms.length === 0) return items;

  // 2. Intent Anchor（意図アンカー語）の自動同定 (第4.2項)
  // 固定 lastWord を廃止し、属性語辞書合致語、または候補群中での出現頻度 (DF) が最も低い稀少語を選択
  let intentAnchor: string | null = null;

  // 属性語辞書からクエリに含まれる最も具体的な属性語（最長一致）を探索
  const matchedAttrs: string[] = [];
  const normalizedQuery = query.toLowerCase();
  for (const attr of INTENT_ATTRIBUTE_TERMS) {
    if (normalizedQuery.includes(attr.toLowerCase())) {
      matchedAttrs.push(attr);
    }
  }
  if (matchedAttrs.length > 0) {
    // より具体的（文字数が長い）な属性語を優先（例: "作詞者" > "作詞"）
    matchedAttrs.sort((a, b) => b.length - a.length);
    intentAnchor = matchedAttrs[0].toLowerCase();
  }

  // 属性語がない場合、候補群中でのドキュメント頻度 df(t) が最も低い稀少語（情報量が最も高い語）を選択
  if (!intentAnchor && queryTerms.length >= 2) {
    let minDf = Infinity;
    let rarestTerm = queryTerms[0];
    // クエリ全体そのものは除外して単語単位で探索
    const candidateTerms = queryTerms.filter((t) => t.length < query.trim().length);
    const searchTerms = candidateTerms.length > 0 ? candidateTerms : queryTerms;
    for (const term of searchTerms) {
      let df = 0;
      for (const item of items) {
        const text = ((item.markdown || item.content || '') + ' ' + (item.title || '')).toLowerCase();
        if (text.includes(term)) df++;
      }
      if (df < minDf || (df === minDf && term.length > rarestTerm.length)) {
        minDf = df;
        rarestTerm = term;
      }
    }
    intentAnchor = rarestTerm;
  }

  // 3. 最大ハイライトスコアの取得（相対校正スケーリング用: 第4.4項）
  let maxHighlightScore = 0;
  for (const item of items) {
    if (item.highlightItems && item.highlightItems.length > 0) {
      const s = item.highlightItems[0]?.score ?? 0;
      if (s > maxHighlightScore) maxHighlightScore = s;
    }
  }

  const scored = items.map((item, originalIndex) => {
    let score = 0;

    const bodyText = (item.markdown || item.content || '').toLowerCase();
    const titleText = (item.title || '').toLowerCase();
    const highlightText = (item.highlights || []).join(' ').toLowerCase();

    // A. クエリタームのカバレッジ（本文・タイトルとハイライト）
    let coveredInBody = 0;
    let coveredInHighlight = 0;
    for (const term of queryTerms) {
      if (bodyText.includes(term) || titleText.includes(term)) {
        coveredInBody++;
      }
      if (highlightText.includes(term)) {
        coveredInHighlight++;
      }
    }

    const bodyCoverage = queryTerms.length > 0 ? coveredInBody / queryTerms.length : 0;
    const highlightCoverage = queryTerms.length > 0 ? coveredInHighlight / queryTerms.length : 0;

    score += bodyCoverage * 8.0;
    score += highlightCoverage * 12.0;

    // 全単語完全充足（100% coverage）ボーナス
    if (bodyCoverage >= 1.0) {
      score += 10.0;
    }
    if (highlightCoverage >= 1.0) {
      score += 6.0;
    }

    // B. Intent Anchor の検証 (第4.2項)
    if (intentAnchor) {
      if (highlightText.includes(intentAnchor)) {
        score += 6.0;
      } else if (bodyText.includes(intentAnchor) || titleText.includes(intentAnchor)) {
        score += 4.0;
      } else {
        // 本文にもハイライトにも意図アンカーが存在しない偽陽性へのペナルティ
        score -= 8.0;
      }
    }

    // C. ρSelect v2 エビデンス特徴量（校正済み & Ablation 対応: 第4.4項）
    const enableRho = options?.enableRhoFeature !== false;
    if (enableRho) {
      const hasHighlights = (item.highlights && item.highlights.length > 0) || (item.highlightItems && item.highlightItems.length > 0);
      if (hasHighlights) {
        score += 3.0; // ハイライト存在基礎点
        if (maxHighlightScore > 0 && item.highlightItems && item.highlightItems.length > 0) {
          const topScore = item.highlightItems[0]?.score ?? 0;
          // 相対正規化により実運用スケール（0.005〜0.02）の差異を吸収
          const normalizedRelativeRho = Math.max(0, Math.min(1, topScore / maxHighlightScore));
          score += normalizedRelativeRho * 3.0;
        }
      }
    }

    // D. 欠陥・エラーペナルティ
    if (item.scrapeError) {
      score -= 10.0;
    }
    if (item.isSnippetFallback) {
      score -= 5.0;
    }

    // E. 正規化された Rank Prior (第4.3項: N非依存の有界減衰関数)
    // alpha / sqrt(rank) により 1位: 2.0点, 2位: 1.41点, 10位: 0.63点と有界
    const origRank = originalIndex + 1;
    const rankPrior = 2.0 / Math.sqrt(origRank);
    score += rankPrior;

    return { item, score, originalIndex };
  });

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.001) {
      return b.score - a.score;
    }
    return a.originalIndex - b.originalIndex;
  });

  // rank の再付番
  return scored.map((s, idx) => {
    const updated = { ...s.item };
    if (typeof updated.rank === 'number' || 'rank' in updated) {
      updated.rank = idx + 1;
    }
    return updated;
  });
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
  // 動的スニペットから Frontmatter やシステム装飾（> 📍 **階層**: 等）をサニタイズ
  let cleanSnippet = dynamicSnippet
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '')
    .replace(/^>\s*(?:📍|📅)\s*\*\*.*?\*\*:.*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .slice(0, 250)
    .trim();

  // サニタイズ後にスニペットが空または極小になった場合は metaDesc を使用
  if (!cleanSnippet || cleanSnippet.length < 10) return metaDesc;

  if (!metaDesc) {
    return cleanSnippet;
  }
  if (!query) return metaDesc;

  const terms = extractTermsWithBigrams(query);
  if (terms.length === 0) return metaDesc;
  const lowerMeta = metaDesc.toLowerCase();

  // Meta Description 内のクエリ単語カバー率を計算
  let metaMatchedCount = 0;
  for (const term of terms) {
    if (lowerMeta.includes(term)) metaMatchedCount++;
  }

  // Meta Description がクエリの半分以上の単語をカバーしており、かつ適正長の場合は著者の Meta を尊重
  const coverage = metaMatchedCount / terms.length;
  if (coverage >= 0.5 && metaDesc.length >= 40 && metaDesc.length <= 300) {
    return metaDesc;
  }

  // クエリ単語が不足している、またはサイト共通ボイラープレートの疑いがある場合は本文動的スニペットを採用
  return cleanSnippet;
}

/**
 * 高速インメモリ品質スコアリング
 * - Bot/Challenge/JS 検出
 * - 本文量
 * - 見出し階層構造
 * - JSON-LD
 * - メタデータ
 * - リンク密度ペナルティ
 */
export function calculateContentQuality(params: {
  markdown: string;
  title?: string;
  description?: string;
  jsonLd?: any[];
  html?: string;
}): { score: number; reasons: string[] } {
  const { markdown = '', title = '', description = '', jsonLd = [], html = '' } = params;
  let score = 50; // 初期ベースライン
  const reasons: string[] = [];

  const lowerMd = markdown.toLowerCase();
  const lowerHtml = html ? html.toLowerCase() : '';

  const textLen = markdown.trim().length;

  // 1. Bot / Challenge / JS 必須ページの検出 (致命的低品質)
  // 本文が充実している正常なページで g-recaptcha 等のスクリプトが含まれるだけのケースでの誤検知を防止
  const isBotChallenge =
    (lowerMd.includes('cloudflare') && (lowerMd.includes('ray id') || lowerMd.includes('just a moment') || lowerMd.includes('verify you are human'))) ||
    lowerMd.includes('attention required! | cloudflare') ||
    lowerMd.includes('ddos-guard') ||
    (lowerMd.includes('access denied') && textLen < 500) ||
    (lowerMd.includes('bot detection') && textLen < 500) ||
    lowerHtml.includes('cf-browser-verification') ||
    (lowerHtml.includes('g-recaptcha') && textLen < 200);

  const isJsRequired =
    (lowerMd.includes('enable javascript') ||
      lowerMd.includes('please turn javascript on') ||
      lowerMd.includes('javascript is required') ||
      lowerMd.includes('javascript must be enabled')) &&
    textLen < 300;

  if (isBotChallenge || isJsRequired) {
    if (isBotChallenge) reasons.push('bot_challenge_detected');
    if (isJsRequired) reasons.push('js_required_detected');
    return { score: 10, reasons };
  }

  // 2. 本文コンテンツ量判定
  if (textLen < 50) {
    score -= 40;
    reasons.push('thin_content');
  } else if (textLen < 200) {
    score -= 15;
  } else if (textLen > 2000) {
    score += 25;
    reasons.push('substantial_content');
  } else if (textLen > 500) {
    score += 15;
    reasons.push('substantial_content');
  }

  // 3. 見出し階層構造 (H1, H2, H3 等の Markdown 見出し)
  if (/^#{1,6}\s+.+/m.test(markdown)) {
    score += 15;
    reasons.push('has_headings');
  }

  // 4. 構造化データ (Schema.org / JSON-LD)
  if (jsonLd && jsonLd.length > 0) {
    score += 15;
    reasons.push('has_json_ld');
  }

  // 5. メタデータ充実度 (タイトルと説明文)
  if (title.trim().length >= 3 && description.trim().length >= 10) {
    score += 10;
    reasons.push('has_rich_metadata');
  }

  // 6. リンク密度過多ペナルティ (本文がほぼリンク集・ナビゲーションの残り)
  if (textLen > 100) {
    const linkMatches = markdown.match(/\[([^\]]+)\]\([^)]+\)/g) || [];
    const linkTextLen = linkMatches.reduce((acc, m) => acc + m.length, 0);
    const linkDensity = linkTextLen / textLen;
    if (linkDensity > 0.6) {
      score -= 20;
      reasons.push('excessive_link_density');
    }
  }

  // 0 〜 100 にクランプ
  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  return { score: finalScore, reasons };
}

/**
 * ページ種別（Article, Product, Q&A, Generic）の高速判定
 */
export function detectPageType(params: {
  jsonLd?: any[];
  meta?: Record<string, string | undefined>;
  url?: string;
  markdown?: string;
}): 'article' | 'product' | 'qa' | 'generic' {
  const { jsonLd = [], meta = {}, url = '', markdown = '' } = params;

  // 1. JSON-LD の @type 検査
  for (const item of jsonLd) {
    const typeStr = Array.isArray(item['@type']) ? item['@type'].join(' ') : (item['@type'] || '');
    if (/Product|Offer|IndividualProduct|ProductModel/i.test(typeStr)) return 'product';
    if (/Article|NewsArticle|BlogPosting|TechArticle|Report/i.test(typeStr)) return 'article';
    if (/QAPage|Question|Answer/i.test(typeStr)) return 'qa';
  }

  // 2. OpenGraph / Twitter meta タグ
  const ogType = (meta['og:type'] || meta['ogType'] || '').toLowerCase();
  if (ogType.includes('article')) return 'article';
  if (ogType.includes('product')) return 'product';

  // 3. URL やコンテンツのヒューリスティクス
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('/item/') || lowerUrl.includes('/product/') || lowerUrl.includes('/goods/') || lowerUrl.includes('/p/')) {
    return 'product';
  }
  if (lowerUrl.includes('/blog/') || lowerUrl.includes('/news/') || lowerUrl.includes('/articles/') || lowerUrl.includes('/story/')) {
    return 'article';
  }
  if (lowerUrl.includes('/qa/') || lowerUrl.includes('/questions/') || lowerUrl.includes('/chiebukuro')) {
    return 'qa';
  }

  // 4. 価格・カート表記
  if (/(?:¥|￥|\$|€|税込|税別|カートに入れる|今すぐ購入|カートに追加)/.test(markdown) && /(?:在庫あり|在庫切れ|品切れ|価格)/.test(markdown)) {
    return 'product';
  }

  return 'generic';
}

/**
 * ページ種別ごとの抽出充足度（Completeness 0〜100）と欠損フィールドの算出
 */
export function calculateExtractionCompleteness(params: {
  pageType: 'article' | 'product' | 'qa' | 'generic';
  title?: string;
  content?: string;
  publishedTime?: string;
  author?: string;
  price?: string;
  availability?: string;
  images?: any[];
  description?: string;
}): { completeness: number; missingFields: string[] } {
  const { pageType, title, content, publishedTime, author, price, availability, images, description } = params;
  const missing: string[] = [];
  let score = 0;

  const hasTitle = !!(title && title.trim().length > 0);
  const hasContent = !!(content && content.trim().length >= 50);

  if (pageType === 'article') {
    if (hasTitle) score += 30; else missing.push('title');
    if (hasContent) score += 30; else missing.push('content');
    if (publishedTime) score += 20; else missing.push('publishedTime');
    if (author) score += 20; else missing.push('author');
  } else if (pageType === 'product') {
    if (hasTitle) score += 25; else missing.push('title');
    if (price) score += 25; else missing.push('price');
    if (availability) score += 25; else missing.push('availability');
    if ((images && images.length > 0) || description || hasContent) score += 25; else missing.push('description');
  } else if (pageType === 'qa') {
    if (hasTitle) score += 30; else missing.push('title');
    if (hasContent) score += 40; else missing.push('answers');
    if (author || publishedTime) score += 30; else missing.push('metadata');
  } else {
    // generic
    if (hasTitle) score += 40; else missing.push('title');
    if (hasContent) score += 60; else missing.push('content');
  }

  return { completeness: Math.min(100, score), missingFields: missing };
}

/**
 * フィールド取得元根拠（Evidence / Provenance）の追跡・集約
 */
export function collectFieldEvidence(params: {
  jsonLd?: any[];
  meta?: Record<string, string | undefined>;
  title?: string;
  description?: string;
  publishedTime?: string;
  author?: string;
  price?: string;
  availability?: string;
  siteName?: string;
}): Record<string, FieldEvidence> {
  const { jsonLd = [], meta = {}, title, description, publishedTime, author, price, availability, siteName } = params;
  const evidence: Record<string, FieldEvidence> = {};

  // JSON-LD から取得されたか確認するヘルパー
  const isInJsonLd = (val: string | undefined): boolean => {
    if (!val) return false;
    const s = JSON.stringify(jsonLd);
    return s.includes(val);
  };

  // Meta から取得されたか確認するヘルパー
  const isInMeta = (val: string | undefined): boolean => {
    if (!val) return false;
    return Object.values(meta).some((v) => typeof v === 'string' && (v === val || v.includes(val)));
  };

  if (title) {
    evidence.title = {
      value: title,
      source: isInJsonLd(title) ? 'jsonld' : (isInMeta(title) ? 'meta' : 'dom'),
    };
  }

  if (description) {
    evidence.description = {
      value: description,
      source: isInJsonLd(description) ? 'jsonld' : (isInMeta(description) ? 'meta' : 'dom'),
    };
  }

  if (publishedTime) {
    evidence.publishedTime = {
      value: publishedTime,
      source: isInJsonLd(publishedTime) ? 'jsonld' : (isInMeta(publishedTime) ? 'meta' : 'dom'),
    };
  }

  if (author) {
    evidence.author = {
      value: author,
      source: isInJsonLd(author) ? 'jsonld' : (isInMeta(author) ? 'meta' : 'dom'),
    };
  }

  if (price) {
    evidence.price = {
      value: price,
      source: isInJsonLd(price) ? 'jsonld' : (isInMeta(price) ? 'meta' : 'dom'),
    };
  }

  if (availability) {
    evidence.availability = {
      value: availability,
      source: isInJsonLd(availability) ? 'jsonld' : (isInMeta(availability) ? 'meta' : 'dom'),
    };
  }

  if (siteName) {
    evidence.siteName = {
      value: siteName,
      source: isInJsonLd(siteName) ? 'jsonld' : (isInMeta(siteName) ? 'meta' : 'dom'),
    };
  }

  return evidence;
}

