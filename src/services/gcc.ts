import {
  type CheckFdaRegulatedResult,
  type CheckProductComplianceResult,
  type CpscCertificateCheckResult,
  TradeInputError,
  checkProductCompliance,
} from './trade.js';
import { buildOrderCoverSheet, escapeHtml, formatPartyText, renderGccSectionHtml, wrapStandalonePrintHtml } from './gcc_html.js';

export interface GccIncompleteItemSummary {
  lineNumber: number;
  sku?: string;
  productName?: string;
  htsCode?: string;
  citations: string[];
  missingFields: string[];
}

/** GCC発行対象の明細に法定必須項目が不足している場合のエラー（allowDraft: false 既定時）。REST では 422 にする。 */
export class TradeGccIncompleteError extends Error {
  readonly code = 'MISSING_REQUIRED_GCC_FIELDS';
  readonly missingFields: string[];
  readonly items: GccIncompleteItemSummary[];
  constructor(message: string, missingFields: string[], items: GccIncompleteItemSummary[]) {
    super(message);
    this.name = 'TradeGccIncompleteError';
    this.missingFields = missingFields;
    this.items = items;
  }
}

export interface GccPartyContact {
  name?: string;
  address?: string;
  email?: string;
  phone?: string;
}

export interface GccResolvedPartyContact {
  name: string;
  address: string;
  email?: string;
  phone?: string;
}

export interface GccManufactureInfo {
  /** 製造年月 (YYYY-MM または YYYY-MM-DD, 16 CFR § 1110.11(a)(5)) */
  date?: string;
  /** 製造都市・省州名 (City / State or Province, 16 CFR § 1110.11(a)(5)) */
  city?: string;
  /** 製造国 (Country, 例: "Japan", "China", "Vietnam", 16 CFR § 1110.11(a)(5)) */
  country?: string;
  /** 製造工場名（ACE eFiling / FDA MID でも利用される実務項目） */
  manufacturerName?: string;
}

export interface GccTestingRecord {
  /** 試験実施日または期間 (YYYY-MM-DD / YYYY-MM, 16 CFR § 1110.11(a)(6)) */
  date?: string;
  /** 試験実施場所（都市・国, 16 CFR § 1110.11(a)(6)） */
  location?: string;
  /** 試験機関名（第三者試験機関または合理的試験プログラム実施機関, 16 CFR § 1110.11(a)(7)） */
  laboratoryName?: string;
  laboratoryAddress?: string;
  laboratoryPhone?: string;
  reportNumber?: string;
}

export interface GccStatutoryFields {
  /** (1) Identification of the product covered by this certificate */
  productIdentification: {
    productName: string;
    sku?: string;
    brand?: string;
    modelOrBatch?: string;
    description?: string;
    htsCode?: string;
  };
  /** (2) Citation to each CPSC product safety regulation to which this product is being certified */
  citations: string[];
  /** (3) Identification of the domestic manufacturer, importer, or foreign direct-to-consumer certifier (16 CFR § 1110.7 / § 1110.11(a)(3)) */
  certifier: GccResolvedPartyContact | null;
  /** (4) Contact information for the individual maintaining records of test results */
  recordCustodian: GccResolvedPartyContact | null;
  /** (5) Date and place (city and country / administrative region) where this product was manufactured */
  manufactureDateAndPlace: {
    date: string | null;
    city: string | null;
    country: string | null;
    manufacturerName?: string;
  };
  /** (6) Date and place where this product was tested for compliance with the regulation(s) cited above */
  testingDateAndPlace: {
    exemptFromTesting: boolean;
    exemptionCitation?: string;
    exemptionReason?: string;
    date: string | null;
    location: string | null;
    reportNumber?: string;
  };
  /** (7) Identification of any third-party laboratory or testing entity on whose testing the certificate depends */
  testingLaboratory: {
    notApplicableReason?: string;
    name: string | null;
    address?: string;
    phone?: string;
  };
}

export interface GccAceFilingGuidance {
  eFilingRequired: boolean;
  certificateType: 'GCC' | 'CCC' | 'none' | 'unknown';
  pgaAgency: 'CPSC';
  disclaimCode?: 'A' | 'B';
  intendedUseCode?: string;
  filingInstruction: string;
  fdaNote?: string;
}

export type GccItemStatus =
  | 'generated'
  | 'draft_needs_info'
  | 'exempt_disclaim_b'
  | 'exempt_no_gcc_needed'
  | 'cpc_required_instead';

export interface GccCertificateItemResult {
  lineNumber: number;
  sku?: string;
  productName?: string;
  htsCode?: string;
  status: GccItemStatus;
  aceFilingGuidance: GccAceFilingGuidance;
  statutoryFields?: GccStatutoryFields;
  warnings?: string[];
  missingFields: string[];
  clarifyingQuestions?: string[];
  compliance: CheckProductComplianceResult;
  documentTitle?: string;
  certificateMarkdown?: string;
  certificateHtml?: string;
}

// ==========================================
// 5. 米国CPSC 一般適合証明書 (GCC: 16 CFR Part 1110) 自動生成 & 通関保留パッケージ出力
// ==========================================

export interface GccOrderItemInput {
  url?: string;
  productName?: string;
  sku?: string;
  brand?: string;
  modelOrBatch?: string;
  description?: string;
  htsCode?: string;
  targetAge?: 'adult' | 'child' | 'unknown';
  material?: string;
  productCategory?: string;
  foodContact?: boolean;
  hasBattery?: boolean;
  batteryType?: 'button_coin' | 'other';
  fabricSurface?: 'plain' | 'raised';
  fabricWeightOzPerSqYd?: number;
  certifier?: GccPartyContact;
  recordCustodian?: GccPartyContact;
  manufacture?: GccManufactureInfo;
  testing?: GccTestingRecord;
}

export interface GenerateGccCertificateOptions extends GccOrderItemInput {
  /** EC注文番号（例: Shopify注文番号 "#10492"）。発送後の配送会社保留（AWB照会）パッケージ出力時に使用 */
  orderNumber?: string;
  /** 航空貨物運送状番号・追跡番号（FedEx / DHL / UPS 等の AWB 番号） */
  awbNumber?: string;
  /** 配送会社名（例: "FedEx", "DHL Express", "UPS"） */
  carrier?: string;
  /** コマーシャルインボイス番号 */
  invoiceNumber?: string;
  /** 法定必須レコード不足時にエラー停止せず未完成ドラフト出力を許可するか（デフォルト: false＝不足時は TradeGccIncompleteError） */
  allowDraft?: boolean;
  /** 複数SKU注文・インボイス一括作成時の明細配列（1〜50件）。省略時はトップレベルの単一商品情報を処理 */
  items?: GccOrderItemInput[];
}

export interface GenerateGccCertificateResult {
  certificateId: string;
  generatedAt: string;
  mode: 'single_product' | 'order_package';
  orderContext?: {
    orderNumber?: string;
    awbNumber?: string;
    carrier?: string;
    invoiceNumber?: string;
  };
  overallStatus: 'ready' | 'exempt' | 'partial_or_draft' | 'cpc_required';
  summary: string;
  warnings?: string[];
  counts: {
    totalItems: number;
    gccGenerated: number;
    draftNeedsInfo: number;
    disclaimBExempt: number;
    disclaimAExempt: number;
    cpcRequired: number;
  };
  items: GccCertificateItemResult[];
  /** 単一商品または注文パッケージ全体の英語版 Markdown（注文時は Page 1 通関カバーシート + 個別SKU証明書） */
  packageMarkdown: string;
  /** そのまま印刷・PDF保存（@media print & SKUごとの改ページ対応）してFedEx/DHL・通関業者へ提出可能なスタンドアロンHTML */
  packageHtml: string;
  disclaimer: string;
}

const DISCLAIMER_GCC =
  '本証明書データおよび通関カバーシートは米国 16 CFR Part 1110（Certificates of Compliance）および CBP ACE CPSC PGA 申告実務に基づく出力です。' +
  '虚偽の試験日・製造所情報の記載は米国消費者製品安全法（CPSA Sec. 19）違反となります。必ず実在の試験報告書・工場情報をご確認の上で提出・電子申告してください。';

function normalizeParty(party?: GccPartyContact): GccResolvedPartyContact | null {
  if (!party) return null;
  const name = party.name?.trim();
  const address = party.address?.trim();
  const email = party.email?.trim();
  const phone = party.phone?.trim();
  if (!name && !address && !email && !phone) return null;
  return {
    name: name || '',
    address: address || '',
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  };
}

/**
 * サーバー環境変数（SORA_GCC_CERTIFIER_* / SORA_GCC_CUSTODIAN_*）からの事業者固定連絡先デフォルト解決。
 * 都度LLMにWeb上の特商法表記を探させたり翻訳ゆれ・推測値を混入させないためのマスタ設定機構。
 */
function resolveEnvGccPartyDefaults(): { certifier?: GccPartyContact; recordCustodian?: GccPartyContact } {
  const certName = process.env.SORA_GCC_CERTIFIER_NAME?.trim();
  const certAddr = process.env.SORA_GCC_CERTIFIER_ADDRESS?.trim();
  const certEmail = process.env.SORA_GCC_CERTIFIER_EMAIL?.trim();
  const certPhone = process.env.SORA_GCC_CERTIFIER_PHONE?.trim();
  const certifier =
    certName || certAddr || certEmail || certPhone
      ? {
          ...(certName ? { name: certName } : {}),
          ...(certAddr ? { address: certAddr } : {}),
          ...(certEmail ? { email: certEmail } : {}),
          ...(certPhone ? { phone: certPhone } : {}),
        }
      : undefined;

  const custName = process.env.SORA_GCC_CUSTODIAN_NAME?.trim();
  const rawCustAddr = process.env.SORA_GCC_CUSTODIAN_ADDRESS?.trim();
  const rawCustEmail = process.env.SORA_GCC_CUSTODIAN_EMAIL?.trim();
  const rawCustPhone = process.env.SORA_GCC_CUSTODIAN_PHONE?.trim();
  // 同一事業者の担当者（SORA_GCC_CUSTODIAN_NAME）が設定されている場合、住所・電話・メールは未指定分のみ CERTIFIER から継承可能
  const custAddr = rawCustAddr || (custName ? certAddr : undefined);
  const custEmail = rawCustEmail || (custName ? certEmail : undefined);
  const custPhone = rawCustPhone || (custName ? certPhone : undefined);
  const recordCustodian =
    custName || rawCustAddr || rawCustEmail || rawCustPhone
      ? {
          ...(custName ? { name: custName } : {}),
          ...(custAddr ? { address: custAddr } : {}),
          ...(custEmail ? { email: custEmail } : {}),
          ...(custPhone ? { phone: custPhone } : {}),
        }
      : undefined;

  return { certifier, recordCustodian };
}

function mergePartyContacts(...sources: Array<GccPartyContact | undefined>): GccPartyContact | undefined {
  let name: string | undefined;
  let address: string | undefined;
  let email: string | undefined;
  let phone: string | undefined;
  for (const s of sources) {
    if (!s) continue;
    if (!name && s.name?.trim()) name = s.name.trim();
    if (!address && s.address?.trim()) address = s.address.trim();
    if (!email && s.email?.trim()) email = s.email.trim();
    if (!phone && s.phone?.trim()) phone = s.phone.trim();
  }
  if (!name && !address && !email && !phone) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  };
}

const GCC_PLACEHOLDER_PATTERNS: RegExp[] = [
  /@example\.|\.example\b/i,
  /\b(?:sample|dummy|placeholder|tbd|todo|unknown|unverified|fictional|mock|fake|probably|estimated?|approx(?:imately)?)\b/i,
  /^(?:n\/?a|none|null|undefined|-+|\?+|xxx+)$/i,
  /0000-0000|\b000-0000\b/,
  /\[(?:missing|required|insert|tbd|todo)\b/i,
  /(?:サンプル|ダミー|仮置き|仮入力|未定|不明|架空)/,
];

function isPlaceholderGccValue(val?: string): boolean {
  const trimmed = val?.trim();
  if (!trimmed) return false;
  return GCC_PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

function assertNoPlaceholderGccFields(input: GccOrderItemInput, linePrefix = ''): void {
  const checks: Array<[string, string | undefined]> = [
    ['modelOrBatch', input.modelOrBatch],
    ['certifier.name', input.certifier?.name],
    ['certifier.address', input.certifier?.address],
    ['certifier.email', input.certifier?.email],
    ['certifier.phone', input.certifier?.phone],
    ['recordCustodian.name', input.recordCustodian?.name],
    ['recordCustodian.address', input.recordCustodian?.address],
    ['recordCustodian.email', input.recordCustodian?.email],
    ['recordCustodian.phone', input.recordCustodian?.phone],
    ['manufacture.date', input.manufacture?.date],
    ['manufacture.city', input.manufacture?.city],
    ['manufacture.country', input.manufacture?.country],
    ['manufacture.manufacturerName', input.manufacture?.manufacturerName],
    ['testing.date', input.testing?.date],
    ['testing.location', input.testing?.location],
    ['testing.laboratoryName', input.testing?.laboratoryName],
    ['testing.laboratoryAddress', input.testing?.laboratoryAddress],
    ['testing.laboratoryPhone', input.testing?.laboratoryPhone],
    ['testing.reportNumber', input.testing?.reportNumber],
  ];
  const bad = checks
    .filter(([, v]) => isPlaceholderGccValue(v))
    .map(([k]) => `${linePrefix}${k}`);
  if (bad.length > 0) {
    throw new TradeInputError(
      `GCC法定項目にサンプル・仮置き・不確定な値が含まれているため拒否しました (${bad.join(', ')})。15 U.S.C. § 2068(a)(6) により推測値や仮置きデータでの証明書生成は厳禁です。実在の確定レコードのみを指定してください。`,
      'UNVERIFIED_PLACEHOLDER_INPUT',
    );
  }
}

function extractCitationList(cpsc?: CpscCertificateCheckResult): string[] {
  if (!cpsc) return [];
  const citations = cpsc.applicableRegulations
    .map((r) => r.cfr)
    .filter((c) => !c.startsWith('CPSC HTS Guidance List') && c !== '個別規格要確認');
  return citations.length > 0 ? Array.from(new Set(citations)) : [];
}

function buildFdaShortNote(fda?: CheckFdaRegulatedResult, manufacture?: GccManufactureInfo): string | undefined {
  if (!fda) return undefined;
  if (fda.possiblePrograms.includes('FCS') || fda.fdFlag === 'FD1') {
    if (fda.fdaRegulatedLikely === false) {
      return 'FDA FD1 Disclaim A (Non-food-contact decorative article)';
    }
    const midReady = manufacture?.manufacturerName && manufacture?.country
      ? `Manufacturer for FDA MID: ${manufacture.manufacturerName} (${[manufacture.city, manufacture.country].filter(Boolean).join(', ')})`
      : 'Provide manufacturer full name & address on Commercial Invoice for FDA MID';
    return `FDA FCS (FD1): Exempt from Prior Notice per 21 CFR 1.276(b)(5); complies with FDA leachable lead/cadmium/FCS safety standards. ${midReady}.`;
  }
  if (fda.fdaRegulatedLikely === true) {
    return `FDA Regulated (${fda.fdFlag} - ${fda.possiblePrograms.join('/')})${fda.priorNoticeRequired ? ' — Prior Notice Required before arrival' : ''}`;
  }
  return undefined;
}

function buildSingleGccItemResult(
  lineNumber: number,
  rawInput: GccOrderItemInput,
  compliance: CheckProductComplianceResult,
): GccCertificateItemResult {
  const envParties = resolveEnvGccPartyDefaults();
  const input: GccOrderItemInput = {
    ...rawInput,
    certifier: mergePartyContacts(rawInput.certifier, envParties.certifier),
    recordCustodian: mergePartyContacts(rawInput.recordCustodian, envParties.recordCustodian),
  };
  assertNoPlaceholderGccFields(input, lineNumber > 1 ? `items[${lineNumber - 1}].` : '');

  const productName = compliance.product.name || input.productName?.trim() || undefined;
  const sku = input.sku?.trim() || undefined;
  const brand = input.brand?.trim() || undefined;
  const htsCode = compliance.product.htsCode || input.htsCode?.trim() || undefined;
  const cpsc = compliance.cpsc;
  const fdaNote = buildFdaShortNote(compliance.fda, input.manufacture);

  // Case 1: 12歳以下の子供向け製品 -> 法的にGCCは発行不可、CPC (CCC) が必要（本システムはCCC非対応のため明確な警告を返す）
  if (compliance.product.targetAge === 'child' || cpsc?.certificateType === 'CCC') {
    const cpcWarning =
      `【重要警告: 子供向け製品のためGCC発行不可（CPC / CCC 必須・本ツール非対応）】` +
      `明細 #${lineNumber}${productName ? `「${productName}」` : ''}${sku ? ` (SKU: ${sku})` : ''} は12歳以下の子供向け製品（Children’s Product）に該当するため、` +
      `一般適合証明書（GCC: 16 CFR Part 1110）の発行は法的に認められません。本ツールは大人・一般向け製品の GCC 専用であり、CPC（Children’s Product Certificate / ACEコード: CCC）の生成には対応していません。` +
      `米国へ出荷する場合は、CPSC認定第三者試験機関での試験（または 16 CFR 1610.1(d) / 1500.91 等の免除決定確認）、製品本体への恒久トラッキングラベル表示（CPSIA Sec. 103）、および別途 CPC（CCC）の発行・ACE eFiling を行ってください。`;
    const filingInstruction =
      'WARNING — DO NOT FILE A GCC (OUT OF SCOPE): Product is for children 12 years of age or younger. This system only generates adult/general-use GCCs and does NOT issue Children’s Product Certificates (CPC / CCC). You must separately obtain CPSC-accepted third-party accredited laboratory testing (or verify statutory CPSC component determinations), affix a permanent CPSIA Sec. 103 tracking label, and eFile a CPC (CCC) via CBP ACE.';
    const title = 'WARNING: Children’s Product — CPC (CCC) Required (GCC Cannot Be Issued)';
    const md = [
      `# ${title}`,
      '',
      `> **WARNING**: ${cpcWarning}`,
      '',
      `- **Line / SKU**: Line ${lineNumber}${sku ? ` / SKU: \`${sku}\`` : ''}`,
      `- **Product**: ${productName || '[Unnamed Product]'}`,
      `- **HTS Code**: ${htsCode || '[Pending]'}`,
      `- **Disposition**: **CPC (CCC) Required — GCC Cannot Be Issued (CPC Generation Not Supported)**`,
      `- **Applicable Standards**: ${extractCitationList(cpsc).join('; ') || 'CPSIA Children’s Product Rules (15 U.S.C. 1278a / 16 CFR 1107)'}`,
      `- **Instruction**: ${filingInstruction}`,
      ...(fdaNote ? [`- **FDA PGA Note**: ${fdaNote}`] : []),
    ].join('\n');

    const html = renderGccSectionHtml({
      badgeText: 'WARNING: CPC REQUIRED (NO GCC)',
      badgeKind: 'cpc',
      title,
      subtitle: `Line ${lineNumber}${sku ? ` • SKU: ${sku}` : ''}${htsCode ? ` • HTS: ${htsCode}` : ''}`,
      rows: [
        { num: '!', label: 'Compliance Warning (JP)', valueHtml: `<strong>${escapeHtml(cpcWarning)}</strong>` },
        { num: '1', label: 'Product', valueHtml: escapeHtml(productName || '[Unnamed Product]') },
        {
          num: '2',
          label: 'Applicable CPSC Children’s Rules',
          valueHtml: escapeHtml(extractCitationList(cpsc).join('; ') || 'CPSIA 15 U.S.C. § 1278a / 16 CFR Part 1107'),
        },
        { num: '3', label: 'ACE Filing Requirement', valueHtml: escapeHtml(filingInstruction) },
        ...(fdaNote ? [{ num: '4', label: 'FDA PGA Note', valueHtml: escapeHtml(fdaNote) }] : []),
      ],
    });

    return {
      lineNumber,
      sku,
      productName,
      htsCode,
      status: 'cpc_required_instead',
      aceFilingGuidance: {
        eFilingRequired: true,
        certificateType: 'CCC',
        pgaAgency: 'CPSC',
        filingInstruction,
        ...(fdaNote ? { fdaNote } : {}),
      },
      warnings: [cpcWarning],
      missingFields: [],
      compliance,
      documentTitle: title,
      certificateMarkdown: md,
      certificateHtml: html,
    };
  }

  // Case 2: 大人服で 16 CFR § 1610.1(d)(1)/(2) 試験免除 & 2016年CPSC執行裁量該当 -> ACE Disclaim B (IUC 130.006) + クーリエ提出用免除根拠シート生成
  if (cpsc?.certificateRequired === false && cpsc.testingExemption?.enforcementDiscretion) {
    const exemptionCitation = cpsc.testingExemption.citation || '16 CFR 1610.1(d)';
    const certifier = normalizeParty(input.certifier);
    const custodian = normalizeParty(input.recordCustodian) ?? certifier;
    const mfg = input.manufacture;
    const fabricDetails = [
      compliance.product.material ? `Fiber Content: ${compliance.product.material}` : undefined,
      input.fabricSurface ? `Fabric Surface: ${input.fabricSurface === 'plain' ? 'Plain surface' : 'Raised-fiber surface'}` : undefined,
      input.fabricWeightOzPerSqYd !== undefined ? `Fabric Weight: ${input.fabricWeightOzPerSqYd} oz/sq yd` : undefined,
    ]
      .filter(Boolean)
      .join(' | ');

    const filingInstruction =
      `Exempt from flammability testing under ${exemptionCitation} and exempt from GCC issuance / CBP ACE eFiling under the CPSC Statement of Policy on Enforcement Discretion Regarding General Conformity Certificates for Adult Wearing Apparel (effective April 25, 2016). File CBP ACE CPSC PGA Disclaimer Code 'B' with Intended Use Code '130.006'.`;

    const statutoryFields: GccStatutoryFields = {
      productIdentification: {
        productName: productName || 'Adult Wearing Apparel',
        ...(sku ? { sku } : {}),
        ...(brand ? { brand } : {}),
        ...(input.modelOrBatch ? { modelOrBatch: input.modelOrBatch } : {}),
        ...(compliance.product.description ? { description: compliance.product.description } : {}),
        ...(htsCode ? { htsCode } : {}),
      },
      citations: [`16 CFR Part 1610 (Exempt from testing under ${exemptionCitation})`],
      certifier,
      recordCustodian: custodian,
      manufactureDateAndPlace: {
        date: mfg?.date?.trim() || null,
        city: mfg?.city?.trim() || null,
        country: mfg?.country?.trim() || null,
        ...(mfg?.manufacturerName?.trim() ? { manufacturerName: mfg.manufacturerName.trim() } : {}),
      },
      testingDateAndPlace: {
        exemptFromTesting: true,
        exemptionCitation,
        exemptionReason: `Exempt from flammability testing pursuant to ${exemptionCitation} (${fabricDetails || ' qualifying adult apparel fabric'}).`,
        date: null,
        location: null,
      },
      testingLaboratory: {
        notApplicableReason: `Not applicable — exempt from testing under ${exemptionCitation} and CPSC Enforcement Discretion Policy (March 24, 2016).`,
        name: null,
      },
    };

    const title = 'Statement of Flammability Testing & GCC Exemption — Adult Wearing Apparel (16 CFR § 1610.1(d))';
    const md = [
      `# ${title}`,
      '',
      `- **1. Product Identification**: ${productName || 'Adult Wearing Apparel'}${sku ? ` (SKU: \`${sku}\`)` : ''}${brand ? ` — Brand: ${brand}` : ''}${htsCode ? ` — HTS: \`${htsCode}\`` : ''}`,
      `- **2. Applicable Standard & Exemption Citation**: 16 CFR Part 1610 — **Exempt from testing under \`${exemptionCitation}\`**`,
      `- **3. Fabric Specification**: ${fabricDetails || 'Exempt fiber / weight per 16 CFR § 1610.1(d)'}`,
      `- **4. CPSC Enforcement Discretion & CBP ACE Instruction**: ${filingInstruction}`,
      ...(certifier ? [`- **5. Exporter / Importer Statement Party**: ${formatPartyText(certifier, 'N/A')}`] : []),
      ...(mfg?.country || mfg?.city || mfg?.date
        ? [`- **6. Manufacture Origin**: ${[mfg?.date, mfg?.manufacturerName, mfg?.city, mfg?.country].filter(Boolean).join(', ')}`]
        : []),
    ].join('\n');

    const html = renderGccSectionHtml({
      badgeText: 'ACE DISCLAIM B (IUC 130.006)',
      badgeKind: 'exempt-b',
      title,
      subtitle: `Line ${lineNumber}${sku ? ` • SKU: ${sku}` : ''}${htsCode ? ` • HTS: ${htsCode}` : ''}`,
      rows: [
        {
          num: '1',
          label: 'Product Identification',
          valueHtml: `${escapeHtml(productName || 'Adult Wearing Apparel')}${sku ? ` <br><small>SKU: ${escapeHtml(sku)}</small>` : ''}${htsCode ? ` <br><small>HTS: ${escapeHtml(htsCode)}</small>` : ''}`,
        },
        {
          num: '2',
          label: 'Exemption Citation',
          valueHtml: `16 CFR Part 1610 — <strong>Exempt under ${escapeHtml(exemptionCitation)}</strong>`,
        },
        {
          num: '3',
          label: 'Qualifying Fabric Specification',
          valueHtml: escapeHtml(fabricDetails || 'Exempt fiber / plain-surface weight per 16 CFR § 1610.1(d)'),
        },
        {
          num: '4',
          label: 'CBP ACE PGA Filing Instruction',
          valueHtml: escapeHtml(filingInstruction),
        },
        ...(certifier
          ? [{ num: '5', label: 'Declaring Party', valueHtml: escapeHtml(formatPartyText(certifier, 'N/A')) }]
          : []),
        ...(mfg?.country || mfg?.city || mfg?.date
          ? [
              {
                num: '6',
                label: 'Place / Date of Manufacture',
                valueHtml: escapeHtml([mfg?.date, mfg?.manufacturerName, mfg?.city, mfg?.country].filter(Boolean).join(', ')),
              },
            ]
          : []),
      ],
    });

    return {
      lineNumber,
      sku,
      productName,
      htsCode,
      status: 'exempt_disclaim_b',
      aceFilingGuidance: {
        eFilingRequired: false,
        certificateType: 'none',
        pgaAgency: 'CPSC',
        disclaimCode: 'B',
        intendedUseCode: '130.006',
        filingInstruction,
        ...(fdaNote ? { fdaNote } : {}),
      },
      statutoryFields,
      missingFields: [],
      compliance,
      documentTitle: title,
      certificateMarkdown: md,
      certificateHtml: html,
    };
  }

  // Case 3: 大人向けでCPSC強制安全基準の非対象品（大人コレクター向けフィギュア/アクスタ、大人用靴/帽子、一般食器 6912 等）-> ACE Disclaim A
  const isUnlistedAdultNonRegulated =
    compliance.product.targetAge === 'adult' &&
    cpsc?.eFilingRequired === false &&
    (cpsc.certificateRequired === false || cpsc.applicableRegulations.length === 0);

  if (isUnlistedAdultNonRegulated) {
    const filingInstruction =
      'Product is an adult/general-use article NOT subject to any mandatory CPSC consumer product safety rule under 16 CFR. A GCC is NOT required (and should not be filed). Transmit CBP ACE CPSC PGA Disclaimer Code \'A\' (product is not regulated by CPSC or not subject to a mandatory CPSC standard) if HTS triggers a CPSC PGA flag.';
    const title = 'CPSC Non-Regulated Product Declaration (ACE Disclaim A)';
    const md = [
      `# ${title}`,
      '',
      `- **Line / SKU**: Line ${lineNumber}${sku ? ` / SKU: \`${sku}\`` : ''}`,
      `- **Product**: ${productName || '[Unnamed Product]'}${htsCode ? ` (HTS: \`${htsCode}\`)` : ''}`,
      `- **CPSC Status**: **No GCC Required — CBP ACE Disclaimer Code \`A\`**`,
      `- **Instruction**: ${filingInstruction}`,
      ...(fdaNote ? [`- **FDA PGA Compliance Note**: ${fdaNote}`] : []),
    ].join('\n');

    const html = renderGccSectionHtml({
      badgeText: 'NO GCC NEEDED (DISCLAIM A)',
      badgeKind: 'exempt-a',
      title,
      subtitle: `Line ${lineNumber}${sku ? ` • SKU: ${sku}` : ''}${htsCode ? ` • HTS: ${htsCode}` : ''}`,
      rows: [
        { num: '1', label: 'Product', valueHtml: `${escapeHtml(productName || '[Unnamed Product]')}${sku ? ` (SKU: ${escapeHtml(sku)})` : ''}` },
        { num: '2', label: 'HTS Code', valueHtml: escapeHtml(htsCode || 'N/A') },
        { num: '3', label: 'CPSC PGA Disposition', valueHtml: escapeHtml(filingInstruction) },
        ...(fdaNote ? [{ num: '4', label: 'FDA PGA Disposition', valueHtml: escapeHtml(fdaNote) }] : []),
      ],
    });

    return {
      lineNumber,
      sku,
      productName,
      htsCode,
      status: 'exempt_no_gcc_needed',
      aceFilingGuidance: {
        eFilingRequired: false,
        certificateType: 'none',
        pgaAgency: 'CPSC',
        disclaimCode: 'A',
        filingInstruction,
        ...(fdaNote ? { fdaNote } : {}),
      },
      missingFields: [],
      compliance,
      documentTitle: title,
      certificateMarkdown: md,
      certificateHtml: html,
    };
  }

  // Case 4: GCC作成対象（または判定情報不足・法定7項目の一部未入力によるドラフト）
  //   ※ 推測値のでっち上げは一切行わず、未入力の法定必須項目をすべて missingFields に列挙する
  const missingFields: string[] = [];
  if (compliance.overallStatus === 'needs_more_info' || !htsCode) {
    for (const m of compliance.missingInputs ?? ['productDetails']) {
      if (!missingFields.includes(m)) missingFields.push(m);
    }
  }
  if (cpsc?.certificateRequired === 'unknown') {
    for (const m of cpsc.missingInputs ?? []) {
      // 大人服であっても実試験レコードが提出されている場合は自発的/実測GCCを発行できるため fabric 質問は必須ブロックにしない
      const hasExplicitTest = Boolean(input.testing?.date?.trim() && input.testing?.laboratoryName?.trim());
      if (hasExplicitTest && (m === 'fabricSurface' || m === 'fabricWeightOzPerSqYd')) continue;
      if (!missingFields.includes(m)) missingFields.push(m);
    }
  }

  if (!productName) missingFields.push('productName');

  const citations = extractCitationList(cpsc);
  if (citations.length === 0) missingFields.push('citations');

  const certifier = normalizeParty(input.certifier);
  if (!certifier?.name) missingFields.push('certifier.name');
  if (!certifier?.address) missingFields.push('certifier.address');
  if (!certifier?.email) missingFields.push('certifier.email');
  if (!certifier?.phone) missingFields.push('certifier.phone');

  const recordCustodian = normalizeParty(input.recordCustodian);
  if (!recordCustodian?.name) missingFields.push('recordCustodian.name');
  if (!recordCustodian?.address) missingFields.push('recordCustodian.address');
  if (!recordCustodian?.email) missingFields.push('recordCustodian.email');
  if (!recordCustodian?.phone) missingFields.push('recordCustodian.phone');

  const mfgDate = input.manufacture?.date?.trim() || null;
  const mfgCity = input.manufacture?.city?.trim() || null;
  const mfgCountry = input.manufacture?.country?.trim() || null;
  if (!mfgDate) missingFields.push('manufacture.date');
  if (!mfgCity) missingFields.push('manufacture.city');
  if (!mfgCountry) missingFields.push('manufacture.country');

  const testDate = input.testing?.date?.trim() || null;
  const testLocation = input.testing?.location?.trim() || null;
  const testLabName = input.testing?.laboratoryName?.trim() || null;
  if (!testDate) missingFields.push('testing.date');
  if (!testLocation) missingFields.push('testing.location');
  if (!testLabName) missingFields.push('testing.laboratoryName');

  const isComplete = missingFields.length === 0;
  const status: GccItemStatus = isComplete ? 'generated' : 'draft_needs_info';

  const statutoryFields: GccStatutoryFields = {
    productIdentification: {
      productName: productName || '[MISSING PRODUCT NAME]',
      ...(sku ? { sku } : {}),
      ...(brand ? { brand } : {}),
      ...(input.modelOrBatch ? { modelOrBatch: input.modelOrBatch } : {}),
      ...(compliance.product.description ? { description: compliance.product.description } : {}),
      ...(htsCode ? { htsCode } : {}),
    },
    citations,
    certifier,
    recordCustodian,
    manufactureDateAndPlace: {
      date: mfgDate,
      city: mfgCity,
      country: mfgCountry,
      ...(input.manufacture?.manufacturerName?.trim()
        ? { manufacturerName: input.manufacture.manufacturerName.trim() }
        : {}),
    },
    testingDateAndPlace: {
      exemptFromTesting: false,
      date: testDate,
      location: testLocation,
      ...(input.testing?.reportNumber?.trim() ? { reportNumber: input.testing.reportNumber.trim() } : {}),
    },
    testingLaboratory: {
      name: testLabName,
      ...(input.testing?.laboratoryAddress?.trim() ? { address: input.testing.laboratoryAddress.trim() } : {}),
      ...(input.testing?.laboratoryPhone?.trim() ? { phone: input.testing.laboratoryPhone.trim() } : {}),
    },
  };

  const filingInstruction = isComplete
    ? 'GCC complete per 16 CFR § 1110.11. Transmit certificate data elements electronically via CBP ACE eFiling (Full PGA Message Set or CPSC Product Registry Reference) and furnish this certificate to distributor/courier upon request.'
    : `INCOMPLETE DRAFT — Do NOT file until missing statutory fields (${missingFields.join(', ')}) are verified from actual manufacturing and test records.`;

  const docTitle = isComplete
    ? 'General Certificate of Conformity (GCC)'
    : 'DRAFT General Certificate of Conformity (GCC) — INCOMPLETE';

  const prodDescParts = [
    statutoryFields.productIdentification.productName,
    sku ? `SKU: ${sku}` : undefined,
    brand ? `Brand: ${brand}` : undefined,
    input.modelOrBatch ? `Batch/Lot: ${input.modelOrBatch}` : undefined,
    htsCode ? `HTS: ${htsCode}` : undefined,
  ].filter(Boolean);

  const mfgText = [
    mfgDate || '[MISSING MANUFACTURE DATE (YYYY-MM)]',
    input.manufacture?.manufacturerName?.trim(),
    mfgCity || '[MISSING CITY]',
    mfgCountry || '[MISSING COUNTRY]',
  ]
    .filter(Boolean)
    .join(', ');

  const testDatePlaceText = [
    testDate || '[MISSING TEST DATE]',
    testLocation || '[MISSING TEST LOCATION]',
    input.testing?.reportNumber?.trim() ? `Report #: ${input.testing.reportNumber.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join(' | ');

  const testLabText = [
    testLabName || '[MISSING TESTING LABORATORY / ENTITY]',
    input.testing?.laboratoryAddress?.trim(),
    input.testing?.laboratoryPhone?.trim() ? `Phone: ${input.testing.laboratoryPhone.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join(' | ');

  const citationsText = citations.length > 0 ? citations.join('; ') : '[MISSING APPLICABLE CPSC SAFETY STANDARD CITATION]';

  const mdLines = [
    `# ${docTitle}`,
    '*Pursuant to 15 U.S.C. § 2063(a)(1) (CPSIA § 102) and 16 CFR Part 1110*',
    '',
    ...(isComplete
      ? []
      : [
          `> **WARNING — DRAFT ONLY (DO NOT SUBMIT TO CBP ACE)**: Missing mandatory fields: \`${missingFields.join('`, `')}\`.`,
          '',
        ]),
    `1. **Identification of the product covered by this certificate (16 CFR § 1110.11(a)(1))**:  `,
    `   ${prodDescParts.join(' — ')}${compliance.product.description ? ` (${compliance.product.description})` : ''}`,
    `2. **Citation to each CPSC product safety regulation to which this product is being certified (16 CFR § 1110.11(a)(2))**:  `,
    `   ${citationsText}`,
    `3. **Identification of the domestic manufacturer, importer, or foreign direct-to-consumer certifier certifying compliance (16 CFR § 1110.11(a)(3))**:  `,
    `   ${formatPartyText(certifier, '[MISSING CERTIFIER NAME, FULL MAILING ADDRESS & PHONE/EMAIL]')}`,
    `4. **Contact information for the individual maintaining records of test results (16 CFR § 1110.11(a)(4))**:  `,
    `   ${formatPartyText(recordCustodian, '[MISSING RECORD CUSTODIAN NAME, ADDRESS, EMAIL & PHONE]')}`,
    `5. **Date and place where this product was manufactured (16 CFR § 1110.11(a)(5))**:  `,
    `   ${mfgText}`,
    `6. **Date(s) and place(s) where this product was tested for compliance with the regulation(s) cited above (16 CFR § 1110.11(a)(6))**:  `,
    `   ${testDatePlaceText}`,
    `7. **Identification of any third-party laboratory or testing entity on whose testing the certificate depends (16 CFR § 1110.11(a)(7))**:  `,
    `   ${testLabText}`,
  ];

  const html = renderGccSectionHtml({
    badgeText: isComplete ? 'GCC READY (16 CFR 1110)' : 'DRAFT — MISSING INFO',
    badgeKind: isComplete ? 'ready' : 'draft',
    title: docTitle,
    subtitle: `Line ${lineNumber}${sku ? ` • SKU: ${sku}` : ''}${htsCode ? ` • HTS: ${htsCode}` : ''}`,
    rows: [
      {
        num: '1',
        label: 'Identification of the product covered by this certificate (16 CFR § 1110.11(a)(1))',
        valueHtml: `<strong>${escapeHtml(statutoryFields.productIdentification.productName)}</strong>${
          sku ? `<br>SKU: <code>${escapeHtml(sku)}</code>` : ''
        }${brand ? ` • Brand: ${escapeHtml(brand)}` : ''}${
          input.modelOrBatch ? ` • Batch/Lot: ${escapeHtml(input.modelOrBatch)}` : ''
        }${htsCode ? ` • HTS: <code>${escapeHtml(htsCode)}</code>` : ''}${
          compliance.product.description ? `<br><small>${escapeHtml(compliance.product.description)}</small>` : ''
        }`,
      },
      {
        num: '2',
        label: 'Citation to each CPSC product safety regulation (16 CFR § 1110.11(a)(2))',
        valueHtml: escapeHtml(citationsText),
      },
      {
        num: '3',
        label: 'Certifying Importer / Domestic Manufacturer / Foreign Shipper (16 CFR § 1110.11(a)(3))',
        valueHtml: escapeHtml(formatPartyText(certifier, '[MISSING CERTIFIER NAME, FULL MAILING ADDRESS & PHONE/EMAIL]')),
      },
      {
        num: '4',
        label: 'Individual Maintaining Records of Test Results (16 CFR § 1110.11(a)(4))',
        valueHtml: escapeHtml(formatPartyText(recordCustodian, '[MISSING RECORD CUSTODIAN NAME, ADDRESS, EMAIL & PHONE]')),
      },
      {
        num: '5',
        label: 'Date and Place (City & Country) of Manufacture (16 CFR § 1110.11(a)(5))',
        valueHtml: escapeHtml(mfgText),
      },
      {
        num: '6',
        label: 'Date(s) and Place(s) of Compliance Testing (16 CFR § 1110.11(a)(6))',
        valueHtml: escapeHtml(testDatePlaceText),
      },
      {
        num: '7',
        label: 'Testing Laboratory / Entity (16 CFR § 1110.11(a)(7))',
        valueHtml: escapeHtml(testLabText),
      },
    ],
    footerNote: isComplete
      ? 'Electronic Filing Ready (16 CFR § 1110.13): Must be electronically filed via CBP ACE upon entry.'
      : `DRAFT WARNING: Missing required fields (${missingFields.join(', ')}). Complete all 7 statutory elements before CBP ACE submission.`,
  });

  return {
    lineNumber,
    sku,
    productName,
    htsCode,
    status,
    aceFilingGuidance: {
      eFilingRequired: true,
      certificateType: 'GCC',
      pgaAgency: 'CPSC',
      filingInstruction,
      ...(fdaNote ? { fdaNote } : {}),
    },
    statutoryFields,
    missingFields,
    ...(compliance.clarifyingQuestions?.length ? { clarifyingQuestions: compliance.clarifyingQuestions } : {}),
    compliance,
    documentTitle: docTitle,
    certificateMarkdown: mdLines.join('\n'),
    certificateHtml: html,
  };
}

/**
 * 単一商品（URL / パラメータ）または発送後・通関保留時の複数明細注文（items[] + AWB/注文番号）から、
 * 16 CFR § 1110.11 法定7項目準拠の GCC 証明書（JSON / 英語Markdown / 印刷・PDF保存用HTML）を一括生成する。
 */
export async function generateGccCertificate(
  options: GenerateGccCertificateOptions,
): Promise<GenerateGccCertificateResult> {
  const hasSingleProductInput = Boolean(
    options.url?.trim() ||
      options.productName?.trim() ||
      options.htsCode?.trim() ||
      options.sku?.trim() ||
      options.description?.trim(),
  );
  if ((!options.items || options.items.length === 0) && !hasSingleProductInput) {
    throw new TradeInputError(
      'At least one product identifier (url, productName, htsCode, sku) or items[] is required for GCC generation.',
    );
  }
  const hasOrderMeta = Boolean(
    options.orderNumber?.trim() || options.awbNumber?.trim() || options.invoiceNumber?.trim() || options.carrier?.trim(),
  );
  const rawItems: GccOrderItemInput[] =
    options.items && options.items.length > 0
      ? options.items
      : [
          {
            url: options.url,
            productName: options.productName,
            sku: options.sku,
            brand: options.brand,
            modelOrBatch: options.modelOrBatch,
            description: options.description,
            htsCode: options.htsCode,
            targetAge: options.targetAge,
            material: options.material,
            productCategory: options.productCategory,
            foodContact: options.foodContact,
            hasBattery: options.hasBattery,
            batteryType: options.batteryType,
            fabricSurface: options.fabricSurface,
            fabricWeightOzPerSqYd: options.fabricWeightOzPerSqYd,
            certifier: options.certifier,
            recordCustodian: options.recordCustodian,
            manufacture: options.manufacture,
            testing: options.testing,
          },
        ];

  const mode: 'single_product' | 'order_package' =
    rawItems.length > 1 || hasOrderMeta ? 'order_package' : 'single_product';

  const generatedAt = new Date().toISOString();
  const dateCompact = generatedAt.slice(0, 10).replace(/-/g, '');

  const envParties = resolveEnvGccPartyDefaults();
  const itemResults: GccCertificateItemResult[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const mergedItem: GccOrderItemInput = {
      ...raw,
      certifier: mergePartyContacts(raw.certifier, options.certifier, envParties.certifier),
      recordCustodian: mergePartyContacts(raw.recordCustodian, options.recordCustodian, envParties.recordCustodian),
      manufacture: raw.manufacture ?? (rawItems.length === 1 ? options.manufacture : undefined),
      testing: raw.testing ?? (rawItems.length === 1 ? options.testing : undefined),
    };
    // スクレイピングや外部通信を行う前に、サンプル・仮置き・不確定データの混入を即時ブロック
    assertNoPlaceholderGccFields(mergedItem, rawItems.length > 1 ? `items[${i}].` : '');
    const compliance = await checkProductCompliance({
      url: mergedItem.url,
      productName: mergedItem.productName,
      description: mergedItem.description,
      htsCode: mergedItem.htsCode,
      targetAge: mergedItem.targetAge,
      material: mergedItem.material,
      productCategory: mergedItem.productCategory,
      foodContact: mergedItem.foodContact,
      hasBattery: mergedItem.hasBattery,
      batteryType: mergedItem.batteryType,
      fabricSurface: mergedItem.fabricSurface,
      fabricWeightOzPerSqYd: mergedItem.fabricWeightOzPerSqYd,
    });
    itemResults.push(buildSingleGccItemResult(i + 1, mergedItem, compliance));
  }

  const refSuffix = (
    options.orderNumber ||
    options.awbNumber ||
    options.sku ||
    rawItems[0]?.sku ||
    itemResults[0]?.sku ||
    'SINGLE'
  )
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 20)
    .toUpperCase();
  const certificateId = `GCC-${dateCompact}-${refSuffix || 'PKG'}`;

  const counts = {
    totalItems: itemResults.length,
    gccGenerated: itemResults.filter((x) => x.status === 'generated').length,
    draftNeedsInfo: itemResults.filter((x) => x.status === 'draft_needs_info').length,
    disclaimBExempt: itemResults.filter((x) => x.status === 'exempt_disclaim_b').length,
    disclaimAExempt: itemResults.filter((x) => x.status === 'exempt_no_gcc_needed').length,
    cpcRequired: itemResults.filter((x) => x.status === 'cpc_required_instead').length,
  };

  if (!options.allowDraft && counts.draftNeedsInfo > 0) {
    const incompleteItems: GccIncompleteItemSummary[] = itemResults
      .filter((x) => x.status === 'draft_needs_info')
      .map((x) => ({
        lineNumber: x.lineNumber,
        ...(x.sku ? { sku: x.sku } : {}),
        ...(x.productName ? { productName: x.productName } : {}),
        ...(x.htsCode ? { htsCode: x.htsCode } : {}),
        citations: extractCitationList(x.compliance.cpsc),
        missingFields: x.missingFields,
      }));
    const allMissing = Array.from(new Set(incompleteItems.flatMap((x) => x.missingFields)));
    throw new TradeGccIncompleteError(
      `GCC発行に必要な確定レコードが不足しています (${allMissing.join(', ')})。LLMによるWeb探索や推測値・仮置き値の補完は厳禁です。事業者連絡先は環境変数 SORA_GCC_CERTIFIER_* / SORA_GCC_CUSTODIAN_* または引数 certifier / recordCustodian で指定し、製造所(manufacture)・試験成績書(testing)等の商品固有項目は実在の確定レコードを指定してください（未確定項目の確認用ドラフトのみ出力する場合は allowDraft: true を指定）。`,
      allMissing,
      incompleteItems,
    );
  }

  let overallStatus: GenerateGccCertificateResult['overallStatus'];
  if (counts.cpcRequired > 0) {
    overallStatus = 'cpc_required';
  } else if (counts.draftNeedsInfo > 0) {
    overallStatus = 'partial_or_draft';
  } else if (counts.gccGenerated > 0) {
    overallStatus = 'ready';
  } else {
    overallStatus = 'exempt';
  }

  const orderContext = hasOrderMeta
    ? {
        ...(options.orderNumber?.trim() ? { orderNumber: options.orderNumber.trim() } : {}),
        ...(options.awbNumber?.trim() ? { awbNumber: options.awbNumber.trim() } : {}),
        ...(options.carrier?.trim() ? { carrier: options.carrier.trim() } : {}),
        ...(options.invoiceNumber?.trim() ? { invoiceNumber: options.invoiceNumber.trim() } : {}),
      }
    : undefined;

  const mdSections: string[] = [];
  const htmlSections: string[] = [];

  if (mode === 'order_package') {
    const cover = buildOrderCoverSheet({
      certificateId,
      generatedAt,
      orderContext,
      certifier: normalizeParty(mergePartyContacts(options.certifier, envParties.certifier)),
      items: itemResults,
    });
    mdSections.push(cover.markdown);
    htmlSections.push(cover.html);
    // 注文パッケージの2ページ目以降には、実際に添付提出が必要な証明書・免除シート・ドラフト・警告シートを含める
    for (const item of itemResults) {
      if (item.status === 'exempt_no_gcc_needed') continue;
      if (item.certificateMarkdown) mdSections.push(item.certificateMarkdown);
      if (item.certificateHtml) htmlSections.push(item.certificateHtml);
    }
  } else {
    const single = itemResults[0];
    if (single?.certificateMarkdown) mdSections.push(single.certificateMarkdown);
    if (single?.certificateHtml) htmlSections.push(single.certificateHtml);
  }

  const summaryParts = [
    `全${counts.totalItems}明細を判定`,
    counts.gccGenerated > 0 ? `GCC発行完了: ${counts.gccGenerated}件` : undefined,
    counts.disclaimBExempt > 0 ? `16 CFR 1610.1(d) 大人服免除 (ACE Disclaim B / 130.006): ${counts.disclaimBExempt}件` : undefined,
    counts.disclaimAExempt > 0 ? `GCC不要 (ACE Disclaim A): ${counts.disclaimAExempt}件` : undefined,
    counts.draftNeedsInfo > 0 ? `情報不足ドラフト: ${counts.draftNeedsInfo}件` : undefined,
    counts.cpcRequired > 0 ? `【警告】子供向けCPC必須 (GCC発行不可・本ツール非対応): ${counts.cpcRequired}件` : undefined,
  ].filter(Boolean);

  const packageWarnings = itemResults.flatMap((x) => x.warnings ?? []);

  return {
    certificateId,
    generatedAt,
    mode,
    ...(orderContext ? { orderContext } : {}),
    overallStatus,
    summary: summaryParts.join(' / '),
    ...(packageWarnings.length > 0 ? { warnings: packageWarnings } : {}),
    counts,
    items: itemResults,
    packageMarkdown: mdSections.join('\n\n---\n\n'),
    packageHtml: wrapStandalonePrintHtml(
      mode === 'order_package'
        ? `US Customs & CPSC GCC Clearance Package — ${orderContext?.orderNumber || orderContext?.awbNumber || certificateId}`
        : itemResults[0]?.documentTitle || certificateId,
      htmlSections,
    ),
    disclaimer: DISCLAIMER_GCC,
  };
}
