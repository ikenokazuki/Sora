import { getFromCache, setToCache } from '../cache.js';
import { rerankSearchResults } from '../enrichment.js';

export const CACHE_TTL_LAW = 24 * 60 * 60 * 1000; // 法令データは24時間キャッシュ

export interface LawSearchResultItem {
  id: string;             // 法令ID (例: "131AC0000000011")
  title: string;          // 法令名 (例: "民法")
  lawNum: string;         // 法令番号 (例: "明治三十一年法律第十一号")
  promulgationDate?: string; // 公布年月日
  category?: string;      // 法令種別 (法律, 政令, 府省令等)
}

export interface LawDataResult {
  id: string;
  title: string;
  lawNum: string;
  era?: string;
  lawType?: string;
  enforcementDate?: string;
  markdown: string;
  articleCount?: number;
  source: 'e-gov';
}

/** e-Gov 法令 API v2 キーワード法令検索 (JSON レスポンス) */
export async function searchLaws(options: {
  keyword: string;
  limit?: number;
  noCache?: boolean;
}): Promise<{ count: number; items: LawSearchResultItem[]; source: 'e-gov' }> {
  const keyword = options.keyword?.trim();
  if (!keyword) {
    throw new Error('keyword is required for law search');
  }

  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const cacheKey = `gov:laws:${keyword}:${limit}`;

  if (!options.noCache) {
    const cached = getFromCache<{ count: number; items: LawSearchResultItem[]; source: 'e-gov' }>(cacheKey);
    if (cached) return cached;
  }

  const url = `https://laws.e-gov.go.jp/api/2/keyword?keyword=${encodeURIComponent(keyword)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Sora-Gov-Law-Fetcher/1.0',
      'Accept': 'application/json, text/plain, */*',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`e-Gov 法令APIへのアクセスに失敗しました (HTTP ${res.status}): ${url}`);
  }

  const rawText = await res.text();
  let json: any = [];
  try {
    json = JSON.parse(rawText);
  } catch {
    // 万が一 XML が返ってきた場合のフォールバック
    const { XMLParser } = await import('fast-xml-parser');
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(rawText);
    const list = parsed?.Data_Root?.Appl_Data?.LawNameListInfo;
    json = Array.isArray(list) ? list : list ? [list] : [];
  }

  const list: any[] = Array.isArray(json) ? json : json?.items || json?.laws || (json?.law_info ? [json] : []);
  const items: LawSearchResultItem[] = [];

  for (const entry of list) {
    const info = entry.law_info || entry;
    const rev = entry.revision_info || entry;
    const lawId = info.law_id || info.LawId;
    if (!lawId) continue;

    items.push({
      id: String(lawId),
      title: String(rev.law_title || rev.law_title_kana || info.LawName || info.law_title || '名称不明')
        .replace(/<span>|<\/span>/g, ''),
      lawNum: String(info.law_num || info.LawNo || ''),
      promulgationDate: (info.promulgation_date || info.PromulgationDate) ? String(info.promulgation_date || info.PromulgationDate) : undefined,
      category: (rev.category || info.law_type || info.LawType) ? String(rev.category || info.law_type || info.LawType) : undefined,
    });
  }

  const reranked = rerankSearchResults(items, keyword);
  const finalItems = reranked.slice(0, limit);

  const result = {
    count: finalItems.length,
    items: finalItems,
    source: 'e-gov' as const,
  };

  if (!options.noCache) {
    setToCache(cacheKey, result, CACHE_TTL_LAW);
  }

  return result;
}

/** e-Gov 法令 JSON AST ノードからプレーンテキストを再帰抽出 */
function extractNodeText(node: any): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(extractNodeText).join('');
  if (node.children) return extractNodeText(node.children);
  return '';
}

/** e-Gov 法令 JSON AST を Markdown 形式に構造化変換するヘルパー */
export function convertLawJsonAstToMarkdown(lawRoot: any): { markdown: string; title: string; lawNum: string; articleCount: number } {
  const lines: string[] = [];
  let articleCount = 0;
  let lawTitle = '';
  let lawNum = '';

  function walk(node: any, depth = 0) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth);
      return;
    }

    const tag = node.tag;
    const attr = node.attr || {};
    const children = node.children || [];

    if (tag === 'Law') {
      lawNum = attr.Num || attr.LawNum || '';
      for (const child of children) walk(child, depth + 1);
      return;
    }

    if (tag === 'LawNum') {
      const numText = extractNodeText(children).trim();
      if (numText) lawNum = numText;
      return;
    }

    if (tag === 'LawTitle') {
      lawTitle = extractNodeText(children).trim();
      lines.push(`# ${lawTitle}\n`);
      if (lawNum) lines.push(`**法令番号:** ${lawNum}\n`);
    } else if (tag === 'ChapterTitle' || tag === 'PartTitle') {
      const text = extractNodeText(children).trim();
      lines.push(`\n## ${text}\n`);
    } else if (tag === 'SectionTitle') {
      const text = extractNodeText(children).trim();
      lines.push(`\n### ${text}\n`);
    } else if (tag === 'SubsectionTitle' || tag === 'DivisionTitle') {
      const text = extractNodeText(children).trim();
      lines.push(`\n#### ${text}\n`);
    } else if (tag === 'Article') {
      articleCount++;
      let artTitle = '';
      let artCaption = '';

      for (const child of children) {
        if (child?.tag === 'ArticleTitle') artTitle = extractNodeText(child).trim();
        if (child?.tag === 'ArticleCaption') artCaption = extractNodeText(child).trim();
      }

      const captionText = artCaption ? ` (${artCaption})` : '';
      lines.push(`\n### ${artTitle || `第${attr.Num || ''}条`}${captionText}\n`);

      for (const child of children) {
        if (child?.tag !== 'ArticleTitle' && child?.tag !== 'ArticleCaption') {
          walk(child, depth + 1);
        }
      }
      return;
    } else if (tag === 'ParagraphSentence') {
      const text = extractNodeText(children).trim();
      if (text) lines.push(`${text}`);
    } else if (tag === 'Item') {
      let itemTitle = '';
      let itemSentence = '';
      for (const child of children) {
        if (child?.tag === 'ItemTitle') itemTitle = extractNodeText(child).trim();
        if (child?.tag === 'ItemSentence') itemSentence = extractNodeText(child).trim();
      }
      if (itemTitle || itemSentence) {
        lines.push(`- **${itemTitle}** ${itemSentence}`.trim());
      }
    } else if (tag === 'SupplProvision') {
      let label = '';
      for (const child of children) {
        if (child?.tag === 'SupplProvisionLabel') label = extractNodeText(child).trim();
      }
      lines.push(`\n## 附則 ${label || ''}\n`);
      for (const child of children) {
        if (child?.tag !== 'SupplProvisionLabel') walk(child, depth + 1);
      }
      return;
    } else if (tag === 'Sentence') {
      const text = extractNodeText(children).trim();
      if (depth === 0 && text) lines.push(text);
    } else {
      if (children.length > 0) {
        walk(children, depth + 1);
      }
    }
  }

  walk(lawRoot);

  return {
    markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    title: lawTitle,
    lawNum,
    articleCount,
  };
}

/** e-Gov 法令 API v2 法令本文・条文詳細取得 */
export async function getLawData(options: {
  lawId: string;
  noCache?: boolean;
}): Promise<LawDataResult> {
  const rawId = options.lawId?.trim();
  if (!rawId) {
    throw new Error('lawId is required for law data');
  }

  const cacheKey = `gov:law_data:${rawId}`;
  if (!options.noCache) {
    const cached = getFromCache<LawDataResult>(cacheKey);
    if (cached) return cached;
  }

  const url = `https://laws.e-gov.go.jp/api/2/law_data/${encodeURIComponent(rawId)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Sora-Gov-Law-Fetcher/1.0',
      'Accept': 'application/json, text/plain, */*',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`e-Gov 法令本文の取得に失敗しました (HTTP ${res.status}): ${rawId}`);
  }

  const rawText = await res.text();
  let jsonAst: any = null;
  try {
    jsonAst = JSON.parse(rawText);
  } catch {}

  let markdown = '';
  let lawTitle = rawId;
  let lawNum = '';
  let articleCount = 0;
  let era: string | undefined;
  let lawType: string | undefined;

  if (jsonAst?.law_full_text) {
    const root = jsonAst.law_full_text;
    era = root.attr?.Era;
    lawType = root.attr?.LawType;
    const parsed = convertLawJsonAstToMarkdown(root);
    markdown = parsed.markdown;
    if (parsed.title) lawTitle = parsed.title;
    if (parsed.lawNum) lawNum = parsed.lawNum;
    articleCount = parsed.articleCount;
  } else {
    markdown = `${rawId} (法令テキスト)`;
  }

  const result: LawDataResult = {
    id: rawId,
    title: lawTitle,
    lawNum,
    era,
    lawType,
    markdown: markdown || `${lawTitle} (法令条文テキスト)`,
    articleCount,
    source: 'e-gov',
  };

  if (!options.noCache) {
    setToCache(cacheKey, result, CACHE_TTL_LAW);
  }

  return result;
}

export const CACHE_TTL_DIET = 60 * 60 * 1000; // 国会会議録は1時間キャッシュ

export interface DietSpeechRecord {
  speechId: string;
  issueId?: string;
  session?: number;
  house: string;
  meeting: string;
  issue?: string;
  date: string;
  speaker: string;
  speakerPosition?: string;
  speakerGroup?: string;
  speakerRole?: string;
  speech: string;
  speechUrl: string;
  meetingUrl?: string;
  pdfUrl?: string;
}

export interface DietMinutesSearchResult {
  count: number;
  totalHits: number;
  items: DietSpeechRecord[];
  source: 'kokkai-ndl';
}

/** 国会会議録検索 API (kokkai.ndl.go.jp) */
export async function searchDietMinutes(options: {
  keyword?: string;
  speaker?: string;
  nameOfHouse?: '衆議院' | '参議院';
  nameOfMeeting?: string;
  from?: string;
  until?: string;
  limit?: number;
  noCache?: boolean;
}): Promise<DietMinutesSearchResult> {
  const keyword = options.keyword?.trim();
  const speaker = options.speaker?.trim();
  const nameOfHouse = options.nameOfHouse?.trim() as '衆議院' | '参議院' | undefined;
  const nameOfMeeting = options.nameOfMeeting?.trim();
  const from = options.from?.trim();
  const until = options.until?.trim();
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 30);

  if (!keyword && !speaker && !nameOfMeeting) {
    throw new Error('keyword, speaker, または nameOfMeeting のいずれかを指定してください');
  }

  const cacheKey = `gov:diet:${keyword || ''}:${speaker || ''}:${nameOfHouse || ''}:${nameOfMeeting || ''}:${from || ''}:${until || ''}:${limit}`;

  if (!options.noCache) {
    const cached = getFromCache<DietMinutesSearchResult>(cacheKey);
    if (cached) return cached;
  }

  const params = new URLSearchParams();
  if (keyword) params.set('any', keyword);
  if (speaker) params.set('speaker', speaker);
  if (nameOfHouse) params.set('nameOfHouse', nameOfHouse);
  if (nameOfMeeting) params.set('nameOfMeeting', nameOfMeeting);
  if (from) params.set('from', from);
  if (until) params.set('until', until);
  params.set('maximumRecords', String(limit));
  params.set('recordPacking', 'json');

  const url = `https://kokkai.ndl.go.jp/api/speech?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Sora-Diet-Minutes-Fetcher/1.0',
      'Accept': 'application/json, text/plain, */*',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`国会会議録 API へのアクセスに失敗しました (HTTP ${res.status}): ${url}`);
  }

  const rawText = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error('国会会議録 API のレスポンスのパースに失敗しました');
  }

  const speechRecords: any[] = json?.speechRecord || [];
  const items: DietSpeechRecord[] = speechRecords.map((r: any) => ({
    speechId: r.speechID || r.speechId || '',
    issueId: r.issueID || r.issueId,
    session: r.session ? Number(r.session) : undefined,
    house: r.nameOfHouse || '',
    meeting: r.nameOfMeeting || '',
    issue: r.issue,
    date: r.date || '',
    speaker: (r.speaker || '').trim(),
    speakerPosition: r.speakerPosition || undefined,
    speakerGroup: r.speakerGroup || undefined,
    speakerRole: r.speakerRole || undefined,
    speech: (r.speech || '').trim(),
    speechUrl: r.speechURL || '',
    meetingUrl: r.meetingURL || undefined,
    pdfUrl: r.pdfURL || undefined,
  }));

  const result: DietMinutesSearchResult = {
    count: items.length,
    totalHits: Number(json?.numberOfRecords ?? items.length),
    items,
    source: 'kokkai-ndl',
  };

  if (!options.noCache) {
    setToCache(cacheKey, result, CACHE_TTL_DIET);
  }

  return result;
}

