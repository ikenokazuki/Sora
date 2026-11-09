// GCC と通関の表紙の印刷用 HTML。呼び出し側の値はすべて escapeHtml を通す
import type { GccIdentifierType, GccItemInput, GccItemSummary, GccParty } from './gcc.js';
import { ADULT_APPAREL_GCC_POLICY } from './trade.js';

export interface GccRenderItem {
  summary: GccItemSummary;
  /** 前後の空白を除いた呼び出し側の値 */
  input: GccItemInput;
  /** Disclaim B */
  exemption?: { citation: '16 CFR 1610.1(d)(1)' | '16 CFR 1610.1(d)(2)'; basis: string };
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
  const citations = summary.citations ?? [];
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
    ['3', 'Certifier (the importer of record for imported products, 16 CFR 1110.7) — 16 CFR 1110.11(a)(3)', partyHtml(render.certifier, miss, 'certifier')],
    ['4', 'Records contact — 16 CFR 1110.11(a)(4)', partyHtml(render.recordCustodian, miss, 'recordCustodian')],
    ['5', 'Manufacture — 16 CFR 1110.11(a)(5)', manufactureHtml],
    ['6', 'Testing — 16 CFR 1110.11(a)(6)', joinLines([...testRecord, ...exclusionLines])],
    ['7', 'Attestation — 16 CFR 1110.11(a)(7)', isDraft ? '[Not attested: this is a draft]' : escapeHtml(GCC_ATTESTATION)],
  ];
  // 表の印にないキー（targetAge など）と、印のキー。印が覆うキー（manufacture の下の項目など）は繰り返さない
  const covered = (key: string) => [...marked].some((m) => key === m || key.startsWith(`${m}.`));
  const missingKeys = [...(summary.missingFields ?? []).filter((k) => !covered(k)), ...marked].join(', ');
  return section({
    badgeKind: isDraft ? 'draft' : 'ready',
    badgeText: isDraft ? 'DRAFT — NOT VALID' : 'GCC',
    title: isDraft ? 'DRAFT General Certificate of Conformity — not valid' : 'General Certificate of Conformity',
    summary,
    input,
    subtitle: isDraft ? `Missing: ${missingKeys}` : `Certificate ID: ${summary.certificateId} · Generated: ${render.generatedAt}`,
    rows,
    footerNote: isDraft ? 'DRAFT — do not file until every missing element is filled in.' : 'File the certificate data in CBP ACE (16 CFR 1110.13(a)(1)).',
  });
}

function exemptBSection(item: GccRenderItem, render: GccRenderInput): string {
  const { input, summary, exemption } = item;
  const fabric = [
    input.material && `Fiber content: ${input.material}`,
    input.fabricSurface && `Fabric surface: ${input.fabricSurface}`,
    input.fabricWeightOzPerSqYd !== undefined && `Fabric weight: ${input.fabricWeightOzPerSqYd} oz/sq yd`,
  ]
    .filter(Boolean)
    .join(' | ');
  return section({
    badgeKind: 'exempt-b',
    badgeText: 'ACE DISCLAIM B (IUC 130.006)',
    title: 'Flammability Testing and GCC Exemption — Adult Wearing Apparel (16 CFR 1610.1(d))',
    summary,
    input,
    rows: [
      ['1', 'Product', productHtml(item)],
      ['2', 'Exemption', `16 CFR Part 1610 — <strong>exempt under ${escapeHtml(exemption?.citation)}</strong><br>${escapeHtml(exemption?.basis)}`],
      ...(fabric ? ([['3', 'Fabric', escapeHtml(fabric)]] as Array<[string, string, string]>) : []),
      ['4', 'ACE filing', escapeHtml(`GCC and ACE eFiling not required under ${ADULT_APPAREL_GCC_POLICY.citation} (effective ${ADULT_APPAREL_GCC_POLICY.effective}). File CPSC PGA Disclaimer Code 'B' with Intended Use Code '130.006'.`)],
      ...(render.certifier ? ([['5', 'Declaring party', partyHtml(render.certifier)]] as Array<[string, string, string]>) : []),
    ],
  });
}

function noGccSection(item: GccRenderItem): string {
  const { input, summary, exclusion1610c } = item;
  const disclaimA = summary.disclaimCode === 'A';
  return section({
    badgeKind: 'exempt-a',
    badgeText: disclaimA ? 'NO GCC (DISCLAIM A)' : 'NO GCC',
    title: 'No GCC — Certifier States No CPSC Rule Applies',
    summary,
    input,
    rows: [
      ['1', 'Product', productHtml(item)],
      ...(exclusion1610c ? ([['2', exclusion1610c.citation, escapeHtml(exclusion1610c.text)]] as Array<[string, string, string]>) : []),
      ['3', 'ACE filing', escapeHtml(disclaimA ? "CPSC PGA Disclaimer Code 'A' may be filed with an Intended Use Code (CBP Appendix R)." : 'No CPSC data is filed (HTS code is not on the CPSC list).')],
    ],
  });
}

function cpcSection(item: GccRenderItem): string {
  const { input, summary } = item;
  return section({
    badgeKind: 'cpc',
    badgeText: 'CPC REQUIRED (NO GCC)',
    title: "WARNING: Children's Product — CPC Required (GCC Cannot Be Issued)",
    summary,
    input,
    rows: [
      ['1', 'Product', productHtml(item)],
      ['!', 'Action', escapeHtml("Product is for children 12 years of age or younger. Do not file a GCC. A Children's Product Certificate (16 CFR 1107) based on third-party testing is required and is not generated by this tool.")],
    ],
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

function coverAction(summary: GccItemSummary): string {
  switch (summary.status) {
    case 'generated':
      return 'GCC attached (eFiling required)';
    case 'draft_needs_info':
      return `DRAFT — missing: ${(summary.missingFields ?? []).join(', ') || 'certifier / custodian'}`;
    case 'exempt_disclaim_b':
      return 'ACE Disclaim B (IUC 130.006, 16 CFR 1610.1(d))';
    case 'exempt_no_gcc_needed':
      return summary.disclaimCode === 'A' ? 'ACE Disclaim A (certifier states no rule applies)' : 'No CPSC data filed (certifier states no rule applies)';
    case 'cpc_required_instead':
      return 'HOLD — CPC required (child ≤ 12)';
  }
}

function coverSection(render: GccRenderInput): string {
  const { order, items } = render;
  const awb = order.awbNumber ? `${order.awbNumber}${order.carrier ? ` (${order.carrier})` : ''}` : 'N/A';
  const rows = items
    .map(({ summary: s }) => `<tr><td class="n">${s.line}</td><td>${escapeHtml(s.identifier || '-')}</td><td>${escapeHtml(s.productName)}</td><td>${escapeHtml(s.htsCode)}</td><td>${escapeHtml(coverAction(s))}</td></tr>`)
    .join('');
  return `<section class="card"><header><div><small>Customs Broker / Courier Clearance</small><h1>U.S. CPSC Entry Summary Cover Sheet</h1><p>Reference: ${escapeHtml(render.packageId)} • Generated: ${escapeHtml(render.generatedAt)}</p></div><span class="badge ready">${items.length} LINE(S)</span></header><p class="meta"><b>AWB / Tracking #:</b> ${escapeHtml(awb)} • <b>Order #:</b> ${escapeHtml(order.orderNumber || 'N/A')} • <b>Commercial Invoice #:</b> ${escapeHtml(order.invoiceNumber || 'N/A')}</p>${render.certifier ? `<p class="meta"><b>Certifier:</b> ${partyHtml(render.certifier)}</p>` : ''}<table><tr><th>Line</th><th>ID</th><th>Product</th><th>HTS</th><th>CPSC PGA action</th></tr>${rows}</table></section>`;
}

const PRINT_CSS =
  ':root{color-scheme:light}*{box-sizing:border-box}body{font:13px/1.45 system-ui,Arial,sans-serif;color:#111827;background:#f9fafb;margin:0;padding:24px}.card{max-width:900px;margin:0 auto 24px;background:#fff;border:1px solid #d1d5db;padding:24px}header{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111827;margin-bottom:16px}h1{font-size:19px;margin:4px 0}header p{margin:0 0 12px;font-size:12px}small{font-weight:700;color:#4b5563}.badge{padding:4px 10px;font-size:11px;font-weight:700;border:1px solid;white-space:nowrap;align-self:flex-start}.ready{color:#065f46}.draft{color:#92400e}.exempt-b{color:#1e40af}.exempt-a{color:#374151}.cpc{color:#991b1b}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d1d5db;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f3f4f6}.n{width:34px;text-align:center}.foot,.meta{font-size:12px;color:#4b5563}@media print{body{background:#fff;padding:0}.card{margin:0;max-width:none}.page{page-break-before:always}}';

/** 表紙（注文のとき）と品ごとの証明書を、印刷できる 1 つの HTML にする */
export function renderGccPackageHtml(input: GccRenderInput): string {
  const sections =
    input.mode === 'order_package'
      ? [coverSection(input), ...input.items.filter((i) => i.summary.status !== 'exempt_no_gcc_needed').map((i) => itemSection(i, input))]
      : input.items.map((i) => itemSection(i, input));
  const title = input.mode === 'order_package' ? `US Customs & CPSC GCC Package — ${input.order.orderNumber || input.order.awbNumber || input.packageId}` : `GCC — ${input.items[0]?.summary.productName}`;
  const body = sections.map((s, i) => (i === 0 ? s : `<div class="page"></div>${s}`)).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}
