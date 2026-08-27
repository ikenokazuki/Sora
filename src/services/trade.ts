import { CPSC_HTS_LIST } from './cpsc_hts_data.js';
import { getFromCache, setToCache } from '../cache.js';

export const CACHE_TTL_USITC = 24 * 60 * 60 * 1000; // USITC HTSデータは24時間キャッシュ

export interface CpscApplicableRegulation {
  cfr: string;
  summary: string;
  excerpt: string;
  sourceUrl: string;
}

export interface CpscCertificateCheckResult {
  certificateRequired: boolean | 'unknown';
  certificateType: 'GCC' | 'CCC' | 'none' | 'unknown';
  eFilingRequired: boolean;
  applicableRegulations: CpscApplicableRegulation[];
  missingInfo: string[];
  nextActions: string[];
  disclaimer: string;
}

const DISCLAIMER =
  '本ツールは参考情報を提供するものであり、法的助言ではありません。正式な判断は米国CPSC公式情報または専門家にご確認ください。';

const CPSC_PDF_SOURCE_URL =
  'https://www.cpsc.gov/s3fs-public/CPSC-Guidance-and-HTS-List-for-Filing-of-Electronic-Certificates-6B-Cleared.pdf';
const CPSC_PDF_EXCERPT =
  'CPSC believes this HTS code is likely to include a product subject to a mandatory standard or is otherwise deemed high-risk. (This list does not encompass all HTS codes where a certificate may be required.)';

function normalizeHtsCode(htsCode: string): string {
  return htsCode.replace(/\./g, '').trim();
}

/** 完全一致(10桁)で該当カテゴリを検索 */
function findExactMatch(normalized: string): string | undefined {
  for (const entry of CPSC_HTS_LIST) {
    if (entry.htsCodes.includes(normalized)) return entry.category;
  }
  return undefined;
}

/** 先頭6桁(HS Subheadingレベル)一致で近似カテゴリ・類似コードを検索 */
function findNearMatch(normalized: string): { category: string; similarCode: string } | undefined {
  const prefix6 = normalized.slice(0, 6);
  for (const entry of CPSC_HTS_LIST) {
    const similar = entry.htsCodes.find((code) => code.slice(0, 6) === prefix6);
    if (similar) return { category: entry.category, similarCode: similar };
  }
  return undefined;
}

/** HTSコードからCPSC適合証明書(GCC/CCC)のeFiling義務要否を判定 */
export async function checkCpscCertificate(options: {
  htsCode: string;
  targetAge: 'adult' | 'child' | 'unknown';
  material?: string;
  productCategory?: string;
  description?: string;
}): Promise<CpscCertificateCheckResult> {
  const htsCode = options.htsCode?.trim();
  if (!htsCode) {
    throw new Error('htsCode is required for CPSC certificate check');
  }
  const normalized = normalizeHtsCode(htsCode);

  const exactCategory = findExactMatch(normalized);

  if (exactCategory) {
    const missingInfo: string[] = [];
    if (options.targetAge === 'unknown') {
      missingInfo.push('targetAge（対象年齢層）が不明です。子供向け製品か否かで適用される安全基準・証明書種別が変わります。');
    }

    const isChild = options.targetAge === 'child';
    const certificateType: CpscCertificateCheckResult['certificateType'] =
      missingInfo.length > 0 ? 'unknown' : isChild ? 'CCC' : 'GCC';

    return {
      certificateRequired: missingInfo.length > 0 ? 'unknown' : true,
      certificateType,
      eFilingRequired: missingInfo.length === 0,
      applicableRegulations: [
        {
          cfr: 'CPSC HTS Guidance List (2026年1月版)',
          summary: `HTSコード "${htsCode}" は "${exactCategory}" カテゴリとしてCPSC eFiling対象HTSリストに掲載`,
          excerpt: CPSC_PDF_EXCERPT,
          sourceUrl: CPSC_PDF_SOURCE_URL,
        },
      ],
      missingInfo,
      nextActions:
        missingInfo.length > 0
          ? ['不足情報を補って再判定してください。']
          : [`${certificateType}を発行し、CBP ACEシステムへeFilingしてください。`],
      disclaimer: DISCLAIMER,
    };
  }

  const nearMatch = findNearMatch(normalized);
  if (nearMatch) {
    return {
      certificateRequired: 'unknown',
      certificateType: 'unknown',
      eFilingRequired: false,
      applicableRegulations: [
        {
          cfr: 'CPSC HTS Guidance List (2026年1月版)',
          summary: `HTSコード "${htsCode}" は完全一致しないが、同じ6桁分類 (${normalized.slice(0, 6)}) の "${nearMatch.category}" カテゴリに類似コード "${nearMatch.similarCode}" がCPSC eFiling対象HTSリストに掲載`,
          excerpt: CPSC_PDF_EXCERPT,
          sourceUrl: CPSC_PDF_SOURCE_URL,
        },
      ],
      missingInfo: [
        `HTSコード "${htsCode}" は完全一致しないが、同じ6桁分類 (${normalized.slice(0, 6)}) の "${nearMatch.category}" カテゴリにCPSC対象コード "${nearMatch.similarCode}" が存在する。個別確認を推奨。`,
      ],
      nextActions: [`類似カテゴリ "${nearMatch.category}" の証明書要否をCPSC公式または専門家に個別確認してください。`],
      disclaimer: DISCLAIMER,
    };
  }

  return {
    certificateRequired: 'unknown',
    certificateType: 'unknown',
    eFilingRequired: false,
    applicableRegulations: [],
    missingInfo: [
      `HTSコード "${htsCode}" はCPSC公式HTSリストに掲載がありません。ただしこのリストは非網羅的であり、掲載が無いことは証明書不要を意味しません。productCategory（製品カテゴリ）を補足するか、CPSC公式に個別確認してください。`,
    ],
    nextActions: ['productCategory（製品カテゴリ）を追加して再判定するか、CPSC公式に個別確認してください。'],
    disclaimer: DISCLAIMER,
  };
}

export interface CheckFdaRegulatedResult {
  fdaRegulatedLikely: boolean | 'unknown';
  possiblePrograms: string[]; // FDAプログラムコード (FOO=食品, DRU=医薬品, COS=化粧品, DEV=医療機器, TOB=タバコ, VME=動物用医薬品等)
  priorNoticeMayApply: boolean;
  matchedChapter: string;
  confidence: 'chapter-level-estimate';
  missingInfo: string[];
  nextActions: string[];
  disclaimer: string;
}

const DISCLAIMER_FDA =
  '本ツールは参考情報を提供するものであり、法的助言ではありません。HTSコードとFDA規制フラグ(FD1〜FD4)の公式対応表は一般公開されていないため、' +
  'この判定はHS Chapter単位の一般的な目安に過ぎません。正式な判断は米国FDA公式情報または専門家にご確認ください。';

interface FdaChapterEntry {
  chapters: string[]; // HTS Chapter番号 (2桁、ゼロ埋め)
  programs: string[]; // FDAプログラムコード
  priorNoticeMayApply: boolean;
  note?: string;
}

/**
 * HS Chapter番号 -> FDA管轄プログラムの対応表。
 * CPSCと異なり、HTS×FD Flagの機械可読な公式対応表は見つからなかったため、
 * HS分類の一般知識に基づく粗い近似（Chapter単位）。将来より精密な公式データが
 * 見つかった場合はそちらに差し替えること。
 */
const FDA_CHAPTER_MAP: FdaChapterEntry[] = [
  { chapters: ['03', '04', '05'], programs: ['FOO'], priorNoticeMayApply: true },
  { chapters: ['06', '07', '08', '09', '10', '11', '12', '13', '14'], programs: ['FOO'], priorNoticeMayApply: true },
  { chapters: ['15'], programs: ['FOO'], priorNoticeMayApply: true },
  {
    chapters: ['16'],
    programs: ['FOO'],
    priorNoticeMayApply: true,
    note: '食肉を含む調製品はUSDA/FSISとの管轄重複あり。',
  },
  { chapters: ['17', '18', '19', '20', '21'], programs: ['FOO'], priorNoticeMayApply: true },
  {
    chapters: ['22'],
    programs: ['FOO'],
    priorNoticeMayApply: true,
    note: 'アルコール飲料はTTB（アルコール・タバコ税貿易管理局）との管轄重複あり。',
  },
  {
    chapters: ['23'],
    programs: ['FOO', 'VME'],
    priorNoticeMayApply: true,
    note: '動物飼料はFDA（動物用医薬品センター/CVM）管轄。',
  },
  { chapters: ['24'], programs: ['TOB'], priorNoticeMayApply: false },
  { chapters: ['30'], programs: ['DRU'], priorNoticeMayApply: false },
  { chapters: ['33'], programs: ['COS'], priorNoticeMayApply: false },
  {
    chapters: ['90'],
    programs: ['DEV'],
    priorNoticeMayApply: false,
    note: '光学・医療用機器の章。同章内でもFDA対象外品目（一般光学機器等）が混在するため個別確認が必要。',
  },
];

// HTS Chapter 2 (食肉および食用くず肉) は原則USDA/FSIS管轄でFDA対象外
const USDA_JURISDICTION_CHAPTERS = ['02'];

/** HTSコードからFDA規制対象の可能性をHS Chapter単位で粗く判定（HTS×FD Flagの公式対応表が存在しないための近似） */
export function checkFdaRegulated(options: {
  htsCode: string;
  productDescription?: string;
}): CheckFdaRegulatedResult {
  const htsCode = options.htsCode?.trim();
  if (!htsCode) {
    throw new Error('htsCode is required for FDA regulation check');
  }
  const normalized = normalizeHtsCode(htsCode);
  const chapter = normalized.slice(0, 2);

  if (USDA_JURISDICTION_CHAPTERS.includes(chapter)) {
    return {
      fdaRegulatedLikely: false,
      possiblePrograms: [],
      priorNoticeMayApply: false,
      matchedChapter: chapter,
      confidence: 'chapter-level-estimate',
      missingInfo: [
        `HTS Chapter ${chapter}（食肉・食用くず肉）は原則USDA/FSIS管轄でありFDAではありません。ただし個別製品によってはFDA関与の余地もあるため確定判断は専門家へ確認してください。`,
      ],
      nextActions: ['USDA/FSISの輸入要件を確認してください。'],
      disclaimer: DISCLAIMER_FDA,
    };
  }

  const entry = FDA_CHAPTER_MAP.find((e) => e.chapters.includes(chapter));
  if (!entry) {
    return {
      fdaRegulatedLikely: false,
      possiblePrograms: [],
      priorNoticeMayApply: false,
      matchedChapter: chapter,
      confidence: 'chapter-level-estimate',
      missingInfo: [],
      nextActions: [],
      disclaimer: DISCLAIMER_FDA,
    };
  }

  return {
    fdaRegulatedLikely: true,
    possiblePrograms: entry.programs,
    priorNoticeMayApply: entry.priorNoticeMayApply,
    matchedChapter: chapter,
    confidence: 'chapter-level-estimate',
    missingInfo: entry.note ? [entry.note] : [],
    nextActions: ['FDA該当プログラムの具体的な登録・提出要件をFDA公式（fda.gov）または専門家に確認してください。'],
    disclaimer: DISCLAIMER_FDA,
  };
}

export interface HtsCandidate {
  htsCode: string;
  description: string;
}

export interface VerifyHtsCodeResult {
  htsCode: string;
  productDescription: string;
  verified: boolean;
  matchLevel: 'exact' | '6-digit-category' | 'unmatched';
  hsCode?: string;
  officialDescription?: string;
  generalRate?: string;
  otherRate?: string;
  specialRate?: string;
  nearbyCandidates: HtsCandidate[];
  disclaimer: string;
  source: 'usitc-hts';
}

const DISCLAIMER_USITC =
  '本ツールは米国USITC公式データによる実在確認・関税率取得であり、法的な分類判断ではありません。' +
  '最終的な分類確定にはCBPのCROSS判定検索（rulings.cbp.gov）や通関士等の専門家への確認が必要です。';

/** 10桁の数字文字列を USITC 表記 (XXXX.XX.XXXX) に変換 */
function toUsitcFullFormat(normalized: string): string {
  return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)}.${normalized.slice(6, 10)}`;
}

/** 10桁の数字文字列の先頭6桁を USITC 表記 (XXXX.XX) に変換 */
function toUsitcSixDigitFormat(normalized: string): string {
  return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)}`;
}

interface UsitcSearchItem {
  htsno: string;
  description: string;
  indent: string;
  general?: string;
  other?: string;
  special?: string;
}

async function searchUsitc(query: string): Promise<UsitcSearchItem[]> {
  const cacheKey = `trade:usitc:${query}`;
  const cached = getFromCache<{ items: UsitcSearchItem[] }>(cacheKey);
  if (cached) return cached.items;

  const url = `https://hts.usitc.gov/reststop/search?keyword=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Sora-Trade-Compliance-Fetcher/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`USITC HTS検索APIへのアクセスに失敗しました (HTTP ${res.status}): ${url}`);
  }
  const items = (await res.json()) as UsitcSearchItem[];
  setToCache(cacheKey, { items }, CACHE_TTL_USITC);
  return items;
}

/**
 * LLM・利用者が推論したHTSコード候補を米国USITC公式データで実在確認・関税率取得する。
 * キーワード検索による一意特定は不可能と判明したため（複数キーワードでもAND検索にならず、
 * 章指定パラメータも効果なし）、逆にコード候補を渡して裏取りする設計にした。
 */
export async function verifyHtsCode(options: {
  htsCode: string;
  productDescription: string;
}): Promise<VerifyHtsCodeResult> {
  const htsCode = options.htsCode?.trim();
  if (!htsCode) {
    throw new Error('htsCode is required for HTS code verification');
  }
  const productDescription = options.productDescription?.trim();
  if (!productDescription) {
    throw new Error('productDescription is required for HTS code verification (推論根拠の明示が必須)');
  }

  const normalized = normalizeHtsCode(htsCode);
  const fullQuery = toUsitcFullFormat(normalized);
  const exactMatches = await searchUsitc(fullQuery);
  const exact = exactMatches.find((item) => normalizeHtsCode(item.htsno) === normalized);

  if (exact) {
    return {
      htsCode,
      productDescription,
      verified: true,
      matchLevel: 'exact',
      hsCode: normalized.slice(0, 6),
      officialDescription: exact.description,
      generalRate: exact.general,
      otherRate: exact.other,
      specialRate: exact.special,
      nearbyCandidates: [],
      disclaimer: DISCLAIMER_USITC,
      source: 'usitc-hts',
    };
  }

  const sixDigitQuery = toUsitcSixDigitFormat(normalized);
  const categoryMatches = await searchUsitc(sixDigitQuery);

  if (categoryMatches.length > 0) {
    return {
      htsCode,
      productDescription,
      verified: false,
      matchLevel: '6-digit-category',
      hsCode: normalized.slice(0, 6),
      nearbyCandidates: categoryMatches.map((item) => ({
        htsCode: item.htsno,
        description: item.description,
      })),
      disclaimer: DISCLAIMER_USITC,
      source: 'usitc-hts',
    };
  }

  return {
    htsCode,
    productDescription,
    verified: false,
    matchLevel: 'unmatched',
    nearbyCandidates: [],
    disclaimer: DISCLAIMER_USITC,
    source: 'usitc-hts',
  };
}
