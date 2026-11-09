import type { GccCertificateItemResult, GccPartyContact, GenerateGccCertificateResult } from './gcc.js';

/** HTMLテンプレートへの埋め込み時に信頼できない全文字列を厳格にエスケープ（XSS防止） */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatPartyText(party: GccPartyContact | null, missingPlaceholder: string): string {
  if (!party || (!party.name && !party.address)) return missingPlaceholder;
  const lines = [
    party.name || '[MISSING NAME]',
    party.address || '[MISSING ADDRESS]',
    party.email ? `Email: ${party.email}` : undefined,
    party.phone ? `Phone: ${party.phone}` : undefined,
  ].filter(Boolean);
  return lines.join(' | ');
}

export function renderGccSectionHtml(options: {
  badgeText: string;
  badgeKind: 'ready' | 'draft' | 'exempt-b' | 'exempt-a' | 'cpc';
  title: string;
  subtitle: string;
  rows: Array<{ num: string; label: string; valueHtml: string }>;
  footerNote?: string;
}): string {
  const rowsHtml = options.rows
    .map(
      (r) => `      <tr>
        <td class="col-num">${escapeHtml(r.num)}</td>
        <th scope="row" class="col-label">${escapeHtml(r.label)}</th>
        <td class="col-val">${r.valueHtml}</td>
      </tr>`,
    )
    .join('\n');

  return `<section class="cert-card">
  <header class="cert-header">
    <div>
      <div class="cert-kicker">U.S. Consumer Product Safety Commission — 16 CFR Part 1110</div>
      <h1 class="cert-title">${escapeHtml(options.title)}</h1>
      <p class="cert-subtitle">${escapeHtml(options.subtitle)}</p>
    </div>
    <span class="badge badge-${options.badgeKind}">${escapeHtml(options.badgeText)}</span>
  </header>
  <table class="cert-table">
    <tbody>
${rowsHtml}
    </tbody>
  </table>
  ${options.footerNote ? `<p class="cert-footer">${escapeHtml(options.footerNote)}</p>` : ''}
</section>`;
}

export function wrapStandalonePrintHtml(title: string, sectionsHtml: string[]): string {
  const body = sectionsHtml
    .map((sec, idx) => (idx === 0 ? sec : `<div class="page-break"></div>\n${sec}`))
    .join('\n\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #111827;
      background: #f9fafb;
      margin: 0;
      padding: 24px;
      line-height: 1.45;
      font-size: 13px;
    }
    .cert-card {
      max-width: 900px;
      margin: 0 auto 24px auto;
      background: #ffffff;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 24px 28px;
    }
    .cert-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      border-bottom: 2px solid #111827;
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .cert-kicker {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #4b5563;
    }
    .cert-title {
      font-size: 19px;
      margin: 4px 0;
      color: #111827;
    }
    .cert-subtitle {
      font-size: 12px;
      color: #4b5563;
      margin: 0;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
      border: 1px solid currentColor;
    }
    .badge-ready { color: #065f46; background: #ecfdf5; }
    .badge-draft { color: #92400e; background: #fffbeb; }
    .badge-exempt-b { color: #1e40af; background: #eff6ff; }
    .badge-exempt-a { color: #374151; background: #f3f4f6; }
    .badge-cpc { color: #991b1b; background: #fef2f2; }
    .cert-table, .summary-table {
      width: 100%;
      border-collapse: collapse;
    }
    .cert-table th, .cert-table td, .summary-table th, .summary-table td {
      border: 1px solid #d1d5db;
      padding: 8px 10px;
      vertical-align: top;
      text-align: left;
    }
    .cert-table th, .summary-table th {
      background: #f3f4f6;
      font-weight: 600;
    }
    .col-num { width: 34px; text-align: center; font-weight: 700; color: #374151; }
    .col-label { width: 34%; }
    .cert-footer {
      margin: 12px 0 0 0;
      font-size: 11.5px;
      color: #4b5563;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 16px;
      margin-bottom: 16px;
      font-size: 12.5px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      background: #f3f4f6;
      padding: 1px 4px;
      border-radius: 3px;
    }
    @media print {
      body { background: #ffffff; padding: 0; }
      .cert-card { border: 1px solid #9ca3af; border-radius: 0; margin: 0; max-width: none; box-shadow: none; }
      .page-break { page-break-before: always; break-before: page; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

export function buildOrderCoverSheet(options: {
  certificateId: string;
  generatedAt: string;
  orderContext?: GenerateGccCertificateResult['orderContext'];
  certifier: GccPartyContact | null;
  items: GccCertificateItemResult[];
}): { markdown: string; html: string } {
  const { orderContext, certifier, items, certificateId, generatedAt } = options;
  const statusLabel = (item: GccCertificateItemResult): string => {
    switch (item.status) {
      case 'generated':
        return 'GCC Attached (eFiling Required)';
      case 'draft_needs_info':
        return `DRAFT — Missing: ${item.missingFields.join(', ')}`;
      case 'exempt_disclaim_b':
        return 'ACE Disclaim B (IUC 130.006 — 16 CFR 1610.1(d) Exempt)';
      case 'exempt_no_gcc_needed':
        return 'ACE Disclaim A (Not Subject to CPSC Rule)';
      case 'cpc_required_instead':
        return 'HOLD — CPC (CCC) Required (Child <=12)';
    }
  };

  const mdHeader = [
    '# U.S. Customs / Courier Clearance & PGA Summary Cover Sheet',
    `- **Package Reference**: \`${certificateId}\` (Generated: ${generatedAt})`,
    ...(orderContext?.awbNumber ? [`- **AWB / Tracking Number**: \`${orderContext.awbNumber}\`${orderContext.carrier ? ` (${orderContext.carrier})` : ''}`] : []),
    ...(orderContext?.orderNumber ? [`- **Order Number**: \`${orderContext.orderNumber}\``] : []),
    ...(orderContext?.invoiceNumber ? [`- **Commercial Invoice Number**: \`${orderContext.invoiceNumber}\``] : []),
    ...(certifier ? [`- **Certifier / Importer / Shipper**: ${formatPartyText(certifier, 'N/A')}`] : []),
    '',
    '| Line | SKU | Product Description | HTS Code | CPSC PGA Disposition | Notes / FDA / Fabric Spec |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
    ...items.map((it) => {
      const extraNotes = [
        it.statutoryFields?.testingDateAndPlace.exemptionReason,
        it.aceFilingGuidance.fdaNote,
      ]
        .filter(Boolean)
        .join(' ');
      return `| ${it.lineNumber} | ${it.sku || '-'} | ${it.productName || '-'} | ${it.htsCode || '-'} | ${statusLabel(it)} | ${extraNotes || '-'} |`;
    }),
  ].join('\n');

  const tableRowsHtml = items
    .map((it) => {
      const extraNotes = [
        it.statutoryFields?.testingDateAndPlace.exemptionReason,
        it.aceFilingGuidance.fdaNote,
      ]
        .filter(Boolean)
        .join(' ');
      return `      <tr>
        <td class="col-num">${escapeHtml(it.lineNumber)}</td>
        <td><code>${escapeHtml(it.sku || '-')}</code></td>
        <td>${escapeHtml(it.productName || '-')}</td>
        <td><code>${escapeHtml(it.htsCode || '-')}</code></td>
        <td><strong>${escapeHtml(statusLabel(it))}</strong></td>
        <td>${escapeHtml(extraNotes || '-')}</td>
      </tr>`;
    })
    .join('\n');

  const html = `<section class="cert-card">
  <header class="cert-header">
    <div>
      <div class="cert-kicker">Customs Broker & Express Courier Clearance Package</div>
      <h1 class="cert-title">U.S. CPSC & FDA PGA Entry Line Summary Cover Sheet</h1>
      <p class="cert-subtitle">Reference: ${escapeHtml(certificateId)} • Generated: ${escapeHtml(generatedAt)}</p>
    </div>
    <span class="badge badge-ready">${escapeHtml(`${items.length} SKU LINE(S)`)}</span>
  </header>
  <div class="meta-grid">
    <div><strong>AWB / Tracking #:</strong> ${escapeHtml(orderContext?.awbNumber ? `${orderContext.awbNumber}${orderContext.carrier ? ` (${orderContext.carrier})` : ''}` : 'N/A')}</div>
    <div><strong>Order #:</strong> ${escapeHtml(orderContext?.orderNumber || 'N/A')}</div>
    <div><strong>Commercial Invoice #:</strong> ${escapeHtml(orderContext?.invoiceNumber || 'N/A')}</div>
    <div><strong>Certifying Party:</strong> ${escapeHtml(formatPartyText(certifier, 'See individual SKU certificates'))}</div>
  </div>
  <table class="summary-table">
    <thead>
      <tr>
        <th>Line</th>
        <th>SKU</th>
        <th>Product</th>
        <th>HTS Code</th>
        <th>CPSC PGA Filing Action</th>
        <th>Exemption / FDA / Broker Notes</th>
      </tr>
    </thead>
    <tbody>
${tableRowsHtml}
    </tbody>
  </table>
  <p class="cert-footer">Per 16 CFR Part 1110, individual General Certificates of Conformity (GCC) and 16 CFR § 1610.1(d) Fabric Exemption Statements are attached on the following pages per regulated SKU.</p>
</section>`;

  return { markdown: mdHeader, html };
}
