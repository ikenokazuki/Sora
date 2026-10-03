import { describe, expect, it } from 'bun:test';
import { convertHtmlToMarkdown } from './html_parser.js';

describe('event details and publication dates', () => {
  const event = {
    '@context': 'https://schema.org', '@type': 'Event',
    name: 'Festival Spring 2026', startDate: '2026-04-19T06:20:00Z',
    endDate: '2026-04-19T08:10:00Z', location: { name: 'RED SUN' },
    description: 'ライブ 15:20〜15:40。特典会 16:10〜17:10。出演者変更の注意事項を確認してください。',
  };
  const calendar = '<time datetime="2026-10">October 2026</time><div role="grid">Mon Tue Wed Thu Fri Sat Sun 28 29 30 1 2 3 4 5 6 7</div>';

  it('recovers event description and end time from JSON-LD when the DOM only contains a calendar', () => {
    const html = `<html><head><title>Festival</title><script type="application/ld+json">${JSON.stringify(event)}</script></head><body>${calendar}</body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/event', 30000);
    expect(result.markdown).toContain(event.description);
    expect(result.markdown).toContain('2026-04-19T08:10:00Z');
    expect(result.markdown).not.toContain('Mon Tue Wed');
    expect(result.contentStatus).toBe('structured_data');
    expect(result.publishedTime).toBeUndefined();
  });

  it('does not claim calendar navigation is page content', () => {
    const html = `<html><head><title>Calendar</title><meta name="description" content="Upcoming events"></head><body>${calendar}</body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/calendar', 30000);
    expect(result.contentStatus).toBe('metadata_only');
    expect(result.markdown).not.toContain('Mon Tue Wed');
    expect(result.quality).toBeLessThan(45);
  });

  it('uses the explicit publication date instead of an unrelated calendar time', () => {
    const html = `<html><head><title>News</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Article', datePublished: '2026-04-01T09:00:00Z' })}</script></head><body>${calendar}<article><p>Festival details and ticket sales announcement with all relevant information.</p></article></body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/news', 30000);
    expect(result.publishedTime).toBe('2026-04-01T09:00:00Z');
  });
});

// Sidebar <article> (calendar widget) comes before the real product <article>.
// A nav block pushes body text over the 200-char fallback trigger.
const SIDEBAR_CALENDAR_PRODUCT_HTML = `<!DOCTYPE html>
<html>
<head><title>Acme Widget Pro Shop</title></head>
<body>
<nav><ul>
<li><a href="/guide">Shopping guide and shipping information center</a></li>
<li><a href="/payment">Payment methods including credit card and bank transfer</a></li>
<li><a href="/delivery">Delivery schedule and business day calendar notice</a></li>
<li><a href="/contact">Contact support for bulk orders and quotations</a></li>
</ul></nav>
<footer><ul>
<li><a href="/s1">Smartphone cases, covers, and screen protectors catalog</a></li>
<li><a href="/s2">Acrylic keychains, figures, and stand displays catalog</a></li>
<li><a href="/s3">Mobile batteries, chargers, and cable accessories catalog</a></li>
<li><a href="/s4">Ring holders, card pockets, and phone stands catalog</a></li>
<li><a href="/s5">Privacy policy, terms of service, and company profile</a></li>
<li><a href="/s6">Frequently asked questions and order tracking support</a></li>
</ul><p>Copyright 2026 Example Shop. All rights reserved worldwide.</p></footer>
<article class="sidebar-widget">
<h2>Business day calendar</h2>
<table class="cal"><tr><th>Mon</th><th>Tue</th><th>Wed</th></tr>
<tr><td>1</td><td>2</td><td>3</td></tr></table>
</article>
<article class="product-detail">
<h1>Acme Widget Pro</h1>
<p>The Acme Widget Pro is a durable multi-purpose container built for daily use.
It ships in two sizes and supports full-color custom printing on the lid.</p>
<h2>Price and lead time</h2>
<table><tr><th>Size</th><th>Price</th><th>Lead time</th></tr>
<tr><td>S</td><td>700</td><td>4 business days</td></tr>
<tr><td>M</td><td>1000</td><td>6 business days</td></tr></table>
</article>
</body>
</html>`;

describe('main content selection', () => {
  it('keeps the product article instead of the leading sidebar calendar article', () => {
    const result = convertHtmlToMarkdown(
      SIDEBAR_CALENDAR_PRODUCT_HTML,
      'https://example.com/shop/acme-widget-pro',
      40000,
      false,
      true,
    );
    expect(result.markdown).toContain('Acme Widget Pro');
    expect(result.markdown).toContain('Lead time');
    expect(result.markdown).toContain('4 business days');
  });
});

describe('fragment anchors', () => {
  it('keeps article content with empty duplicate anchors', () => {
    const html = `<!DOCTYPE html><html><head><title>Anchor Test</title></head><body>
<nav><ul>
<li><a href="/a">First navigation entry with descriptive text here</a></li>
<li><a href="/b">Second navigation entry with descriptive text here</a></li>
<li><a href="/c">Third navigation entry with descriptive text here</a></li>
<li><a href="/d">Fourth navigation entry with descriptive text here</a></li>
<li><a href="/e">Fifth navigation entry with descriptive text here</a></li>
<li><a href="/f">Sixth navigation entry with descriptive text here</a></li>
<li><a href="/g">Seventh navigation entry with descriptive text here</a></li>
</ul></nav>
<article class="detail">
<h1>Gadget Specification</h1>
<div id="spec"></div>
<p>The gadget measures 120mm and weighs 300 grams with battery included.</p>
<div id="spec"></div>
<h2>Warranty and support</h2>
<p>Two year warranty with free repairs for manufacturing defects.</p>
</article>
</body></html>`;
    for (const url of [
      'https://example.com/gadget#spec',
      'https://example.com/gadget#missing',
      'https://example.com/gadget',
    ]) {
      const result = convertHtmlToMarkdown(html, url, 40000, false, true);
      expect(result.markdown).toContain('Gadget Specification');
      expect(result.markdown).toContain('120mm');
    }
  });
});

describe('content containers', () => {
  it('keeps tables inside #content without nav noise takeover', () => {
    const nav = Array.from({ length: 12 }, (_, i) => `<li><a href="/n${i}">Navigation entry number ${i} with descriptive words</a></li>`).join('');
    const html = `<!DOCTYPE html><html><head><title>Fee Table</title></head><body><nav><ul>${nav}</ul></nav><div id="content"><h1>Service Fees</h1><p>Our service fees depend on the plan you choose. All prices include tax and support.</p><table><tr><th>Plan</th><th>Monthly</th></tr><tr><td>Basic</td><td>1000</td></tr><tr><td>Pro</td><td>3000</td></tr></table></div></body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/fees', 40000, false, true);
    expect(result.markdown).toContain('Service Fees');
    expect(result.markdown).toContain('3000');
  });
});

describe('F2 body preservation over aside tables', () => {
  it('keeps main prose when the only table lives in an aside article', () => {
    const prose = 'MainProseAnchorAlpha ' + 'the quick brown fox jumps over the lazy dog near the riverbank garden. '.repeat(14);
    const asideCells = Array.from({ length: 24 }, (_, i) => `<tr><td>AsideWidgetRow${i}</td><td>value${i}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html><head><title>Prose Page</title></head><body><main><article><h1>Riverbank Guide</h1><p>${prose}</p><p>SecondMainProseAnchorBeta confirms the body text survives structural rescue attempts.</p></article></main><aside><article><h2>Widget Index</h2><table>${asideCells}</table></article></aside></body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/guide', 40000, false, true);
    expect(result.markdown).toContain('MainProseAnchorAlpha');
    expect(result.markdown).toContain('SecondMainProseAnchorBeta');
  });
});

describe('F3 duplicate table headers', () => {
  it('keeps both colspan values under unique keys', async () => {
    const mod = await import('./html_parser.js');
    expect(mod.uniqueTableHeaders(['Revenue', 'Revenue', 'Revenue_2'])).toEqual(['Revenue', 'Revenue_3', 'Revenue_2']);
    const html = `<!DOCTYPE html><html><head><title>Sales</title></head><body><main><h1>Quarterly Sales Report</h1><p>Intro paragraph with enough substance to look like a real article body for readers.</p><table><tr><th colspan="2">Revenue</th></tr><tr><td>100</td><td>200</td></tr></table></main></body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/sales', 40000, false, true);
    const tables = (result as { tables?: Array<{ headers: string[]; rows: Array<Record<string, string>> }> }).tables ?? [];
    expect(tables.length).toBeGreaterThan(0);
    const row = tables[0].rows[0];
    const values = Object.values(row);
    expect(values).toContain('100');
    expect(values).toContain('200');
    expect(result.markdown).toContain('100');
    expect(result.markdown).toContain('200');
  });
});

describe('F4 lazy image resolution', () => {
  it('resolves data-src and srcset to real urls in images and markdown', async () => {
    const mod = await import('./html_parser.js');
    expect(mod.resolveImageUrl({ src: 'https://cdn.example.com/placeholder.png', dataSrc: 'https://cdn.example.com/real.jpg' }, 'https://example.com/')).toBe('https://cdn.example.com/real.jpg');
    expect(mod.resolveImageUrl({ src: 'https://cdn.example.com/real.jpg', dataSrc: 'https://cdn.example.com/other.jpg' }, 'https://example.com/')).toBe('https://cdn.example.com/real.jpg');
    expect(mod.resolveImageUrl({ srcset: 'https://cdn.example.com/s.jpg 400w, https://cdn.example.com/l.jpg 800w' }, 'https://example.com/')).toBe('https://cdn.example.com/l.jpg');
    expect(mod.resolveImageUrl({ src: '/img/real-two.jpg' }, 'https://example.com/a/b')).toBe('https://example.com/img/real-two.jpg');
    const html = `<!DOCTYPE html><html><head><title>Photos</title></head><body><main><article><h1>Gallery</h1><p>${'Gallery intro sentence with descriptive words for the photo collection. '.repeat(6)}</p><img src="https://cdn.example.com/placeholder.png" data-src="https://cdn.example.com/real-one.jpg" alt="exhibit hall photograph"><img srcset="https://cdn.example.com/small-two.jpg 400w, https://cdn.example.com/real-two.jpg 1200w" alt="second exhibit photograph"></article></main></body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/gallery', 40000, false, true);
    const urls = (result.images ?? []).map((i) => i.url);
    expect(urls).toContain('https://cdn.example.com/real-one.jpg');
    expect(urls).toContain('https://cdn.example.com/real-two.jpg');
    expect(result.markdown).toContain('https://cdn.example.com/real-one.jpg');
    expect(result.markdown).toContain('https://cdn.example.com/real-two.jpg');
  });
});
