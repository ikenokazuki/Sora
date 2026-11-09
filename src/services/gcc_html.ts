// GCC と通関の表紙の印刷用 HTML。呼び出し側の値はすべて escapeHtml を通す
import type { GccItemInput, GccItemSummary, GccParty } from './gcc.js';
import { ADULT_APPAREL_GCC_POLICY } from './trade.js';

export interface GccRenderItem {
  summary: GccItemSummary;
  /** 前後の空白を除いた呼び出し側の値 */
  input: GccItemInput;
  /** Disclaim B */
  exemption?: { citation: '16 CFR 1610.1(d)(1)' | '16 CFR 1610.1(d)(2)'; basis: string };
  /** Disclaim A の根拠（(c) の見出しのとき） */
  exclusion1610c?: { citation: string; text: string };
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

/** HTML に埋め込む文字列をエスケープする（XSS 防止） */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MISSING = '[MISSING]';
const idLabel = (input: GccItemInput) => (input.identifierType ?? 'sku').toUpperCase();
const joinHtml = (lines: Array<string | undefined>) => lines.filter(Boolean).map(escapeHtml).join('<br>');

/** 当事者を name / street / city, state / country / Email / Phone の行に分ける */
function partyHtml(party?: GccParty): string {
  return (
    joinHtml([
      party?.name,
      party?.street,
      [party?.city, party?.state].filter(Boolean).join(', '),
      party?.country,
      party?.email && `Email: ${party.email}`,
      party?.phone && `Phone: ${party.phone}`,
    ]) || MISSING
  );
}

function section(options: {
  badgeKind: 'ready' | 'draft' | 'exempt-b' | 'exempt-a' | 'cpc';
  badgeText: string;
  title: string;
  summary: GccItemSummary;
  input: GccItemInput;
  rows: Array<[string, string, string]>;
  footerNote?: string;
}): string {
  const { summary, input } = options;
  const subtitle = `Line ${summary.line}${summary.identifier ? ` • ${idLabel(input)}: ${summary.identifier}` : ''} • HTS: ${summary.htsCode}`;
  const rows = options.rows.map(([num, label, value]) => `<tr><td class="n">${escapeHtml(num)}</td><th>${escapeHtml(label)}</th><td>${value}</td></tr>`).join('');
  return `<section class="card"><header><div><small>16 CFR Part 1110</small><h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(subtitle)}</p></div><span class="badge ${options.badgeKind}">${escapeHtml(options.badgeText)}</span></header><table>${rows}</table>${options.footerNote ? `<p class="foot">${escapeHtml(options.footerNote)}</p>` : ''}</section>`;
}

function productHtml({ input, summary }: GccRenderItem): string {
  const facts = [summary.identifier && `${idLabel(input)}: ${summary.identifier}`, input.brand && `Brand: ${input.brand}`, `HTS: ${summary.htsCode}`].filter(Boolean).join(' • ');
  return `<strong>${escapeHtml(summary.productName)}</strong><br>${escapeHtml(facts)}${input.description ? `<br>${escapeHtml(input.description)}` : ''}`;
}

function certificateSection(item: GccRenderItem, render: GccRenderInput): string {
  const { input, summary } = item;
  const isDraft = summary.status === 'draft_needs_info';
  const { manufacture, testing } = input;
  const manufactureHtml = `${escapeHtml(manufacture?.date || MISSING)}<br>${partyHtml(manufacture)}`;
  const testHtml = [
    ...(summary.testingExclusions ?? []).map((c) => `Testing exclusion claimed: ${escapeHtml(c)}`),
    ...(testing?.date ? [`Most recent test: ${escapeHtml(testing.date)}${testing.reportNumber ? ` (Report #: ${escapeHtml(testing.reportNumber)})` : ''}`] : []),
    ...(testing?.parties ?? []).map(partyHtml),
  ].join('<br>') || MISSING;
  return section({
    badgeKind: isDraft ? 'draft' : 'ready',
    badgeText: isDraft ? 'DRAFT — MISSING INFO' : 'GCC READY (16 CFR 1110)',
    title: isDraft ? 'DRAFT General Certificate of Conformity (GCC) — INCOMPLETE' : 'General Certificate of Conformity (GCC)',
    summary,
    input,
    rows: [
      ['1', 'Product (16 CFR 1110.11(a)(1))', productHtml(item)],
      ['2', 'Rules certified (16 CFR 1110.11(a)(2))', joinHtml(summary.citations ?? []) || MISSING],
      ['3', 'Certifier (16 CFR 1110.11(a)(3))', partyHtml(render.certifier)],
      ['4', 'Records custodian (16 CFR 1110.11(a)(4))', partyHtml(render.recordCustodian)],
      ['5', 'Manufacture (16 CFR 1110.11(a)(5))', manufactureHtml],
      ['6', 'Testing (16 CFR 1110.11(a)(6))', testHtml],
    ],
    footerNote: isDraft ? `DRAFT — do not file. Missing: ${summary.missingFields?.join(', ') ?? 'certifier / custodian details'}.` : 'File the certificate data in CBP ACE (16 CFR 1110.13(a)(1)).',
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
