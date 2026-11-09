import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { clearCache } from '../cache.js';
import { installExternalApiFixtures } from '../test_fixtures/external_apis.js';
import { resetCrossBreakerForTest } from './cbp_cross.js';
import { TradeGccIncompleteError, generateGccCertificate } from './gcc.js';
import { resetHtsDataForTest } from './hts_data.js';
import { TradeInputError } from './trade.js';

describe('GCC', () => {
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = installExternalApiFixtures();
  });
  afterAll(() => restore?.());
  beforeEach(() => {
    clearCache();
    resetCrossBreakerForTest();
    resetHtsDataForTest();
  });

  describe('generateGccCertificate & checkProductCompliance GCC integration', () => {
    const sampleCertifier = {
      name: 'Acme Imports LLC',
      address: '100 Example Street, Anytown, CA, United States',
      email: 'compliance@acme-imports.test',
      phone: '+1-213-555-0199',
    };
    const sampleCustodian = {
      name: 'Compliance Manager',
      address: '100 Example Street, Anytown, CA, United States',
      email: 'qa-records@acme-imports.test',
      phone: '+1-202-555-0103',
    };

    it('generates a complete 7-element 16 CFR 1110.11 GCC (JSON, Markdown, print HTML) for a regulated SKU', async () => {
      const res = await generateGccCertificate({
        productName: 'Official Concert LED Penlight',
        sku: 'PEN-2026-TOUR',
        brand: 'Acme',
        modelOrBatch: 'LOT-2026-09A',
        description: 'Handheld LED concert penlight using LR44 button cells',
        htsCode: '9405.42.84.40',
        targetAge: 'adult',
        material: 'ABS plastic',
        hasBattery: true,
        batteryType: 'button_coin',
        certifier: sampleCertifier,
        recordCustodian: sampleCustodian,
        manufacture: {
          date: '2026-09',
          city: 'Shenzhen, Guangdong',
          country: 'China',
          manufacturerName: 'Acme Electronics Factory',
        },
        testing: {
          date: '2026-09-18',
          location: 'Shenzhen, China',
          laboratoryName: 'Acme Test Lab',
          laboratoryAddress: '2 Example Road, Shenzhen, Guangdong, China',
          laboratoryPhone: '+1-202-555-0104',
          reportNumber: 'TR-0001',
        },
      });

      expect(res.mode).toBe('single_product');
      expect(res.overallStatus).toBe('ready');
      expect(res.counts.gccGenerated).toBe(1);
      const item = res.items[0];
      expect(item.status).toBe('generated');
      expect(item.missingFields).toEqual([]);
      expect(item.aceFilingGuidance.eFilingRequired).toBe(true);
      expect(item.statutoryFields?.productIdentification.sku).toBe('PEN-2026-TOUR');
      expect(item.statutoryFields?.citations.some((c) => c.includes('16 CFR 1263'))).toBe(true);
      expect(item.statutoryFields?.certifier?.name).toBe('Acme Imports LLC');
      expect(item.statutoryFields?.recordCustodian?.email).toBe('qa-records@acme-imports.test');
      expect(item.statutoryFields?.manufactureDateAndPlace).toMatchObject({
        date: '2026-09',
        city: 'Shenzhen, Guangdong',
        country: 'China',
      });
      expect(item.statutoryFields?.testingLaboratory.name).toContain('Acme Test Lab');
      expect(item.certificateMarkdown).toContain('General Certificate of Conformity');
      expect(item.certificateMarkdown).toContain('PEN-2026-TOUR');
      expect(item.certificateMarkdown).toContain('16 CFR 1263');
      expect(res.packageHtml).toContain('<!DOCTYPE html>');
      expect(res.packageHtml).toContain('@media print');
    });

    it('fails closed with TradeGccIncompleteError by default when statutory fields are missing, and returns draft_needs_info only with allowDraft: true', async () => {
      const incompleteInput = {
        productName: 'Tour Brushed Fleece Pullover Hoodie',
        sku: 'HD-COT-BLK-M',
        htsCode: '6109.10.00.12',
        targetAge: 'adult' as const,
        material: '80% cotton 20% polyester',
        fabricSurface: 'raised' as const,
        fabricWeightOzPerSqYd: 9.1,
      };

      let caught: unknown;
      try {
        await generateGccCertificate(incompleteInput);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TradeGccIncompleteError);
      const incompleteErr = caught as TradeGccIncompleteError;
      expect(incompleteErr.code).toBe('MISSING_REQUIRED_GCC_FIELDS');
      expect(incompleteErr.missingFields).toContain('certifier.name');
      expect(incompleteErr.missingFields).toContain('certifier.email');
      expect(incompleteErr.missingFields).toContain('recordCustodian.email');
      expect(incompleteErr.missingFields).toContain('manufacture.date');
      expect(incompleteErr.missingFields).toContain('testing.laboratoryName');

      const res = await generateGccCertificate({
        ...incompleteInput,
        allowDraft: true,
      });

      expect(res.overallStatus).toBe('partial_or_draft');
      const item = res.items[0];
      expect(item.status).toBe('draft_needs_info');
      expect(item.missingFields).toContain('certifier.name');
      expect(item.missingFields).toContain('certifier.address');
      expect(item.missingFields).toContain('certifier.email');
      expect(item.missingFields).toContain('certifier.phone');
      expect(item.missingFields).toContain('recordCustodian.name');
      expect(item.missingFields).toContain('recordCustodian.email');
      expect(item.missingFields).toContain('manufacture.date');
      expect(item.missingFields).toContain('manufacture.city');
      expect(item.missingFields).toContain('manufacture.country');
      expect(item.missingFields).toContain('testing.date');
      expect(item.missingFields).toContain('testing.laboratoryName');
      expect(item.certificateMarkdown).toContain('DRAFT');
    });

    it('rejects sample, placeholder, or uncertain values in statutory GCC fields even when allowDraft is true', async () => {
      let caught: unknown;
      try {
        await generateGccCertificate({
          productName: 'Tour Brushed Fleece Pullover Hoodie',
          sku: 'HD-COT-BLK-M',
          htsCode: '6109.10.00.12',
          targetAge: 'adult',
          material: '100% cotton',
          fabricSurface: 'raised',
          fabricWeightOzPerSqYd: 9.4,
          allowDraft: true,
          certifier: {
            name: 'Sample Exporter Inc.',
            address: '100 Example Street, Anytown, CA',
            email: 'compliance@acme-imports.example.com',
            phone: '+81-3-0000-0000',
          },
          manufacture: {
            date: 'TBD',
            city: '仮置き工場',
            country: 'Unknown',
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TradeInputError);
      const inputErr = caught as TradeInputError;
      expect(inputErr.code).toBe('UNVERIFIED_PLACEHOLDER_INPUT');
      expect(inputErr.message).toContain('certifier.name');
      expect(inputErr.message).toContain('certifier.email');
      expect(inputErr.message).toContain('certifier.phone');
      expect(inputErr.message).toContain('manufacture.date');
      expect(inputErr.message).toContain('manufacture.city');
      expect(inputErr.message).toContain('manufacture.country');
    });

    it('uses pre-configured SORA_GCC_CERTIFIER_* and SORA_GCC_CUSTODIAN_* environment defaults without requiring LLM lookup', async () => {
      const envKeys = [
        'SORA_GCC_CERTIFIER_NAME',
        'SORA_GCC_CERTIFIER_ADDRESS',
        'SORA_GCC_CERTIFIER_EMAIL',
        'SORA_GCC_CERTIFIER_PHONE',
        'SORA_GCC_CUSTODIAN_NAME',
      ] as const;
      const prev: Record<string, string | undefined> = {};
      for (const k of envKeys) prev[k] = process.env[k];

      process.env.SORA_GCC_CERTIFIER_NAME = 'Acme Imports LLC';
      process.env.SORA_GCC_CERTIFIER_ADDRESS = '100 Example Street, Anytown, CA, United States';
      process.env.SORA_GCC_CERTIFIER_EMAIL = 'compliance@acme-imports.test';
      process.env.SORA_GCC_CERTIFIER_PHONE = '+1-202-555-0101';
      process.env.SORA_GCC_CUSTODIAN_NAME = 'Compliance Manager, Acme Imports LLC';

      try {
        const res = await generateGccCertificate({
          productName: 'Adult Road Bicycle Helmet',
          sku: 'HLM-ENV-01',
          htsCode: '6506.10.60.45',
          targetAge: 'adult',
          material: 'polycarbonate',
          hasBattery: true,
          batteryType: 'button_coin',
          manufacture: { date: '2026-10', city: 'Taichung', country: 'Taiwan' },
          testing: {
            date: '2026-10-12',
            location: 'Osaka, Japan',
            laboratoryName: 'Acme Test Lab Osaka',
            reportNumber: 'TR-0004',
          },
        });
        expect(res.overallStatus).toBe('ready');
        expect(res.items[0].status).toBe('generated');
        expect(res.items[0].statutoryFields?.certifier).toEqual({
          name: 'Acme Imports LLC',
          address: '100 Example Street, Anytown, CA, United States',
          email: 'compliance@acme-imports.test',
          phone: '+1-202-555-0101',
        });
        expect(res.items[0].statutoryFields?.recordCustodian).toEqual({
          name: 'Compliance Manager, Acme Imports LLC',
          address: '100 Example Street, Anytown, CA, United States',
          email: 'compliance@acme-imports.test',
          phone: '+1-202-555-0101',
        });
      } finally {
        for (const k of envKeys) {
          if (prev[k] === undefined) delete process.env[k];
          else process.env[k] = prev[k];
        }
      }
    });

    it('refuses to issue a GCC when a product is for children <= 12 (returns cpc_required_instead)', async () => {
      const res = await generateGccCertificate({
        productName: 'Kids Plush Mascot Doll',
        sku: 'PLUSH-KIDS-01',
        htsCode: '9503.00.00.73',
        targetAge: 'child',
        material: 'polyester plush',
        certifier: sampleCertifier,
        recordCustodian: sampleCustodian,
      });

      expect(res.overallStatus).toBe('cpc_required');
      expect(res.warnings?.length).toBe(1);
      expect(res.warnings?.[0]).toContain('CPC');
      expect(res.warnings?.[0]).toContain('非対応');
      expect(res.items[0].status).toBe('cpc_required_instead');
      expect(res.items[0].warnings?.length).toBe(1);
      expect(res.items[0].aceFilingGuidance.certificateType).toBe('CCC');
      expect(res.items[0].aceFilingGuidance.eFilingRequired).toBe(true);
    });

    it('generates a multi-SKU post-shipment Courier / Customs Clearance Package (Page 1 Cover Sheet + per-SKU GCCs & Fabric Exemption Statement)', async () => {
      const pkg = await generateGccCertificate({
        orderNumber: 'SHOP-ORD-10492',
        awbNumber: 'TEST-AWB-0003',
        carrier: 'FedEx',
        invoiceNumber: 'INV-2026-10492',
        certifier: sampleCertifier,
        recordCustodian: sampleCustodian,
        items: [
          {
            sku: 'TEE-WHT-L',
            productName: "Men's Heavyweight Plain Cotton T-Shirt",
            description: 'Short sleeve crew neck plain jersey t-shirt',
            htsCode: '6109.10.00.12',
            targetAge: 'adult',
            material: '100% cotton',
            fabricSurface: 'plain',
            fabricWeightOzPerSqYd: 5.6,
            manufacture: { date: '2026-08', city: 'Osaka', country: 'Japan' },
          },
          {
            sku: 'HD-FLC-XL',
            productName: 'Unisex Cotton-Blend Brushed Fleece Hoodie',
            description: 'Pullover sweatshirt hoodie with brushed fleece interior',
            htsCode: '6109.10.00.12',
            targetAge: 'adult',
            material: '80% cotton 20% polyester',
            fabricSurface: 'raised',
            fabricWeightOzPerSqYd: 9.4,
            manufacture: { date: '2026-08', city: 'Suzhou, Jiangsu', country: 'China' },
            testing: {
              date: '2026-08-20',
              location: 'Shanghai, China',
              laboratoryName: 'Acme Test Lab Shanghai',
              reportNumber: 'TR-0002',
            },
          },
          {
            sku: 'PEN-LED-02',
            productName: 'LED Concert Penlight Stick',
            description: 'Portable LED light stick powered by coin cell battery',
            htsCode: '9405.42.84.40',
            targetAge: 'adult',
            material: 'ABS plastic',
            hasBattery: true,
            batteryType: 'button_coin',
            manufacture: { date: '2026-09', city: 'Shenzhen', country: 'China' },
            testing: {
              date: '2026-09-10',
              location: 'Shenzhen, China',
              laboratoryName: 'Acme Test Lab Shenzhen',
              reportNumber: 'TR-0003',
            },
          },
          {
            sku: 'MUG-CER-01',
            productName: 'Logo Stoneware Coffee Mug',
            description: 'Ceramic coffee mug for hot beverages',
            htsCode: '6912.00.44.00',
            targetAge: 'adult',
            material: 'ceramic',
            foodContact: true,
            manufacture: {
              date: '2026-07',
              city: 'Tajimi, Gifu',
              country: 'Japan',
              manufacturerName: 'Acme Ceramics Factory',
            },
          },
        ],
      });

      expect(pkg.mode).toBe('order_package');
      expect(pkg.overallStatus).toBe('ready');
      expect(pkg.counts).toEqual({
        totalItems: 4,
        gccGenerated: 2,
        draftNeedsInfo: 0,
        disclaimBExempt: 1,
        disclaimAExempt: 1,
        cpcRequired: 0,
      });

      expect(pkg.items[0].status).toBe('exempt_disclaim_b');
      expect(pkg.items[0].aceFilingGuidance.disclaimCode).toBe('B');
      expect(pkg.items[0].aceFilingGuidance.intendedUseCode).toBe('130.006');
      expect(pkg.items[1].status).toBe('generated');
      expect(pkg.items[2].status).toBe('generated');
      expect(pkg.items[3].status).toBe('exempt_no_gcc_needed');
      expect(pkg.items[3].aceFilingGuidance.disclaimCode).toBe('A');
      expect(pkg.items[3].aceFilingGuidance.fdaNote).toContain('21 CFR');

      // Cover sheet + individual SKU documents + print page breaks
      expect(pkg.packageMarkdown).toContain('SHOP-ORD-10492');
      expect(pkg.packageMarkdown).toContain('TEST-AWB-0003');
      expect(pkg.packageMarkdown).toContain('130.006');
      expect(pkg.packageHtml).toContain('page-break-before: always');
      expect(pkg.packageHtml).toContain('HD-FLC-XL');
      expect(pkg.packageHtml).toContain('PEN-LED-02');
    });

    it('strictly HTML-escapes all untrusted product, order, and party strings in certificateHtml and packageHtml (XSS prevention)', async () => {
      const xss = `<script>alert("xss")</script><img src=x onerror=alert('1')>&"`;
      const res = await generateGccCertificate({
        orderNumber: `ORD-${xss}`,
        awbNumber: `AWB-${xss}`,
        certifier: {
          name: `Certifier ${xss}`,
          address: `Addr ${xss}`,
          email: 'sec@acme-imports.test',
          phone: '+1-213-555-0144',
        },
        recordCustodian: {
          name: `Custodian ${xss}`,
          address: `CustAddr ${xss}`,
          email: 'rec@acme-imports.test',
          phone: '+1-213-555-0145',
        },
        items: [
          {
            sku: `SKU-${xss}`,
            productName: `Helmet ${xss}`,
            description: `Adult cycling helmet ${xss}`,
            htsCode: '6506.10.60.45',
            targetAge: 'adult',
            material: 'polycarbonate',
            hasBattery: true,
            batteryType: 'button_coin',
            manufacture: { date: '2026-05', city: `City ${xss}`, country: 'Japan' },
            testing: { date: '2026-05-10', location: `LabLoc ${xss}`, laboratoryName: `Lab ${xss}` },
          },
        ],
      });

      expect(res.packageHtml).not.toContain('<script>');
      expect(res.packageHtml).not.toContain('<img src=x');
      expect(res.packageHtml).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(res.items[0].certificateHtml).not.toContain('<script>');
      expect(res.items[0].certificateHtml).toContain('&amp;&quot;');
    });
  });
});
