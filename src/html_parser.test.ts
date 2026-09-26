import { describe, expect, it } from 'bun:test';
import { convertHtmlToMarkdown } from './html_parser.js';

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
