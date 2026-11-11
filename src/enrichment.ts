import { promises as dnsPromises } from 'dns';
import { isBlockedHostname, isPrivateIp } from './browser_engine.js';
import { scorePassage, extractTermsWithBigrams, dinkelbachOptimalWindow, type HeadingBlock } from './extractor/hierarchical_bm25.js';
import { parseMarkdownSections, tokenizeAndSelectTerms } from './extractor/markdown_sections.js';
import {
  analyzeFacetEvidence,
  associationMultiplier,
  dateYearMultiplier,
  detectCurrentIntent,
  entityTermsForQuery,
  extractDateRequirements,
  splitSentences,
  structuralMultiplier,
  temporalMultiplier,
} from './retrieval/answerability.js';
import {
  assignBlockProvenance,
  formatBlockAnchor,
  computeEvidenceDiagnostics,
  type ProvenanceBlock,
} from './extractor/accessibility_compiler.js';
import { selectMaximalMarginalRelevance } from './extractor/information_retrieval.js';
import {
  extractTemporalAnchors,
  annotateTextWithTemporalAnchors,
  type TemporalAnchor,
} from './extractor/temporal_anchor.js';
export {
  assignBlockProvenance,
  formatBlockAnchor,
  computeEvidenceDiagnostics,
  selectMaximalMarginalRelevance,
  extractTemporalAnchors,
  annotateTextWithTemporalAnchors,
};
import type {
  FieldEvidence,
  HighlightItem,
  EvidenceDiagnostics,
} from './types.js';
import { INTENT_ATTRIBUTE_TERMS_LIST } from './retrieval/lexicons/temporal.js';

import { estimateTokens } from './text_tokens.js';
import { errorMessageWithoutUrls } from './errors.js';
export { estimateTokens };

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

/** safeTruncateMarkdown は、開いたコードブロックを閉じる 4 字のぶん maxChars をはみ出しうる。その分だけ手前で切り直して、maxChars 字以内にする */
export function truncateMarkdownWithin(markdown: string, maxChars: number): string {
  const kept = safeTruncateMarkdown(markdown, maxChars);
  return kept.length > maxChars ? safeTruncateMarkdown(markdown, Math.max(0, 2 * maxChars - kept.length)) : kept;
}

// Markdown の飛び先 (url "title") の中身と、画像の alt。URL の中の括弧は 1 段まで読み（filters:format(webp) など）、alt は \] のような逃がした字も読む。
// どちらも「ほどいたループ」で書く（1 字ごとに選ぶループ (?:a|b)* は、JSC が 100 万字ほどの data URI で戻りの記録を使い切り、黙って一致しなくなる）
const MD_DEST = String.raw`[^()]*(?:\([^()]*\)[^()]*)*`;
const MD_ALT = String.raw`([^\]\\]*(?:\\.[^\]\\]*)*)`;
const EMPTY_IMAGE_RE = new RegExp(String.raw`!\[(?:\s|&nbsp;)*\]\s*\(${MD_DEST}\)`, 'g');
const EMPTY_LINK_RE = new RegExp(String.raw`\[(?:\s|&nbsp;)*\]\(${MD_DEST}\)`, 'g');
// JS_LINK_RE は、Turndown が逃がした `\[`（地の文の [。直前の `\` が奇数個）からは始めない。逃がした `\[` が並ぶと、各 `[` が次の `]` まで読んで二乗の時間になる。
// 直前の `\` が偶数個なら、`\\` が字の `\` で、続く `[a](javascript:x)` は生きたリンクなので外す。
// 先頭の (?=\[) は、後読みを `[` の位置でだけ評価するため。無いと、`\` の長い並びで JSC が途中で諦めて（外すべきリンクが残り、0.7〜1 秒かかる）
const JS_LINK_RE = new RegExp(String.raw`(?=\[)(?<!(?<!\\)(?:\\\\)*\\)\[([^\]]+)\]\(javascript:${MD_DEST}\)`, 'gi');
const DATA_IMAGE_RE = new RegExp(String.raw`!\[${MD_ALT}\]\(data:image\/${MD_DEST}\)`, 'g');
const MARKDOWN_IMAGE_RE = new RegExp(String.raw`!\[${MD_ALT}\]\(${MD_DEST}\)`, 'g');

/** 不要な空リンク、無効な JavaScript リンク、連続空行、巨大な base64 インライン画像をパージしてトークンを削減 */
export function cleanMarkdownTokens(markdown: string, keepDataImages = false): string {
  if (!markdown) return '';
  let cleaned = markdown
    // 1. 空の画像タグの除去: ![](url), ![] (url)。空のリンクより先に消す（先に [](url) を消すと ! だけが残り、後ろのリンクと画像の記法になる）。
    // 前後がどちらも空白でないときは、前後の語がくっつかないように空白 1 字にする（Cocktail![](url)Friendsgiving）。
    // 前が `[`、または後ろが `]` のとき（リンクの文字の端）は足さない（[![](url)Text](url) が [ Text](url) にならないように）
    .replace(EMPTY_IMAGE_RE, (m, offset: number, whole: string) => {
      const before = whole[offset - 1] ?? ' ';
      const after = whole[offset + m.length] ?? ' ';
      return /\S/.test(before) && /\S/.test(after) && before !== '[' && after !== ']' ? ' ' : '';
    })
    // 2. 空の Markdown リンクの除去: [](url), [ ](url), [&nbsp;](url)
    .replace(EMPTY_LINK_RE, '')
    // 3. javascript: 疑似リンクのテキスト化: [Click](javascript:void(0)) -> Click
    .replace(JS_LINK_RE, '$1');

  // 3.1. 巨大な base64 インライン画像の置換・パージ (LLM トークン浪費防止)
  // keepDataImages が false の場合、data:image/... を [画像: alt] に置換、alt が空なら完全除去
  if (!keepDataImages) {
    cleaned = cleaned.replace(DATA_IMAGE_RE, (_, alt) => {
      const trimmedAlt = alt.trim();
      return trimmedAlt ? `[画像: ${trimmedAlt}]` : '';
    });
  }

  return cleaned
    // 4. 空白のみの行を完全な空行に統一
    .replace(/^[ \t]+$/gm, '')
    // 5. 3連続以上の空行を2行に圧縮
    .replace(/\n{3,}/g, '\n\n')
    // 6. 行末の不要な半角スペースを除去。(?<![ \t]) は空白の並びの先頭からだけ試すため（無いと、行の途中の長い空白で、並びの途中のすべての位置から読んで二乗の時間になる）
    .replace(/(?<![ \t])[ \t]+$/gm, '')
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

/** Markdown の画像を「[画像: alt]」に置き換える（alt が無ければ消す）。includeMedia: false の応答で使う */
export function replaceMarkdownImages(markdown: string): string {
  return markdown.replace(MARKDOWN_IMAGE_RE, (_m, alt: string) => (alt.trim() ? `[画像: ${alt.trim()}]` : ''));
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

  // 1. メールアドレス。後読みで、ローカル部の字の並びの先頭からだけ試す（途中の字ごとに並びの最後まで読むと、長い英数字の並びで二乗の時間になる）。
  //    後ろの枝は、前の一致が `_` `+` の手前で終わり、そこから次のメールが続く形（a@b.c_d@e.f）も前と同じに読むため
  masked = masked.replace(/(?:(?<![a-zA-Z0-9_.+-])|(?=[_+])(?<=@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+))[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[EMAIL]');

  // 2. クレジットカード番号 (13〜19桁, Luhn 検証または一般的な4桁x4ブロック)
  masked = masked.replace(/\b(?:\d{4}[ -]?){3}\d{4}\b|\b\d{4}[ -]?\d{6}[ -]?\d{5}\b/g, (match) => {
    return isValidCreditCardNumber(match) ? '[CREDIT_CARD]' : match;
  });

  // 3. 日本の電話番号 (携帯・固定)
  masked = masked.replace(/\b(?:\+?81[- ]?|0)(?:[789]0[- ]?\d{4}[- ]?\d{4}|[1-9]\d{0,3}[- ]?\d{1,4}[- ]?\d{4})\b/g, '[PHONE]');

  return masked;
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

/** Webhook を送り、2xx で受け取られたときだけ true を返す (SSRF Protected)。失敗は例外にせず false */
export async function deliverWebhook(webhookUrl?: string, payload?: any): Promise<boolean> {
  if (!webhookUrl || typeof webhookUrl !== 'string') return false;

  const isSafe = await isSafeWebhookUrl(webhookUrl);
  if (!isSafe) {
    // URL は出さない（Webhook の URL は秘密を含む。管理者のアラートの宛先など）。下の 2 つも同じ
    console.warn('[web-fetcher/webhook] Blocked SSRF attempt to private/internal webhook destination');
    return false;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      redirect: 'error', // SSRF: webhook先のリダイレクト追従を禁止 (redirect先の再検証なしに追従しない)

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
      console.warn(`[web-fetcher/webhook] Failed to send webhook: HTTP ${res.status}`);
    }
    return res.ok;
  } catch (err) {
    // 例外の文にも宛先の URL が入る（Bun の UnexpectedRedirect など）ので、URL を伏せる
    console.warn('[web-fetcher/webhook] Error sending webhook:', errorMessageWithoutUrls(err));
    return false;
  }
}

/** 長時間ジョブ完了時の Webhook コールバック非同期送信 (Fire-and-forget & SSRF Protected) */
export async function sendWebhookNotification(webhookUrl?: string, payload?: any): Promise<void> {
  await deliverWebhook(webhookUrl, payload);
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

// maxHighlights を指定しないときの足し方: 上位 3 件の後、合計がこの字数に収まる限り、窓で切った節を丸ごとに戻し、
// さらに後ろの候補を足す（最大 8 件）。語を並べた検索語で答えの節が 4 位以下・窓の外になるのを拾う
export const HIGHLIGHT_CHAR_BUDGET = 1600;
const BUDGET_MAX_HIGHLIGHTS = 8;
// 長い節を窓で切るとき、前に付ける節の書き出しの字数（返す文だけに付け、MMR の類似度には使わない）
const WINDOW_LEAD_CHARS = 350;
// 取りこぼした語を補う節を試す数の上限
const FILL_MAX_TRIES = 5;
// maxHighlights を指定しないとき、足切り（最高点の 0.35 倍）に届かない節も、この倍率以上なら字数の目安の残りで足す
const LOW_SCORE_RATIO = 0.25;
// maxHighlights を指定しないとき、目安より長い節（表・コード以外。丸ごとには戻せない）は、窓に加えて、段落をこの字数までまとめた塊も
// 候補にする（長い段落は文でまとめる）。答えが窓の外の段落にあるのを拾う。選んだ窓と塊は節ごとに 1 つのハイライトにまとめる。
// 文で切れずにこの 2 倍を超えた塊（. や ．で文を終える英語・論文の段落など）は候補にしない（先頭 3 件は字数を確かめないので、目安を大きく超える）
const SPLIT_CHUNK_CHARS = 300;
// MMR の重み λ（1 に近いほど関連度を重んじ、0 に近いほど重複を避ける）
const MMR_LAMBDA = 0.7;

export interface QueryHighlightDetailsOptions {
  sourceId?: string;
  url?: string;
  publishedTime?: string;
  /** 指定すると、その件数まで選ぶ（字数の目安による追加・取りこぼしの補い・長い節の塊をしない）。選ぶ節は件数の目安を入れる前と同じ */
  maxHighlights?: number;
  annotateTemporal?: boolean;
}

export interface QueryHighlightDetailsResult {
  highlights: string[];
  highlightItems: HighlightItem[];
  diagnostics: EvidenceDiagnostics;
  temporalAnchors: TemporalAnchor[];
}

/** クエリ関連ハイライト詳細抽出 (Block Provenance・文脈保持パッセージ・証拠観測量・時間的文脈アンカーを統合) */
export function extractQueryHighlightDetails(
  content: string,
  query: string,
  options: QueryHighlightDetailsOptions = {},
): QueryHighlightDetailsResult {
  // 件数を指定されなければ（null も省略と同じ）、上位 3 件の後に字数の目安まで足す。REST は件数を検査しないので、端数は切り上げ、1 未満は 1 にする
  const extend = options.maxHighlights == null;
  const maxHighlights = extend ? 3 : Math.max(1, Math.ceil(options.maxHighlights as number)) || 1;
  const sourceId = options.sourceId || 'S1';

  if (!query || !content) {
    return {
      highlights: [],
      highlightItems: [],
      diagnostics: computeEvidenceDiagnostics(content || '', query || '', 0, 0),
      temporalAnchors: [],
    };
  }

  const terms = extractTermsWithBigrams(query);
  // 節の切り分けは parseMarkdownSections（先頭のメタデータ・「📍 階層」「📅」の目印の行・リンク先のホストが多いリンクだけの段落（言語の一覧など）を外し、
  // リストの中の見出しも見出しとして扱う）
  const sections = parseMarkdownSections(content);
  const rawBlocks: HeadingBlock[] = sections.map((sec) => {
    const headingPath = sec.heading ? sec.heading.split(' > ') : [];
    return { headingPath, nearestHeading: headingPath[headingPath.length - 1] ?? '', depth: sec.headingLevel, body: sec.fullText };
  });
  if (terms.length === 0 || rawBlocks.length === 0) {
    return {
      highlights: [],
      highlightItems: [],
      diagnostics: computeEvidenceDiagnostics(content, query, 0, 0),
      temporalAnchors: [],
    };
  }

  // ブロック単位の出所識別 (Block Provenance)
  const blocks = assignBlockProvenance(rawBlocks, sourceId, options.url, options.publishedTime);

  interface ScoredCandidate {
    block: ProvenanceBlock;
    score: number;
    snippet: string;
    /** MMR の類似度を測る文: 窓で切った節は書き出しを付けない窓（選ぶ節を書き出しで変えない） */
    rawSnippetBody: string;
    /** 窓で切ったときの、節を丸ごと出す形 */
    wholeSnippet?: string;
    /** 塊に分けた節の窓・塊: 本文の中の位置と、まとめるときの見出し・書き出しの終わり */
    part?: { span: [number, number]; chunk: boolean; prefix: string; leadEnd: number };
  }

  const scoredCandidates: ScoredCandidate[] = [];

  // 答えの値の倍率: 要件の語の回答値（対象つき）・表の行・定義の組がある節を上げ、最新を問う問いでは古い値を、
  // 日付を問う問いでは年の合わない日付を下げる（倍率は retrieval/evidence_weights の一表）
  const requirements = tokenizeAndSelectTerms(query, sections, 6).terms;
  const entities = entityTermsForQuery(query);
  const currentIntent = detectCurrentIntent(query);
  const dateReqs = extractDateRequirements(query);
  const answerValueMultiplier = (block: HeadingBlock): number => {
    const text = `${block.nearestHeading}\n${block.body}`;
    const sentences = splitSentences(text);
    const lower = text.toLowerCase();
    let best = 1;
    let found = false;
    for (const r of requirements) {
      if (!lower.includes(r.toLowerCase())) continue;
      const m = Math.max(associationMultiplier(analyzeFacetEvidence(sentences, entities, r)), structuralMultiplier(text, r)) * temporalMultiplier(sentences, r, currentIntent);
      best = found ? Math.max(best, m) : m;
      found = true;
    }
    return best * dateYearMultiplier(sentences, dateReqs);
  };

  for (const block of blocks) {
    const score = scorePassage(block, terms, blocks) * answerValueMultiplier(block);
    if (score <= 0) continue;

    let snippetBody = block.body;
    let similarityText = block.body;
    let win: ReturnType<typeof dinkelbachOptimalWindow> | undefined;
    if (block.body.length > 800 && !isTableOrCode(block.body)) {
      win = dinkelbachOptimalWindow(block.body, terms, blocks, { leadChars: WINDOW_LEAD_CHARS });
      snippetBody = win.withLead;
      similarityText = win.passage;
    }

    const headingPrefix = block.headingPath.length > 0
      ? `## ${block.headingPath.join(' > ')}\n\n`
      : '';

    // 目安より長い節は塊も候補にする（件数を指定しないときだけ）。窓は節の点のまま、塊は節の点 × 節の中での点の比
    const split = extend && win?.span && block.body.length > HIGHLIGHT_CHAR_BUDGET;
    const leadEnd = win?.leadEnd ?? 0;
    scoredCandidates.push({
      block,
      score,
      snippet: `${headingPrefix}${snippetBody}`.trim(),
      rawSnippetBody: similarityText,
      wholeSnippet: snippetBody !== block.body && !split ? `${headingPrefix}${block.body}`.trim() : undefined,
      part: split ? { span: win!.span!, chunk: false, prefix: headingPrefix, leadEnd } : undefined,
    });
    if (split) {
      const chunks = chunkSpans(block.body, SPLIT_CHUNK_CHARS).map(([a, b]) => {
        const chunk = { ...block, body: block.body.slice(a, b).trim() };
        return { span: [a, b] as [number, number], text: chunk.body, raw: scorePassage(chunk, terms, blocks) * answerValueMultiplier(chunk) };
      });
      const maxRaw = Math.max(...chunks.map((c) => c.raw));
      for (const c of chunks) {
        if (c.raw <= 0 || c.text.length > 2 * SPLIT_CHUNK_CHARS) continue;
        scoredCandidates.push({ block, score: score * c.raw / maxRaw, snippet: `${headingPrefix}${c.text}`.trim(), rawSnippetBody: c.text, part: { span: c.span, chunk: true, prefix: headingPrefix, leadEnd } });
      }
    }
  }

  const topScore = scoredCandidates.length > 0
    ? Math.max(...scoredCandidates.map((c) => c.score))
    : 0;

  const diagnostics = computeEvidenceDiagnostics(
    content,
    query,
    scoredCandidates.filter((c) => !c.part?.chunk).length,
    topScore,
  );

  if (scoredCandidates.length === 0) {
    return {
      highlights: [],
      highlightItems: [],
      diagnostics,
      temporalAnchors: [],
    };
  }

  scoredCandidates.sort((a, b) => b.score - a.score);

  // 1. スコア閾値 (topScore * 0.35) を満たす候補にフィルタ
  const validCandidates = scoredCandidates.filter((c, idx) => idx === 0 || c.score >= topScore * 0.35);

  // 2. MMR (Maximal Marginal Relevance) による多様性選択 (同一内容・言い換えの重複排除)
  // MMR の貪欲な順は上限に依らず、類似度は書き出しを付けない窓で測るので、件数を指定したときの節と、
  // 指定しないときの先頭 3 件（目安より長い節の塊が入るときを除く）は、目安を入れる前と同じ
  const mmrOrder = selectMaximalMarginalRelevance(validCandidates, {
    getScore: (c) => c.score,
    getText: (c) => c.rawSnippetBody,
    limit: extend ? BUDGET_MAX_HIGHLIGHTS : maxHighlights,
    lambda: MMR_LAMBDA,
  });
  const mmrCandidates = mmrOrder.slice(0, maxHighlights);
  if (extend) {
    let used = mergeSectionParts(mmrCandidates).reduce((n, c) => n + c.snippet.length, 0);
    // 1. 余りがあれば、窓で切った節を丸ごとに戻す（順位の高い順）
    for (const c of mmrCandidates) {
      if (!c.wholeSnippet || used + c.wholeSnippet.length - c.snippet.length > HIGHLIGHT_CHAR_BUDGET) continue;
      used += c.wholeSnippet.length - c.snippet.length;
      c.snippet = c.wholeSnippet;
    }
    // 2. 収まる候補を MMR の順に足す（同じ節の窓・塊はまとめた字数で数える）
    for (const c of mmrOrder.slice(maxHighlights)) {
      const next = c.part ? mergeSectionParts([...mmrCandidates, c]).reduce((n, x) => n + x.snippet.length, 0) : used + c.snippet.length;
      if (next > HIGHLIGHT_CHAR_BUDGET) continue;
      mmrCandidates.push(c);
      used = next;
    }
    // 3. 選んだハイライトに無い検索語（採点で外れる 1 字の語も含む）がページにあれば、それを最も多く含む節（同数なら点の高い節）を 1 つ足す。
    //    本文は max(目安の残り, 800) 字まで: 窓で切る節（800 字超）は書き出しと窓で収まり、収まらない表・コード・切れ目の無い長い文の節は
    //    飛ばして次の節を試す（試すのは FILL_MAX_TRIES 節まで。窓の計算は節ごとに全節の IDF を数えるため）
    const covered = mergeSectionParts(mmrCandidates).map((c) => c.snippet.toLowerCase()).join('\n');
    const missing = coverageWords(query).filter((w) => !covered.includes(w));
    if (missing.length > 0) {
      const chosen = new Set(mmrCandidates.map((c) => c.block));
      const scoreOf = new Map(scoredCandidates.filter((c) => !c.part?.chunk).map((c) => [c.block, c.score]));
      const cap = Math.max(HIGHLIGHT_CHAR_BUDGET - used, 800);
      const fills = blocks
        .filter((b) => !chosen.has(b))
        .map((b) => ({ b, hits: missing.filter((w) => `${b.headingPath.join(' ')}\n${b.body}`.toLowerCase().includes(w)).length }))
        .filter((f) => f.hits > 0)
        .sort((x, y) => y.hits - x.hits || (scoreOf.get(y.b) ?? 0) - (scoreOf.get(x.b) ?? 0));
      for (const { b } of fills.slice(0, FILL_MAX_TRIES)) {
        const fillTerms = missing.filter((w) => b.body.toLowerCase().includes(w));
        const body = b.body.length > 800 && !isTableOrCode(b.body)
          ? dinkelbachOptimalWindow(b.body, fillTerms.length > 0 ? fillTerms : terms, blocks, { leadChars: WINDOW_LEAD_CHARS }).withLead
          : b.body;
        if (body.length > cap) continue;
        const headingPrefix = b.headingPath.length > 0 ? `## ${b.headingPath.join(' > ')}\n\n` : '';
        const fill = { block: b, score: scoreOf.get(b) ?? 0, snippet: `${headingPrefix}${body}`.trim(), rawSnippetBody: body };
        mmrCandidates.push(fill);
        used += fill.snippet.length;
        break;
      }
    }
    // 4. 足切りに届かない、最高点の LOW_SCORE_RATIO 倍以上の節を、点の順に目安の残りに収まる限り足す（8 件まで）。
    //    取りこぼしの補いの後に足すので、補いの節は変えない。MMR を通らないので、選んだ節と本文が同じ節は飛ばす
    const chosenBlocks = new Set(mmrCandidates.map((c) => c.block));
    const chosenBodies = new Set(mmrCandidates.map((c) => c.rawSnippetBody));
    for (const c of scoredCandidates.slice(validCandidates.length)) {
      if (mmrCandidates.length >= BUDGET_MAX_HIGHLIGHTS || c.score < topScore * LOW_SCORE_RATIO) break;
      if (c.part?.chunk || chosenBlocks.has(c.block) || chosenBodies.has(c.rawSnippetBody) || used + c.snippet.length > HIGHLIGHT_CHAR_BUDGET) continue;
      mmrCandidates.push(c);
      chosenBodies.add(c.rawSnippetBody);
      used += c.snippet.length;
    }
  }

  const selectedHighlights: string[] = [];
  const selectedItems: HighlightItem[] = [];
  const allTemporalAnchors: TemporalAnchor[] = [];

  for (const cand of mergeSectionParts(mmrCandidates)) {
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

  return {
    highlights: selectedHighlights,
    highlightItems: selectedItems,
    diagnostics,
    temporalAnchors: allTemporalAnchors,
  };
}

/**
 * 同じ節から選んだ窓・塊を、その節で最初に選んだものの位置で 1 つのハイライトにまとめる: 書き出し・窓・塊を本文の順に並べ、
 * 離れたところは ... でつなぐ。窓だけなら窓の形（書き出し付き）のまま
 */
function mergeSectionParts<T extends { block: HeadingBlock; snippet: string; part?: { span: [number, number]; chunk: boolean; prefix: string; leadEnd: number } }>(sel: T[]): T[] {
  if (!sel.some((c) => c.part?.chunk)) return sel;
  const out: T[] = [];
  const done = new Set<HeadingBlock>();
  for (const c of sel) {
    if (!c.part) { out.push(c); continue; }
    if (done.has(c.block)) continue;
    done.add(c.block);
    const parts = sel.filter((x) => x.part && x.block === c.block).map((x) => x.part!);
    if (parts.length === 1 && !parts[0].chunk) { out.push(c); continue; }
    const body = c.block.body;
    const spans = [[0, parts[0].leadEnd] as [number, number], ...parts.map((p) => p.span)].sort((x, y) => x[0] - y[0]);
    let text = '';
    let end = 0;
    for (const [a, b] of spans) {
      if (b <= end) continue;
      // 重なり・空白だけの間はそのままつなぐ
      text += a <= end || !body.slice(end, a).trim() ? body.slice(end, b) : ` ... ${body.slice(a, b)}`;
      end = b;
    }
    out.push({ ...c, snippet: `${c.part.prefix}${text.trim()}`.trim() });
  }
  return out;
}

/** 本文を [開始, 終了) の塊に分ける: 空行で区切った段落を前から max 字までまとめる。max 字を超える段落は文（。！？!? と改行で区切る）を max 字までまとめてから */
function chunkSpans(body: string, max: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let start = 0;
  for (const m of [...body.matchAll(/\n\s*\n/g), null]) {
    const end = m ? m.index! : body.length;
    const para = body.slice(start, end);
    if (para.length <= max) pieces.push([start, end]);
    else pieces.push(...packSpans([...para.matchAll(/[^。！？!?\r\n]+[。！？!?\r\n]*/g)].map((x) => [start + x.index!, start + x.index! + x[0].length] as [number, number]), max));
    if (m) start = m.index! + m[0].length;
  }
  return packSpans(pieces, max).filter(([a, b]) => body.slice(a, b).trim());
}

/** 並んだ区間を、前から合わせて max 字以内になる限りまとめる */
function packSpans(spans: Array<[number, number]>, max: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && b - last[0] <= max) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

/** 表・コードの節（窓で切らない） */
function isTableOrCode(body: string): boolean {
  return (body.includes('|') && body.includes('---')) || body.includes('```');
}

/** 取りこぼしを確かめる検索語: Segmenter の語（1 字の語も含む）。ひらがなだけの語と記号は除く */
function coverageWords(query: string): string[] {
  const out = new Set<string>();
  for (const seg of new Intl.Segmenter('ja', { granularity: 'word' }).segment(query)) {
    const w = seg.segment.toLowerCase().trim();
    if (!seg.isWordLike || !w || /^[\p{Script=Hiragana}ー]+$/u.test(w) || !/[\p{L}\p{N}]/u.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

/** クエリ関連ハイライト抽出（本文だけが要るときの入口。中身は extractQueryHighlightDetails） */
export function extractQueryHighlights(content: string, query: string, maxHighlights = 3): string[] {
  return extractQueryHighlightDetails(content, query, { maxHighlights }).highlights;
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
export interface SearchCandidateScore {
  score: number;
  titleScore: number;
  snippetScore: number;
  exactMatchScore: number;
  sourceHintScore: number;
}

interface ScoredSearchCandidate<T> {
  item: T;
  originalIndex: number;
  score: number;
  breakdown: SearchCandidateScore;
}

// Shared lexical scoring core (RFC P0-WEB-02).
// rerankSearchResults() is a thin ordering wrapper over this core.
// The core is also exposed via scoreSearchCandidate() for diagnostics
// and deep-retrieval selection. Ranking callers must not use it to
// replace provider order on a single SERP.
function computeCandidateScores<T extends { title?: string; snippet?: string; description?: string; url?: string; content?: string }>(
  items: T[],
  query: string,
): Array<ScoredSearchCandidate<T>> {
  const terms = extractTermsWithBigrams(query);
  const N = items.length;
  const lowerQuery = query.toLowerCase().trim();
  const itemDocs = items.map((item) => ({
    title: (item.title || '').toLowerCase(),
    snippet: (item.snippet || item.description || item.content || '').toLowerCase(),
  }));
  let totalTitleLen = 0;
  let totalSnippetLen = 0;
  for (const doc of itemDocs) {
    totalTitleLen += doc.title.length;
    totalSnippetLen += doc.snippet.length;
  }
  const avgTitleLen = Math.max(1, totalTitleLen / Math.max(1, N));
  const avgSnippetLen = Math.max(1, totalSnippetLen / Math.max(1, N));
  const dfMap = new Map<string, number>();
  for (const term of terms) {
    let df = 0;
    for (const doc of itemDocs) {
      if (doc.title.includes(term) || doc.snippet.includes(term)) df++;
    }
    dfMap.set(term, df);
  }
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
  const k1 = 1.2;
  const b = 0.75;
  const wTitle = 3.0;
  const wSnippet = 1.0;
  return items.map((item, originalIndex) => {
    const doc = itemDocs[originalIndex];
    let exactMatchScore = 0;
    if (doc.title.includes(lowerQuery)) exactMatchScore += 5.0;
    if (doc.snippet.includes(lowerQuery)) exactMatchScore += 2.5;
    if (doc.title.startsWith(lowerQuery)) exactMatchScore += 2.0;
    let titleScore = 0;
    let snippetScore = 0;
    const normTitle = 1 - b + b * (doc.title.length / avgTitleLen);
    const normSnippet = 1 - b + b * (doc.snippet.length / avgSnippetLen);
    for (const term of terms) {
      const df = dfMap.get(term) || 0;
      if (df === 0) continue;
      const termIdf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const tfTitle = countOccurrences(doc.title, term);
      const tfSnippet = countOccurrences(doc.snippet, term);
      if (tfTitle > 0 || tfSnippet > 0) {
        const bm25Title = tfTitle > 0 ? (tfTitle * (k1 + 1)) / (tfTitle + k1 * normTitle) : 0;
        const bm25Snippet = tfSnippet > 0 ? (tfSnippet * (k1 + 1)) / (tfSnippet + k1 * normSnippet) : 0;
        const lengthBonus = term.length >= 4 ? 1.4 : term.length >= 3 ? 1.2 : 1.0;
        titleScore += termIdf * wTitle * bm25Title * lengthBonus;
        snippetScore += termIdf * wSnippet * bm25Snippet * lengthBonus;
      }
    }
    let sourceHintScore = 0;
    try {
      const host = new URL(item.url || '').hostname.toLowerCase();
      if (host.endsWith('.go.jp') || host === 'go.jp' || host.endsWith('.gov') || host === 'gov') sourceHintScore += 2.0;
      if (host.endsWith('.ac.jp') || host.endsWith('.edu')) sourceHintScore += 1.5;
      if (host.endsWith('.org')) sourceHintScore += 0.5;
    } catch {
    }
    if (terms.length >= 2) {
      for (let i = 0; i < terms.length - 1; i++) {
        const t1 = terms[i];
        const t2 = terms[i + 1];
        const p1 = doc.title.indexOf(t1);
        const p2 = doc.title.indexOf(t2, p1 >= 0 ? p1 : 0);
        if (p1 >= 0 && p2 > p1 && (p2 - p1) < 40) titleScore += 2.0;
      }
    }
    const stabilityPrior = (N - originalIndex) * 0.05;
    const score = exactMatchScore + titleScore + snippetScore + sourceHintScore + stabilityPrior;
    return { item, originalIndex, score, breakdown: { score, titleScore, snippetScore, exactMatchScore, sourceHintScore } };
  });
}

/** Diagnostic candidate scoring (no reordering). Shares the core with rerankSearchResults. */
export function scoreSearchCandidate<T extends { title?: string; snippet?: string; description?: string; url?: string; content?: string }>(
  items: T[],
  query: string,
): Array<{ item: T; lexicalScore: number; originalIndex: number; breakdown: SearchCandidateScore }> {
  const zero = (): SearchCandidateScore => ({ score: 0, titleScore: 0, snippetScore: 0, exactMatchScore: 0, sourceHintScore: 0 });
  if (!items || items.length === 0 || !query) {
    return (items || []).map((item, originalIndex) => ({ item, lexicalScore: 0, originalIndex, breakdown: zero() }));
  }
  const terms = extractTermsWithBigrams(query);
  if (terms.length === 0) {
    return items.map((item, originalIndex) => ({ item, lexicalScore: 0, originalIndex, breakdown: zero() }));
  }
  return computeCandidateScores(items, query).map((s) => ({
    item: s.item,
    lexicalScore: s.score,
    originalIndex: s.originalIndex,
    breakdown: s.breakdown,
  }));
}

/** Legacy ordering wrapper over the shared scoring core. Do not use to replace provider order. */
export function rerankSearchResults<T extends { title?: string; snippet?: string; description?: string; url?: string; content?: string }>(
  items: T[],
  query: string,
): T[] {
  if (!items || items.length <= 1 || !query) return items;
  const terms = extractTermsWithBigrams(query);
  if (terms.length === 0) return items;
  const scored = computeCandidateScores(items, query);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
export function reciprocalRankFusion(docRanks: Array<{ key: string; rank: number }>, k = 60, weightOf?: (key: string) => number): number {
  let s = 0;
  for (const r of docRanks) {
    let w = 1;
    try {
      const v = weightOf ? weightOf(r.key) : 1;
      if (Number.isFinite(v) && v >= 0) w = v;
    } catch {}
    s += w / (k + r.rank + 1);
  }
  return s;
}

/** P2 answer-bearing: snippet/body contains answer-like signals (diagnostic, not ranking replacement) */
export function computeAnswerability(item: { title?: string; snippet?: string; description?: string; markdown?: string; content?: string }, query: string): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;
  try {
    const q = (query || "").toLowerCase();
    const text = `${item.title || ""} ${item.snippet || item.description || ""} ${item.markdown || item.content || ""}`;
    const has = (re: RegExp) => re.test(text);
    const qHas = (...keys: string[]) => keys.some((k) => q.includes(k));
    if (qHas("\u4fa1\u683c", "\u6599\u91d1", "\u5024\u6bb5")) {
      if (has(/[\u5186\uffe5$\uff04]/) || has(/\d[\d,]*\s*\u5186/)) { score += 2; signals.push("price"); }
    }
    if (has(/\d{1,2}:\d{2}/) || has(/\d{1,2}\u6642/) || has(/\d+\/\d+/)) { score += 0.5; if (!signals.includes("concrete")) signals.push("concrete"); }
    if (qHas("\u51fa\u6f14\u6642\u9593", "\u30bf\u30a4\u30c6", "\u55b6\u696d\u6642\u9593", "\u958b\u6f14")) {
      if (has(/\d{1,2}:\d{2}/) || has(/\d{1,2}\u6642/)) { score += 2; signals.push("time"); }
    }
    if (qHas("\u8f9e\u9000", "\u30ad\u30e3\u30f3\u30bb\u30eb", "\u4e2d\u6b62", "\u6b20\u5e2d")) {
      if (has(/\u8f9e\u9000|\u30ad\u30e3\u30f3\u30bb\u30eb|\u4e2d\u6b62|\u6b20\u5e2d|\u53d6\u308a\u6d88\u3057/)) { score += 2; signals.push("cancel"); }
    }
  } catch {} 
  return { score, signals };
}

export interface DeepEvidenceRerankOptions {
  requirements?: string[];
  enableHighlightFeature?: boolean;
}

/**
 * 意図・属性を表すキーフレーズ（Intent Attribute Terms）
 * ユーザーが具体的な事実やメタデータを求めていることを示す属性語群
 */
const INTENT_ATTRIBUTE_TERMS: Set<string> = new Set(INTENT_ATTRIBUTE_TERMS_LIST);

/**
 * 深層スクレイピング後のエビデンス駆動リランキング (Evidence-Aware Deep Reranking)
 *
 * 【位置づけ】
 * 本機能はハイライトの選択そのものではなく、
 * 「Production Retrieval-Verification Layer（検索検証レイヤー）」として動作する。
 *
 * 【解決する課題】
 * スニペット段階のBM25+リランキングでは、検索インデックスが合成した断片スニペットに
 * たまたま別文脈で単語（例: 「作詞」）が含まれていた場合、偽陽性（False Positive）として
 * 本文中にユーザーの求める回答根拠が一切存在しないページが上位に来てしまう。
 *
 * 【評価プロトコル v0.1 準拠の実装】
 * 1. 堅牢なターム分解: extractTermsWithBigrams により日本語無空白クエリでも正確にタームを抽出
 * 2. Intent Anchor: 固定末尾語依存を廃止し、属性語辞書の語から意図語を同定。辞書の語が無い問いでは置かない
 *    （以前は候補群で出現の最も少ない語で代用していたが、保存済みの検索結果で比べると、代用をやめたほうが
 *    1 位のページに答えがある割合が上がった）
 * 3. 有界な Rank Prior: (N-index) 依存を廃止し、alpha / sqrt(rank) による正規化事前確率を採用
 * 4. ハイライトのエビデンス: ハイライト存在基礎点と相対スケーリングによる頑健な証拠加算（Ablation対応）
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

  // 1. クエリタームの分解（P2重み付きcoverage）
  // Entity/要求属性 weight 3, 日付/場所 weight 2, 通常 1, 生成bigram 0.5
  let queryTerms: string[] = [];
  const termWeights = new Map<string, number>();
  if (options?.requirements && options.requirements.length > 0) {
    queryTerms = options.requirements.map((r) => r.toLowerCase().trim()).filter((r) => r.length > 0);
    for (const t of queryTerms) termWeights.set(t, 3.0);
  } else {
    // 共通の extractTermsWithBigrams を使用し、空白の有無に関わらず形態素・複合語・Bigram を抽出
    const extracted = extractTermsWithBigrams(query);
    const whitespaceWords = query.toLowerCase().trim().split(/[\s　]+/).map((w) => w.trim()).filter((w) => w.length > 0);
    const termSet = new Set<string>();
    const isDateLike = (t: string) => /\d.*[月日時/\-:：]/.test(t) || /\d{1,2}:\d{2}/.test(t);
    const isAttrTerm = (t: string) => {
      for (const attr of INTENT_ATTRIBUTE_TERMS) { if (t.includes(attr.toLowerCase())) return true; }
      return false;
    };
    // First whitespace token is the main entity (weight 3); later tokens
    // are support (1) unless they carry attribute (3) or date (2) intent.
    const contentWords = whitespaceWords.filter((t) => t.length >= 2);
    contentWords.forEach((t, idx) => {
      termSet.add(t);
      let w = idx === 0 ? 3.0 : 1.0;
      if (isAttrTerm(t)) w = 3.0;
      else if (isDateLike(t)) w = Math.max(w, 2.0);
      termWeights.set(t, w);
    });
    for (const t of extracted) {
      if (t.length >= 2 && !termSet.has(t)) {
        termSet.add(t);
        // Generated bigrams/composites start low; attribute or date signals promote them.
        let w = 0.5;
        if (isAttrTerm(t)) w = 3.0;
        else if (isDateLike(t)) w = 2.0;
        else w = 1.0;
        termWeights.set(t, w);
      }
    }
    queryTerms = Array.from(termSet);
  }

  if (queryTerms.length === 0) return items;

  // 2. Intent Anchor（意図アンカー語）の同定 (第4.2項)
  // 固定 lastWord を廃止し、属性語辞書合致語を選択（辞書の語が無ければ置かない）
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

  // P2: Entity Anchor (2軸化)
  const entityAnchor = query.toLowerCase().trim().split(/[\s　]+/).map((w) => w.trim()).find((w) => w.length >= 2) ?? null;

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

    // A. P2重み付きカバレッジ
    let coveredWeightBody = 0;
    let coveredWeightHl = 0;
    let totalWeight = 0;
    for (const term of queryTerms) {
      const w = termWeights.get(term) ?? 1.0;
      totalWeight += w;
      if (bodyText.includes(term) || titleText.includes(term)) coveredWeightBody += w;
      if (highlightText.includes(term)) coveredWeightHl += w;
    }
    const bodyCoverage = totalWeight > 0 ? coveredWeightBody / totalWeight : 0;
    const highlightCoverage = totalWeight > 0 ? coveredWeightHl / totalWeight : 0;

    score += bodyCoverage * 8.0;
    score += highlightCoverage * 12.0;

    // 全単語完全充足（100% coverage）ボーナス
    if (bodyCoverage >= 1.0) {
      score += 10.0;
    }
    if (highlightCoverage >= 1.0) {
      score += 6.0;
    }

    // B. P2 Entity+Intent 2軸anchor 近接評価
    if (entityAnchor && intentAnchor) {
      const body = bodyText + ' ' + titleText;
      const pe = body.indexOf(entityAnchor);
      const pi = intentAnchor ? body.indexOf(intentAnchor) : -1;
      if (pe >= 0 && pi >= 0 && Math.abs(pe - pi) < 200) score += 4.0;
      else if (pe >= 0 && pi >= 0) score += 1.0;
    } else if (entityAnchor) {
      if (bodyText.includes(entityAnchor) || titleText.includes(entityAnchor)) score += 1.0;
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

    // C. ハイライトのエビデンス特徴量（Ablation 対応: 第4.4項）
    if (options?.enableHighlightFeature !== false) {
      const hasHighlights = (item.highlights && item.highlights.length > 0) || (item.highlightItems && item.highlightItems.length > 0);
      if (hasHighlights) {
        score += 3.0; // ハイライト存在基礎点
        if (maxHighlightScore > 0 && item.highlightItems && item.highlightItems.length > 0) {
          const topScore = item.highlightItems[0]?.score ?? 0;
          // ページの間の点数の尺度の違いを、最高点との比で吸収する
          score += Math.max(0, Math.min(1, topScore / maxHighlightScore)) * 3.0;
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
