import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { GenerateGccCertificateRequestSchema } from '../types.js';
import { type GccItemInput, TradeGccIncompleteError, generateGccCertificate } from './gcc.js';
import { GCC_ATTESTATION } from './gcc_html.js';
import { ADULT_APPAREL_GCC_POLICY, SECTION_1610_1_D, TradeInputError } from './trade.js';

// サーバーの既定（SORA_GCC_*）が手元の環境にあっても、テストは呼び出し側の値だけで始める
const savedEnv = { certifier: process.env.SORA_GCC_CERTIFIER, custodian: process.env.SORA_GCC_CUSTODIAN };
beforeEach(() => {
  delete process.env.SORA_GCC_CERTIFIER;
  delete process.env.SORA_GCC_CUSTODIAN;
});
afterAll(() => {
  for (const [key, value] of [['SORA_GCC_CERTIFIER', savedEnv.certifier], ['SORA_GCC_CUSTODIAN', savedEnv.custodian]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const CERTIFIER = { name: 'Acme Imports LLC', street: '100 Example Street', city: 'Anytown', state: 'CA', country: 'United States', email: 'compliance@acme-imports.test', phone: '+1-202-555-0101' };
const CUSTODIAN = { ...CERTIFIER, name: 'Compliance Manager', email: 'records@acme-imports.test', phone: '+1-202-555-0102' };
const FACTORY = { date: '2026-06', name: 'Acme Helmet Factory', street: '1 Example Road', city: 'Taichung', state: 'Taichung City', country: 'Taiwan', email: 'factory@acme-factory.test', phone: '+1-202-555-0103' };
const LAB = { name: 'Acme Test Lab', street: '2 Example Road', city: 'Taipei', state: 'Taipei City', country: 'Taiwan', email: 'lab@acme-lab.test', phone: '+1-202-555-0104' };
const HELMET: GccItemInput = { htsCode: '6506.10.60.45', productName: 'Adult Bicycle Helmet', identifier: 'HLM-001', targetAge: 'adult', citations: ['16 CFR 1203'], manufacture: FACTORY, testing: { date: '2026-06-15', reportNumber: 'TR-0001', parties: [LAB] } };
const PENLIGHT: GccItemInput = { htsCode: '8513.10.20.00', productName: 'LED Penlight', identifier: 'PEN-001', targetAge: 'adult', hasBattery: true, batteryType: 'button_coin', manufacture: FACTORY, testing: { date: '2026-06-15', parties: [LAB] } };
const TEE: GccItemInput = { htsCode: '6109.90.10.07', productName: 'Adult Polyester T-Shirt', identifier: 'TEE-001', targetAge: 'adult', material: '100% polyester' };

describe('generateGccCertificate', () => {
  it('makes a GCC with the elements of the current 16 CFR 1110.11 when every record is given', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(res.overallStatus).toBe('ready');
    expect(res.mode).toBe('single_product');
    expect(res.items[0]).toMatchObject({ line: 1, status: 'generated', htsCode: '6506.10.60.45', identifier: 'HLM-001', citations: ['16 CFR 1203'] });
    expect(res.items[0].missingFields).toBeUndefined();
    expect(res.items[0].certificateId).toMatch(/^GCC-[0-9A-F]{12}$/);
    expect(res.packageId).toMatch(/^PKG-[0-9A-F]{12}$/);
    expect(res.missingFields).toBeUndefined();
  });

  it('keeps a GCC a draft without the unique identifier and the full contact details (review probe for C1)', async () => {
    const item: GccItemInput = { htsCode: '6506.10.60.45', productName: 'Adult Bicycle Helmet', targetAge: 'adult', citations: ['16 CFR 1203'], manufacture: { date: '2026-06', city: 'Taichung', country: 'Taiwan' }, testing: { date: '2026-06-15', parties: [{ name: 'Acme Test Lab' }] } };
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [item], allowDraft: true });
    expect(res.items[0].status).toBe('draft_needs_info');
    expect(res.items[0].missingFields).toEqual([
      'identifier', 'manufacture.name', 'manufacture.street', 'manufacture.state', 'manufacture.email', 'manufacture.phone',
      'testing.parties[0].street', 'testing.parties[0].city', 'testing.parties[0].state', 'testing.parties[0].country', 'testing.parties[0].email', 'testing.parties[0].phone',
    ]);
    expect(res.items[0].certificateId).toBeUndefined();
    await expect(generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [item] })).rejects.toBeInstanceOf(TradeGccIncompleteError);
  });

  it('does not call an unlisted adult item "no GCC needed" until the certifier says no rule applies (review probe for C2)', async () => {
    const gas: GccItemInput = { htsCode: '3923.30.00.90', productName: 'Portable Gasoline Container', identifier: 'GAS-5', targetAge: 'adult' };
    const asked = await generateGccCertificate({ items: [gas], allowDraft: true });
    expect(asked.items[0].status).toBe('draft_needs_info');
    expect(asked.items[0].missingFields).toContain('citations');
    const none = await generateGccCertificate({ items: [{ ...gas, citations: [] }] });
    expect(none.items[0].status).toBe('exempt_no_gcc_needed');
    expect(none.items[0].disclaimCode).toBeUndefined();
    expect(none.items[0].filingNote).toContain('CPSC の一覧に無い');
  });

  it('does not give Disclaim A to an adult dresser on a children’s furniture code (review probe for C3)', async () => {
    const dresser: GccItemInput = { htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult' };
    expect((await generateGccCertificate({ items: [dresser], allowDraft: true })).items[0].status).toBe('draft_needs_info');
    const stated = await generateGccCertificate({ items: [{ ...dresser, citations: [] }] });
    expect(stated.items[0]).toMatchObject({ status: 'exempt_no_gcc_needed', disclaimCode: 'A', cpscListCategory: 'Other Children’s Furniture' });
    expect(stated.items[0].warnings?.[0]).toContain('Other Children’s Furniture');
  });

  it('gives Disclaim B with IUC 130.006 to adult apparel exempt under 16 CFR 1610.1(d) without the certifier', async () => {
    const res = await generateGccCertificate({ items: [TEE] });
    expect(res.items[0]).toMatchObject({ status: 'exempt_disclaim_b', disclaimCode: 'B', intendedUseCode: '130.006' });
    expect(res.overallStatus).toBe('exempt');
    expect(res.missingFields).toBeUndefined();
  });

  it('identifies the 16 CFR 1610.1(d) testing exclusion in a GCC instead of a test record (16 CFR 1110.11(c))', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...TEE, citations: ['16 CFR 1610'], manufacture: FACTORY }] });
    expect(res.items[0]).toMatchObject({ status: 'generated', testingExclusions: ['16 CFR 1610.1(d)(2)'] });
  });

  it('keeps a button-cell product a draft until 16 CFR 1263 is among the citations', async () => {
    const wrong = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...PENLIGHT, citations: ['16 CFR 1203'] }] });
    expect(wrong.items[0].status).toBe('draft_needs_info');
    expect(wrong.items[0].clarifyingQuestions?.join('')).toContain('16 CFR 1263');
    const right = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...PENLIGHT, citations: ['16 CFR 1263'] }] });
    expect(right.items[0].status).toBe('generated');
  });

  it('does not make a GCC for children’s products and asks for the age when it is missing', async () => {
    const child = await generateGccCertificate({ items: [{ htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1', targetAge: 'child' }] });
    expect(child.items[0].status).toBe('cpc_required_instead');
    expect(child.overallStatus).toBe('cpc_required');
    const noAge = await generateGccCertificate({ allowDraft: true, items: [{ htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1' }] });
    expect(noAge.items[0].missingFields).toContain('targetAge');
  });

  it('takes each party whole from one source and never mixes the caller’s and the server’s values (review probe for I2)', async () => {
    const prev = process.env.SORA_GCC_CERTIFIER;
    process.env.SORA_GCC_CERTIFIER = JSON.stringify({ ...CERTIFIER, name: 'Server Default LLC', email: 'ops@server-default.test' });
    try {
      const mixed = await generateGccCertificate({ certifier: { name: 'Caller Brand Inc.' }, recordCustodian: CUSTODIAN, items: [HELMET], allowDraft: true });
      expect(mixed.missingFields).toEqual(['certifier.street', 'certifier.city', 'certifier.state', 'certifier.country', 'certifier.email', 'certifier.phone']);
      expect(mixed.packageHtml).not.toContain('ops@server-default.test');
      const fromEnv = await generateGccCertificate({ recordCustodian: CUSTODIAN, items: [HELMET] });
      expect(fromEnv.items[0].status).toBe('generated');
      expect(fromEnv.packageHtml).toContain('ops@server-default.test');
      process.env.SORA_GCC_CERTIFIER = '{not json';
      await expect(generateGccCertificate({ recordCustodian: CUSTODIAN, items: [HELMET] })).rejects.toThrow('SORA_GCC_CERTIFIER');
    } finally {
      if (prev === undefined) delete process.env.SORA_GCC_CERTIFIER;
      else process.env.SORA_GCC_CERTIFIER = prev;
    }
  });

  it('rejects an HTS code that is not 10 digits, no items and more than 50 items (I5, I10)', async () => {
    await expect(generateGccCertificate({ items: [{ ...HELMET, htsCode: '6506.10' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(generateGccCertificate({ items: [{ ...HELMET, productName: '  ' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(generateGccCertificate({ items: [{ ...HELMET, citations: [' '] }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(GenerateGccCertificateRequestSchema.safeParse({}).success).toBe(false);
    expect(GenerateGccCertificateRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(GenerateGccCertificateRequestSchema.safeParse({ items: Array.from({ length: 51 }, () => HELMET) }).success).toBe(false);
    const fifty = Array.from({ length: 50 }, () => HELMET);
    expect(GenerateGccCertificateRequestSchema.safeParse({ items: fifty }).success).toBe(true);
    expect((await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: fifty })).counts.gccGenerated).toBe(50);
  });

  it('gives stable IDs without a date, different for different products (M1)', async () => {
    const a1 = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    const a2 = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(a2.packageId).toBe(a1.packageId);
    expect(a2.items[0].certificateId).toBe(a1.items[0].certificateId);
    const other = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...HELMET, identifier: 'HLM-002' }] });
    expect(other.items[0].certificateId).not.toBe(a1.items[0].certificateId);
    const t1 = await generateGccCertificate({ items: [{ htsCode: '6109.90.10.07', productName: 'Adult Polyester T-Shirt', targetAge: 'adult', material: '100% polyester' }] });
    const t2 = await generateGccCertificate({ items: [{ htsCode: '6201.40.40.21', productName: 'Adult Nylon Jacket', targetAge: 'adult', material: '100% nylon' }] });
    expect(t1.packageId).not.toBe(t2.packageId);
  });

  it('returns a small summary and the HTML only: no Markdown and no per-item compliance result (I4, I6)', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, orderNumber: 'ORDER-1001', items: [HELMET, TEE] });
    expect(res.mode).toBe('order_package');
    expect(Object.keys(res).sort()).toEqual(['counts', 'disclaimer', 'generatedAt', 'items', 'mode', 'overallStatus', 'packageHtml', 'packageId']);
    for (const item of res.items) for (const k of ['compliance', 'certificateMarkdown', 'certificateHtml', 'statutoryFields', 'aceFilingGuidance']) expect(item).not.toHaveProperty(k);
  });
  it('keeps 16 CFR 1610 on an unlisted garment code with a coin cell (review F1)', async () => {
    const shirt: GccItemInput = { ...PENLIGHT, htsCode: '6109.10.00.12', productName: 'Adult Cotton T-Shirt With LED Badge', identifier: 'TEE-LED-1', material: '100% cotton' };
    const only1263 = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...shirt, citations: ['16 CFR 1263'] }] });
    expect(only1263.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['citations'] });
    expect(only1263.items[0].clarifyingQuestions?.join('')).toContain('16 CFR 1610');
    const both = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...shirt, citations: ['16 CFR 1263', '16 CFR 1610'] }] });
    expect(both.items[0].status).toBe('generated');
  });

  it('keeps an item with a battery of unknown type a draft, because the type decides 16 CFR 1263 (review m1)', async () => {
    const parties = { certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true };
    const helmet = await generateGccCertificate({ ...parties, items: [{ ...HELMET, hasBattery: true }] });
    expect(helmet.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['batteryType'] });
    expect(helmet.items[0].clarifyingQuestions?.join('')).toContain('16 CFR 1263');
    const moreMissing = await generateGccCertificate({ ...parties, items: [{ ...HELMET, hasBattery: true, identifier: undefined }] });
    expect(moreMissing.items[0].missingFields).toEqual(['batteryType', 'identifier']);
    const exemptGarment = await generateGccCertificate({ allowDraft: true, items: [{ ...TEE, hasBattery: true }] });
    expect(exemptGarment.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['batteryType'] });
    const noRule = await generateGccCertificate({ allowDraft: true, items: [{ htsCode: '3923.30.00.90', productName: 'Portable Gasoline Container', identifier: 'GAS-5', targetAge: 'adult', citations: [], hasBattery: true }] });
    expect(noRule.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['batteryType'] });
    const knownType = await generateGccCertificate({ ...parties, items: [{ ...HELMET, hasBattery: true, batteryType: 'other' }] });
    expect(knownType.items[0].status).toBe('generated');
  });

  it('reads "16 C.F.R." the same as "16 CFR" (review m2)', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...PENLIGHT, citations: ['16 C.F.R. 1263'] }] });
    expect(res.items[0].status).toBe('generated');
  });

  it('accepts 16 CFR 1250 in place of 1263 only on a code in the Toys list (16 CFR 1263.1(c))', async () => {
    const toy: GccItemInput = { ...PENLIGHT, htsCode: '9503.00.00.73', productName: 'Adult Collectible Figure With Light', identifier: 'FIG-1', citations: ['16 CFR 1250'] };
    expect((await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [toy] })).items[0].status).toBe('generated');
    const notToy = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...PENLIGHT, citations: ['16 CFR 1250'] }] });
    expect(notToy.items[0]).toMatchObject({ status: 'draft_needs_info', missingFields: ['citations'] });
  });

  it('asks for a test party when testing.parties is empty', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...HELMET, testing: { date: '2026-06-15', parties: [] } }] });
    expect(res.items[0].missingFields).toEqual(['testing.parties']);
  });

  it('reports the line of each draft in a generated and draft mix', async () => {
    const err = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET, { ...HELMET, identifier: undefined }] }).catch((e) => e);
    expect(err).toBeInstanceOf(TradeGccIncompleteError);
    expect(err.details.items.map((item: { line: number }) => item.line)).toEqual([2]);
    expect(err.details.missingFields).toEqual([]);
  });

  it('uses a valid server default on an all-exempt package too (review m5)', async () => {
    process.env.SORA_GCC_CERTIFIER = JSON.stringify({ ...CERTIFIER, email: 'ops@server-default.test' });
    const order = await generateGccCertificate({ orderNumber: 'ORDER-1001', items: [TEE] });
    expect(order.items[0].status).toBe('exempt_disclaim_b');
    expect(order.packageHtml.split('ops@server-default.test').length - 1).toBe(1); // Disclaim B の紙の Declared by（表紙は名前だけ）
    expect(order.packageHtml.split('Acme Imports LLC').length - 1).toBe(2); // 表紙と Declared by
    expect((await generateGccCertificate({ items: [TEE] })).packageHtml).toContain('ops@server-default.test');
  });

  it('ignores a broken server default when no certificate needs it, and reports it as a server setting when one does (review m5)', async () => {
    process.env.SORA_GCC_CERTIFIER = '{not json';
    process.env.SORA_GCC_CUSTODIAN = '[1]';
    const exempt = await generateGccCertificate({ orderNumber: 'ORDER-1001', items: [TEE] });
    expect(exempt.items[0].status).toBe('exempt_disclaim_b');
    expect(exempt.packageHtml).not.toContain('[MISSING');
    const err = await generateGccCertificate({ recordCustodian: CUSTODIAN, items: [HELMET] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TradeInputError);
    expect(err.message).toContain('SORA_GCC_CERTIFIER');
  });

  it('gives the same certificate id whatever the key order of the records (review m6)', async () => {
    const reversed = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).reverse()) as T;
    const a = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    const b = await generateGccCertificate({
      certifier: reversed(CERTIFIER),
      recordCustodian: reversed(CUSTODIAN),
      items: [{ ...HELMET, manufacture: reversed(FACTORY), testing: reversed({ date: '2026-06-15', reportNumber: 'TR-0001', parties: [reversed(LAB)] }) }],
    });
    expect(b.items[0].certificateId).toBe(a.items[0].certificateId);
  });

  it('rejects sample or placeholder values in what the caller sent, even with allowDraft, but not in the server defaults (M2)', async () => {
    const err = await generateGccCertificate({
      allowDraft: true,
      certifier: { ...CERTIFIER, name: 'Sample Exporter Inc.', email: 'compliance@acme-imports.example.com', phone: '+81-3-0000-0000' },
      recordCustodian: CUSTODIAN,
      items: [{ ...HELMET, manufacture: { ...FACTORY, date: 'TBD', city: '仮置き工場', country: 'Unknown' } }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TradeInputError);
    expect(err.code).toBe('UNVERIFIED_PLACEHOLDER_INPUT');
    for (const field of ['certifier.name', 'certifier.email', 'certifier.phone', 'items[0].manufacture.date', 'items[0].manufacture.city', 'items[0].manufacture.country']) expect(err.message).toContain(field);
    process.env.SORA_GCC_CERTIFIER = JSON.stringify({ ...CERTIFIER, email: 'compliance@acme-imports.example.com' });
    const res = await generateGccCertificate({ recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(res.items[0].status).toBe('generated');
  });

  it('prints only the caller’s citations, never a rule Sora derived', async () => {
    const cited = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...PENLIGHT, citations: ['16 CFR 1263'] }] });
    expect(cited.packageHtml).toContain('16 CFR 1263');
    expect(cited.packageHtml).not.toContain('ANSI/UL 4200A');
    const draft = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [PENLIGHT], allowDraft: true });
    expect(draft.items[0].clarifyingQuestions?.[0]).toContain('16 CFR 1263');
    expect(draft.packageHtml).not.toContain('16 CFR 1263');
  });

  it('asks about 16 CFR 1610.1(c) for an adult hat instead of citing 16 CFR 1610 on its own', async () => {
    const hat: GccItemInput = { htsCode: '6505.00.60.30', productName: 'Adult Knit Cap', identifier: 'CAP-1', targetAge: 'adult' };
    const res = await generateGccCertificate({ items: [hat], allowDraft: true });
    expect(res.items[0].status).toBe('draft_needs_info');
    expect(res.items[0].missingFields).toContain('citations');
    expect(res.items[0].clarifyingQuestions?.[0]).toContain('16 CFR 1610.1(c)(1)');
    expect(res.items[0].citations).toBeUndefined();
    const stated = await generateGccCertificate({ items: [{ ...hat, citations: [] }] });
    expect(stated.items[0].status).toBe('exempt_no_gcc_needed');
    expect(stated.packageHtml).toContain('16 CFR 1610.1(c)(1)');
  });

  it('escapes every caller string in packageHtml (XSS)', async () => {
    const xss = `<script>alert("xss")</script><img src=x onerror=alert('1')>&"`;
    const party = { ...CERTIFIER, name: `Party ${xss}`, street: `Street ${xss}` };
    const res = await generateGccCertificate({
      orderNumber: `ORD-${xss}`,
      awbNumber: `AWB-${xss}`,
      certifier: party,
      recordCustodian: party,
      items: [{ ...HELMET, identifier: `SKU-${xss}`, productName: `Helmet ${xss}`, brand: `Brand ${xss}`, description: `Desc ${xss}`, citations: [`16 CFR 1203 ${xss}`], manufacture: { ...FACTORY, city: `City ${xss}` }, testing: { date: '2026-06-15', reportNumber: `TR ${xss}`, parties: [{ ...LAB, name: `Lab ${xss}` }] } }],
    });
    expect(res.packageHtml).not.toContain('<script>');
    expect(res.packageHtml).not.toContain('<img src=x');
    expect(res.packageHtml).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('GCC document (16 CFR 1110.11)', () => {
  /** 表の n 行目（16 CFR 1110.11(a)(n)）の値のセル */
  const row = (html: string, n: number) => html.match(new RegExp(`<tr><td class="n">${n}</td><th>[^<]*</th><td>(.*?)</td></tr>`))?.[1] ?? '';
  /** 下書きの題の下の行 */
  const missingLine = (html: string) => html.match(/<p>(Missing[^<]*)<\/p>/)?.[1];

  it('prints every element of 16 CFR 1110.11(a) and the attestation word for word', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    const html = res.packageHtml;
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(html).toContain(`16 CFR 1110.11(a)(${n})`);
    expect(html).toContain(GCC_ATTESTATION);
    expect(html).toContain('SKU: HLM-001');
    expect(html).toContain('<li>16 CFR 1203</li>');
    for (const v of ['100 Example Street', 'Anytown, CA', 'compliance@acme-imports.test', '+1-202-555-0104', 'Acme Helmet Factory', 'Date of manufacture: 2026-06', 'Most recent test: 2026-06-15', res.items[0].certificateId!]) expect(html).toContain(v);
    expect(html).toContain('the importer for imported products');
    expect(html).not.toContain('importer of record');
    // 値は自分の行にある: 記録の担当は (a)(4)、証明者は (a)(3)
    expect(row(html, 3)).toContain('compliance@acme-imports.test');
    expect(row(html, 3)).not.toContain('records@acme-imports.test');
    for (const v of ['Compliance Manager', 'records@acme-imports.test', '+1-202-555-0102']) expect(row(html, 4)).toContain(v);
    expect(row(html, 4)).not.toContain('compliance@acme-imports.test');
    expect(row(html, 5)).toContain('Acme Helmet Factory');
    expect(row(html, 6)).toContain('Acme Test Lab');
    expect(html).toContain('<title>GCC — Adult Bicycle Helmet</title>');
    expect(html).toContain('Filing: see 16 CFR 1110.13.');
    expect(html).not.toMatch(/direct.to.consumer/i);
  });

  it('marks a draft as not valid and shows each missing element', async () => {
    const res = await generateGccCertificate({ allowDraft: true, items: [{ ...HELMET, identifier: undefined }] });
    expect(res.packageHtml).toContain('DRAFT');
    expect(res.packageHtml).toContain('[MISSING: identifier]');
    expect(res.packageHtml).toContain('[MISSING: certifier]');
    expect(res.packageHtml).not.toContain('[MISSING: certifier.name]');
    expect(res.packageHtml).not.toMatch(/\bREADY\b/);
  });

  it('does not print the attestation on a draft, and prints one marker for a party that is wholly absent', async () => {
    const res = await generateGccCertificate({ allowDraft: true, items: [{ htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult' }] });
    const html = res.packageHtml;
    expect(html).not.toContain(GCC_ATTESTATION);
    expect(html).toContain('[Not attested: this is a draft]');
    for (const key of ['certifier', 'recordCustodian', 'manufacture', 'testing']) expect(html).toContain(`[MISSING: ${key}]`);
    expect(html).not.toMatch(/\[MISSING: (certifier|recordCustodian|manufacture|testing)\./);
    const partly = await generateGccCertificate({ allowDraft: true, certifier: { name: 'Caller Brand Inc.' }, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(partly.packageHtml).toContain('[MISSING: certifier.street]');
    expect(partly.packageHtml).not.toContain('[MISSING: certifier]');
    expect((await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] })).packageHtml).toContain(GCC_ATTESTATION);
  });

  it('keeps 50 drafts with nothing filled in within the response target (150,000 characters)', async () => {
    const res = await generateGccCertificate({ allowDraft: true, items: Array.from({ length: 50 }, (_, i) => ({ htsCode: '9403.50.90.80', productName: `Wooden Dresser ${i}`, identifier: `DRS-${i}`, targetAge: 'adult' as const })) });
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(150_000);
  });

  it('identifies the testing exclusion in place of the test date and place (16 CFR 1110.11(c))', async () => {
    const res = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...TEE, citations: ['16 CFR 1610'], manufacture: FACTORY }] });
    expect(res.packageHtml).toContain('Testing exclusion for 16 CFR 1610: 16 CFR 1610.1(d)(2)');
    expect(res.packageHtml).toContain('in lieu of the test date and place (16 CFR 1110.11(c))');
  });

  it('asks for the test record only when a cited rule has no testing exclusion', async () => {
    const only1610 = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...TEE, citations: ['16 CFR 1610'] }] });
    expect(only1610.packageHtml).toContain('[MISSING: manufacture]');
    expect(only1610.packageHtml).not.toContain('Most recent test');
    expect(only1610.packageHtml).not.toContain('[MISSING: testing.');
    const both = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...TEE, citations: ['16 CFR 1203', '16 CFR 1610'], manufacture: FACTORY }] });
    expect(both.packageHtml).toContain('[MISSING: testing]');
    expect(both.packageHtml).toContain('Testing exclusion for 16 CFR 1610: 16 CFR 1610.1(d)(2)');
    expect(missingLine(both.packageHtml)).toBe('Missing elements are marked below.');
    const dateOnly = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...HELMET, testing: { date: '2026-06-15' } }] });
    expect(dateOnly.packageHtml).toContain('Most recent test: 2026-06-15');
    expect(dateOnly.packageHtml).toContain('[MISSING: testing.parties]');
  });

  it('prints every cited rule in the rules row, also on a draft whose age is not known yet', async () => {
    const both = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [{ ...PENLIGHT, citations: ['16 CFR 1263', '16 CFR 1203'] }] });
    expect(row(both.packageHtml, 2)).toBe('<ul><li>16 CFR 1263</li><li>16 CFR 1203</li></ul>');
    const noAge = await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, allowDraft: true, items: [{ ...HELMET, targetAge: undefined }] });
    expect(noAge.items[0].missingFields).toEqual(['targetAge']);
    expect(row(noAge.packageHtml, 2)).toBe('<ul><li>16 CFR 1203</li></ul>');
    expect(noAge.packageHtml).not.toContain('[MISSING: citations]');
    expect(missingLine(noAge.packageHtml)).toBe('Missing: targetAge');
  });

  it('does not repeat the markers in the draft’s Missing line', async () => {
    const partly = await generateGccCertificate({ allowDraft: true, certifier: { name: 'Caller Brand Inc.' }, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(partly.packageHtml).toContain('[MISSING: certifier.street]');
    expect(missingLine(partly.packageHtml)).toBe('Missing elements are marked below.');
    const allMissing = await generateGccCertificate({ allowDraft: true, items: [{ htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult' }] });
    for (const key of ['certifier', 'recordCustodian', 'manufacture', 'testing', 'citations']) expect(allMissing.packageHtml).toContain(`[MISSING: ${key}]`);
    expect(missingLine(allMissing.packageHtml)).toBe('Missing: material');
    expect(missingLine((await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] })).packageHtml)).toBeUndefined();
  });

  it('puts DRAFT in the title of a single-product draft, which print headers and PDF names use', async () => {
    const res = await generateGccCertificate({ allowDraft: true, items: [HELMET] });
    expect(res.packageHtml).toContain('<title>DRAFT GCC — Adult Bicycle Helmet</title>');
  });
});

describe('exemption statements, cover sheet and FDA note', () => {
  /** 表紙（最初の節） */
  const cover = (html: string) => html.split('<section')[1] ?? '';
  const MUG: GccItemInput = { htsCode: '6912.00.44.00', productName: 'Stoneware Coffee Mug', identifier: 'MUG-1', targetAge: 'adult', foodContact: true, citations: [] };
  const FCS_NOTE = 'FDA FD1: no Prior Notice (21 CFR 1.276(b)(5)(i)(A)); the MID needs the manufacturer’s name and address.';
  const FCS_UNSTATED = 'FDA FD1: food contact use not stated — if it touches food, no Prior Notice (21 CFR 1.276(b)(5)(i)(A)); if not, file the FDA disclaimer.';
  const title = (html: string) => html.match(/<title>(.*?)<\/title>/)?.[1];
  const authority = (html: string) => html.match(/<small>(.*?)<\/small>/)?.[1];

  it('writes the Disclaim B statement with the 2016 policy’s exact title, citation and effective date (C5)', async () => {
    const html = (await generateGccCertificate({ items: [TEE] })).packageHtml;
    expect(html).toContain(ADULT_APPAREL_GCC_POLICY.title);
    expect(html).toContain('81 FR 12587');
    expect(html).toContain('March 25, 2016');
    expect(html).not.toContain('April 25, 2016');
    expect(html).not.toContain('March 24, 2016');
    expect(html).toContain(SECTION_1610_1_D['16 CFR 1610.1(d)(2)']);
    expect(html).toContain('Disclaim B with Intended Use Code 130.006');
    expect(html).toContain(`${ADULT_APPAREL_GCC_POLICY.title}, ${ADULT_APPAREL_GCC_POLICY.citation}, effective ${ADULT_APPAREL_GCC_POLICY.effective}.`);
    expect(html).toContain('Statement of Exemption — Adult Wearing Apparel (16 CFR 1610.1(d))');
    expect(html).toContain('Fiber content: 100% polyester');
    expect(html).toContain('The product must still meet the flammability requirements of 16 CFR 1610.');
    expect(html).not.toContain('Declared by');
  });

  it('bases a 16 CFR 1610.1(d)(1) exemption on the plain surface and the weight, and names the declaring certifier', async () => {
    const shirt: GccItemInput = { htsCode: '6109.10.00.12', productName: 'Adult Cotton T-Shirt', identifier: 'TEE-C1', targetAge: 'adult', material: '100% cotton', fabricSurface: 'plain', fabricWeightOzPerSqYd: 4 };
    const html = (await generateGccCertificate({ certifier: CERTIFIER, items: [shirt] })).packageHtml;
    expect(html).toContain(`16 CFR 1610.1(d)(1): ${SECTION_1610_1_D['16 CFR 1610.1(d)(1)']}`);
    expect(html).toContain('Fabric: plain surface, 4 oz/sq yd');
    expect(html).not.toContain('Fiber content');
    expect(html).toContain('Declared by');
    expect(html).toContain('compliance@acme-imports.test');
  });

  it('tells the filer that Disclaim A also needs an Intended Use Code (M4)', async () => {
    const res = await generateGccCertificate({ items: [{ htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult', citations: [] }] });
    expect(res.items[0].filingNote).toContain('Intended Use Code');
    expect(res.packageHtml).toContain('Intended Use Code');
    expect(res.packageHtml).toContain('Appendix R');
    expect(res.packageHtml).toContain('Statement — No CPSC Certificate Required');
    expect(res.packageHtml).toContain('Disclaim A may be filed. Every disclaimer needs an Intended Use Code (CATAIR, Disclaimer PG01 Note 1): choose it from CBP Appendix R, e.g. 130.XXX For Consumer Use as a Non-Food Product (besides 130.001-005).');
    expect(res.items[0].filingNote).toContain('130.001-005'); // 130.001-005 は子供の年齢帯の別のコード（CATAIR の除外）
    expect(res.packageHtml).toContain('The certifier states that no CPSC rule, ban, standard, or regulation requiring a certificate applies to this product.');
  });

  it('states the 16 CFR 1610.1(c) basis on a Disclaim A statement, and no ACE data for an unlisted code', async () => {
    const hat = await generateGccCertificate({ items: [{ htsCode: '6505.00.60.30', productName: 'Adult Knit Cap', identifier: 'CAP-1', targetAge: 'adult', citations: [] }] });
    expect(hat.packageHtml).toContain('Not subject to 16 CFR 1610 under 16 CFR 1610.1(c)(1): Hats, provided');
    expect(hat.packageHtml).toContain('The certifier states that no other CPSC rule requiring a certificate applies.');
    const gas = await generateGccCertificate({ items: [{ htsCode: '3923.30.00.90', productName: 'Portable Gasoline Container', identifier: 'GAS-5', targetAge: 'adult', citations: [] }] });
    expect(gas.packageHtml).toContain('The HTS code is not on CPSC’s eFiling list; no CPSC data is filed.');
    expect(gas.packageHtml).not.toContain('Appendix R');
  });

  it('does not claim FDA compliance for a mug without test data (review probe for C6)', async () => {
    const res = await generateGccCertificate({ orderNumber: 'ORDER-1002', items: [MUG, { ...MUG, identifier: 'MUG-2' }] });
    expect(res.items[0].fdaNote).toContain('21 CFR 1.276(b)(5)(i)(A)');
    expect(res.packageHtml).not.toMatch(/compl(?:y|ies) with FDA/i);
    expect(res.items[0].fdaNote).toBe(FCS_NOTE);
    // 表紙は同じ文を表の下に 1 回だけ出し、行には印（番号）を付ける
    const top = cover(res.packageHtml);
    expect(top.split(FCS_NOTE).length - 1).toBe(1);
    expect(top).toContain(`<b>Note 1:</b> ${FCS_NOTE}`);
    expect(top.match(/<td>1<\/td><\/tr>/g)?.length).toBe(2);
  });

  it('words the FDA note from checkFdaRegulated and leaves it out where FDA is not involved', async () => {
    const note = async (item: Partial<GccItemInput>) => (await generateGccCertificate({ allowDraft: true, items: [{ ...MUG, ...item }] })).items[0].fdaNote;
    expect(await note({ foodContact: false })).toBe('FDA FD1: not for food contact — file the FDA disclaimer.');
    expect(await note({ foodContact: true })).toBe(FCS_NOTE);
    expect(await note({ htsCode: '3304.99.50.00', productName: 'Face Cream', foodContact: undefined })).toBe('FDA FD2 (COS)');
    // 章からの推定は推定と書く（章に FDA の対象でない品が混ざる）
    expect(await note({ htsCode: '0901.21.00.00', productName: 'Roasted Coffee', foodContact: undefined })).toBe('FDA FD4 (FOO): estimated from the HTS chapter, confirm the item. If it is food, Prior Notice is required before arrival.');
    expect(await note({ htsCode: '9002.11.90.00', productName: 'Camera Lens', foodContact: undefined })).toBe('FDA FD2 (DEV): estimated from the HTS chapter, confirm the item.');
    // 食品接触の用途が分からない食器コードは、食品接触品と決めつけない
    expect(await note({ htsCode: '7013.99.90.00', productName: 'Decorative Glass Vase', foodContact: undefined })).toBe(FCS_UNSTATED);
    expect(await note({ htsCode: '7013.99.90.00', productName: 'Drinking Glass', foodContact: true })).toBe(FCS_NOTE);
    expect(await note({ htsCode: '6506.10.60.45', productName: 'Adult Bicycle Helmet', foodContact: undefined })).toBeUndefined();
    const helmet = await generateGccCertificate({ orderNumber: 'ORDER-1004', items: [{ ...HELMET, citations: [] }, TEE] });
    expect(cover(helmet.packageHtml)).not.toMatch(/FDA FD/);
  });

  it('puts the order, AWB and every line on the cover sheet and escapes every caller string (XSS)', async () => {
    const xss = `<script>alert("x")</script><img src=x onerror=alert('1')>&"`;
    const res = await generateGccCertificate({ orderNumber: `ORDER-${xss}`, awbNumber: 'TEST-AWB-0001', carrier: 'Courier', certifier: { ...CERTIFIER, name: `Acme ${xss}` }, recordCustodian: CUSTODIAN, items: [{ ...HELMET, productName: `Helmet ${xss}` }, TEE] });
    expect(res.packageHtml).toContain('TEST-AWB-0001');
    expect(res.packageHtml).not.toContain('<script>');
    expect(res.packageHtml).not.toContain('<img src=x');
    expect(res.packageHtml).toContain('&lt;script&gt;');
  });

  it('names every line of an order on the cover, with the CPSC action and the FDA note per line', async () => {
    const dresser: GccItemInput = { htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult', citations: [] };
    const gas: GccItemInput = { htsCode: '3923.30.00.90', productName: 'Portable Gasoline Container', identifier: 'GAS-5', targetAge: 'adult', citations: [] };
    const blocks: GccItemInput = { htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1', targetAge: 'child' };
    const res = await generateGccCertificate({
      certifier: CERTIFIER, recordCustodian: CUSTODIAN, orderNumber: 'ORDER-1005', awbNumber: 'TEST-AWB-0002', carrier: 'Courier', invoiceNumber: 'INV-1',
      items: [HELMET, TEE, dresser, gas, blocks, MUG],
    });
    const top = cover(res.packageHtml);
    expect(top).toContain('Customs Clearance Summary — CPSC (and FDA) PGA');
    for (const label of ['Package ID', 'Generated', 'Order #', 'AWB / Tracking #', 'Carrier', 'Invoice #', 'Certifier']) expect(top).toContain(`<b>${label}:</b>`);
    for (const v of [res.packageId, res.generatedAt, 'ORDER-1005', 'TEST-AWB-0002', 'Courier', 'INV-1', '<b>Certifier:</b> Acme Imports LLC']) expect(top).toContain(v);
    expect(top).not.toContain('compliance@acme-imports.test');
    expect(top).toContain('<tr><th>Line</th><th>Product</th><th>Identifier</th><th>HTS</th><th>CPSC</th><th>Note</th></tr>');
    for (const v of [`GCC attached (${res.items[0].certificateId})`, 'Disclaim B, IUC 130.006 (statement attached)', 'Disclaim A — IUC required', 'No CPSC data (HTS code not on CPSC list)', 'HOLD — CPC required', `<b>Note 1:</b> ${FCS_NOTE}`]) expect(top).toContain(v);
    expect(top.match(/<td class="n">\d+<\/td>/g)?.length).toBe(6);
    // 表紙のあとに、GCC・Disclaim B・CPC の節だけを続ける（Disclaim A の節は付けない）
    expect(res.packageHtml.match(/<section/g)?.length).toBe(4);
    expect(res.packageHtml).not.toContain('Statement — No CPSC Certificate Required');
    const draft = await generateGccCertificate({ allowDraft: true, certifier: CERTIFIER, recordCustodian: CUSTODIAN, orderNumber: 'ORDER-1006', items: [{ ...HELMET, identifier: undefined }] });
    expect(cover(draft.packageHtml)).toContain('DRAFT — missing: identifier');
  });

  it('keeps the cover’s Certifier line only when a certificate needs one, and marks it missing then', async () => {
    const dresser: GccItemInput = { htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult', citations: [] };
    const blocks: GccItemInput = { htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1', targetAge: 'child' };
    const noCertificate = await generateGccCertificate({ orderNumber: 'ORDER-1007', items: [TEE, dresser, blocks] });
    expect(cover(noCertificate.packageHtml)).not.toContain('Certifier');
    expect(noCertificate.packageHtml).not.toContain('[MISSING');
    const draft = await generateGccCertificate({ allowDraft: true, orderNumber: 'ORDER-1007', items: [TEE, HELMET] });
    expect(draft.items[1].status).toBe('draft_needs_info');
    expect(cover(draft.packageHtml)).toContain('<b>Certifier:</b> [MISSING: certifier]');
    const unknownAge = await generateGccCertificate({ allowDraft: true, orderNumber: 'ORDER-1007', items: [{ ...HELMET, targetAge: undefined }, TEE] });
    expect(cover(unknownAge.packageHtml)).toContain('<b>Certifier:</b> [MISSING: certifier]');
    const nameless = await generateGccCertificate({ allowDraft: true, orderNumber: 'ORDER-1007', certifier: { ...CERTIFIER, name: undefined }, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(cover(nameless.packageHtml)).toContain('<b>Certifier:</b> [MISSING: certifier.name]');
    const noCustodian = await generateGccCertificate({ allowDraft: true, orderNumber: 'ORDER-1007', certifier: CERTIFIER, items: [HELMET, { ...HELMET, identifier: undefined }] });
    expect(cover(noCustodian.packageHtml)).toContain('DRAFT — missing: recordCustodian</td>'); // 証明者は渡されているので、名前を挙げない
    expect(cover(noCustodian.packageHtml)).toContain('DRAFT — missing: identifier, recordCustodian</td>');
    expect(cover(noCustodian.packageHtml)).not.toContain('missing: certifier');
    const partly = await generateGccCertificate({ allowDraft: true, orderNumber: 'ORDER-1007', certifier: { name: 'Caller Brand Inc.' }, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(cover(partly.packageHtml)).toContain('DRAFT — missing: certifier</td>'); // 欠けた項目は証明書の表の印が示す
    const noParties = await generateGccCertificate({ allowDraft: true, orderNumber: 'ORDER-1007', items: [HELMET] });
    expect(cover(noParties.packageHtml)).toContain('DRAFT — missing: certifier, recordCustodian</td>');
    const given = await generateGccCertificate({ orderNumber: 'ORDER-1007', certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] });
    expect(cover(given.packageHtml)).toContain('<b>Certifier:</b> Acme Imports LLC');
    expect(cover(given.packageHtml)).not.toContain('[MISSING');
  });

  it('prints a CPC notice, not a GCC, for children’s products', async () => {
    const html = (await generateGccCertificate({ items: [{ htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1', targetAge: 'child' }] })).packageHtml;
    expect(html).toContain('Children’s Product Certificate');
    expect(html).not.toContain('General Certificate of Conformity');
    expect(html).toContain('Children’s Product — CPC Required (no GCC issued)');
    expect(html).toContain('Children’s products (12 years of age or younger) need a Children’s Product Certificate (CPC) under 16 CFR part 1107, based on testing by a CPSC-accepted third party conformity assessment body. This tool does not issue CPCs.');
  });

  it('breaks the page before every section after the first, with a print CSS of at most 1,500 characters', async () => {
    const html = (await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, orderNumber: 'ORDER-1008', items: [HELMET, TEE] })).packageHtml;
    const css = html.match(/<style>(.*?)<\/style>/)?.[1] ?? '';
    expect(css.length).toBeGreaterThan(0);
    expect(css.length).toBeLessThanOrEqual(1500);
    expect(css).toContain('page-break-before:always;break-before:page');
    expect(html).not.toContain('class="page"');
  });

  it('titles each paper by what it is, and only a certificate is titled "GCC" (I1)', async () => {
    const dresser: GccItemInput = { htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult', citations: [] };
    const blocks: GccItemInput = { htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1', targetAge: 'child' };
    expect(title((await generateGccCertificate({ items: [TEE] })).packageHtml)).toBe('Statement of Exemption — Adult Polyester T-Shirt');
    expect(title((await generateGccCertificate({ items: [dresser] })).packageHtml)).toBe('No CPSC Certificate — Wooden Dresser');
    expect(title((await generateGccCertificate({ items: [blocks] })).packageHtml)).toBe('CPC Required — Wooden Blocks');
    expect(title((await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] })).packageHtml)).toBe('GCC — Adult Bicycle Helmet');
    expect(title((await generateGccCertificate({ allowDraft: true, items: [HELMET] })).packageHtml)).toBe('DRAFT GCC — Adult Bicycle Helmet');
    // 注文は、GCC が 1 つも無くても表紙の題
    expect(title((await generateGccCertificate({ orderNumber: 'ORDER-2', items: [TEE, blocks] })).packageHtml)).toBe('Customs Clearance Summary — ORDER-2');
    expect(title((await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, awbNumber: 'TEST-AWB-0003', items: [HELMET, TEE] })).packageHtml)).toBe('Customs Clearance Summary — TEST-AWB-0003');
  });

  it('heads each paper with its own authority, not the certificate part (I2)', async () => {
    const dresser: GccItemInput = { htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult', citations: [] };
    const blocks: GccItemInput = { htsCode: '9503.00.00.73', productName: 'Wooden Blocks', identifier: 'BLK-1', targetAge: 'child' };
    expect(authority((await generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, items: [HELMET] })).packageHtml)).toBe('16 CFR Part 1110');
    expect(authority((await generateGccCertificate({ allowDraft: true, items: [HELMET] })).packageHtml)).toBe('16 CFR Part 1110');
    expect(authority((await generateGccCertificate({ items: [TEE] })).packageHtml)).toBe('16 CFR 1610.1(d)');
    expect(authority((await generateGccCertificate({ items: [dresser] })).packageHtml)).toBe('CPSC eFiling');
    expect(authority((await generateGccCertificate({ items: [blocks] })).packageHtml)).toBe('16 CFR Part 1107');
    const order = (await generateGccCertificate({ orderNumber: 'ORDER-3', items: [TEE, blocks] })).packageHtml;
    expect(order).not.toContain('16 CFR Part 1110');
  });

  it('names the declaring certifier on a Disclaim A statement, as on Disclaim B (M1)', async () => {
    const dresser: GccItemInput = { htsCode: '9403.50.90.80', productName: 'Wooden Dresser', identifier: 'DRS-1', targetAge: 'adult', citations: [] };
    const given = (await generateGccCertificate({ certifier: CERTIFIER, items: [dresser] })).packageHtml;
    expect(given).toContain('Declared by');
    expect(given).toContain('compliance@acme-imports.test');
    expect((await generateGccCertificate({ items: [dresser] })).packageHtml).not.toContain('Declared by');
  });

  it('keeps 10 and 50 food-contact items within the response targets (35,000 and 150,000 characters), with each FDA note once on the cover (I4)', async () => {
    const mug = (i: number): GccItemInput => ({ ...HELMET, htsCode: '6912.00.44.00', productName: `Adult Stoneware Mug Model ${i}`, identifier: `MUG-${String(i).padStart(4, '0')}`, foodContact: true, citations: ['16 CFR 1303'] });
    const make = (n: number) => generateGccCertificate({ certifier: CERTIFIER, recordCustodian: CUSTODIAN, orderNumber: 'ORDER-1009', items: Array.from({ length: n }, (_, i) => mug(i + 1)) });
    const ten = await make(10);
    expect(ten.counts.gccGenerated).toBe(10);
    expect(JSON.stringify(ten).length).toBeLessThanOrEqual(35_000);
    const fifty = await make(50);
    expect(fifty.counts.gccGenerated).toBe(50);
    expect(fifty.items.every((item) => item.fdaNote === FCS_NOTE)).toBe(true);
    expect(cover(fifty.packageHtml).split(FCS_NOTE).length - 1).toBe(1);
    expect(JSON.stringify(fifty).length).toBeLessThanOrEqual(150_000);
  });
});
