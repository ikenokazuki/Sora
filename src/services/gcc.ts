// 米国CPSC 一般適合証明書 (GCC: 16 CFR Part 1110) の作成と、通関の保留に出す一式。
// 証明書に載せる値は呼び出し側が渡したものだけ。規則の判断は同梱の CPSC の一覧と HTS の桁で行い、外には取りに行かない
import { createHash } from 'node:crypto';
import { errorMessage } from '../errors.js';
import { GccPartySchema } from '../types.js';
import { type GccRenderItem, NO_STATE, renderGccPackageHtml } from './gcc_html.js';
import { BATTERY_CONTRADICTION, type SECTION_1610_1_D, TradeInputError, checkCpscCertificate, checkFdaRegulated, findCpscListCategory, section1610cExclusionFor } from './trade.js';

export type GccIdentifierType = 'sku' | 'model' | 'gtin' | 'upc' | 'serial' | 'registered' | 'other';
export interface GccParty {
  name?: string;
  street?: string;
  city?: string;
  state?: string;
  country?: string;
  email?: string;
  phone?: string;
}
/** 商品ページから読んだ候補。証明書には載らない（呼び出し側が確かめて identifier などに入れる） */
export interface GccSuggestions {
  identifier?: string;
  identifierType?: GccIdentifierType;
  pageProductName?: string;
  brand?: string;
  /** ページにある種類（ProductGroup の hasVariant）の数 */
  variants?: number;
}
export interface GccItemInput {
  htsCode: string;
  productName: string;
  identifier?: string;
  identifierType?: GccIdentifierType;
  brand?: string;
  description?: string;
  targetAge?: 'adult' | 'child' | 'unknown';
  material?: string;
  fabricSurface?: 'plain' | 'raised';
  fabricWeightOzPerSqYd?: number;
  hasBattery?: boolean;
  batteryType?: 'button_coin' | 'other';
  foodContact?: boolean;
  citations?: string[];
  manufacture?: GccParty & { date?: string };
  testing?: { date?: string; reportNumber?: string; parties?: GccParty[] };
  /** 商品ページ。identifier が無いときだけ読み、候補（suggestions）を返す。証明書には載せない */
  url?: string;
}
export interface GenerateGccCertificateOptions {
  items: GccItemInput[];
  certifier?: GccParty;
  recordCustodian?: GccParty;
  orderNumber?: string;
  awbNumber?: string;
  carrier?: string;
  invoiceNumber?: string;
  allowDraft?: boolean;
}
export type GccItemStatus = 'generated' | 'draft_needs_info' | 'exempt_disclaim_b' | 'exempt_no_gcc_needed' | 'cpc_required_instead';
export interface GccItemSummary {
  /** 1 始まり */
  line: number;
  status: GccItemStatus;
  htsCode: string;
  productName: string;
  identifier?: string;
  /** status が generated のときだけ */
  certificateId?: string;
  /** CPSC の一覧の完全一致の区分 */
  cpscListCategory?: string;
  /** GCC のとき */
  citations?: string[];
  /** 例 ['16 CFR 1610.1(d)(2)'] */
  testingExclusions?: string[];
  disclaimCode?: 'A' | 'B';
  /** B のとき '130.006' */
  intendedUseCode?: string;
  filingNote: string;
  /** FDA の注記（英語。表紙は同じ文を表の下に 1 回だけ出す）。FDA が関わるときだけ。適合したとは書かない */
  fdaNote?: string;
  missingFields?: string[];
  clarifyingQuestions?: string[];
  warnings?: string[];
  /** url を付けて identifier を省いた品だけ */
  suggestions?: GccSuggestions;
}
export interface GenerateGccCertificateResult {
  packageId: string;
  /** ISO 8601（UTC） */
  generatedAt: string;
  mode: 'single_product' | 'order_package';
  overallStatus: 'ready' | 'exempt' | 'partial_or_draft' | 'cpc_required';
  counts: { totalItems: number; gccGenerated: number; draftNeedsInfo: number; disclaimBExempt: number; noGccNeeded: number; cpcRequired: number };
  /** certifier.* と recordCustodian.*（GCC の品があるときだけ） */
  missingFields?: string[];
  items: GccItemSummary[];
  packageHtml: string;
  disclaimer: string;
}

/** GCC に必要な記録が足りないとき（allowDraft: false の既定）。REST では 422 にする */
export class TradeGccIncompleteError extends Error {
  readonly code = 'MISSING_REQUIRED_GCC_FIELDS';
  constructor(
    message: string,
    readonly details: {
      missingFields: string[];
      items: Array<Pick<GccItemSummary, 'line' | 'htsCode' | 'productName' | 'identifier' | 'missingFields' | 'clarifyingQuestions' | 'suggestions' | 'warnings'>>;
    },
  ) {
    super(message);
    this.name = 'TradeGccIncompleteError';
  }
}

const DISCLAIMER_GCC = '参考の出力で、法的助言ではありません。証明書の中身は証明者（輸入者など）の責任です（16 CFR 1110.15）。偽りの証明書は CPSA 第19条の違反になります。';

const FILING_NOTE = {
  generated: 'ACE の CPSC の PGA Message Set で GCC のデータを送ります（Full PGA Message Set か Product Registry の参照。16 CFR 1110.13(a)(1)）。郵便（EMS など）で送る品は、着く前に Product Registry に入れます。',
  draft: '下書きです。missingFields を記録から埋めるまで ACE に送らないでください。',
  disclaimB: 'ACE で Disclaim B と Intended Use Code 130.006 を送ります（16 CFR 1610.1(d) の免除の大人の衣料。81 FR 12587）。',
  disclaimA: 'ACE で Disclaim A を送れます（任意）。Disclaimer には Intended Use Code が要ります（CATAIR の Disclaimer PG01 の Note 1。CBP の Appendix R から選ぶ。例 130.XXX の Consumer Use as a Non-Food Product、ただし 130.001-005 は除く）。',
  notListed: 'CPSC の一覧に無い HTS コードで、証明者は当てはまる規則が無いとしています。CPSC のデータは送りません（規則が当てはまるなら GCC が要ります）。',
  cpc: '12 歳以下の子供用なので CPC が要ります（このツールは CPC を作りません）。',
};
const Q_AGE = 'この製品は 12 歳以下の子供向けですか？子供向けなら GCC ではなく CPC（16 CFR 1107）が要ります。';
const Q_BATTERY = '電池の種類を batteryType に入れてください（button_coin: ボタン・コイン電池、other: それ以外）。button_coin なら 16 CFR 1263 が当てはまります。';
const qRequired = (rules: string[]) =>
  `citations に ${rules.map((p) => `16 CFR ${p}`).join('・')} がありません。試験報告書で確かめて citations に足してください（ボタン・コイン電池は 16 CFR 1263、衣料は 16 CFR 1610）。`;

const PARTY_FIELDS = ['name', 'street', 'city', 'state', 'country', 'email', 'phone'] as const;
const FABRIC_INPUTS = ['material', 'fabricSurface', 'fabricWeightOzPerSqYd'];
const htsDigits = (code: string) => code.replace(/\D/g, '');
const cfrPart = (citation: string) => citation.match(/16\s*C\.?F\.?R\.?\s*(?:Part\s*|§\s*)?(\d{3,4})/i)?.[1];
const partyValues = (party?: GccParty) => PARTY_FIELDS.map((f) => party?.[f] ?? '');
const hash12 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12).toUpperCase();

/** 文字列の前後の空白を、入れ子の中まで除く */
function trimDeep<T>(value: T): T {
  if (typeof value === 'string') return value.trim() as T;
  if (Array.isArray(value)) return value.map(trimDeep) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimDeep(v)])) as T;
  return value;
}

// 見本・仮置きと見なすのは、値全体が見本の語のとき・型の差し込み口・予約された名前（RFC 2606・6761）・電話でない数字だけ。語が値の一部にあるだけ（"Sample & Co. GmbH"）は通す
const PLACEHOLDER_WORD = /^(?:n\/a|none|null|nil|undefined|unknown|tbd|tba|todo|sample|dummy|placeholder|test|example|x+|-+|\?+|\.{2,}|…+)$/i;
const PLACEHOLDER_WORD_JA = /^(?:未定|不明|未入力|仮|仮置き|仮入力|ダミー|サンプル|なし|無し)$/;
const TEMPLATE_SLOT = /\[(?:missing|insert|required|tbd|todo|your)\b|\{\{[^{}]*\}\}/i; // [^}] は {{ の繰り返しで二乗の時間になる
const RESERVED_DOMAIN = /(?:^|\.)example\.(?:com|net|org)$|\.(?:example|invalid|localhost)$/;
const FAKE_EMAIL = /^(?:test|sample|dummy|fake|example)@(?:test|sample|dummy|fake|example)(?:\.|$)/i;

function isPlaceholderValue(value: string, kind?: 'email' | 'phone' | 'state'): boolean {
  if (kind === 'state' && NO_STATE.test(value)) return false; // 州・県が無い国（シンガポールなど）の答え
  if (PLACEHOLDER_WORD.test(value) || PLACEHOLDER_WORD_JA.test(value) || TEMPLATE_SLOT.test(value)) return true;
  if (kind === 'email') return RESERVED_DOMAIN.test(value.slice(value.lastIndexOf('@') + 1).toLowerCase()) || FAKE_EMAIL.test(value);
  if (kind === 'phone') {
    const digits = value.replace(/\D/g, '');
    return digits.length < 7 || /(\d)\1{6}/.test(digits);
  }
  return false;
}

/** YYYY-MM か YYYY-MM-DD で、実在し、地球上でいちばん進んだ今日（UTC+14）より先でない */
function isValidGccDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(date);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined];
  if (year < 1900 || month < 1 || month > 12) return false;
  if (day !== undefined) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return false;
  }
  return date <= new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, date.length);
}

/**
 * 呼び出し側が渡した文字列の確かめ（商品ページを読む前に行う）。見本・仮置きに見える値は 400、日付の形と未来の日付も 400。
 * サーバーの SORA_GCC_*（運営者の設定）と、注文の番号は見ない
 */
function assertGccInputs(options: GenerateGccCertificateOptions): void {
  type Kind = 'email' | 'phone' | 'state';
  type Check = [path: string, value: string | undefined, kind?: Kind];
  const party = (prefix: string, p?: GccParty): Check[] => PARTY_FIELDS.map((f) => [`${prefix}.${f}`, p?.[f], f === 'email' || f === 'phone' || f === 'state' ? f : undefined]);
  const dates: Check[] = [];
  if (options.items.filter((item) => item.url).length > 5) throw new TradeInputError('url を付けられる品は 1 回に 5 件までです', 'INVALID_INPUT');
  const checks: Check[] = [...party('certifier', options.certifier), ...party('recordCustodian', options.recordCustodian)];
  options.items.forEach((item, i) => {
    const at = `items[${i}]`;
    if (item.hasBattery === false && item.batteryType === 'button_coin') {
      throw new TradeInputError(`${at}: ${BATTERY_CONTRADICTION}`, 'INVALID_INPUT');
    }
    const manufactureDate: Check = [`${at}.manufacture.date`, item.manufacture?.date];
    const testingDate: Check = [`${at}.testing.date`, item.testing?.date];
    dates.push(manufactureDate, testingDate);
    checks.push(
      [`${at}.productName`, item.productName],
      [`${at}.identifier`, item.identifier],
      [`${at}.brand`, item.brand],
      [`${at}.description`, item.description],
      [`${at}.material`, item.material],
      ...(item.citations ?? []).map((c, k): Check => [`${at}.citations[${k}]`, c]),
      ...party(`${at}.manufacture`, item.manufacture),
      manufactureDate,
      testingDate,
      [`${at}.testing.reportNumber`, item.testing?.reportNumber],
      ...(item.testing?.parties ?? []).flatMap((p, j) => party(`${at}.testing.parties[${j}]`, p)),
    );
  });
  // 空の値は「足りない」であって、見本ではない
  const offending = (list: Check[], bad: (value: string, kind?: Kind) => boolean) => list.filter(([, value, kind]) => value?.trim() && bad(value.trim(), kind)).map(([path]) => path);
  const placeholders = offending(checks, isPlaceholderValue);
  if (placeholders.length > 0) {
    throw new TradeInputError(`GCC の項目に見本・仮置きに見える値があります（${placeholders.join(', ')}）。記録の値だけを渡してください。`, 'UNVERIFIED_PLACEHOLDER_INPUT');
  }
  const badDates = offending(dates, (value) => !isValidGccDate(value));
  if (badDates.length > 0) {
    throw new TradeInputError(`日付は YYYY-MM か YYYY-MM-DD の、実在する未来でない日にしてください（${badDates.join(', ')}）。`, 'INVALID_INPUT');
  }
}

/** 呼び出し側の値に中身があればそれを丸ごと、無ければサーバーの環境変数を丸ごと使う（項目ごとに混ぜない）。環境変数が読めないときは、証明書に要るときだけエラーにする */
function resolveParty(party: GccParty | undefined, envName: 'SORA_GCC_CERTIFIER' | 'SORA_GCC_CUSTODIAN', needed: boolean): GccParty | undefined {
  const given = trimDeep(party);
  if (given && PARTY_FIELDS.some((f) => given[f])) return given;
  const raw = process.env[envName]?.trim();
  if (!raw) return undefined;
  try {
    return trimDeep(GccPartySchema.parse(JSON.parse(raw)));
  } catch {
    if (!needed) return undefined;
    throw new Error(`${envName} を読めません（JSON のオブジェクトで name・street・city・state・country・email・phone）`);
  }
}

/**
 * FDA の注記（英語）。HTS と foodContact から言えることだけを書き、FDA への適合は書かない。
 * 食品接触の用途が未指定の食器コードと、章からの推定は、そう書く。表紙は同じ文を表の下に 1 回だけ出す
 */
function fdaNoteFor(htsCode: string, foodContact?: boolean): string | undefined {
  const fda = checkFdaRegulated({ htsCode, foodContact });
  if (fda.fdaRegulatedLikely === true) {
    if (fda.possiblePrograms.includes('FCS') || fda.fdFlag === 'FD1') {
      return foodContact === undefined
        ? 'FDA FD1: food contact use not stated — if it touches food, no Prior Notice (21 CFR 1.276(b)(5)(i)(A)); if not, file the FDA disclaimer.'
        : 'FDA FD1: no Prior Notice (21 CFR 1.276(b)(5)(i)(A)); the MID needs the manufacturer’s name and address.';
    }
    const flag = `FDA ${fda.fdFlag} (${fda.possiblePrograms.join(', ')})`;
    if (fda.missingInputs?.includes('foodUsage')) return `${flag}: food use not stated.`;
    return fda.confidence === 'chapter-level-estimate'
      ? `${flag}: estimated from the HTS chapter, confirm the item.${fda.priorNoticeRequired ? ' If it is food, Prior Notice is required before arrival.' : ''}`
      : `${flag}${fda.priorNoticeRequired ? ' — Prior Notice is required before arrival.' : ''}`;
  }
  if (fda.fdaRegulatedLikely === false && fda.fdFlag === 'FD1') return 'FDA FD1: not for food contact — file the FDA disclaimer.';
}

const missingPartyFields = (prefix: string, party?: GccParty) => PARTY_FIELDS.filter((f) => !party?.[f]).map((f) => `${prefix}.${f}`);

/** 16 CFR 1110.11(a)(1)・(5)・(6) の順に足りない項目を挙げる */
function missingItemRecords(input: GccItemInput, needsTestRecord: boolean): string[] {
  const missing: string[] = [];
  if (!input.identifier) missing.push('identifier');
  if (!input.manufacture?.date) missing.push('manufacture.date');
  missing.push(...missingPartyFields('manufacture', input.manufacture));
  if (needsTestRecord) {
    const parties = input.testing?.parties ?? [];
    if (!input.testing?.date) missing.push('testing.date');
    if (parties.length === 0) missing.push('testing.parties');
    for (const [j, party] of parties.entries()) missing.push(...missingPartyFields(`testing.parties[${j}]`, party));
  }
  return missing;
}

/** 判定の結果。gcc が true の品（GCC の道）は、証明者・記録の担当の欠けも見てから status と filingNote が決まる */
type ItemDecision = GccRenderItem & { gcc: boolean };

// --- 商品ページ（url）からの候補。値は suggestions と質問にだけ入れ、証明書にも HTML にも載せない ---
type Json = Record<string, any>;
const asList = (value: unknown): Json[] => (Array.isArray(value) ? value : [value]).filter((v): v is Json => !!v && typeof v === 'object');
/** ページの値は、空白と制御文字を 1 つの空白にまとめ、長さを切って文字列にする（ページが応答を膨らませない。質問の文に入れる値なので、改行などは残さない） */
const pageText = (value: unknown, max = 200) => (typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, max) : '') || undefined;
const ID_MAX = 64;
const brandOf = (o: Json) => pageText(typeof o.brand === 'object' ? o.brand?.name : o.brand);

function identifierOf(o: Json): Pick<GccSuggestions, 'identifier' | 'identifierType'> {
  const offers = asList(o.offers);
  const sku = pageText(o.sku, ID_MAX) ?? (offers.length === 1 ? pageText(offers[0].sku, ID_MAX) : undefined);
  if (sku) return { identifier: sku, identifierType: 'sku' };
  const gtin = ['gtin13', 'gtin12', 'gtin14', 'gtin8', 'gtin'].map((k) => pageText(o[k], ID_MAX)).find(Boolean);
  if (gtin) return { identifier: gtin, identifierType: 'gtin' };
  const mpn = pageText(o.mpn, ID_MAX);
  return mpn ? { identifier: mpn, identifierType: 'model' } : {};
}

/**
 * scrape の jsonLd（配列と、その中の @graph を 1 段）の最初の ProductGroup・Product から候補を読む。
 * 種類が 2 つ以上あるときは、URL の ?variant= と完全に同じ種類だけを選ぶ（"12" は "123" に当てない）。選べなければ番号は出さない
 */
function readProductSuggestions(jsonLd: unknown, pageUrl: string, wantedVariant: string | null): GccSuggestions | undefined {
  const nodes = asList(Array.isArray(jsonLd) ? jsonLd.flat() : []).flatMap((n) => [n, ...asList(n['@graph'])]);
  const product = nodes.find((n) => [n['@type']].flat().some((t) => t === 'ProductGroup' || t === 'Product'));
  if (!product) return undefined;
  const variants = asList(product.hasVariant);
  const isWanted = (variant: Json) =>
    [variant['@id'], variant.url, ...asList(variant.offers).map((o) => o.url)].some((ref) => {
      if (typeof ref !== 'string' || ref === '' || ref.startsWith('#')) return false; // 自分の URL を引き継ぐ参照は、どの種類にも当たってしまう
      try {
        return new URL(ref, pageUrl).searchParams.get('variant') === wantedVariant;
      } catch {
        return false;
      }
    });
  const picked = variants.length === 0 ? product : wantedVariant !== null ? variants.find(isWanted) : variants.length === 1 ? variants[0] : undefined;
  const suggestions: GccSuggestions = {
    ...(picked ? identifierOf(picked) : {}),
    pageProductName: pageText(picked?.name) ?? pageText(product.name),
    brand: (picked && brandOf(picked)) ?? brandOf(product),
    variants: variants.length || undefined,
  };
  return Object.values(suggestions).some((v) => v !== undefined) ? suggestions : undefined;
}

/** ページを読む時間の上限（1 品あたりの全体。scrape の timeoutMs は転送 1 回ごとなので、リダイレクトをたどる間は超える） */
const PAGE_READ_MS = 10_000;

/** GCC を出せる品（下書き）で、identifier が無く url がある品の商品ページを、ブラウザなしで読む。読めなくても品は進める（warnings に書く） */
async function readItemPage({ input, summary }: ItemDecision): Promise<void> {
  if (!input.url || input.identifier || summary.status !== 'draft_needs_info') return;
  const warn = (text: string) => {
    summary.warnings = [...(summary.warnings ?? []), text];
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { scrapeUrl } = await import('../scraper.js'); // 使う呼び出しのときだけ読み込む
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('10 秒以内に読めませんでした')), PAGE_READ_MS);
    });
    const page = await Promise.race([scrapeUrl({ url: input.url, fastOnly: true, timeoutMs: PAGE_READ_MS, formats: ['jsonLd'], onlyMainContent: true, maxChars: 2_000 }), deadline]);
    // 4xx・5xx のページ（scrape は投げずに unavailable で返す）の構造化データは、商品のものとは限らない
    if (page.contentStatus === 'unavailable') return warn('商品ページを読めませんでした（HTTP エラーか、本文のないページです）');
    const wantedVariant = new URL(input.url).searchParams.get('variant');
    const suggestions = readProductSuggestions(page.jsonLd, page.url, wantedVariant);
    if (!suggestions) return warn('商品ページに商品データ（JSON-LD）が見つかりませんでした');
    summary.suggestions = suggestions;
    const question = suggestions.identifier
      ? `商品ページの番号 ${suggestions.identifier}（${suggestions.identifierType}）を使うなら、出荷する品と同じか確かめてから identifier に入れてください。`
      : suggestions.variants && suggestions.variants >= 2
        ? wantedVariant !== null
          ? `商品ページに ${suggestions.variants} 種類ありますが、URL の ?variant= に当たる種類がありません。出荷する種類の番号を identifier に入れてください。`
          : `商品ページに ${suggestions.variants} 種類あります。出荷する種類の番号を identifier に入れてください（URL に ?variant= を付けると候補を出せます）。`
        : undefined;
    if (question) summary.clarifyingQuestions = [...(summary.clarifyingQuestions ?? []), question];
  } catch (err) {
    warn(`商品ページを読めませんでした（${(errorMessage(err) || String(err)).slice(0, 200)}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 1 品の判定（16 CFR 1110.11 と CPSC の一覧の桁だけで決める。証明書の規則は呼び出し側の citations だけ） */
async function decideItem(item: GccItemInput, index: number): Promise<ItemDecision> {
  const input = trimDeep(item);
  const digits = htsDigits(input.htsCode);
  if (digits.length !== 10) throw new TradeInputError(`items[${index}].htsCode は 10 桁の HTS コードにしてください`, 'INVALID_INPUT');
  if (!input.productName) throw new TradeInputError(`items[${index}].productName を入れてください`, 'INVALID_INPUT');
  if (input.citations?.some((c) => !c)) throw new TradeInputError(`items[${index}].citations に空の文字列があります`, 'INVALID_INPUT');

  const targetAge = input.targetAge ?? 'unknown';
  const cpsc = await checkCpscCertificate({
    htsCode: digits,
    targetAge,
    material: input.material,
    hasBattery: input.hasBattery,
    batteryType: input.batteryType,
    fabricSurface: input.fabricSurface,
    fabricWeightOzPerSqYd: input.fabricWeightOzPerSqYd,
  });
  const category = findCpscListCategory(digits);
  const cEx = section1610cExclusionFor(digits);
  // 電池の種類で 16 CFR 1263 が当たるかが決まるので、分かるまで免除・規則なしの答えを出さない
  const askBattery = input.hasBattery === true && !input.batteryType;
  const fdaNote = fdaNoteFor(digits, input.foodContact);
  const summaryBase = {
    line: index + 1,
    htsCode: input.htsCode,
    productName: input.productName,
    ...(input.identifier ? { identifier: input.identifier } : {}),
    ...(category ? { cpscListCategory: category } : {}),
    ...(fdaNote ? { fdaNote } : {}),
  };
  const decided = (summary: Omit<GccItemSummary, keyof typeof summaryBase>, extra: Partial<ItemDecision> = {}): ItemDecision => ({
    input,
    gcc: false,
    summary: { ...summaryBase, ...summary },
    ...extra,
  });
  const draft = (missingFields: string[], clarifyingQuestions: string[]) =>
    decided({ status: 'draft_needs_info', filingNote: FILING_NOTE.draft, missingFields, clarifyingQuestions });
  /** GCC の道。証明者の欠けは品に入れず、status は呼び出し元で決める */
  const gccPath = (rec: { citations?: string[]; testingExclusions?: string[]; testingNotNeeded?: boolean; missingFields: string[]; clarifyingQuestions?: string[] }) => {
    const { citations, testingExclusions } = rec;
    const missingFields = [...(askBattery ? ['batteryType'] : []), ...rec.missingFields];
    const clarifyingQuestions = [...(rec.clarifyingQuestions ?? []), ...(askBattery ? [Q_BATTERY] : [])];
    return decided(
      {
        status: 'draft_needs_info',
        filingNote: FILING_NOTE.draft,
        ...(citations ? { citations } : {}),
        ...(testingExclusions?.length ? { testingExclusions } : {}),
        ...(missingFields.length ? { missingFields } : {}),
        ...(clarifyingQuestions.length ? { clarifyingQuestions } : {}),
      },
      { gcc: true, ...(rec.testingNotNeeded ? { testingNotNeeded: true } : {}) },
    );
  };

  // 12 歳以下は CPC（このツールの対象外）
  if (targetAge === 'child' || cpsc.certificateType === 'CCC') {
    return decided({ status: 'cpc_required_instead', filingNote: FILING_NOTE.cpc });
  }
  // 年齢が分からなければ、ここで聞いて止める
  if (targetAge === 'unknown') return draft(['targetAge'], [Q_AGE]);

  // Sora が当てはまると判断する規則（16 CFR 1610.1(c) の見出しは条件で決まるので 1610 を求めない）
  const cfrs = cpsc.applicableRegulations.map((r) => r.cfr);
  const required = [
    ...(cfrs.some((c) => c.startsWith('16 CFR 1263')) ? ['1263'] : []),
    ...(cfrs.some((c) => c.startsWith('16 CFR 1610')) && !cEx ? ['1610'] : []),
  ];

  if (input.citations === undefined) {
    if (cpsc.certificateRequired === false && cpsc.testingExemption?.enforcementDiscretion) {
      if (askBattery) return draft(['batteryType'], [Q_BATTERY]);
      const citation = cpsc.testingExemption.citation as keyof typeof SECTION_1610_1_D;
      return decided({ status: 'exempt_disclaim_b', disclaimCode: 'B', intendedUseCode: '130.006', filingNote: FILING_NOTE.disclaimB }, { exemption: { citation } });
    }
    const references = cfrs.filter((c) => !c.startsWith('CPSC HTS Guidance List') && c !== '個別規格要確認');
    const qCitations =
      'この製品に当てはまる CPSC の規則を、試験報告書のとおり citations に 1 つずつ入れてください（例: "16 CFR 1203"）。当てはまる規則が無いと確かめたら citations: [] にします（CPSC の一覧のコードなら Disclaim A）。' +
      (required.length ? ` Sora は ${required.map((p) => `16 CFR ${p}`).join('・')} が当てはまると判断しています。` : '') +
      (references.length ? ` 参考: ${references.join('・')}。` : '') +
      (cEx ? ` ${cEx.citation} の条件（${cEx.text}）に当たるなら 16 CFR 1610 は当てはまりません。` : '');
    return gccPath({
      missingFields: [
        'citations',
        ...(cpsc.missingInputs ?? []).filter((m) => FABRIC_INPUTS.includes(m)),
        ...missingItemRecords(input, true),
      ],
      clarifyingQuestions: [qCitations, ...(cpsc.clarifyingQuestions ?? [])],
    });
  }

  if (input.citations.length === 0) {
    if (required.length > 0) return draft([...(askBattery ? ['batteryType'] : []), 'citations'], [qRequired(required), ...(askBattery ? [Q_BATTERY] : [])]);
    if (askBattery) return draft(['batteryType'], [Q_BATTERY]);
    return decided(
      {
        status: 'exempt_no_gcc_needed',
        ...(category
          ? {
              disclaimCode: 'A' as const,
              warnings: [`HTS ${input.htsCode} は CPSC の一覧（${category}）にあり、規則の対象になりうる品目です。当てはまる規則が無いことを確かめてから Disclaim A を送ってください。`],
              filingNote: FILING_NOTE.disclaimA,
            }
          : { filingNote: FILING_NOTE.notListed }),
      },
      cEx ? { exclusion1610c: cEx } : {},
    );
  }

  const parts = new Set(input.citations.map(cfrPart));
  const uncited = required.filter((p) => !parts.has(p) && !(p === '1263' && category === 'Toys' && parts.has('1250')));
  const exemption = cpsc.testingExemption;
  const testingExclusions = exemption?.exempt && exemption.citation?.startsWith('16 CFR 1610.1(d)') && parts.has('1610') ? [exemption.citation] : [];
  const needsTestRecord = input.citations.some((c) => !(cfrPart(c) === '1610' && testingExclusions.length > 0));
  return gccPath({
    citations: input.citations,
    testingExclusions,
    testingNotNeeded: !needsTestRecord,
    missingFields: [...(uncited.length ? ['citations'] : []), ...missingItemRecords(input, needsTestRecord)],
    clarifyingQuestions: uncited.length ? [qRequired(uncited)] : undefined,
  });
}

/**
 * 明示された記録から、16 CFR 1110.11 の GCC と通関の保留に出す一式（JSON の要約と印刷用の HTML）を作る。
 * HTS は推測せず、CPSC の一覧と HTS の桁だけで判断する。
 */
export async function generateGccCertificate(options: GenerateGccCertificateOptions): Promise<GenerateGccCertificateResult> {
  assertGccInputs(options);
  const decisions: ItemDecision[] = [];
  for (let i = 0; i < options.items.length; i++) decisions.push(await decideItem(options.items[i], i));
  await Promise.all(decisions.map(readItemPage));

  const hasGcc = decisions.some((d) => d.gcc);
  const certifier = resolveParty(options.certifier, 'SORA_GCC_CERTIFIER', hasGcc);
  const recordCustodian = resolveParty(options.recordCustodian, 'SORA_GCC_CUSTODIAN', hasGcc);
  const missingFields = hasGcc ? [...missingPartyFields('certifier', certifier), ...missingPartyFields('recordCustodian', recordCustodian)] : [];

  const order = trimDeep({ orderNumber: options.orderNumber, awbNumber: options.awbNumber, carrier: options.carrier, invoiceNumber: options.invoiceNumber });
  for (const decision of decisions) {
    if (!decision.gcc || decision.summary.missingFields?.length || missingFields.length) continue;
    const { input, summary } = decision;
    summary.status = 'generated';
    summary.filingNote = FILING_NOTE.generated;
    summary.certificateId = `GCC-${hash12(
      JSON.stringify([
        htsDigits(input.htsCode),
        input.productName,
        input.identifierType ?? 'sku',
        input.identifier,
        input.brand ?? '',
        input.description ?? '',
        summary.citations,
        summary.testingExclusions,
        partyValues(certifier),
        partyValues(recordCustodian),
        [input.manufacture?.date ?? '', ...partyValues(input.manufacture)],
        [input.testing?.date ?? '', input.testing?.reportNumber ?? '', (input.testing?.parties ?? []).map(partyValues)],
      ]),
    )}`;
  }

  const summaries = decisions.map((d) => d.summary);
  const count = (status: GccItemStatus) => summaries.filter((s) => s.status === status).length;
  const counts = {
    totalItems: summaries.length,
    gccGenerated: count('generated'),
    draftNeedsInfo: count('draft_needs_info'),
    disclaimBExempt: count('exempt_disclaim_b'),
    noGccNeeded: count('exempt_no_gcc_needed'),
    cpcRequired: count('cpc_required_instead'),
  };

  if (!options.allowDraft && counts.draftNeedsInfo > 0) {
    const drafts = summaries.filter((s) => s.status === 'draft_needs_info');
    const allMissing = [...new Set([...drafts.flatMap((s) => s.missingFields ?? []), ...missingFields])];
    throw new TradeGccIncompleteError(`GCC に必要な記録が足りません（${allMissing.join(', ')}）。記録の値を渡してください。下書きを見るには allowDraft: true。`, {
      missingFields,
      items: drafts.map(({ line, htsCode, productName, identifier, missingFields: itemMissing, clarifyingQuestions, suggestions, warnings }) => ({
        line,
        htsCode,
        productName,
        ...(identifier ? { identifier } : {}),
        ...(itemMissing ? { missingFields: itemMissing } : {}),
        ...(clarifyingQuestions ? { clarifyingQuestions } : {}),
        ...(suggestions ? { suggestions } : {}),
        ...(warnings ? { warnings } : {}),
      })),
    });
  }

  const packageId = `PKG-${hash12(
    JSON.stringify([
      decisions.map((d) => d.summary.certificateId ?? `${d.summary.status}:${htsDigits(d.input.htsCode)}:${d.summary.productName}:${d.summary.identifier ?? ''}`),
      order.orderNumber ?? '',
      order.awbNumber ?? '',
      order.carrier ?? '',
      order.invoiceNumber ?? '',
    ]),
  )}`;
  const generatedAt = new Date().toISOString();
  const mode = summaries.length > 1 || Object.values(order).some(Boolean) ? 'order_package' : 'single_product';
  const overallStatus = counts.cpcRequired > 0 ? 'cpc_required' : counts.draftNeedsInfo > 0 ? 'partial_or_draft' : counts.gccGenerated > 0 ? 'ready' : 'exempt';

  return {
    packageId,
    generatedAt,
    mode,
    overallStatus,
    counts,
    ...(missingFields.length ? { missingFields } : {}),
    items: summaries,
    packageHtml: renderGccPackageHtml({ packageId, generatedAt, mode, order, certifier, recordCustodian, items: decisions }),
    disclaimer: DISCLAIMER_GCC,
  };
}
