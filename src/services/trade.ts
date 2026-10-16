import { CPSC_HTS_LIST } from './cpsc_hts_data.js';
import { errorMessage } from '../errors.js';
import { type CrossRuling, type CrossStatus, lookupCrossRulings } from './cbp_cross.js';
import {
  type HtsLine,
  type HtsSearchHit,
  getHtsLine,
  hasEnglishWords,
  htsDataInfo,
  htsLinesUnder,
  queryTerms,
  searchHtsLines,
} from './hts_data.js';

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
  inputCompleteness?: 'complete' | 'partial';
  missingInputs?: string[];
  clarifyingQuestions?: string[];
  impactExplanation?: string;
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
    const missingInputs: string[] = [];
    const clarifyingQuestions: string[] = [];

    if (options.targetAge === 'unknown') {
      missingInfo.push('targetAge（対象年齢層）が不明です。子供向け製品か否かで適用される安全基準・証明書種別が変わります。');
      missingInputs.push('targetAge');
      clarifyingQuestions.push('この製品の対象年齢層は12歳以下の子供向けですか？それとも大人・一般向けですか？');
    }
    if (!options.material) {
      missingInputs.push('material');
      clarifyingQuestions.push('製品の主要素材は何ですか？（例: プラスチック、金属、木材、布地など。鉛・フタル酸エステル等の安全基準適用確認に必要です）');
    }

    const isChild = options.targetAge === 'child';
    const certificateType: CpscCertificateCheckResult['certificateType'] =
      options.targetAge === 'unknown' ? 'unknown' : isChild ? 'CCC' : 'GCC';

    const inputCompleteness: 'complete' | 'partial' = missingInputs.length > 0 ? 'partial' : 'complete';
    const impactExplanation =
      options.targetAge === 'unknown'
        ? '対象年齢が未確定のため証明書種別を確定できません。12歳以下の子供向け製品の場合はCPSC認定第三者試験機関による適合性試験とCPC（Children’s Product Certificate）作成、および2026年7月完全義務化のeFilingが必要です。大人向けの場合は一般適合証明書(GCC)となります。'
        : missingInputs.length > 0
          ? '主要素材が未指定のため、鉛・フタル酸エステル含有量規制や可燃性試験などの個別安全規格への該当性を精緻に特定できていません。'
          : undefined;

    return {
      certificateRequired: options.targetAge === 'unknown' ? 'unknown' : true,
      certificateType,
      eFilingRequired: options.targetAge !== 'unknown',
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
        options.targetAge === 'unknown'
          ? ['不足情報（対象年齢など）を補って再判定してください。']
          : [
              `${certificateType}を発行し、CBP ACEシステムへeFilingしてください（申告方式: フルPGAメッセージセット送信、またはCPSC Product Registry事前登録による参照送信）。`,
            ],
      disclaimer: DISCLAIMER,
      inputCompleteness,
      missingInputs: missingInputs.length > 0 ? missingInputs : undefined,
      clarifyingQuestions: clarifyingQuestions.length > 0 ? clarifyingQuestions : undefined,
      impactExplanation,
    };
  }

  const nearMatch = findNearMatch(normalized);
  if (nearMatch) {
    const missingInputs: string[] = [];
    const clarifyingQuestions: string[] = [];
    if (options.targetAge === 'unknown') {
      missingInputs.push('targetAge');
      clarifyingQuestions.push('この製品の対象年齢層は12歳以下の子供向けですか？それとも大人・一般向けですか？');
    }
    if (!options.material) {
      missingInputs.push('material');
      clarifyingQuestions.push('製品の主要素材は何ですか？（例: プラスチック、金属、木材、布地など）');
    }

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
      inputCompleteness: 'partial',
      missingInputs: missingInputs.length > 0 ? missingInputs : ['exactHtsClassification'],
      clarifyingQuestions: clarifyingQuestions.length > 0 ? clarifyingQuestions : [
        `HTSコード "${htsCode}" は類似コードが見つかりました。製品の具体的な用途や仕様を教えていただけますか？`,
      ],
      impactExplanation:
        'HTSコードが完全一致せず類似カテゴリに位置しているため、CPSC規制対象か免責(Disclaimer)申告可能かの切り分けが必要です。非対象品であればACEでの免責コード申告を通関業者に指示してください。',
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
    inputCompleteness: 'partial',
    missingInputs: ['productCategory'],
    clarifyingQuestions: [
      '製品の大まかなカテゴリ（玩具、アパレル、家具、電子機器等）または用途を教えていただけますか？',
    ],
    impactExplanation:
      'CPSCのeFiling重点リストには掲載がありませんが、12歳以下の子供向け製品全般や特定安全基準品目はCPSC証明書が必要です。製品カテゴリが明確になればより精度の高い判定が可能です。',
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
  inputCompleteness?: 'complete' | 'partial';
  missingInputs?: string[];
  clarifyingQuestions?: string[];
  impactExplanation?: string;
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
      inputCompleteness: 'complete',
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
        inputCompleteness: 'complete',
        impactExplanation:
          '食品非接触用途（装飾・ディスプレイ用等）であることが確認されたため、FDA食品安全基準は適用されません。ACE通関時のDisclaimer（免責申告：コードA）によりスムーズに通関可能です。',
      };
    }

    const isFcs = subMatch.programs.includes('FCS');
    const isFoodRaw = subMatch.fdFlag === 'FD3';
    const missingInputs: string[] = [];
    const clarifyingQuestions: string[] = [];

    if (isFcs && options.foodContact === undefined) {
      missingInputs.push('foodContact');
      clarifyingQuestions.push('この製品は飲食物に直接接触する用途（飲食・調理・保存等）ですか？それとも装飾・観賞用等の非食品用途ですか？');
    } else if (isFoodRaw && options.foodContact === undefined) {
      missingInputs.push('foodUsage');
      clarifyingQuestions.push('この製品は食品原料・調製品として使用されますか？それとも工業・化粧品用途等の非食品用途ですか？');
    }

    const inputCompleteness: 'complete' | 'partial' = missingInputs.length > 0 ? 'partial' : 'complete';
    const impactExplanation =
      isFcs && options.foodContact === undefined
        ? '本品目（FD1）は食品接触用途（飲食・調理用）である場合のみFDA食品接触物質安全基準（溶出試験等）が適用されます。装飾・工業用等の非接触用途であればACE通関時にDisclaimer（免責申告：コードA）が可能です。'
        : isFoodRaw && options.foodContact === undefined
          ? '本品目（FD3）は食品用途の場合にPrior Notice提出が必須となります。非食品用途（工業原料・化粧品等）であればACE Disclaimerが可能です。'
          : undefined;

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
      inputCompleteness,
      missingInputs: missingInputs.length > 0 ? missingInputs : undefined,
      clarifyingQuestions: clarifyingQuestions.length > 0 ? clarifyingQuestions : undefined,
      impactExplanation,
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
      inputCompleteness: 'complete',
    };
  }

  const missingInputs: string[] = [];
  const clarifyingQuestions: string[] = [];
  if ((entry.programs.includes('FCS') || entry.fdFlag === 'FD1') && options.foodContact === undefined) {
    missingInputs.push('foodContact');
    clarifyingQuestions.push('この製品は飲食物に直接接触する用途（飲食・調理用等）で使用されますか？');
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
    inputCompleteness: missingInputs.length > 0 ? 'partial' : 'complete',
    missingInputs: missingInputs.length > 0 ? missingInputs : undefined,
    clarifyingQuestions: clarifyingQuestions.length > 0 ? clarifyingQuestions : undefined,
    impactExplanation:
      missingInputs.length > 0
        ? '章レベルでの推定判定です。用途や食品接触の有無によってFDA規制要件またはACE免責の適用が分岐します。'
        : undefined,
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
  /** 公式の階層での位置（最上位の見出しから親まで）。"Other" のような説明だけでは分からないときの手がかり。 */
  officialPath?: string[];
  generalRate?: string;
  otherRate?: string;
  specialRate?: string;
  nearbyCandidates: HtsCandidate[];
  disclaimer: string;
  source: 'usitc-hts';
  inputCompleteness?: 'complete' | 'partial';
  missingInputs?: string[];
  clarifyingQuestions?: string[];
  impactExplanation?: string;
}

const DISCLAIMER_USITC =
  '本ツールは米国USITC公式データによる実在確認・関税率取得であり、法的な分類判断ではありません。' +
  '最終的な分類確定にはCBPのCROSS判定検索（rulings.cbp.gov）や通関士等の専門家への確認が必要です。' +
  'なお、HTS Revision 18等の大統領布告・通商法301条（中国原産品追加関税等）に基づくChapter 99の特別追加関税は別途個別確認が必要です。';

/** 文末の区切り（: ; ,）を取る。HTS の説明は中間行が "Other:" のように終わる。 */
function tidyHts(s: string): string {
  return s.replace(/[\s:;,]+$/, '').trim();
}

/** 候補の表示用の説明。"Other" のように説明だけでは分からない行には、親の説明を添える。 */
function describeCandidate(line: HtsLine): string {
  const own = tidyHts(line.description);
  const parent = tidyHts(line.path[line.path.length - 1] ?? '');
  return /^other\b/i.test(own) && parent ? `${parent} › ${own}` : own;
}

/**
 * LLM・利用者が推論したHTSコード候補を米国USITC公式データ（HTS全件のローカルコピー）で実在確認し、関税率を取得する。
 * 率は、その行に無ければ最も近い祖先の率を継承する（10桁の行の多くは率を持たない）。
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
  const line = normalized.length >= 8 ? await getHtsLine(normalized) : undefined;

  if (line) {
    // 8桁の行にこれより細かい行（10桁の統計細分）がある場合は、10桁の確定を促す
    const finer = line.leaf ? [] : await htsLinesUnder(normalized, { leafOnly: true, limit: 30 });
    return {
      htsCode,
      productDescription,
      verified: true,
      matchLevel: 'exact',
      hsCode: normalized.slice(0, 6),
      officialDescription: line.description,
      officialPath: line.path.map(tidyHts),
      generalRate: line.general || undefined,
      otherRate: line.other || undefined,
      specialRate: line.special || undefined,
      nearbyCandidates: finer.map((l) => ({ htsCode: l.code, description: describeCandidate(l) })),
      disclaimer: DISCLAIMER_USITC,
      source: 'usitc-hts',
      ...(finer.length > 0
        ? {
            inputCompleteness: 'partial' as const,
            missingInputs: ['hts10DigitSubdivision'],
            clarifyingQuestions: [
              '指定されたコードには、より細かい10桁の統計細分があります。製品の詳細な素材構成比率、寸法、または特定機能（手動/電動等）を教えていただけますか？',
            ],
            impactExplanation:
              '8桁の行は実在しますが、米国の10桁統計細分が未確定です。統計細分によって一般関税率や適用される追加関税が異なる場合があります。',
          }
        : {
            inputCompleteness: 'complete' as const,
            impactExplanation: '米国USITC公式関税率表にて10桁統計細分コードの実在および一般関税率が確認されました。',
          }),
    };
  }

  const categoryLines = normalized.length >= 4 ? await htsLinesUnder(normalized.slice(0, 6), { leafOnly: true, limit: 30 }) : [];
  if (categoryLines.length > 0) {
    return {
      htsCode,
      productDescription,
      verified: false,
      matchLevel: '6-digit-category',
      hsCode: normalized.slice(0, 6),
      nearbyCandidates: categoryLines.map((l) => ({ htsCode: l.code, description: describeCandidate(l) })),
      disclaimer: DISCLAIMER_USITC,
      source: 'usitc-hts',
      inputCompleteness: 'partial',
      missingInputs: ['hts10DigitSubdivision'],
      clarifyingQuestions: [
        '正確な10桁HTS統計細分および一般関税率を特定するため、製品の詳細な素材構成比率、寸法、または特定機能（手動/電動等）を教えていただけますか？',
      ],
      impactExplanation:
        '提示されたHTSコードは6桁国際共通サブヘディングのみ合致しており、米国の10桁統計細分が未確定です。統計細分によって一般関税率や適用される追加関税が異なるため、詳細仕様の確認が必要です。',
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
    inputCompleteness: 'partial',
    missingInputs: ['validHtsCode'],
    clarifyingQuestions: [
      '指定されたHTSコードはUSITC公式データに見つかりませんでした。商品の素材・用途・品名から推測ツール（predict_hts_code）を実行するか、最新のHTSコード番号をご確認いただけますか？',
    ],
    impactExplanation:
      '無効または未存在のHTSコードでは通関時にCBPシステム（ACE）でエラーとなり貨物が保留されるリスクがあります。',
  };
}

// ==========================================
// 3.5. 商品情報からの HTS/HSコード推測エンジン (predictHtsCode)
// ==========================================
// 品目の規則表や辞書は持たない。次の二つの手がかりを6桁の単位で統合し、足りない情報は分岐点の質問で補う。
//   (1) USITC 公式 HTS 全件の階層つき全文検索（hts_data.ts）
//   (2) CBP の分類判例（CROSS）。普段の言葉と法令の用語をつなぐ
// 判例が使えないとき（通信失敗・該当なし）は (1) だけで答える。

/** 入力の誤り（英語の語が無い、該当する品目が見つからない）。REST では 400 にする。 */
export class TradeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradeInputError';
  }
}

export interface PredictHtsOptions {
  productName: string;
  description?: string;
  material?: string;
  productCategory?: string;
  targetAge?: 'adult' | 'child' | 'unknown';
  foodContact?: boolean;
  hasBattery?: boolean;
}

export type PredictHtsSource = 'hts-text' | 'cbp-ruling';

export interface PredictHtsCandidate {
  htsCode: string;
  description: string;
  generalRate: string;
  score: number;
  path?: string[];
  sources?: PredictHtsSource[];
}

export interface HtsDecisionOption {
  text: string;
  htsCode?: string;
  generalRate?: string;
}

/** 候補が公式の階層のどこで分かれるか。選択肢は公式の説明文。答えを description に加えて再実行すると絞れる。 */
export interface HtsDecisionPoint {
  question: string;
  options: HtsDecisionOption[];
}

export interface PredictHtsEvidence {
  dataFetchedAt: string;
  crossStatus: CrossStatus;
  crossQuery?: string;
  crossNote?: string;
  /** 最有力の6桁を支持した判例（上位3件）。 */
  rulings: { rulingNumber: string; date: string; subject: string; tariffs: string[]; url: string }[];
}

export interface PredictHtsResult {
  detectedSubheading: string;
  category: string;
  bestMatch: {
    htsCode: string;
    description: string;
    parentDescription?: string;
    path?: string[];
    generalRate: string;
    /** 率を継承した祖先のコード。その行自身の率なら無い。 */
    rateFrom?: string;
    score: number;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    cpsc?: CpscCertificateCheckResult;
    fda?: CheckFdaRegulatedResult;
  };
  candidates: PredictHtsCandidate[];
  decisionPoints?: HtsDecisionPoint[];
  evidence: PredictHtsEvidence;
  disclaimer: string;
  inputCompleteness?: 'complete' | 'partial';
  missingInputs?: string[];
  clarifyingQuestions?: string[];
  impactExplanation?: string;
}

// 6桁の候補の統合: 判例の票の割合（CROSS_WEIGHT）と、候補の6桁の中で測り直した全文検索の点数（残り）の和。
// 評価セット eval/hts_predict_cases.json の dev で決めた（0.6〜0.7、候補数 4〜8 で結果は同じ）。
const CROSS_WEIGHT = 0.7;
const CANDIDATES_PER_SOURCE = 6;
// 本体ではなく部品・付属品の行を選ぶ誤りを減らす。見出しが "Parts" で始まる6桁は、商品の語に部品・付属品を示す語が無いとき減点する。
const PARTS_HEADING_PENALTY = 0.5;
const PARTS_HEADING = /^(other )?parts\b/i;
const ACCESSORY_WORDS = /\b(parts?|accessor\w*|components?|replacement|spare|case|cases|cover|covers|strap|straps|band|bands|holder|sleeve|adapter|charger|cable|stand|mount)\b/i;
// 信頼度の閾値（dev＋test 103件で適合率を測って決めた: high 90%、low 42%）
const HIGH_CROSS_SHARE = 0.4;
const LOW_MARGIN = 0.1;
const MATERIAL_QUESTION =
  '素材は何ですか？ material に英語で指定して再実行すると、素材つき（例: "plastic coaster"）で判例を引き直します（plastic, textile, leather, wood, ceramic, glass, metal, paper など）。PU・ビニールなどの合成皮革は、織物の基布が主体なら textile、そうでなければ plastic で、leather は本革だけです。';
const MAX_DECISION_OPTIONS = 6;
const DECISION_TEXT_LIMIT = 160;

/**
 * 否定された語（"not ceramic", "without battery"）は商品の特徴ではないので、検索から外す。
 * 呼び出し側の LLM が "Not textile, not tin foil, not ceramic" のように書き足すことがあり、そのままだと箔や陶器の行を引いてしまう。
 */
export function stripNegations(text: string): string {
  return text.replace(/\b(?:not|no|without|excluding|except|isn't|doesn't)\b(?:\s+[a-z][a-z-]*){1,3}/gi, ' ').replace(/\bnon-[a-z]+/gi, ' ');
}

/**
 * 公式の行の説明文に現れる、年齢・性別の区分の語。検索語ではなく、候補の行の説明文の側を調べる。
 * under/over の年齢は (kind:'childAge', max: 3) のように正規化し、入力の年齢表現と突き合わせる。
 */
interface AgeGenderMarker {
  kind: 'men' | 'women' | 'boys' | 'girls' | 'infants' | 'children' | 'childAge';
  /** "Under N years" の N（含まない）。"M to N years" では使わない */
  max?: number;
  /** "M to N years" の M（含む）。"Under N years" では 0 */
  min?: number;
}

const AGE_GENDER_PATTERNS: { re: RegExp; mark: AgeGenderMarker }[] = [
  { re: /\bunder (\d+) years? of age\b/i, mark: { kind: 'childAge' } }, // max は文中の数字で埋める
  { re: /\b(\d+) to (\d+) years? of age\b/i, mark: { kind: 'childAge' } },
  { re: /\bmen'?s?(?: or boys'?)?\b/i, mark: { kind: 'men' } },
  { re: /\bwomen'?s?(?: or girls'?)?\b/i, mark: { kind: 'women' } },
  { re: /\bfor men\b/i, mark: { kind: 'men' } },
  { re: /\bfor women\b/i, mark: { kind: 'women' } },
  { re: /\bboys?\b/i, mark: { kind: 'boys' } },
  { re: /\bgirls?\b/i, mark: { kind: 'girls' } },
  { re: /\binfants?(?:'|’)?\b|\bbab(?:y|ies)\b/i, mark: { kind: 'infants' } },
  { re: /\bchildren\b|\bchild\b|\btoddlers?\b/i, mark: { kind: 'children' } },
];

/** 行の公式の説明文（自分と祖先）から、年齢・性別の区分を取り出す。該当が無ければ空。
 *  同じ文言の行が複数あるとき（9503 の "Under 3 years of age" が .11 と .71）は、
 *  祖先の説明もマーカーに含めて区別できるように、行ごとのマーカー列を返す。
 *  祖先の区分（"Children's products" など）は、年齢の判定には使わず、同一文言の行の区別にだけ使う。
 */
function lineMarkers(line: HtsLine): AgeGenderMarker[][] {
  const own: AgeGenderMarker[] = [];
  const ancestors: AgeGenderMarker[] = [];
  const collect = (text: string, out: AgeGenderMarker[]) => {
    for (const { re, mark } of AGE_GENDER_PATTERNS) {
      const m = text.match(re);
      if (!m) continue;
      if (mark.kind === 'childAge') {
        const nums = (m[0].match(/\d+/g) ?? []).map(Number);
        out.push(nums.length === 1 ? { kind: 'childAge', min: 0, max: nums[0] } : { kind: 'childAge', min: nums[0], max: nums[1] + 1 });
      } else {
        out.push({ ...mark });
      }
    }
  };
  collect(line.description, own);
  for (const a of line.path) collect(a, ancestors);
  // 行自体に区分が無いときは、祖先の区分を借りる（"Other" のような行）。行自体にあるときは行を優先
  return [own.length > 0 ? own : ancestors];
}

export interface ProductAgeGender {
  men?: boolean;
  women?: boolean;
  boys?: boolean;
  girls?: boolean;
  infants?: boolean;
  children?: boolean;
  /** 説明文から読めた対象年齢（歳）。"aged 3+"、"for 3-year-olds"、"3 to 12 years" の下限など */
  ageYears?: number;
}

/**
 * 入力の年齢・性別の情報。説明文の表現を優先し（事実だから）、無ければ targetAge を使う。
 * 性別は説明文からしか取らない（targetAge には性別の情報が無い）。
 */
export function detectProductAgeGender(text: string, targetAge?: string): ProductAgeGender {
  const out: ProductAgeGender = {};
  // "men" は "women" の部分文字列なので、women を先に除いてから判定する
  const noWomen = text.replace(/\bwomen'?s?\b/gi, ' ');
  if (/\bmen'?s\b|\bfor men\b/i.test(noWomen)) out.men = true;
  if (/\bwomen'?s\b|\bfor women\b/i.test(text)) out.women = true;
  if (/\bboys?\b/i.test(text)) out.boys = true;
  if (/\bgirls?\b/i.test(text)) out.girls = true;
  if (/\binfants?\b|\bbab(?:y|ies)\b/i.test(text)) { out.infants = true; out.children = true; }
  if (/\btoddlers?\b|\bchildren\b|\bchild\b/i.test(text)) out.children = true;
  const m =
    text.match(/\baged?\s*(\d+)\s*(?:\+|plus|and (?:up|over|older))\b/i) ??
    text.match(/\bfor\s*(?:ages?\s*)?(\d+)\s*[-–]\s*\d+\s*(?:years?|yrs?)(?:\s*old)?\b/i) ??
    text.match(/\b(\d+)\s*[-–]\s*\d+\s*(?:years?|yrs?)(?:\s*old)?\b/i) ??
    text.match(/\b(\d+)\s*(?:years?|yrs?)(?:\s*old)?\s*(?:and (?:up|over|older)|\+)/i) ??
    text.match(/\bfor\s*(\d+)\s*[-–]?\s*year[-–]?olds?\b/i) ??
    text.match(/\bchildren\s+aged\s*(\d+)\s*[-–+]\b/i) ??
    text.match(/\baged\s*(\d+)\s*[-–]\b/i);
  if (m) out.ageYears = Number(m[1]);
  else if (targetAge === 'child') out.children = true;
  return out;
}

/**
 * 行が、入力の年齢・性別に合うか。合う・合わない・分からない（行に区分が無い）の3値を返す。
 * 性別: 行が men's なら入力に men/boys が要り、women's なら women/girls が要る。children/infants の行は性別では絞らない。
 * 年齢: "Under N years" の行は入力の年齢が N 未満のときだけ合い、"M to N years" の行は M 以上のときだけ合う。
 *   入力の年齢が不明でも、targetAge=child なら "Under 3" は除外しない（3歳未満かもしれない）が、
 *   "3 to 12" 側も選ばない（分からないので、ここでは絞らない）。
 */
function matchAgeGender(line: HtsLine, info: ProductAgeGender): 'match' | 'mismatch' | 'unknown' {
  const markerSets = lineMarkers(line);
  if (markerSets.every((ms) => ms.length === 0)) return 'unknown';
  // いずれかのマーカー列で「合う」があれば match。全ての列で合わなければ mismatch
  let anyMatch = false;
  for (const markers of markerSets) {
    if (markers.length === 0) continue;
    const r = matchMarkerSet(markers, info);
    if (r === 'match') anyMatch = true;
    else if (r === 'mismatch') return 'mismatch';
  }
  return anyMatch ? 'match' : 'unknown';
}

/** 1つのマーカー列（行自体、または祖先）の判定 */
function matchMarkerSet(markers: AgeGenderMarker[], info: ProductAgeGender): 'match' | 'mismatch' | 'unknown' {
  let matched = false;
  for (const mk of markers) {
    switch (mk.kind) {
      case 'men':
        if (info.men || info.boys) matched = true;
        else if (info.women || info.girls) return 'mismatch';
        break;
      case 'women':
        if (info.women || info.girls) matched = true;
        else if (info.men || info.boys) return 'mismatch';
        break;
      case 'boys':
        if (info.boys || info.men) matched = true;
        break;
      case 'girls':
        if (info.girls || info.women) matched = true;
        break;
      case 'infants':
        if (info.infants) matched = true;
        else if (info.ageYears !== undefined && info.ageYears >= 3) return 'mismatch';
        break;
      case 'children':
        if (info.children || info.infants) matched = true;
        break;
      case 'childAge': {
        const max = mk.max ?? 99;
        const min = mk.min ?? 0;
        if (info.ageYears !== undefined) {
          if (info.ageYears >= min && info.ageYears < max) matched = true;
          else return 'mismatch';
        } else if (info.children && min >= 3) {
          // 年齢不明の子供向け: "3 to 12" 側は選ばず、"Under 3" 側も除外しない（分からないので絞らない）
          return 'unknown';
        }
        break;
      }
    }
  }
  return matched ? 'match' : 'unknown';
}

/** reason 用に、入力の年齢・性別を短く表す（例: "3歳以上"、"men's"）。 */
function describeAgeGender(info: ProductAgeGender): string {
  const parts: string[] = [];
  if (info.ageYears !== undefined) parts.push(`${info.ageYears}歳以上`);
  else if (info.children) parts.push('子供向け');
  if (info.men) parts.push("men's");
  if (info.women) parts.push("women's");
  if (info.boys) parts.push('boys');
  if (info.girls) parts.push('girls');
  if (info.infants) parts.push('infant');
  return parts.join('・') || '年齢・性別';
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const formatSubheading = (d6: string) => `${d6.slice(0, 4)}.${d6.slice(4, 6)}`;

/**
 * CROSS に問い合わせる語。検索は AND 条件で、語が多いと 0 件になるため、絞りながら順に試す。
 *   1. 品名の全ての語  2. 前置詞・接続詞（for, with, and など）より前の名詞句  3. その名詞句の後ろ 4・3・2・1 語
 * 品名の末尾は名詞なので、後ろから絞る（"Wooden Building Blocks for Toddlers" は "wooden building blocks" が先に試される）。
 * HTS の語彙にない語（speaker、kettle など）こそ品名の肝なので、語彙での絞り込みはしない。
 */
export function crossQueriesFor(productName: string, material?: string): string[] {
  const head = productName.split(/\b(?:for|with|without|and|in|to|by|from)\b|[,;(|]/i)[0];
  const all = queryTerms(productName).slice(0, 8);
  const noun = queryTerms(head);
  // 呼び出し側が素材を明示したら、素材つきの照会を最も具体的なものとして先頭に置く（"plastic coaster" は "coaster" の上位10件に無い 3924.10 の判例に当たる）
  const materialTerms = queryTerms(material ?? '').slice(0, 2);
  const withMaterial = materialTerms.length > 0 && noun.length > 0 ? [2, 1].map((n) => [...materialTerms, ...noun.slice(-n)].join(' ')) : [];
  return [...new Set([...withMaterial, all.join(' '), noun.slice(0, 8).join(' '), ...[4, 3, 2, 1].map((n) => noun.slice(-n).join(' '))])].filter(Boolean);
}

// 判例が挙げた古い6桁（改訂で番号が変わったもの）を、現行の6桁に振り分けるときの上限。多いと曖昧なので使わない。
const MAX_HEADING_FANOUT = 6;

/**
 * 判例が挙げたコードを、現行の木にある6桁に直す。10桁の葉があればそれを、8桁の行（これより細かい行を持つ）があればその8桁も返す。
 * 6桁が現行に無いとき（HTS の改訂で小見出しの番号が変わった）は、現行の6桁に振り分ける。
 * 分割（9405.20 → 9405.21・9405.29）では上位5桁が保たれるので、まず上位5桁が同じ6桁へ。統合（9503.30 → 9503.00）では保たれないので、次に見出し（4桁）の下の6桁へ。
 */
async function resolveCitedCode(digits: string): Promise<{ d6s: string[]; leaf?: HtsLine; p8?: string } | undefined> {
  let leaf: HtsLine | undefined;
  let p8: string | undefined;
  if (digits.length >= 8) {
    const line = await getHtsLine(digits);
    if (line?.leaf) leaf = line;
    else if (!line && digits.length > 8 && (await getHtsLine(digits.slice(0, 8)))) p8 = digits.slice(0, 8);
    else if (line && digits.length === 8) p8 = digits;
  }
  const d6 = digits.slice(0, 6);
  if (leaf || p8 || (await htsLinesUnder(d6, { limit: 1 })).length > 0) return { d6s: [d6], leaf, p8 };
  const heading = await htsLinesUnder(digits.slice(0, 4), { limit: 400 });
  const children = [...new Set(heading.filter((l) => l.digits.length >= 6).map((l) => l.digits.slice(0, 6)))];
  const split = children.filter((c) => c.startsWith(digits.slice(0, 5)));
  const target = split.length > 0 ? split : children;
  return target.length > 0 && target.length <= MAX_HEADING_FANOUT ? { d6s: target } : undefined;
}

/** その6桁が、部品・付属品の見出しの下か（"Parts" で始まる見出し／小見出し）。 */
async function isPartsHeading(d6: string): Promise<boolean> {
  const first = (await htsLinesUnder(d6, { limit: 1 }))[0];
  if (!first) return false;
  return PARTS_HEADING.test(first.path[0] ?? '') || PARTS_HEADING.test(first.path[1] ?? '') || (first.indent <= 1 && PARTS_HEADING.test(first.description));
}

/** 候補の葉の公式の位置（祖先の説明＋自分の説明）。 */
const pathOf = (line: HtsLine) => [...line.path, line.description].map(tidyHts);

/**
 * 候補の葉が公式の階層で最初に分かれる位置を求め、その位置の説明文を選択肢にした質問を作る。
 * 先頭の候補が最有力。候補が1つしか無い、または全て同じ位置なら undefined。
 */
function buildDecisionPoint(pool: HtsLine[]): HtsDecisionPoint | undefined {
  if (pool.length < 2) return undefined;
  const paths = pool.map(pathOf);
  const shortest = Math.min(...paths.map((p) => p.length));
  let depth = 0;
  while (depth < shortest - 1 && paths.every((p) => p[depth] === paths[0][depth])) depth++;

  const groups = new Map<string, HtsLine>();
  for (const [i, line] of pool.entries()) {
    const label = truncate(paths[i].slice(depth, depth + 3).join(' › '), DECISION_TEXT_LIMIT);
    if (!groups.has(label)) groups.set(label, line);
  }
  if (groups.size < 2) return undefined;

  const options = [...groups.entries()].slice(0, MAX_DECISION_OPTIONS).map(([text, line]) => ({
    text,
    htsCode: line.code,
    generalRate: line.general || undefined,
  }));
  // 質問の見出し: 分かれる位置の祖先のうち、"Other" ではなく内容のある最も近いもの。見出しの段で分かれるときは、見出しの違いを尋ねる
  const stem = paths[0].slice(0, depth).reverse().find((t) => !/^other\b/i.test(t));
  return {
    question: stem
      ? `分類の確認: 公式の区分「${truncate(stem, DECISION_TEXT_LIMIT)}」のうち、商品が当たるのはどれですか？ 答えとなる区分の語を description に加えて再実行してください。`
      : '分類の確認: 候補が異なる見出しに分かれています。商品が当たるのはどれですか？ 答えとなる区分の語を description に加えて再実行してください。',
    options,
  };
}

function decisionPointText(dp: HtsDecisionPoint): string {
  const list = dp.options
    .map((o, i) => `(${i + 1}) ${o.text}${o.htsCode ? ` [${o.htsCode}${o.generalRate ? `, ${o.generalRate}` : ''}]` : ''}`)
    .join(' / ');
  return `${dp.question} 選択肢: ${list}`;
}

/**
 * 商品情報（英語の商品名・説明・素材など）から、米国の10桁HTSコード候補・関税率・規制要件を推測する。
 * USITC 公式の関税率表（全件）の階層つき全文検索と、CBP の分類判例を統合する。
 */
export async function predictHtsCode(options: PredictHtsOptions): Promise<PredictHtsResult> {
  const productName = options.productName?.trim();
  if (!productName) {
    throw new TradeInputError('productName is required for HTS code prediction');
  }
  const combinedText = [productName, options.description, options.productCategory, options.material]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!hasEnglishWords(combinedText)) {
    throw new TradeInputError(
      'HTSの照合は英語の品目説明で行います。productName と description を、商品の一般名の英語（例: "Stainless Steel Water Bottle"）にして再実行してください。',
    );
  }
  const factualText = stripNegations(combinedText);
  const searchText = options.hasBattery ? `${factualText} battery` : factualText;

  // 1. 二つの手がかりを並行して取る
  const [ftsHits, cross] = await Promise.all([
    searchHtsLines(searchText, { limit: 60 }),
    lookupCrossRulings(crossQueriesFor(productName, options.material)),
  ]);

  // 2. 全文検索: 6桁ごとの最良の行（順位は検索の順）
  const textOrder: string[] = [];
  for (const hit of ftsHits) {
    const d6 = hit.digits.slice(0, 6);
    if (!textOrder.includes(d6)) textOrder.push(d6);
  }

  // 3. 判例: 現行の木にあるコードへの票（上位の判例ほど重く、1件の判例が複数の6桁を挙げたら分ける）
  const votes = new Map<string, number>();
  const citedLeaves = new Map<string, Map<string, { line: HtsLine; votes: number }>>();
  const cited8 = new Map<string, Map<string, number>>(); // 6桁 → (判例が挙げた8桁 → 票)
  const supporting = new Map<string, CrossRuling[]>();
  for (const [rank, ruling] of cross.rulings.entries()) {
    const resolved = (await Promise.all(ruling.tariffs.map(resolveCitedCode))).filter((r): r is NonNullable<typeof r> => !!r);
    const distinct6 = new Set(resolved.flatMap((r) => r.d6s));
    if (distinct6.size === 0) continue;
    const weight = 1 / (rank + 1) / distinct6.size;
    for (const d6 of distinct6) {
      votes.set(d6, (votes.get(d6) ?? 0) + weight);
      supporting.set(d6, [...(supporting.get(d6) ?? []), ruling]);
    }
    for (const r of resolved) {
      if (r.p8) {
        const m8 = cited8.get(r.p8.slice(0, 6)) ?? new Map();
        m8.set(r.p8, (m8.get(r.p8) ?? 0) + weight);
        cited8.set(r.p8.slice(0, 6), m8);
      }
      if (!r.leaf) continue;
      const d6 = r.leaf.digits.slice(0, 6);
      const m = citedLeaves.get(d6) ?? new Map();
      m.set(r.leaf.digits, { line: r.leaf, votes: (m.get(r.leaf.digits)?.votes ?? 0) + weight });
      citedLeaves.set(d6, m);
    }
  }
  const crossOrder = [...votes.entries()].sort((a, b) => b[1] - a[1]).map(([d6]) => d6);
  const totalVotes = [...votes.values()].reduce((a, b) => a + b, 0);

  // 4. 6桁の統合。全文検索の点数は、候補の6桁の中だけで測り直す
  //    （商品の語が HTS に無いと、全体の検索は無関係な行に引かれるため）
  const candidate6 = new Set([...crossOrder.slice(0, CANDIDATES_PER_SOURCE), ...textOrder.slice(0, CANDIDATES_PER_SOURCE)]);
  if (candidate6.size === 0) {
    throw new TradeInputError(
      '商品名・説明に該当するHTSの品目を見つけられませんでした。商品の一般名（英語）・素材・用途を具体的にして再実行してください。',
    );
  }
  const inPrefix = new Map<string, HtsSearchHit[]>();
  const partsOnly = new Set<string>();
  const wantsParts = ACCESSORY_WORDS.test(combinedText);
  await Promise.all(
    [...candidate6].map(async (d6) => {
      inPrefix.set(d6, await searchHtsLines(searchText, { prefix: d6, limit: 10 }));
      if (!wantsParts && (await isPartsHeading(d6))) partsOnly.add(d6);
    }),
  );
  const textScore = (d6: string) => inPrefix.get(d6)?.[0]?.score ?? 0;
  const textMax = Math.max(1e-9, ...[...candidate6].map(textScore));
  const crossShareOf = (d6: string) => (totalVotes > 0 ? (votes.get(d6) ?? 0) / totalVotes : 0);
  const fused = new Map<string, number>();
  for (const d6 of candidate6) {
    const score = CROSS_WEIGHT * crossShareOf(d6) + (1 - CROSS_WEIGHT) * (textScore(d6) / textMax);
    fused.set(d6, partsOnly.has(d6) ? score * PARTS_HEADING_PENALTY : score);
  }
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
  const best6 = ranked[0][0];

  // 5. 最有力の6桁の中の行: 年齢・性別に合う行 → 判例が挙げた現行の葉（票の多い順）→ 判例が挙げた8桁の下で全文検索 → 6桁の中で全文検索
  //    年齢・性別は、公式の行の説明文（"Men's"、"Under 3 years of age" など）と入力の年齢・性別を突き合わせる。
  //    玩具の年齢（3歳未満 / 3〜12歳）、アパレル・靴の男女区分など、同じ6桁の中で分かれる行の選択に使う。
  const ageGender = detectProductAgeGender(factualText, options.targetAge);
  const inBest6 = inPrefix.get(best6) ?? [];
  const citedBest = [...(citedLeaves.get(best6)?.values() ?? [])].sort((a, b) => b.votes - a.votes).map((c) => c.line);
  const siblings = await htsLinesUnder(best6, { leafOnly: true, limit: 80 });
  const ageGenderMatch = (line?: HtsLine) => (line ? matchAgeGender(line, ageGender) : 'unknown');
  // 不一致の行を除き、一致する行があればその中から選ぶ。一致が複数・ゼロなら今の順位のまま
  const filterAgeGender = (lines: HtsLine[]): HtsLine[] => {
    if (lines.every((l) => ageGenderMatch(l) === 'unknown')) return lines;
    const kept = lines.filter((l) => ageGenderMatch(l) !== 'mismatch');
    return kept.length > 0 ? kept : lines;
  };
  const ageMatchedSiblings = filterAgeGender(siblings).filter((l) => ageGenderMatch(l) === 'match');
  const topCited8 = [...(cited8.get(best6)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
  let inCited8: HtsLine[] = [];
  if (citedBest.length === 0 && topCited8) {
    const hits = await searchHtsLines(searchText, { prefix: topCited8, limit: 10 });
    // 商品の語に当たる行が無ければ、その8桁の最後の葉（通常は "Other"）
    inCited8 = hits.length > 0 ? hits : (await htsLinesUnder(topCited8, { leafOnly: true, limit: 200 })).slice(-1);
  }
  const bestLine: HtsLine | undefined =
    filterAgeGender(citedBest)[0] ?? filterAgeGender(inCited8)[0] ?? filterAgeGender(inBest6)[0] ?? ageMatchedSiblings[0] ?? siblings[siblings.length - 1];
  if (!bestLine) {
    throw new TradeInputError('該当するHTSの行を特定できませんでした。商品の一般名（英語）・素材・用途を具体的にして再実行してください。');
  }
  const ageGenderApplied = ageGenderMatch(bestLine) === 'match';

  // 6. 信頼度: 判例の1位・全文検索の1位・最終候補が一致して票が集まっていれば high、
  //    首位との差が小さい、またはどちらの1位でもなければ low。
  //    年齢・性別で10桁を確定できたときは、6桁の一致に加えて low を避ける（兄弟の行との取り違えが解けたため）
  const crossShare = crossShareOf(best6);
  const margin = ranked[0][1] - (ranked[1]?.[1] ?? 0);
  const textTop = textOrder[0];
  const crossTop = crossOrder[0];
  const confidence: 'high' | 'medium' | 'low' =
    textTop === best6 && crossTop === best6 && crossShare >= HIGH_CROSS_SHARE
      ? 'high'
      : margin < LOW_MARGIN || (textTop !== best6 && crossTop !== best6)
        ? ageGenderApplied && (textTop === best6 || crossTop === best6)
          ? 'medium'
          : 'low'
        : 'medium';

  // 7. 候補: 6桁ごとに代表の行を1つ（上位5つの6桁）
  const repFor = async (d6: string): Promise<{ line: HtsLine; sources: PredictHtsSource[] } | undefined> => {
    const cited = [...(citedLeaves.get(d6)?.values() ?? [])].sort((a, b) => b.votes - a.votes)[0]?.line;
    const line = d6 === best6 ? bestLine : (cited ?? inPrefix.get(d6)?.[0] ?? (await htsLinesUnder(d6, { leafOnly: true, limit: 1 }))[0]);
    if (!line) return undefined;
    const sources: PredictHtsSource[] = [];
    if (textOrder.includes(d6)) sources.push('hts-text');
    if (votes.has(d6)) sources.push('cbp-ruling');
    return { line, sources };
  };
  const reps = (await Promise.all(ranked.slice(0, 5).map(([d6]) => repFor(d6)))).filter((r): r is NonNullable<typeof r> => !!r);
  const candidates: PredictHtsCandidate[] = reps.map(({ line, sources }) => ({
    htsCode: line.code,
    description: describeCandidate(line),
    generalRate: line.general || 'N/A',
    score: Math.round((fused.get(line.digits.slice(0, 6)) ?? 0) * 1000) / 10,
    path: line.path.map(tidyHts),
    sources,
  }));

  // 8. 分岐点: 6桁が競っているときは6桁の代表どうし、そうでなければ最有力の6桁の下の全ての葉で、分かれる位置を探す
  //    （商品の語が当たらない行も含める。例: 自転車用ヘルメットは "Athletic, recreational and sporting headgear" で、"helmet" の語を含まない）
  const contested = ranked.length > 1 && ranked[1][1] >= 0.6 * ranked[0][1];
  const pool: HtsLine[] = [bestLine];
  const addToPool = (l?: HtsLine) => {
    if (l && !pool.some((p) => p.digits === l.digits)) pool.push(l);
  };
  if (contested) for (const r of reps) addToPool(r.line);
  else for (const l of [...citedBest, ...inCited8, ...inBest6, ...siblings]) addToPool(l);
  const decision = confidence === 'high' ? undefined : buildDecisionPoint(pool);

  // 9. CPSC・FDA の判定（最有力のコードで）
  const category = tidyHts(bestLine.path[0] ?? bestLine.description);
  const [cpscRes, fdaRes] = await Promise.all([
    checkCpscCertificate({
      htsCode: bestLine.code,
      targetAge: options.targetAge || 'unknown',
      material: options.material,
      productCategory: options.productCategory || category,
      description: combinedText,
    }),
    Promise.resolve(
      checkFdaRegulated({
        htsCode: bestLine.code,
        productDescription: combinedText,
        foodContact: options.foodContact,
      }),
    ),
  ]);

  // 10. 不足情報: 分岐点の質問と、CPSC・FDA の判定が実際に必要とした情報（キーワードでの推測はしない）
  const missingInputs: string[] = [];
  const clarifyingQuestions: string[] = [];
  const addMissing = (inputs?: string[], questions?: string[]) => {
    for (const m of inputs ?? []) if (m !== 'exactHtsClassification' && !missingInputs.includes(m)) missingInputs.push(m);
    for (const q of questions ?? []) if (!clarifyingQuestions.includes(q)) clarifyingQuestions.push(q);
  };
  if (decision) {
    missingInputs.push('classificationDetail');
    clarifyingQuestions.push(decisionPointText(decision));
  }
  if (cpscRes.applicableRegulations.length > 0) addMissing(cpscRes.missingInputs, cpscRes.clarifyingQuestions);
  addMissing(fdaRes.missingInputs, fdaRes.clarifyingQuestions);
  // 確度が高くなく、素材が未指定のとき: 素材を指定すると判例を素材つきで引き直す（同じ品名でも素材で章が分かれる。例: plastic coaster は 3924.10、textile coaster は 6304.93）
  //   CPSC が同じ素材を尋ねているときは、質問を1つにまとめる（CPSC の理由は impactExplanation に残る）
  if (confidence !== 'high' && !options.material?.trim()) {
    if (!missingInputs.includes('material')) missingInputs.push('material');
    for (let i = clarifyingQuestions.length - 1; i >= 0; i--) if (clarifyingQuestions[i].startsWith('製品の主要素材は何ですか')) clarifyingQuestions.splice(i, 1);
    clarifyingQuestions.push(MATERIAL_QUESTION);
  }

  let impactExplanation: string;
  if (missingInputs.length > 0) {
    const impacts: string[] = [];
    if (missingInputs.includes('classificationDetail')) {
      impacts.push('候補が公式の階層の途中で分かれており、どの区分に当たるかで10桁のコードと一般関税率が変わる');
    }
    if (missingInputs.includes('material')) {
      impacts.push('素材の違いによりHTSコードおよび一般関税率が大きく変動（例: 0%〜20%以上）');
    }
    if (missingInputs.includes('targetAge')) {
      impacts.push('12歳以下向けの場合はCPSC子供向け製品証明書(CPC)および2026年7月義務化eFilingが必須');
    }
    if (missingInputs.includes('foodContact')) {
      impacts.push('食品接触用途の場合はFDA食品安全基準適用、非接触の場合はACE免責(Disclaimer)申告が可能');
    }
    impactExplanation = `一部の情報（${missingInputs.join('、')}）が未指定のため、暫定的なHTSコード候補を提示しています。${
      impacts.length > 0 ? `実務上、【${impacts.join('、')}】という重大な分岐が生じるため、` : ''
    }正確な関税率算出および通関規制判定には追加情報の確認を強く推奨します。`;
  } else {
    impactExplanation = '製品情報（素材・対象年齢・用途等）が十分に提供されており、高確度なHTSコード候補および規制要件を特定しました。';
  }

  const supportingRulings = (supporting.get(best6) ?? []).slice(0, 3);
  const reasonParts = [
    `商品名・説明をUSITC公式HTS全件の階層つき全文検索で照合し、判例と合わせて${formatSubheading(best6)}を最有力としました`,
    ageGenderApplied
      ? `10桁は入力の年齢・性別（${describeAgeGender(ageGender)}）に合う「${tidyHts(bestLine.description)}」の行を選びました`
      : undefined,
    cross.status === 'ok'
      ? `CBP分類判例${cross.rulings.length}件のうち${supporting.get(best6)?.length ?? 0}件が同じ6桁です`
      : cross.status === 'no_rulings'
        ? 'CBP分類判例には該当がありませんでした'
        : 'CBP分類判例は参照できませんでした',
  ].filter((p): p is string => !!p);

  return {
    detectedSubheading: formatSubheading(best6),
    category,
    bestMatch: {
      htsCode: bestLine.code,
      description: bestLine.description,
      parentDescription: bestLine.path.map(tidyHts).join(' › ') || undefined,
      path: bestLine.path.map(tidyHts),
      generalRate: bestLine.general || 'N/A',
      rateFrom: bestLine.rateFrom,
      score: Math.round((fused.get(best6) ?? 0) * 1000) / 10,
      confidence,
      reason: `${reasonParts.join('。')}。`,
      cpsc: cpscRes,
      fda: fdaRes,
    },
    candidates,
    decisionPoints: decision ? [decision] : undefined,
    evidence: {
      dataFetchedAt: (await htsDataInfo()).fetchedAt,
      crossStatus: cross.status,
      crossQuery: cross.query,
      crossNote: cross.error,
      rulings: supportingRulings.map((r) => ({
        rulingNumber: r.rulingNumber,
        date: r.date,
        subject: r.subject,
        tariffs: r.tariffs,
        url: r.url,
      })),
    },
    disclaimer: DISCLAIMER_USITC,
    inputCompleteness: missingInputs.length > 0 ? 'partial' : 'complete',
    missingInputs: missingInputs.length > 0 ? missingInputs : undefined,
    clarifyingQuestions: clarifyingQuestions.length > 0 ? clarifyingQuestions : undefined,
    impactExplanation,
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
  inputCompleteness?: 'complete' | 'partial';
  missingInputs?: string[];
  /** 不足情報がある場合のみ設定。LLMがユーザーへ確認すべき質問リスト。 */
  clarifyingQuestions?: string[];
  impactExplanation?: string;
  htsVerification?: VerifyHtsCodeResult;
  htsPrediction?: PredictHtsResult;
  fda?: CheckFdaRegulatedResult;
  cpsc?: CpscCertificateCheckResult;
  actionPlan: string[];
  disclaimer: string;
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
 * 商品情報（URL または 商品名・説明・素材など）から、HTS実在検証・FDA規制判定・CPSC証明書/eFiling判定を一連のパイプラインとして一括実行。
 * HTSコードが未指定なら predictHtsCode で推測する。確度が低い・英語の情報が無いときは、既定のコードで進めず確認質問を返す。
 */
export async function checkProductCompliance(
  options: CheckProductComplianceOptions,
): Promise<CheckProductComplianceResult> {
  let productName = options.productName?.trim();
  let description = options.description?.trim();
  const targetAge = options.targetAge ?? 'unknown';
  const material = options.material?.trim();
  const productCategory = options.productCategory?.trim();
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
    } catch (err) {
      console.warn('[TradeCompliance] Scrape failed for url:', options.url, errorMessage(err));
    }
  }

  const combinedText = `${productName || ''} ${description || ''} ${productCategory || ''} ${material || ''}`.trim();

  const needsMoreInfo = (
    questions: string[],
    missing: string[],
    htsPrediction?: PredictHtsResult,
  ): CheckProductComplianceResult => ({
    product: {
      name: productName,
      description: combinedText || undefined,
      url: options.url,
      detectedCategory: htsPrediction?.category || productCategory,
      targetAge,
      material,
    },
    overallStatus: 'needs_more_info',
    summary: '正確な判定に必要な情報が不足しています。以下の質問にご回答ください。',
    inputCompleteness: 'partial',
    missingInputs: missing,
    clarifyingQuestions: questions,
    impactExplanation:
      '商品の種類が特定できないため、HTSコード分類（関税率）やPGA規制（CPSC/FDA）の分岐を特定できません。',
    htsPrediction,
    actionPlan: ['上記の質問にご回答いただいた上で、再度お問い合わせください。'],
    disclaimer: DISCLAIMER_COMPLIANCE,
  });

  if (!combinedText) {
    return needsMoreInfo(['商品名または商品説明を教えてください。'], ['productDetails']);
  }

  // 2. HTSコードの確定: 指定が無ければ推測する。指定があっても、章の食い違いの検知のために推測を試みる
  let htsPrediction: PredictHtsResult | undefined;
  let predictionNote: string | undefined;
  try {
    htsPrediction = await predictHtsCode({
      productName: productName || combinedText,
      description: description || combinedText,
      material,
      productCategory,
      targetAge,
      foodContact: options.foodContact,
      hasBattery: options.hasBattery,
    });
  } catch (e) {
    if (!(e instanceof TradeInputError)) console.warn('[TradeCompliance] predictHtsCode failed:', errorMessage(e));
    predictionNote = errorMessage(e);
  }

  if (!htsCode) {
    if (!htsPrediction || htsPrediction.bestMatch.confidence === 'low') {
      // 商品ページが日本語のときは、該当なしではなく英訳が必要だと伝える
      const japanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(combinedText);
      const questions = htsPrediction?.clarifyingQuestions?.length
        ? htsPrediction.clarifyingQuestions
        : !htsPrediction && japanese
          ? [
              '商品名・説明が日本語です。HTS と判例は英語なので、商品の一般名・素材・用途を英語にして productName と description に渡して再実行してください（宣伝文句やブランド名は除く。例: "PU Leather Coaster"）。',
            ]
          : [
              predictionNote ??
                '商品の一般名（英語）・素材・用途をより具体的に教えてください。入力された情報だけでは、HTSコードを高い確度で特定できませんでした。',
            ];
      return needsMoreInfo(questions, htsPrediction ? ['classificationDetail'] : ['productDetails'], htsPrediction);
    }
    htsCode = htsPrediction.bestMatch.htsCode;
  }
  const detectedCategory = htsPrediction?.category;

  const effectiveDescription = description || productName || combinedText;

  // 3. パイプライン並行実行 (HTS検証, FDA判定, CPSC判定)
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
      targetAge,
      material,
      productCategory: productCategory || detectedCategory,
      description: effectiveDescription,
    }),
  ]);

  // 4. アクションプラン & 総合レポート生成
  const { overallStatus, summary, actionPlan } = buildIntegratedActionPlan(
    htsVerification,
    fdaResult,
    cpscResult,
  );

  if (options.hasBattery === true && options.batteryType === 'button_coin') {
    actionPlan.push(
      '【CPSC ボタン電池・コイン電池】ボタン電池・コイン電池を使う製品は、誤飲防止の規則（Reese’s Law, 16 CFR 1263）の包装・警告表示・性能基準への適合確認が必要です。',
    );
  } else if (options.hasBattery === true && options.batteryType === 'other') {
    actionPlan.push(
      '【DOT/PHMSA 危険物】リチウムイオン電池等を含む場合、輸送時にUN3480/UN3481区分の適切な表示・梱包' +
      '（危険物輸送規則, 49 CFR）が必要か確認してください。',
    );
  }

  // 4.5. 安全弁（フェイルセーフ）：呼び出し元から指定された HTSコードと、商品情報から推測した章（Chapter）の乖離検知
  let hasChapterMismatch = false;
  let mismatchWarning: string | undefined = undefined;
  if (options.htsCode && htsPrediction && htsPrediction.bestMatch.confidence !== 'low') {
    const passedChapter = options.htsCode.replace(/\D/g, '').slice(0, 2);
    const predictedHts = htsPrediction.bestMatch.htsCode;
    const predictedChapter = predictedHts.replace(/\D/g, '').slice(0, 2);

    if (passedChapter && passedChapter !== predictedChapter) {
      hasChapterMismatch = true;
      mismatchWarning = `【HTSコード乖離注意】指定されたHTSコード (${options.htsCode}, Chapter ${passedChapter}) は、商品情報から推定される品目分類 (${htsPrediction.category}, 推奨Chapter ${predictedChapter} / コード例: ${predictedHts}) と章（Chapter）が異なっています。AI・LLMによる推測値である場合は、htsCodeを未指定（省略）にして再実行するとSoraのUSITC公式推測エンジンによる最適なコードが自動判定されます。`;
      actionPlan.unshift(mismatchWarning);
    }
  }

  // 5. サブモジュールからの不足情報・確認質問・実務影響の統合
  //    CPSC の対象リストに無いコードでは、CPSC の判定は一律に「カテゴリを教えてください」と尋ねる。
  //    公式の階層で分類済みなので、リストに近いコードが無いときの CPSC の質問は使わない（推測と同じ扱い）。
  const cpscAsks = cpscResult.applicableRegulations.length > 0;
  const subMissingInputs = Array.from(
    new Set([
      ...(options.htsCode ? [] : htsPrediction?.missingInputs || []),
      ...(cpscAsks ? cpscResult.missingInputs || [] : []),
      ...(fdaResult.missingInputs || []),
      ...(htsVerification.missingInputs || []),
    ]),
  );
  const subClarifyingQuestions = Array.from(
    new Set([
      ...(options.htsCode ? [] : htsPrediction?.clarifyingQuestions || []),
      ...(cpscAsks ? cpscResult.clarifyingQuestions || [] : []),
      ...(fdaResult.clarifyingQuestions || []),
      ...(htsVerification.clarifyingQuestions || []),
    ]),
  );
  const inputCompleteness: 'complete' | 'partial' = subMissingInputs.length > 0 ? 'partial' : 'complete';
  let impactExplanation =
    subMissingInputs.length > 0
      ? `一部の任意属性（${subMissingInputs.join('、')}）が未指定のため、代表的な仕様に基づく診断結果です。より厳密な関税率やPGA規制判定には追加ヒアリング情報の確認を推奨します。`
      : '提供された製品仕様（素材・年齢層・用途等）に基づき、高精度な総合コンプライアンス診断を実施しました。';

  if (hasChapterMismatch && mismatchWarning) {
    impactExplanation = `${mismatchWarning} ${impactExplanation}`;
  }

  return {
    product: {
      name: productName,
      description: effectiveDescription,
      url: options.url,
      detectedCategory: detectedCategory || productCategory,
      targetAge,
      material,
      htsCode,
    },
    overallStatus,
    summary,
    inputCompleteness,
    missingInputs: subMissingInputs.length > 0 ? subMissingInputs : undefined,
    clarifyingQuestions: subClarifyingQuestions.length > 0 ? subClarifyingQuestions : undefined,
    impactExplanation,
    htsVerification,
    htsPrediction,
    fda: fdaResult,
    cpsc: cpscResult,
    actionPlan,
    disclaimer: DISCLAIMER_COMPLIANCE,
  };
}
