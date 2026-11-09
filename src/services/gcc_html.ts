// GCC と通関の表紙の印刷用 HTML。呼び出し側の値はすべて escapeHtml を通す
import type { GccIdentifierType, GccItemInput, GccItemSummary, GccParty } from './gcc.js';
import { ADULT_APPAREL_GCC_POLICY, SECTION_1610_1_D } from './trade.js';

export interface GccRenderItem {
  summary: GccItemSummary;
  /** 前後の空白を除いた呼び出し側の値 */
  input: GccItemInput;
  /** Disclaim B */
  exemption?: { citation: '16 CFR 1610.1(d)(1)' | '16 CFR 1610.1(d)(2)' };
  /** Disclaim A の根拠（(c) の見出しのとき） */
  exclusion1610c?: { citation: string; text: string };
  /** 引用した規則が全部、試験の除外のとき。試験の日付・場所の代わりに除外を書く（16 CFR 1110.11(c)） */
  testingNotNeeded?: boolean;
}
export interface GccRenderInput {
  packageId: string;
  generatedAt: string;
  mode: 'single_product' | 'order_package';
  order: { orderNumber?: string; awbNumber?: string; carrier?: string; invoiceNumber?: string };
  certifier?: GccParty;
  recordCustodian?: GccParty;
  items: GccRenderItem[];
}

/** 16 CFR 1110.11(a)(7) の文（紙・電子の証明書に入れる。eFile のときは Product Registry と CATAIR にある）。eCFR の本文から写した */
export const GCC_ATTESTATION =
  'I hereby certify that the finished product(s) covered by this certificate comply with the rules, bans, standards, and regulations stated herein, and that the information in this certificate is true and accurate to the best of my knowledge, information, and belief. I understand and acknowledge that it is a United States federal crime to knowingly and willfully make any materially false, fictitious, or fraudulent statement, representation, or omission on this certificate.';

/** HTML に埋め込む文字列をエスケープする（XSS 防止） */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PARTY_FIELDS = ['name', 'street', 'city', 'state', 'country', 'email', 'phone'] as const;
const ID_LABELS: Record<GccIdentifierType, string> = { sku: 'SKU', model: 'Model number', gtin: 'GTIN', upc: 'UPC', serial: 'Serial number', registered: 'Registered number', other: 'Identifier' };
const idLabel = (input: GccItemInput) => ID_LABELS[input.identifierType ?? 'sku'];
const joinLines = (lines: Array<string | undefined | false>) => lines.filter(Boolean).join('<br>');

/** 欠けた項目を出す関数。表に [MISSING: キー] と書き、キーを覚える */
type Miss = (key: string) => string;

/** 当事者を name / street / city, state / country / Email・Phone の行に分ける。miss があれば、欠けた項目を prefix.項目 の印にする（まるごと無いときは prefix の印 1 つ。whole が false なら項目ごと） */
function partyHtml(party?: GccParty, miss?: Miss, prefix = '', whole = true): string {
  if (miss && whole && !PARTY_FIELDS.some((f) => party?.[f])) return miss(prefix);
  const [name, street, city, state, country, email, phone] = PARTY_FIELDS.map((f) => (party?.[f] ? escapeHtml(party[f]) : (miss?.(`${prefix}.${f}`) ?? '')));
  return joinLines([name, street, [city, state].filter(Boolean).join(', '), country, [email && `Email: ${email}`, phone && `Phone: ${phone}`].filter(Boolean).join(' · ')]);
}

function section(options: {
  badgeKind: 'ready' | 'draft' | 'exempt-b' | 'exempt-a' | 'cpc';
  badgeText: string;
  title: string;
  summary: GccItemSummary;
  input: GccItemInput;
  /** 無ければ「Line N • ID • HTS」 */
  subtitle?: string;
  rows: Array<[string, string, string]>;
  footerNote?: string;
}): string {
  const { summary, input } = options;
  const subtitle = options.subtitle ?? `Line ${summary.line}${summary.identifier ? ` • ${idLabel(input)}: ${summary.identifier}` : ''} • HTS: ${summary.htsCode}`;
  const rows = options.rows.map(([num, label, value]) => `<tr><td class="n">${escapeHtml(num)}</td><th>${escapeHtml(label)}</th><td>${value}</td></tr>`).join('');
  return `<section class="card"><header><div><small>16 CFR Part 1110</small><h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(subtitle)}</p></div><span class="badge ${options.badgeKind}">${escapeHtml(options.badgeText)}</span></header><table>${rows}</table>${options.footerNote ? `<p class="foot">${escapeHtml(options.footerNote)}</p>` : ''}</section>`;
}

function productHtml({ input, summary }: GccRenderItem, miss?: Miss): string {
  const identifier = summary.identifier ? escapeHtml(summary.identifier) : miss?.('identifier');
  return joinLines([
    `<strong>${escapeHtml(summary.productName)}</strong>`,
    input.brand && `Brand: ${escapeHtml(input.brand)}`,
    identifier && `${idLabel(input)}: ${identifier}`,
    `HTS: ${escapeHtml(summary.htsCode)}`,
    input.description && escapeHtml(input.description),
  ]);
}

/** GCC（16 CFR 1110.11(a)(1)〜(7)）。欠けた値は [MISSING: キー] にして、下書きの印を付ける */
function certificateSection(item: GccRenderItem, render: GccRenderInput): string {
  const { input, summary } = item;
  const isDraft = summary.status === 'draft_needs_info';
  const { manufacture, testing } = input;
  const marked = new Set<string>();
  const miss: Miss = (key) => {
    marked.add(key);
    return `[MISSING: ${key}]`;
  };
  const value = (key: string, text?: string) => (text ? escapeHtml(text) : miss(key));
  const citations = summary.citations ?? input.citations ?? [];
  const citationsMissing = !citations.length || !!summary.missingFields?.includes('citations');
  const exclusions = summary.testingExclusions ?? [];
  const parties = testing?.parties ?? [];
  const rules = citations.length ? `<ul>${citations.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : '';
  const hasTestData = testing?.date || parties.length || testing?.reportNumber;
  const testRecord = item.testingNotNeeded
    ? []
    : !hasTestData
      ? [miss('testing')]
      : [
          `Most recent test: ${value('testing.date', testing?.date)}`,
          ...(parties.length ? parties.map((party, j) => partyHtml(party, miss, `testing.parties[${j}]`)) : [miss('testing.parties')]),
          testing?.reportNumber && `Report: ${escapeHtml(testing.reportNumber)}`,
        ];
  const exclusionLines = exclusions.map(
    (e) => `Testing exclusion for 16 CFR ${escapeHtml(e.replace(/^16 CFR (\d+).*/, '$1'))}: ${escapeHtml(e)} (identified in lieu of the test date and place (16 CFR 1110.11(c)))`,
  );
  const manufactureHtml =
    !manufacture?.date && !PARTY_FIELDS.some((f) => manufacture?.[f])
      ? miss('manufacture')
      : joinLines([`Date of manufacture: ${value('manufacture.date', manufacture?.date)}`, partyHtml(manufacture, miss, 'manufacture', false)]);
  const rows: Array<[string, string, string]> = [
    ['1', 'Product — 16 CFR 1110.11(a)(1)', productHtml(item, miss)],
    ['2', 'Rules certified — 16 CFR 1110.11(a)(2)', rules + (citationsMissing ? miss('citations') : '')],
    ['3', 'Certifier (the importer for imported products, 16 CFR 1110.3 and 1110.7) — 16 CFR 1110.11(a)(3)', partyHtml(render.certifier, miss, 'certifier')],
    ['4', 'Records contact — 16 CFR 1110.11(a)(4)', partyHtml(render.recordCustodian, miss, 'recordCustodian')],
    ['5', 'Manufacture — 16 CFR 1110.11(a)(5)', manufactureHtml],
    ['6', 'Testing — 16 CFR 1110.11(a)(6)', joinLines([...testRecord, ...exclusionLines])],
    ['7', 'Attestation — 16 CFR 1110.11(a)(7)', isDraft ? '[Not attested: this is a draft]' : escapeHtml(GCC_ATTESTATION)],
  ];
  // 題の下の行は、表の印が覆わないキー（targetAge など）だけ。印のキーは繰り返さない（印が覆うキーは、印と同じか、その下の項目）
  const covered = (key: string) => [...marked].some((m) => key === m || key.startsWith(`${m}.`));
  const unmarked = (summary.missingFields ?? []).filter((k) => !covered(k));
  return section({
    badgeKind: isDraft ? 'draft' : 'ready',
    badgeText: isDraft ? 'DRAFT — NOT VALID' : 'GCC',
    title: isDraft ? 'DRAFT General Certificate of Conformity — not valid' : 'General Certificate of Conformity',
    summary,
    input,
    subtitle: isDraft ? (unmarked.length ? `Missing: ${unmarked.join(', ')}` : 'Missing elements are marked below.') : `Certificate ID: ${summary.certificateId} · Generated: ${render.generatedAt}`,
    rows,
    footerNote: isDraft ? 'DRAFT — do not file until every missing element is filled in.' : 'Filing: see 16 CFR 1110.13.',
  });
}

/** 証明書でない紙の表。番号は 1 から順に振る */
const numbered = (rows: Array<[string, string]>): Array<[string, string, string]> => rows.map(([label, value], i) => [String(i + 1), label, value]);

function exemptBSection(item: GccRenderItem, render: GccRenderInput): string {
  const { input, summary } = item;
  const citation = item.exemption!.citation; // exempt_disclaim_b は必ず免除の条文を持つ（gcc.ts）
  const basis = citation === '16 CFR 1610.1(d)(1)' ? `Fabric: plain surface, ${input.fabricWeightOzPerSqYd} oz/sq yd` : `Fiber content: ${input.material}`;
  const policy = ADULT_APPAREL_GCC_POLICY;
  return section({
    badgeKind: 'exempt-b',
    badgeText: 'ACE DISCLAIM B (IUC 130.006)',
    title: 'Statement of Exemption — Adult Wearing Apparel (16 CFR 1610.1(d))',
    summary,
    input,
    rows: numbered([
      ['Product', productHtml(item)],
      ['Exemption', escapeHtml(`${citation}: ${SECTION_1610_1_D[citation]}`)],
      ['Basis', escapeHtml(basis)],
      ['CPSC policy', escapeHtml(`${policy.title}, ${policy.citation}, effective ${policy.effective}.`)],
      ['ACE', escapeHtml('CPSC PGA Message Set: Disclaim B with Intended Use Code 130.006 (CPSC eFiling CATAIR Implementation Guide).')],
      ['Note', escapeHtml('The product must still meet the flammability requirements of 16 CFR 1610.')],
      ...(render.certifier ? ([['Declared by', partyHtml(render.certifier)]] as Array<[string, string]>) : []),
    ]),
  });
}

/** Disclaim A（1 品のときだけ紙にする。注文のときは表紙の行だけ） */
function noGccSection(item: GccRenderItem): string {
  const { input, summary, exclusion1610c } = item;
  const basis = exclusion1610c
    ? `Not subject to 16 CFR 1610 under ${exclusion1610c.citation}: ${exclusion1610c.text}. The certifier states that no other CPSC rule requiring a certificate applies.`
    : 'The certifier states that no CPSC rule, ban, standard, or regulation requiring a certificate applies to this product.';
  const ace =
    summary.disclaimCode === 'A'
      ? 'Disclaim A may be filed. Every disclaimer needs an Intended Use Code (CATAIR, PG01 Note 1): choose it from CBP Appendix R, e.g. 130.XXX For Consumer Use as a Non-Food Product.'
      : 'The HTS code is not on CPSC’s eFiling list; no CPSC data is filed.';
  return section({
    badgeKind: 'exempt-a',
    badgeText: summary.disclaimCode === 'A' ? 'NO GCC (DISCLAIM A)' : 'NO GCC',
    title: 'Statement — No CPSC Certificate Required',
    summary,
    input,
    rows: numbered([
      ['Product', productHtml(item)],
      ['Basis', escapeHtml(basis)],
      ['ACE', escapeHtml(ace)],
    ]),
  });
}

function cpcSection(item: GccRenderItem): string {
  const { input, summary } = item;
  return section({
    badgeKind: 'cpc',
    badgeText: 'CPC REQUIRED (NO GCC)',
    title: 'Children’s Product — CPC Required (no GCC issued)',
    summary,
    input,
    rows: numbered([
      ['Product', productHtml(item)],
      ['Action', escapeHtml('Children’s products (12 years of age or younger) need a Children’s Product Certificate (CPC) under 16 CFR part 1107, based on testing by a CPSC-accepted third party conformity assessment body. This tool does not issue CPCs.')],
    ]),
  });
}

function itemSection(item: GccRenderItem, render: GccRenderInput): string {
  switch (item.summary.status) {
    case 'generated':
    case 'draft_needs_info':
      return certificateSection(item, render);
    case 'exempt_disclaim_b':
      return exemptBSection(item, render);
    case 'exempt_no_gcc_needed':
      return noGccSection(item);
    case 'cpc_required_instead':
      return cpcSection(item);
  }
}

/** 表紙の CPSC の列 */
function coverAction(summary: GccItemSummary): string {
  switch (summary.status) {
    case 'generated':
      return `GCC attached (${summary.certificateId})`;
    case 'draft_needs_info':
      return `DRAFT — missing: ${(summary.missingFields ?? []).join(', ') || 'certifier / custodian'}`;
    case 'exempt_disclaim_b':
      return 'Disclaim B, IUC 130.006 (statement attached)';
    case 'exempt_no_gcc_needed':
      return summary.disclaimCode === 'A' ? 'Disclaim A — IUC required' : 'No CPSC data (HTS code not on CPSC list)';
    case 'cpc_required_instead':
      return 'HOLD — CPC required';
  }
}

function coverSection(render: GccRenderInput): string {
  const { order, items, certifier } = render;
  // 証明書（GCC か下書き）が 1 つでもあれば証明者が要る。無いまま渡すときは、欠けた印を表紙にも出す
  const needsCertifier = items.some(({ summary }) => summary.status === 'generated' || summary.status === 'draft_needs_info');
  const certifierName = certifier?.name ? escapeHtml(certifier.name) : needsCertifier ? (PARTY_FIELDS.some((f) => certifier?.[f]) ? '[MISSING: certifier.name]' : '[MISSING: certifier]') : '';
  const meta = joinLines(
    (
      [
        ['Package ID', escapeHtml(render.packageId)],
        ['Generated', escapeHtml(render.generatedAt)],
        ['Order #', escapeHtml(order.orderNumber)],
        ['AWB / Tracking #', escapeHtml(order.awbNumber)],
        ['Carrier', escapeHtml(order.carrier)],
        ['Invoice #', escapeHtml(order.invoiceNumber)],
        ['Certifier', certifierName],
      ] as const
    ).map(([label, value]) => value && `<b>${label}:</b> ${value}`),
  );
  const rows = items
    .map(({ summary: s }) => `<tr><td class="n">${s.line}</td><td>${escapeHtml(s.productName)}</td><td>${escapeHtml(s.identifier || '-')}</td><td>${escapeHtml(s.htsCode)}</td><td>${escapeHtml(coverAction(s))}</td><td>${escapeHtml(s.fdaNote)}</td></tr>`)
    .join('');
  return `<section class="card"><header><div><small>Customs Broker / Courier Clearance</small><h1>Customs Clearance Summary — CPSC (and FDA) PGA</h1></div><span class="badge ready">${items.length} LINE(S)</span></header><p class="meta">${meta}</p><table><tr><th>Line</th><th>Product</th><th>Identifier</th><th>HTS</th><th>CPSC</th><th>Note</th></tr>${rows}</table></section>`;
}

const PRINT_CSS =
  ':root{color-scheme:light}*{box-sizing:border-box}body{font:13px/1.45 system-ui,Arial,sans-serif;color:#111827;background:#f9fafb;margin:0;padding:24px}.card{max-width:900px;margin:0 auto 24px;background:#fff;border:1px solid #d1d5db;padding:24px}header{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111827;margin-bottom:16px}h1{font-size:19px;margin:4px 0}header p{margin:0 0 12px;font-size:12px}small{font-weight:700;color:#4b5563}.badge{padding:4px 10px;font-size:11px;font-weight:700;border:1px solid;white-space:nowrap;align-self:flex-start}.ready{color:#065f46}.draft{color:#92400e}.exempt-b{color:#1e40af}.exempt-a{color:#374151}.cpc{color:#991b1b}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d1d5db;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f3f4f6}.n{width:34px;text-align:center}.foot,.meta{font-size:12px;color:#4b5563}@media print{body{background:#fff;padding:0}.card{margin:0;max-width:none}section+section{page-break-before:always;break-before:page}}';

/** 表紙（注文のとき）と品ごとの証明書を、印刷できる 1 つの HTML にする */
export function renderGccPackageHtml(input: GccRenderInput): string {
  const sections =
    input.mode === 'order_package'
      ? [coverSection(input), ...input.items.filter((i) => i.summary.status !== 'exempt_no_gcc_needed').map((i) => itemSection(i, input))]
      : input.items.map((i) => itemSection(i, input));
  const title = input.mode === 'order_package' ? `US Customs & CPSC GCC Package — ${input.order.orderNumber || input.order.awbNumber || input.packageId}` : `${input.items[0]?.summary.status === 'draft_needs_info' ? 'DRAFT ' : ''}GCC — ${input.items[0]?.summary.productName}`;
  const body = sections.join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}
