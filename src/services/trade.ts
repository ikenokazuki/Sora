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
  disclaimerCodeHint?: string;
  missingInfo: string[];
  nextActions: string[];
  disclaimer: string;
}

const DISCLAIMER =
  '本ツールは参考情報を提供するものであり、法的助言ではありません。正式な判断は米国CPSC公式情報または専門家にご確認ください。';

const CPSC_PDF_SOURCE_URL =
  'https://www.cpsc.gov/s3fs-public/CPSC-Guidance-and-HTS-List-for-Filing-of-Electronic-Certificates-6B-Cleared.pdf';
const CPSC_PDF_EXCERPT =
  'CPSC believes this HTS code is likely to include a product subject to a mandatory standard or is otherwise deemed high-risk. (2026年7月8日よりCBP ACEでの電子申告eFilingが完全義務化。非対象品はACE Disclaimerが必要。)';

/**
 * CPSC_HTS_LIST の category 名をキーとした、CFR上の具体的な安全規格の対応表。
 * 実在確認済みの3カテゴリのみ収録。それ以外はCPSC_CATEGORY_FALLBACK_EXCERPTの
 * 汎用フォールバックを使用する（存在しない規格を捏造しないため）。
 */
const CPSC_CATEGORY_REGULATIONS: Record<string, CpscApplicableRegulation> = {
  Clothing: {
    cfr: '16 CFR 1610',
    summary: '衣料品の可燃性基準（一般衣料品）。子供用寝間着に該当する場合は16 CFR 1615/1616（子供用睡眠衣の可燃性基準）も適用される可能性があります。',
    excerpt: "Standard for the Flammability of Clothing Textiles (16 CFR Part 1610). Children's sleepwear may additionally be subject to 16 CFR 1615/1616.",
    sourceUrl: 'https://www.ecfr.gov/current/title-16/chapter-II/subchapter-D/part-1610',
  },
  'Infant Sleep Products': {
    cfr: '16 CFR 1632 / 1633',
    summary: 'マットレス・寝具の可燃性基準（16 CFR 1632: マットレス／1633: オープンフレーム着火試験）。',
    excerpt: 'Standard for the Flammability of Mattresses and Mattress Pads (16 CFR Part 1632) and Standard for the Flammability (Open Flame) of Mattress Sets (16 CFR Part 1633).',
    sourceUrl: 'https://www.ecfr.gov/current/title-16/chapter-II/subchapter-D/part-1632',
  },
  Toys: {
    cfr: 'ASTM F963 / 16 CFR 1501',
    summary: '玩具安全規格 ASTM F963（CPSIAにより強制規格化）および小部品誤飲防止基準（16 CFR 1501）。',
    excerpt: 'Consumer product safety standard for toys (ASTM F963, incorporated by reference under CPSIA) and 16 CFR Part 1501 (small parts choking hazard).',
    sourceUrl: 'https://www.cpsc.gov/Regulations-Laws--Standards/Statutes/ASTM-F963',
  },
};

const CPSC_GUIDANCE_SOURCE_URL = 'https://www.cpsc.gov/Regulations-Laws--Standards';
const CPSC_CATEGORY_FALLBACK_EXCERPT =
  'This CPSC HTS category has no product-specific CFR citation curated in this tool yet. Confirm applicable mandatory standards (flammability, small parts, magnets, lead/phthalates, etc.) against official CPSC guidance.';

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
          cfr: 'CPSC HTS Guidance List (2026年完全義務化施行)',
          summary: `HTSコード "${htsCode}" は "${exactCategory}" カテゴリとしてCPSC eFiling対象HTSリストに掲載（2026年7月8日よりCBP ACEでの電子申告が完全義務化）`,
          excerpt: CPSC_PDF_EXCERPT,
          sourceUrl: CPSC_PDF_SOURCE_URL,
        },
        CPSC_CATEGORY_REGULATIONS[exactCategory] ?? {
          cfr: '個別規格要確認',
          summary: `"${exactCategory}" カテゴリに適用される具体的な安全規格（可燃性・小部品・磁石・鉛/フタル酸エステル等）はCPSC公式ガイダンスで個別に確認してください。`,
          excerpt: CPSC_CATEGORY_FALLBACK_EXCERPT,
          sourceUrl: CPSC_GUIDANCE_SOURCE_URL,
        },
      ],
      missingInfo,
      nextActions:
        missingInfo.length > 0
          ? ['不足情報を補って再判定してください。']
          : [
              `${certificateType}を発行し、CBP ACEシステムへeFilingしてください（申告方式: フルPGAメッセージセット送信、またはCPSC Product Registry事前登録による参照送信）。`,
            ],
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
          cfr: 'CPSC HTS Guidance List (2026年完全義務化施行)',
          summary: `HTSコード "${htsCode}" は完全一致しないが、同じ6桁分類 (${normalized.slice(0, 6)}) の "${nearMatch.category}" カテゴリに類似コード "${nearMatch.similarCode}" がCPSC eFiling対象HTSリストに掲載`,
          excerpt: CPSC_PDF_EXCERPT,
          sourceUrl: CPSC_PDF_SOURCE_URL,
        },
      ],
      disclaimerCodeHint: 'A (Not Regulated) または B (Not Subject to Mandatory Standard)',
      missingInfo: [
        `HTSコード "${htsCode}" は完全一致しないが、同じ6桁分類 (${normalized.slice(0, 6)}) の "${nearMatch.category}" カテゴリにCPSC対象コード "${nearMatch.similarCode}" が存在する。個別確認を推奨。`,
      ],
      nextActions: [
        `類似カテゴリ "${nearMatch.category}" の証明書要否をCPSC公式または専門家に個別確認してください。規制対象外であることが確認できた場合は、通関ブローカーへACE免責申告（Disclaimerコード A または B）を指示してください。`,
      ],
      disclaimer: DISCLAIMER,
    };
  }

  return {
    certificateRequired: 'unknown',
    certificateType: 'unknown',
    eFilingRequired: false,
    applicableRegulations: [],
    disclaimerCodeHint: 'A (Not Regulated by CPSC)',
    missingInfo: [
      `HTSコード "${htsCode}" はCPSC公式HTSリストに掲載がありません。ただしこのリストは非網羅的であり、掲載が無いことは証明書不要を意味しません。productCategory（製品カテゴリ）を補足するか、CPSC公式に個別確認してください。`,
    ],
    nextActions: [
      'productCategory（製品カテゴリ）を追加して再判定するか、CPSC公式に個別確認してください。非規制品目であれば、ACE通関エラー防止のため免責コード（Disclaimer）での申告を通関業者へ指示してください。',
    ],
    disclaimer: DISCLAIMER,
  };
}

export interface CheckFdaRegulatedResult {
  fdaRegulatedLikely: boolean | 'unknown';
  fdFlag: 'FD1' | 'FD2' | 'FD3' | 'FD4' | 'none';
  possiblePrograms: string[]; // FDAプログラムコード (FOO=食品, DRU=医薬品, COS=化粧品, DEV=医療機器, TOB=タバコ, VME=動物用医薬品, FCS=食品接触物質等)
  priorNoticeMayApply: boolean;
  priorNoticeRequired?: boolean;
  matchedSubheading?: string;
  matchedChapter: string;
  confidence: 'hts-flag-match' | 'chapter-level-estimate';
  requiredActions?: string[];
  missingInfo: string[];
  nextActions: string[];
  disclaimer: string;
}

const DISCLAIMER_FDA =
  '本ツールは参考情報を提供するものであり、法的助言ではありません。米国CBP ACEにおけるFDA規制フラグ(FD1〜FD4)に基づく通関要件の目安です。正式な判断は米国FDA公式情報または通関士・専門家にご確認ください。';

interface FdaSubheadingRule {
  subheadings: string[]; // 4桁または6桁のプレフィックス
  programs: string[];
  fdFlag: 'FD1' | 'FD2' | 'FD3' | 'FD4';
  priorNotice: boolean;
  actionNote: string;
}

const FDA_SUBHEADING_RULES: FdaSubheadingRule[] = [
  // 医薬品
  {
    subheadings: ['3001', '3002', '3003', '3004', '3005', '3006'],
    programs: ['DRU'],
    fdFlag: 'FD2',
    priorNotice: false,
    actionNote: '【FDA医薬品 (DRU)】NDCコード取得、FDA施設登録(Facility Registration)、新薬/OTCモノグラフ適合性の確認が必須です。',
  },
  // 化粧品
  {
    subheadings: ['3303', '3304', '3305', '3307'],
    programs: ['COS'],
    fdFlag: 'FD2',
    priorNotice: false,
    actionNote: '【FDA化粧品規制 (MoCRA)】FDA施設登録および製品リスティング(Cosmetics Direct)、安全実証義務を確認してください。',
  },
  // 医療機器
  {
    subheadings: ['9018', '9019', '9020', '9021', '9022', '9025'],
    programs: ['DEV'],
    fdFlag: 'FD2',
    priorNotice: false,
    actionNote: '【FDA医療機器 (DEV)】FDA製造所登録(Device Registration)、製品リスティング(Listing)、510(k)届出または市販前承認要否を確認してください。',
  },
  // タバコ製品
  {
    subheadings: ['2401', '2402', '2403', '2404'],
    programs: ['TOB'],
    fdFlag: 'FD2',
    priorNotice: false,
    actionNote: '【FDAタバコ (TOB)】CTP（タバコ製品センター）のPMTA（市販前タバコ製品申請）適合性を確認してください。',
  },
  // 食品接触物質 (FCS) / テーブルウェア
  {
    subheadings: ['3924', '4419', '6911', '6912', '7013', '7323'],
    programs: ['FCS'],
    fdFlag: 'FD1',
    priorNotice: false,
    actionNote: '【FDA食品接触物質 (FCS)】食品・飲料用容器・食器の場合、FDA食品接触安全基準（溶出試験・鉛・カドミウム・BPA等）適合確認が必要です。非食品接触用途の場合はACE Disclaimerを申告してください。',
  },
  // 香料・食品添加物原料
  {
    subheadings: ['3301', '3302'],
    programs: ['FOO'],
    fdFlag: 'FD3',
    priorNotice: true,
    actionNote: '【FDA食品用途原料 (FOO)】食品用香料・添加物として輸入する場合はPrior Notice提出が必須です。工業用・化粧品用の場合はACE Disclaimerを申告してください。',
  },
];

interface FdaChapterEntry {
  chapters: string[]; // HTS Chapter番号 (2桁、ゼロ埋め)
  programs: string[]; // FDAプログラムコード
  fdFlag: 'FD1' | 'FD2' | 'FD3' | 'FD4';
  priorNoticeMayApply: boolean;
  note?: string;
}

const FDA_CHAPTER_MAP: FdaChapterEntry[] = [
  { chapters: ['03', '04', '05'], programs: ['FOO'], fdFlag: 'FD4', priorNoticeMayApply: true },
  { chapters: ['06', '07', '08', '09', '10', '11', '12', '13', '14'], programs: ['FOO'], fdFlag: 'FD4', priorNoticeMayApply: true },
  { chapters: ['15'], programs: ['FOO'], fdFlag: 'FD4', priorNoticeMayApply: true },
  {
    chapters: ['16'],
    programs: ['FOO'],
    fdFlag: 'FD4',
    priorNoticeMayApply: true,
    note: '食肉を含む調製品はUSDA/FSISとの管轄重複あり。',
  },
  { chapters: ['17', '18', '19', '20', '21'], programs: ['FOO'], fdFlag: 'FD4', priorNoticeMayApply: true },
  {
    chapters: ['22'],
    programs: ['FOO'],
    fdFlag: 'FD4',
    priorNoticeMayApply: true,
    note: 'アルコール飲料はTTB（アルコール・タバコ税貿易管理局）との管轄重複あり。',
  },
  {
    chapters: ['23'],
    programs: ['FOO', 'VME'],
    fdFlag: 'FD4',
    priorNoticeMayApply: true,
    note: '動物飼料はFDA（動物用医薬品センター/CVM）管轄。',
  },
  { chapters: ['24'], programs: ['TOB'], fdFlag: 'FD2', priorNoticeMayApply: false },
  { chapters: ['30'], programs: ['DRU'], fdFlag: 'FD2', priorNoticeMayApply: false },
  { chapters: ['33'], programs: ['COS'], fdFlag: 'FD2', priorNoticeMayApply: false },
  {
    chapters: ['90'],
    programs: ['DEV'],
    fdFlag: 'FD2',
    priorNoticeMayApply: false,
    note: '光学・医療用機器の章。同章内でもFDA対象外品目（一般光学機器等）が混在するため個別確認が必要。',
  },
];

// HTS Chapter 2 (食肉および食用くず肉) は原則USDA/FSIS管轄でFDA対象外
const USDA_JURISDICTION_CHAPTERS = ['02'];

/** HTSコードからFDA規制対象の可能性およびCBP ACE FDフラグ(FD1〜FD4)を判定 */
export function checkFdaRegulated(options: {
  htsCode: string;
  productDescription?: string;
  foodContact?: boolean;
}): CheckFdaRegulatedResult {
  const htsCode = options.htsCode?.trim();
  if (!htsCode) {
    throw new Error('htsCode is required for FDA regulation check');
  }
  const normalized = normalizeHtsCode(htsCode);
  const chapter = normalized.slice(0, 2);
  const prefix4 = normalized.slice(0, 4);

  if (USDA_JURISDICTION_CHAPTERS.includes(chapter)) {
    return {
      fdaRegulatedLikely: false,
      fdFlag: 'none',
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

  // 1. サブヘディング（4桁/6桁）レベルの精緻判定
  const subMatch = FDA_SUBHEADING_RULES.find((r) => r.subheadings.includes(prefix4));
  if (subMatch) {
    // 食器等の食品接触品目で、明示的に食品非接触（装飾用等）と指定されている場合はFDA対象外
    if (subMatch.programs.includes('FCS') && options.foodContact === false) {
      return {
        fdaRegulatedLikely: false,
        fdFlag: 'FD1',
        possiblePrograms: ['FCS'],
        priorNoticeMayApply: false,
        matchedSubheading: prefix4,
        matchedChapter: chapter,
        confidence: 'hts-flag-match',
        missingInfo: ['食品非接触（装飾用途等）として申告するため、ACE通関時にDisclaimer（免責申告）を提出してください。'],
        nextActions: ['通関ブローカーへACE Disclaimer（食品非接触）コードの申告を指示してください。'],
        disclaimer: DISCLAIMER_FDA,
      };
    }

    const isFcs = subMatch.programs.includes('FCS');
    return {
      fdaRegulatedLikely: true,
      fdFlag: subMatch.fdFlag,
      possiblePrograms: subMatch.programs,
      priorNoticeMayApply: subMatch.priorNotice,
      priorNoticeRequired: subMatch.fdFlag === 'FD4',
      matchedSubheading: prefix4,
      matchedChapter: chapter,
      confidence: 'hts-flag-match',
      requiredActions: [subMatch.actionNote],
      missingInfo: isFcs && options.foodContact === undefined ? ['食品接触用途か否かでFDA基準適用とACE Disclaimer申告が分岐します。'] : [],
      nextActions: [
        subMatch.actionNote,
        subMatch.fdFlag === 'FD4'
          ? '【FDA Prior Notice】貨物の米国到着前にFDAへの事前通知（Prior Notice）提出および確認番号(PNC)の取得が絶対必須です。'
          : '該当FDAプログラムの具体的な登録・提出要件をFDA公式（fda.gov）または通関士にご確認ください。',
      ],
      disclaimer: DISCLAIMER_FDA,
    };
  }

  // 2. Chapterレベルのフォールバック判定
  const entry = FDA_CHAPTER_MAP.find((e) => e.chapters.includes(chapter));
  if (!entry) {
    return {
      fdaRegulatedLikely: false,
      fdFlag: 'none',
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
    fdFlag: entry.fdFlag,
    possiblePrograms: entry.programs,
    priorNoticeMayApply: entry.priorNoticeMayApply,
    priorNoticeRequired: entry.fdFlag === 'FD4',
    matchedChapter: chapter,
    confidence: 'chapter-level-estimate',
    missingInfo: entry.note ? [entry.note] : [],
    nextActions: [
      entry.fdFlag === 'FD4'
        ? '【FDA Prior Notice】食品・飲料品等の輸入にあたり、米国到着前にFDAへの事前通知(Prior Notice)の提出が必須です。'
        : 'FDA該当プログラムの具体的な登録・提出要件をFDA公式（fda.gov）または専門家に確認してください。',
    ],
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
  '最終的な分類確定にはCBPのCROSS判定検索（rulings.cbp.gov）や通関士等の専門家への確認が必要です。' +
  'なお、HTS Revision 18等の大統領布告・通商法301条（中国原産品追加関税等）に基づくChapter 99の特別追加関税は別途個別確認が必要です。';

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

// ==========================================
// 3.5. 商品情報からの HTS/HSコード推測エンジン (predictHtsCode)
// ==========================================

export interface PredictHtsOptions {
  productName: string;
  description?: string;
  material?: string;
  productCategory?: string;
  targetAge?: 'adult' | 'child' | 'unknown';
  foodContact?: boolean;
  hasBattery?: boolean;
}

export interface PredictHtsCandidate {
  htsCode: string;
  description: string;
  generalRate: string;
  score: number;
}

export interface PredictHtsResult {
  detectedSubheading: string;
  category: string;
  bestMatch: {
    htsCode: string;
    description: string;
    parentDescription?: string;
    generalRate: string;
    score: number;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    cpsc?: CpscCertificateCheckResult;
    fda?: CheckFdaRegulatedResult;
  };
  candidates: PredictHtsCandidate[];
  disclaimer: string;
}

interface SubheadingRule {
  category: string;
  subheadings: {
    subheading: string;
    description: string;
    matchScore: (input: PredictHtsOptions, text: string) => number;
  }[];
}

const PREDICT_SUBHEADING_RULES: SubheadingRule[] = [
  // 1. 玩具
  {
    category: 'Toys',
    subheadings: [
      {
        subheading: '9503.00',
        description: 'Tricycles, scooters, pedal cars, dolls, puzzles, other toys',
        matchScore: (input, text) => {
          if (/toy|toys|block|puzzle|lego|doll|plush|知育|おもちゃ|玩具|ぬいぐるみ|フィギュア/i.test(text)) return 18;
          return 0;
        },
      },
    ],
  },
  // 2. ヘルメット
  {
    category: 'Bicycle Helmets',
    subheadings: [
      {
        subheading: '6506.10',
        description: 'Safety headgear (helmets)',
        matchScore: (input, text) => {
          if (/helmet|ヘルメット/i.test(text)) return 18;
          return 0;
        },
      },
    ],
  },
  // 3. 自転車
  {
    category: 'Bicycles',
    subheadings: [
      {
        subheading: '8712.00',
        description: 'Bicycles and other cycles, not motorized',
        matchScore: (input, text) => {
          if (/bicycle|bike|cycling|自転車/i.test(text) && !/helmet|ヘルメット/i.test(text)) return 18;
          return 0;
        },
      },
    ],
  },
  // 4. アパレル (Tシャツ、シャツ、ボトムス等)
  {
    category: 'Apparel',
    subheadings: [
      {
        subheading: '6109.10',
        description: 'T-shirts, singlets and other vests, knitted or crocheted, of cotton',
        matchScore: (input, text) => {
          const isTshirt = /t-shirt|tee|singlet|tシャツ/i.test(text);
          const isCotton = /cotton|綿/i.test(text) || input.material === 'cotton';
          if (isTshirt && isCotton) return 18;
          if (isTshirt) return 12;
          return 0;
        },
      },
      {
        subheading: '6205.20',
        description: "Men's or boys' shirts, of cotton, not knitted",
        matchScore: (input, text) => {
          const isShirt = /shirt|シャツ/i.test(text) && !/t-shirt|tシャツ/i.test(text);
          if (isShirt) return 14;
          return 0;
        },
      },
      {
        subheading: '6204.62',
        description: "Women's or girls' trousers, bib and brace overalls, breeches and shorts, of cotton",
        matchScore: (input, text) => {
          if (/pants|trousers|shorts|jeans|ズボン|パンツ|ジーンズ/i.test(text) && /women|lady|レディース/i.test(text)) return 14;
          return 0;
        },
      },
      {
        subheading: '6203.42',
        description: "Men's or boys' trousers, bib and brace overalls, breeches and shorts, of cotton",
        matchScore: (input, text) => {
          if (/pants|trousers|shorts|jeans|ズボン|パンツ|ジーンズ/i.test(text)) return 12;
          return 0;
        },
      },
    ],
  },
  // 5. 食器・キッチン用品 (素材別)
  {
    category: 'Kitchenware & Tableware',
    subheadings: [
      {
        subheading: '6912.00',
        description: 'Ceramic tableware, kitchenware, other household articles',
        matchScore: (input, text) => {
          const isDish = /mug|cup|plate|bowl|dish|tableware|kitchenware|マグ|カップ|皿|食器|調理器具/i.test(text);
          const isCeramic = /ceramic|stoneware|earthenware|陶器|磁器|せっ器/i.test(text) || input.material === 'ceramic';
          if (isDish && isCeramic) return 22;
          if (isDish && !input.material) return 8;
          return 0;
        },
      },
      {
        subheading: '7013.49',
        description: 'Glassware of a kind used for table or kitchen purposes',
        matchScore: (input, text) => {
          const isDish = /glass|mug|cup|bottle|グラス|コップ|瓶/i.test(text);
          const isGlass = /glass|ガラス/i.test(text) || input.material === 'glass';
          if (isDish && isGlass) return 22;
          return 0;
        },
      },
      {
        subheading: '7323.93',
        description: 'Table, kitchen or other household articles, of stainless steel',
        matchScore: (input, text) => {
          const isDish = /cookware|pan|pot|knife|fork|spoon|bottle|mug|鍋|フライパン|ボトル|ステンレスマグ/i.test(text);
          const isMetal = /stainless|steel|metal|ステンレス|金属/i.test(text) || input.material === 'metal';
          if (isDish && isMetal) return 22;
          return 0;
        },
      },
      {
        subheading: '3924.10',
        description: 'Tableware and kitchenware, of plastics',
        matchScore: (input, text) => {
          const isDish = /mug|cup|plate|bowl|bottle|容器|食器|コップ/i.test(text);
          const isPlastic = /plastic|プラスチック|樹脂/i.test(text) || input.material === 'plastic';
          if (isDish && isPlastic) return 20;
          return 0;
        },
      },
      {
        subheading: '4419.90',
        description: 'Tableware and kitchenware, of wood',
        matchScore: (input, text) => {
          const isDish = /tableware|kitchenware|spoon|fork|chopsticks|bowl|木製食器|スプーン|箸/i.test(text);
          const isWood = /wood|wooden|木製/i.test(text) || input.material === 'wood';
          if (isDish && isWood) return 20;
          return 0;
        },
      },
    ],
  },
  // 6. 化粧品・スキンケア
  {
    category: 'Cosmetics',
    subheadings: [
      {
        subheading: '3304.99',
        description: 'Beauty or make-up preparations and preparations for the care of the skin (other than medicaments)',
        matchScore: (input, text) => {
          if (/cream|lotion|serum|skincare|moisturizer|cosmetic|beauty|クリーム|乳液|美容液|化粧水|スキンケア|コスメ/i.test(text)) return 18;
          return 0;
        },
      },
      {
        subheading: '3304.10',
        description: 'Lip make-up preparations',
        matchScore: (input, text) => {
          if (/lip|lipstick|lip balm|リップ|口紅/i.test(text)) return 20;
          return 0;
        },
      },
      {
        subheading: '3305.10',
        description: 'Shampoos',
        matchScore: (input, text) => {
          if (/shampoo|シャンプー/i.test(text)) return 20;
          return 0;
        },
      },
    ],
  },
  // 7. 食品・飲料
  {
    category: 'Food Preparations',
    subheadings: [
      {
        subheading: '0902.10',
        description: 'Green tea (not fermented) in immediate packings of a content not exceeding 3 kg',
        matchScore: (input, text) => {
          if (/green tea|matcha|緑茶|抹茶|煎茶/i.test(text)) return 22;
          return 0;
        },
      },
      {
        subheading: '1806.90',
        description: 'Chocolate and other food preparations containing cocoa',
        matchScore: (input, text) => {
          if (/chocolate|cocoa|チョコレート|チョコ/i.test(text)) return 20;
          return 0;
        },
      },
      {
        subheading: '2106.90',
        description: 'Food preparations not elsewhere specified or included',
        matchScore: (input, text) => {
          if (/snack|confectionery|supplement|food|お菓子|サプリメント|健康食品|食品/i.test(text)) return 14;
          return 0;
        },
      },
    ],
  },
  // 8. 医薬品・医療機器
  {
    category: 'Pharmaceuticals',
    subheadings: [
      {
        subheading: '3004.90',
        description: 'Medicaments consisting of mixed or unmixed products for therapeutic uses',
        matchScore: (input, text) => {
          if (/medicine|pharmaceutical|drug|tablet|capsule|医薬品|薬/i.test(text)) return 18;
          return 0;
        },
      },
    ],
  },
  {
    category: 'Medical Devices',
    subheadings: [
      {
        subheading: '9018.90',
        description: 'Instruments and appliances used in medical, surgical, dental or veterinary sciences',
        matchScore: (input, text) => {
          if (/medical device|syringe|bandage|surgical|医療機器|注射器/i.test(text)) return 18;
          return 0;
        },
      },
      {
        subheading: '9025.19',
        description: 'Thermometers and pyrometers, not combined with other instruments',
        matchScore: (input, text) => {
          if (/thermometer|体温計/i.test(text)) return 20;
          return 0;
        },
      },
    ],
  },
  // 9. 家具・寝具
  {
    category: 'Furniture',
    subheadings: [
      {
        subheading: '9403.60',
        description: 'Other wooden furniture',
        matchScore: (input, text) => {
          const isFurn = /furniture|table|desk|cabinet|shelf|家具|机|テーブル|棚/i.test(text);
          const isWood = /wood|wooden|木製/i.test(text) || input.material === 'wood';
          if (isFurn && isWood) return 18;
          if (isFurn) return 12;
          return 0;
        },
      },
      {
        subheading: '9401.61',
        description: 'Seats with wooden frames, upholstered',
        matchScore: (input, text) => {
          if (/chair|seat|sofa|椅子|チェア|ソファ/i.test(text)) return 16;
          return 0;
        },
      },
      {
        subheading: '9404.90',
        description: 'Articles of bedding and similar furnishing',
        matchScore: (input, text) => {
          if (/bedding|pillow|mattress|crib|bassinet|枕|布団|マットレス|ベビーベッド/i.test(text)) return 18;
          return 0;
        },
      },
    ],
  },
  // 10. 電子機器・電源
  {
    category: 'Electronics',
    subheadings: [
      {
        subheading: '8504.40',
        description: 'Static converters (power supplies, chargers, adapters)',
        matchScore: (input, text) => {
          if (/charger|adapter|power supply|converter|充電器|アダプタ|電源/i.test(text)) return 18;
          return 0;
        },
      },
      {
        subheading: '8518.30',
        description: 'Headphones and earphones, whether or not combined with a microphone',
        matchScore: (input, text) => {
          if (/headphone|earphone|earbuds|イヤホン|ヘッドホン/i.test(text)) return 20;
          return 0;
        },
      },
      {
        subheading: '8506.10',
        description: 'Manganese dioxide primary cells and primary batteries',
        matchScore: (input, text) => {
          if (input.hasBattery && /button|coin|ボタン電池|コイン電池/i.test(text)) return 22;
          return 0;
        },
      },
    ],
  },
];

function scoreHtsCandidate(
  item: UsitcSearchItem,
  input: PredictHtsOptions,
  combinedText: string,
  parentDesc: string,
): number {
  let score = 0;
  const digits = normalizeHtsCode(item.htsno);
  const is10Digit = digits.length === 10;
  const is8Digit = digits.length === 8;

  // 10桁統計細分コードを大幅優先（米国税関申告には10桁が必須）
  if (is10Digit) {
    score += 15;
  } else if (is8Digit) {
    score += 5;
  }

  const descCombined = `${item.description} ${parentDesc}`.toLowerCase();
  const textLower = combinedText.toLowerCase();

  // 対象年齢マッチ
  if (input.targetAge === 'child') {
    if (/under 3 years|3 to 12 years|infant|toddler|children|child/i.test(descCombined)) {
      score += 10;
    }
    if (/3 to 12 years/i.test(item.description) && /3\+|3 to 12|toddler|child/i.test(textLower)) {
      score += 5;
    }
  } else if (input.targetAge === 'adult') {
    if (/men|women|adult/i.test(descCombined)) {
      score += 8;
    }
  }

  // 自転車ヘルメット (Athletic vs Motorcycle)
  if (/bicycle|cycling|bike|athletic|sport/i.test(textLower)) {
    if (/athletic, recreational and sporting/i.test(descCombined)) score += 15;
    if (/motorcycle/i.test(descCombined) && !/motorcycle|バイク/i.test(textLower)) score -= 12;
  }

  // 食器 (Mugs / Cups / Plates)
  if (/mug|cup|マグ|カップ/i.test(textLower)) {
    if (/mugs|teacups/i.test(descCombined)) score += 14;
  }

  // 化粧品 (Petroleum jelly ではなく Other)
  if (/cream|lotion|serum|skincare|moisturizer/i.test(textLower)) {
    if (/petroleum jelly/i.test(item.description)) {
      score -= 10;
    } else if (/other/i.test(item.description)) {
      score += 10;
    }
  }

  // Tシャツ (Men's vs Women's)
  if (/t-shirt|tee/i.test(textLower)) {
    if (/t-shirts/i.test(descCombined)) score += 10;
    if (/men/i.test(textLower) && /men's/i.test(item.description)) score += 12;
  }

  // 有機食品 (Organic)
  if (/organic|有機/i.test(textLower) && /certified organic/i.test(descCombined)) {
    score += 10;
  }

  // 単語一致ボーナス
  const words = textLower.split(/\s+/).filter((w) => w.length > 2);
  for (const w of words) {
    if (descCombined.includes(w)) score += 2;
  }

  return score;
}

/**
 * 商品情報（商品名・説明・素材・カテゴリ・用途）から、USITC公式現行関税率表と照合して確度の高いHTSコード候補・関税率・規制要件を推測
 */
export async function predictHtsCode(options: PredictHtsOptions): Promise<PredictHtsResult> {
  const productName = options.productName?.trim();
  if (!productName) {
    throw new Error('productName is required for HTS code prediction');
  }

  const combinedText = `${productName} ${options.description || ''} ${options.productCategory || ''} ${options.material || ''}`.trim();

  // 1. サブヘディングの候補を特定
  let bestSub: { subheading: string; category: string; desc: string; score: number } | null = null;
  for (const rule of PREDICT_SUBHEADING_RULES) {
    for (const sub of rule.subheadings) {
      const score = sub.matchScore(options, combinedText);
      if (!bestSub || score > bestSub.score) {
        bestSub = { subheading: sub.subheading, category: rule.category, desc: sub.description, score };
      }
    }
  }

  // フォールバック: 一般雑貨 (3926.90)
  const targetSubheading = bestSub && bestSub.score > 0 ? bestSub.subheading : '3926.90';
  const targetCategory = bestSub && bestSub.score > 0 ? bestSub.category : 'General Goods';

  // 2. USITC APIからサブヘディング配下のコード一覧を取得
  const rawItems = await searchUsitc(targetSubheading);
  const targetChapter = targetSubheading.slice(0, 2);

  // Chapter 99 (一時措置・特別除外) を除外し、該当章 (01〜97) のコードに絞り込む
  const usitcItems = rawItems.filter((item) => {
    const d = normalizeHtsCode(item.htsno);
    return d.startsWith(targetChapter);
  });

  if (usitcItems.length === 0) {
    throw new Error(`USITC API returned no valid HTS entries for subheading ${targetSubheading}`);
  }

  // 親見出しのテキストおよび一般関税率を特定
  const rootItem = usitcItems.find((i) => i.indent === '0') || usitcItems[0];
  const rootGeneralRate = rootItem?.general || 'Free';
  const parentDesc = rootItem ? rootItem.description : '';

  // 3. 各アイテムをスコアリング
  const scored = usitcItems.map((item) => {
    const score = scoreHtsCandidate(item, options, combinedText, parentDesc);
    const effectiveRate = item.general && item.general.trim().length > 0 ? item.general : rootGeneralRate;
    return { item, score, effectiveRate };
  });

  scored.sort((a, b) => b.score - a.score);

  // 10桁統計細分コードを優先抽出
  const top10Candidates = scored.filter((s) => normalizeHtsCode(s.item.htsno).length === 10);
  const selectedTop = top10Candidates.length > 0 ? top10Candidates[0] : scored[0];

  const topHtsCode = selectedTop.item.htsno;

  // 4. 最有力候補に対する CPSC および FDA 判定の並行実行
  const [cpscRes, fdaRes] = await Promise.all([
    checkCpscCertificate({
      htsCode: topHtsCode,
      targetAge: options.targetAge || 'unknown',
      material: options.material,
      productCategory: options.productCategory || targetCategory,
      description: combinedText,
    }),
    Promise.resolve(
      checkFdaRegulated({
        htsCode: topHtsCode,
        productDescription: combinedText,
        foodContact: options.foodContact,
      }),
    ),
  ]);

  // 確信度の算出
  const confidence: 'high' | 'medium' | 'low' =
    selectedTop.score >= 25 ? 'high' : selectedTop.score >= 12 ? 'medium' : 'low';

  const candidates: PredictHtsCandidate[] = scored
    .filter((s) => normalizeHtsCode(s.item.htsno).length >= 8)
    .slice(0, 3)
    .map((s) => ({
      htsCode: s.item.htsno,
      description: s.item.description,
      generalRate: s.effectiveRate,
      score: s.score,
    }));

  return {
    detectedSubheading: targetSubheading,
    category: targetCategory,
    bestMatch: {
      htsCode: topHtsCode,
      description: selectedTop.item.description,
      parentDescription: parentDesc,
      generalRate: selectedTop.effectiveRate,
      score: selectedTop.score,
      confidence,
      reason: `商品名・説明文・素材から "${targetCategory}" (Subheading ${targetSubheading}) と分類し、USITC公式品目定義とのセマンティック照合により最適コードを特定しました。`,
      cpsc: cpscRes,
      fda: fdaRes,
    },
    candidates,
    disclaimer: DISCLAIMER_USITC,
  };
}

// ==========================================
// 4. 統合商品コンプライアンス判定 (checkProductCompliance)
// ==========================================

const DISCLAIMER_COMPLIANCE =
  '本判定結果は参考情報を提供するものであり、法的助言・通関確定情報ではありません。正式な判断は米国CBP、FDA、CPSC公式情報および通関士・弁護士等の専門家にご確認ください。' +
  '原産国に応じた追加関税（Section 301追加関税、アンチダンピング税/相殺関税等）は本ツールの対象外であり、別途個別に確認が必要です。';

export interface CheckProductComplianceOptions {
  url?: string;
  productName?: string;
  description?: string;
  htsCode?: string;
  targetAge?: 'adult' | 'child' | 'unknown';
  material?: string;
  productCategory?: string;
  foodContact?: boolean;
  hasBattery?: boolean;
  batteryType?: 'button_coin' | 'other';
}

export interface CheckProductComplianceResult {
  product: {
    name?: string;
    description?: string;
    url?: string;
    detectedCategory?: string;
    targetAge: 'adult' | 'child' | 'unknown';
    material?: string;
    htsCode?: string;
  };
  overallStatus: 'action_required' | 'potential_action_required' | 'likely_exempt' | 'needs_more_info';
  summary: string;
  /** 不足情報がある場合のみ設定。LLMがユーザーへ確認すべき質問リスト。 */
  clarifyingQuestions?: string[];
  htsVerification?: VerifyHtsCodeResult;
  htsPrediction?: PredictHtsResult;
  fda?: CheckFdaRegulatedResult;
  cpsc?: CpscCertificateCheckResult;
  actionPlan: string[];
  disclaimer: string;
}

const CATEGORY_HTS_DEFAULTS: {
  category: string;
  keywords: string[];
  defaultHts: string;
  targetAge?: 'child' | 'adult';
  /** この分類に必要な追加情報。不足している場合、推測ではなくユーザーへの確認を促す。 */
  requires?: ('material' | 'targetAge' | 'foodContact' | 'hasBattery')[];
}[] = [
  {
    category: 'Toys',
    keywords: ['toy', 'toys', 'doll', 'puzzle', 'lego', 'block', 'figure', 'plush', '玩具', 'おもちゃ', 'ぬいぐるみ', '知育', 'フィギュア'],
    defaultHts: '9503.00.0073',
    targetAge: 'child',
  },
  {
    category: 'Bicycle Helmets',
    keywords: ['helmet', 'bicycle helmet', 'bike helmet', 'ヘルメット'],
    defaultHts: '6506.10.3045',
    requires: ['targetAge'], // 子供用か大人用かで CCC/GCC が分岐
  },
  {
    category: 'Bicycles',
    keywords: ['bicycle', 'bike', 'cycling', '自転車'],
    defaultHts: '8712.00.1510',
    requires: ['targetAge'], // 子供用自転車は別 HTS (8712.00.1510 vs 9501.00.4000)
  },
  {
    category: 'Cosmetics',
    keywords: ['cosmetic', 'lotion', 'cream', 'serum', 'skincare', 'makeup', 'lipstick', 'sunscreen', '化粧品', '美容液', '乳液', '日焼け止め', 'コスメ'],
    defaultHts: '3304.99.5000',
  },
  {
    category: 'Food Preparations',
    keywords: ['food', 'snack', 'candy', 'supplement', 'tea', 'coffee', 'confectionery', '食品', 'お菓子', 'サプリメント', '茶', '飲料'],
    defaultHts: '2106.90.9998',
  },
  {
    category: 'Pharmaceuticals',
    keywords: ['medicine', 'pharmaceutical', 'drug', 'tablet', 'capsule', '医薬品', '薬'],
    defaultHts: '3004.90.0000',
  },
  {
    category: 'Medical Devices',
    keywords: ['medical', 'thermometer', 'syringe', 'bandage', 'mask', '医療機器', '体温計', 'マスク'],
    defaultHts: '9018.90.8000',
  },
  {
    category: 'Infant Sleep Products',
    keywords: ['crib', 'bassinet', 'cradle', 'baby mattress', 'ベビーベッド', 'クーファン'],
    defaultHts: '9404.90.9622',
    targetAge: 'child',
  },
  {
    category: 'Pacifiers',
    keywords: ['pacifier', 'teether', 'おしゃぶり', '歯固め'],
    defaultHts: '3926.90.1600',
    targetAge: 'child',
  },
  {
    category: 'Children’s Clothing',
    keywords: ['baby clothing', 'infant clothes', 'kids clothes', '子供服', 'ベビー服'],
    defaultHts: '6209.20.3000',
    targetAge: 'child',
  },
  {
    category: 'Adult Clothing',
    keywords: ['shirt', 'pants', 'jacket', 't-shirt', 'apparel', 'clothing', '服', 'シャツ', 'ジャケット'],
    defaultHts: '6205.20.2061',
    targetAge: 'adult',
  },
  {
    category: 'Imitation Jewelry',
    keywords: ['jewelry', 'necklace', 'earring', 'bracelet', 'accessory', 'アクセサリー', 'ネックレス', 'ピアス'],
    defaultHts: '7117.19.9000',
  },
  {
    category: 'Furniture',
    keywords: ['furniture', 'table', 'chair', 'desk', 'cabinet', 'shelf', '家具', '机', '椅子', 'テーブル', '棚'],
    defaultHts: '9403.60.8081',
  },
  {
    category: 'Kitchenware',
    keywords: ['kitchen', 'cookware', 'pan', 'pot', 'knife', 'spoon', 'fork', 'mug', 'cup', 'bottle', '調理器具', '包丁', '鍋', 'フライパン', 'マグカップ', 'ボトル'],
    defaultHts: '7323.93.0080',
    requires: ['material', 'foodContact'], // 素材で 6912/7013/7323/3924 等が分岐、飲食用途でFDA判断が変わる
  },
  {
    category: 'Electronics',
    keywords: ['electronics', 'charger', 'cable', 'battery', 'headphone', 'speaker', 'adapter', '電子機器', '充電器', 'ケーブル', 'イヤホン', 'スピーカー'],
    defaultHts: '8504.40.9580',
    requires: ['hasBattery'], // 電池搭載有無・種別でCPSC Button Cell & Coin Batteriesカテゴリへ分岐、DOT/PHMSA危険物表示要否にも影響
  },
];

function inferTargetAge(text: string): 'child' | 'adult' | 'unknown' {
  const lower = text.toLowerCase();
  if (
    /(?:child|children|baby|infant|toddler|kid|kids|boy|girl|0-3|3\+|4\+|5\+|6\+|7\+|8\+|9\+|10\+|11\+|12\+|子供|子ども|乳幼児|赤ちゃん|男の子|女の子|歳児|歳以上)/i.test(
      lower,
    )
  ) {
    return 'child';
  }
  if (/(?:adult|men|women|lady|gentleman|大人|成人|メンズ|レディース)/i.test(lower)) {
    return 'adult';
  }
  return 'unknown';
}

function inferMaterial(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/plastic|プラスチック|樹脂/i.test(lower)) return 'plastic';
  if (/wood|wooden|木製|天然木/i.test(lower)) return 'wood';
  if (/metal|steel|aluminum|金属|ステンレス|アルミ/i.test(lower)) return 'metal';
  if (/cotton|綿|コットン/i.test(lower)) return 'cotton';
  if (/glass|ガラス/i.test(lower)) return 'glass';
  if (/leather|本革|レザー/i.test(lower)) return 'leather';
  if (/silicone|シリコン/i.test(lower)) return 'silicone';
  return undefined;
}

function buildIntegratedActionPlan(
  htsResult: VerifyHtsCodeResult,
  fdaResult: CheckFdaRegulatedResult,
  cpscResult: CpscCertificateCheckResult,
): {
  overallStatus: 'action_required' | 'potential_action_required' | 'likely_exempt';
  summary: string;
  actionPlan: string[];
} {
  const actionPlan: string[] = [];
  const summaryParts: string[] = [];
  let isActionRequired = false;
  let isPotentialAction = false;

  // CPSCチェック
  if (cpscResult.eFilingRequired || cpscResult.certificateRequired === true) {
    isActionRequired = true;
    summaryParts.push(`CPSC規制対象 (${cpscResult.certificateType}証明書作成 & eFiling電子申告が完全義務化)`);
    if (cpscResult.certificateType === 'CCC') {
      actionPlan.push('【CPSC CCC】12歳以下の子供向け製品として、CPSC認定の第三者試験機関による適合性試験を実施してください（小部品誤飲・窒息ハザード試験 16 CFR 1501 を含む）。');
      actionPlan.push('【CPSC CCC】試験結果に基づき Children’s Product Certificate (CCC) を作成・発行してください。');
    } else if (cpscResult.certificateType === 'GCC') {
      actionPlan.push('【CPSC GCC】一般製品安全基準への適合性を確認し、General Certificate of Conformity (GCC) を作成・発行してください。');
    }
    if (cpscResult.eFilingRequired) {
      actionPlan.push('【CPSC eFiling（完全義務化）】米国税関(CBP) ACEシステムへの輸入通関申告時に証明書データを電子申告してください（申告方式: フルPGAメッセージセット送信、またはCPSC Product Registry事前登録による参照送信）。');
    }
    for (const reg of cpscResult.applicableRegulations) {
      actionPlan.push(`【適用規格】${reg.cfr}: ${reg.summary}`);
    }
  } else if (cpscResult.certificateRequired === 'unknown' && cpscResult.missingInfo.length > 0) {
    isPotentialAction = true;
    summaryParts.push('CPSC個別確認推奨（類似コードまたは対象年齢の確定が必要）');
    actionPlan.push(...cpscResult.nextActions);
  }

  // FDAチェック (FD1〜FD4フラグ連動)
  if (fdaResult.fdaRegulatedLikely === true) {
    isActionRequired = true;
    const progs = fdaResult.possiblePrograms.join('/');
    summaryParts.push(`FDA規制対象 (${fdaResult.fdFlag || 'PGA'} - ${progs} プログラム管轄)`);

    if (fdaResult.fdFlag === 'FD4' || fdaResult.priorNoticeRequired) {
      actionPlan.push('【FDA Prior Notice (FD4)】食品・飲料品等の輸入にあたり、米国到着前にFDAへの事前通知(Prior Notice)の提出および確認番号(PNC)の取得が絶対必須です。');
    } else if (fdaResult.priorNoticeMayApply) {
      actionPlan.push('【FDA Prior Notice (FD3)】食品用途原料・調製品に該当する場合、米国到着前にFDAへの事前通知(Prior Notice)が必要です。');
    }

    if (fdaResult.possiblePrograms.includes('COS')) {
      actionPlan.push('【FDA 化粧品規制 (MoCRA)】FDA施設登録および製品リスト提出(Cosmetics Direct)要件を確認してください。');
    }
    if (fdaResult.possiblePrograms.includes('DEV')) {
      actionPlan.push('【FDA 医療機器】FDA施設登録(Device Registration)および製品リスティング(Listing)、510(k)等の要否を確認してください。');
    }
    if (fdaResult.possiblePrograms.includes('DRU')) {
      actionPlan.push('【FDA 医薬品】NDCコードの取得、製造所登録、新薬/OTCモノグラフ適合性を確認してください。');
    }
    if (fdaResult.possiblePrograms.includes('FCS') || fdaResult.fdFlag === 'FD1') {
      actionPlan.push('【FDA 食品接触物質 (FCS)】食器・調理器具等の場合、FDA食品接触安全基準（溶出試験等）への適合証明が必要です。非食品接触用途の場合は通関業者へACE免責（Disclaimer）申告を指示してください。');
    }

    actionPlan.push(...fdaResult.nextActions);
  } else if (fdaResult.fdFlag === 'FD1') {
    actionPlan.push(...fdaResult.nextActions);
  }

  // HTS実在確認 & 関税情報
  if (htsResult.verified) {
    if (htsResult.generalRate) {
      actionPlan.push(`【関税情報】USITC一般関税率: ${htsResult.generalRate} (品目: ${htsResult.officialDescription || ''})`);
    }
    actionPlan.push('【追加関税確認】HTS Revision 18等の大統領布告（PP 11059等）や通商法301条（中国原産品追加関税等）に基づくChapter 99の特別追加関税の適用有無を通関士にご確認ください。');
  } else {
    isPotentialAction = true;
    actionPlan.push(`【HTS確認】HTSコード "${htsResult.htsCode}" は完全一致していません。近傍コードを確認の上、通関士等へ分類確定を依頼してください。`);
  }

  const overallStatus: 'action_required' | 'potential_action_required' | 'likely_exempt' =
    isActionRequired ? 'action_required' : isPotentialAction ? 'potential_action_required' : 'likely_exempt';

  if (actionPlan.length === 0) {
    summaryParts.push('一般品目（現行のFDA/CPSC主要eFiling規制リスト外）');
    actionPlan.push('一般的な米国通関手続き（インボイス、パッキングリスト、原産地証明等）に従って輸出申告を行ってください。');
  }

  return {
    overallStatus,
    summary: summaryParts.join(' / ') || '一般品目',
    actionPlan,
  };
}

/**
 * 判定に必要な情報が不足している場合、LLMがユーザーへ確認すべき質問リストを返す。
 * 空配列の場合は情報十分でパイプライン実行可能。
 * キーワードリストは持たず、CATEGORY_HTS_DEFAULTS の requires フィールドを参照する。
 *
 * この関数（needs_more_info）は「分類そのものを開始できないケース」を扱う事前ゲート。
 * 分類実行後に判明する不確実性（近傍一致のHTS、CPSC/FDAのボーダーライン判定等）は
 * buildIntegratedActionPlan が missingInfo/nextActions 経由で potential_action_required として扱う。
 * 両者はパイプライン実行前後で分かれており重複しない。
 */
function gatherClarifyingQuestions(
  combinedText: string,
  opts: {
    material?: string;
    targetAge?: string;
    htsCode?: string;
    foodContact?: boolean;
    hasBattery?: boolean;
    matchedEntry?: { requires?: ('material' | 'targetAge' | 'foodContact' | 'hasBattery')[] };
    isFallback: boolean;
  },
): string[] {
  const questions: string[] = [];

  // 商品情報が空
  if (!combinedText) {
    questions.push('商品名または商品説明を教えてください。');
    return questions;
  }

  // HTSコードが明示されている場合は推測精度の問題はない
  if (opts.htsCode) return questions;

  const requires = opts.matchedEntry?.requires ?? [];

  // カテゴリが特定できず汎用フォールバックになる場合
  if (opts.isFallback) {
    questions.push(
      '商品の種類・素材をより詳しく教えてください（例: 素材・用途・対象ユーザーなど）。' +
      '入力された情報だけでは正確なHTSコードの分類が困難です。',
    );
    return questions; // fallback 時はこれ以上詳細に聞けないので早期返却
  }

  // カテゴリはマッチしたが素材が必要
  if (requires.includes('material') && !opts.material) {
    questions.push(
      '商品の素材を教えてください（例: 陶器・磁器・ガラス・ステンレス・プラスチック・木材・綿など）。' +
      '素材によってHTSコードおよび関税率が大きく異なります。',
    );
  }

  // 食品接触用途の確認（false=非食品接触という明示回答も「回答済み」として扱う）
  if (requires.includes('foodContact') && opts.foodContact === undefined) {
    questions.push(
      'この商品は飲食物と接触する用途（飲み物・食べ物を入れる / 口をつける）で使用しますか？' +
      'それとも装飾目的・非食品接触用途ですか？（FDA食品接触安全基準の適用有無に影響します）',
    );
  }

  // 対象年齢の確認（targetAge が unknown かつカテゴリが要求している場合）
  if (requires.includes('targetAge') && (!opts.targetAge || opts.targetAge === 'unknown')) {
    questions.push(
      'この商品の主な対象ユーザーを教えてください（子供向け 12歳以下 / 大人向け / 全年齢対象）。' +
      '子供向けの場合はCPSC認定第三者試験機関による試験とCCC証明書が義務付けられます。',
    );
  }

  // 電池搭載有無・種別の確認（CPSC規制カテゴリ判定・DOT/PHMSA危険物表示要否に必要）
  if (requires.includes('hasBattery') && opts.hasBattery === undefined) {
    questions.push(
      'この商品は電池・バッテリーを使用しますか？使用する場合、ボタン電池・コイン電池ですか、' +
      'それとも他の種類の電池（リチウムイオン電池等）ですか？（電池の種類によりCPSC規制対象カテゴリや' +
      '輸送時の危険物表示義務が変わります）',
    );
  }

  return questions;
}

/**
 * 商品情報（URL または 商品名・説明・素材など）から、HTS実在検証・FDA規制判定・CPSC証明書/eFiling判定を一連のパイプラインとして一括実行
 */
export async function checkProductCompliance(
  options: CheckProductComplianceOptions,
): Promise<CheckProductComplianceResult> {
  let productName = options.productName?.trim();
  let description = options.description?.trim();
  let targetAge = options.targetAge;
  let material = options.material?.trim();
  let productCategory = options.productCategory?.trim();
  let htsCode = options.htsCode?.trim();

  // 1. URL が指定されている場合はスクレイピングして商品情報を取得
  if (options.url) {
    try {
      const { scrapeUrl } = await import('../scraper.js');
      const scrapeRes = await scrapeUrl({
        url: options.url,
        onlyMainContent: true,
        maxChars: 5000,
      });

      if (!productName && scrapeRes.title) {
        productName = scrapeRes.title;
      }
      if (!description) {
        description = scrapeRes.description || scrapeRes.content?.slice(0, 1000);
      }
    } catch (err: any) {
      console.warn('[TradeCompliance] Scrape failed for url:', options.url, err?.message);
    }
  }

  const combinedText = `${productName || ''} ${description || ''} ${productCategory || ''} ${material || ''}`.trim();

  // 2. 属性の自動推定（未指定の場合）
  if (!targetAge || targetAge === 'unknown') {
    targetAge = inferTargetAge(combinedText);
  }
  const inferredMaterial = !material ? inferMaterial(combinedText) : undefined;
  if (!material) {
    material = inferredMaterial;
  }

  // カテゴリマッチの試行
  let detectedCategory: string | undefined = undefined;
  let isFallback = false;
  let matchedEntry: (typeof CATEGORY_HTS_DEFAULTS)[number] | undefined;
  if (!htsCode) {
    matchedEntry = CATEGORY_HTS_DEFAULTS.find((entry) =>
      entry.keywords.some((kw) => combinedText.toLowerCase().includes(kw.toLowerCase())),
    );
    if (matchedEntry) {
      detectedCategory = matchedEntry.category;
      if (targetAge === 'unknown' && matchedEntry.targetAge) {
        targetAge = matchedEntry.targetAge;
      }
    } else {
      isFallback = true;
    }
  }

  // 2.5. 不足情報チェック：問題がある場合はパイプラインを実行せず即時返却
  const clarifyingQuestions = gatherClarifyingQuestions(combinedText, {
    material: inferredMaterial || material,
    targetAge,
    htsCode,
    foodContact: options.foodContact,
    hasBattery: options.hasBattery,
    matchedEntry,
    isFallback,
  });
  if (clarifyingQuestions.length > 0) {
    return {
      product: {
        name: productName,
        description: combinedText || undefined,
        url: options.url,
        detectedCategory: detectedCategory || productCategory,
        targetAge: targetAge || 'unknown',
        material,
      },
      overallStatus: 'needs_more_info',
      summary: '正確な判定に必要な情報が不足しています。以下の質問にご回答ください。',
      clarifyingQuestions,
      actionPlan: ['上記の質問にご回答いただいた上で、再度お問い合わせください。'],
      disclaimer: DISCLAIMER_COMPLIANCE,
    };
  }

  // 3. HTSコードの確定（既知カテゴリのデフォルトまたは推測エンジン）
  let htsPredictionResult: PredictHtsResult | undefined = undefined;
  try {
    htsPredictionResult = await predictHtsCode({
      productName: productName || 'General Goods',
      description: description || combinedText,
      material,
      productCategory: productCategory || detectedCategory,
      targetAge: targetAge || 'unknown',
      foodContact: options.foodContact,
      hasBattery: options.hasBattery,
    });
  } catch (e: any) {
    console.warn('[TradeCompliance] predictHtsCode failed:', e?.message);
  }

  if (!htsCode) {
    if (matchedEntry) {
      if (matchedEntry.category === 'Electronics' && options.hasBattery === true && options.batteryType === 'button_coin') {
        htsCode = '8506.10.0010'; // CPSC "Button Cell & Coin Batteries" 代表コード
        detectedCategory = 'Button Cell & Coin Batteries';
      } else {
        htsCode = matchedEntry.defaultHts;
      }
    } else if (htsPredictionResult?.bestMatch?.htsCode) {
      htsCode = htsPredictionResult.bestMatch.htsCode;
      if (!detectedCategory) {
        detectedCategory = htsPredictionResult.category;
      }
    } else if (material === 'wood') {
      htsCode = '9403.60.8081';
      detectedCategory = 'Wooden Articles';
    } else if (material === 'metal') {
      htsCode = '7326.90.8688';
      detectedCategory = 'Metal Articles';
    } else if (material === 'cotton') {
      htsCode = '6307.90.9889';
      detectedCategory = 'Textile Articles';
    } else {
      htsCode = '3926.90.9985';
      detectedCategory = 'General Goods';
    }
  }

  const effectiveDescription = description || productName || combinedText || 'Product description for compliance check';

  // 4. パイプライン並行実行 (HTS検証, FDA判定, CPSC判定)
  const [htsVerification, fdaResult, cpscResult] = await Promise.all([
    verifyHtsCode({ htsCode, productDescription: effectiveDescription }),
    Promise.resolve(
      checkFdaRegulated({
        htsCode,
        productDescription: effectiveDescription,
        foodContact: options.foodContact,
      }),
    ),
    checkCpscCertificate({
      htsCode,
      targetAge: targetAge || 'unknown',
      material,
      productCategory: productCategory || detectedCategory,
      description: effectiveDescription,
    }),
  ]);

  // 5. アクションプラン & 総合レポート生成
  const { overallStatus, summary, actionPlan } = buildIntegratedActionPlan(
    htsVerification,
    fdaResult,
    cpscResult,
  );

  if (matchedEntry?.category === 'Electronics' && options.hasBattery === true && options.batteryType === 'other') {
    actionPlan.push(
      '【DOT/PHMSA 危険物】リチウムイオン電池等を含む場合、輸送時にUN3480/UN3481区分の適切な表示・梱包' +
      '（危険物輸送規則, 49 CFR）が必要か確認してください。',
    );
  }

  return {
    product: {
      name: productName,
      description: effectiveDescription,
      url: options.url,
      detectedCategory: detectedCategory || productCategory,
      targetAge: targetAge || 'unknown',
      material,
      htsCode,
    },
    overallStatus,
    summary,
    htsVerification,
    htsPrediction: htsPredictionResult,
    fda: fdaResult,
    cpsc: cpscResult,
    actionPlan,
    disclaimer: DISCLAIMER_COMPLIANCE,
  };
}

