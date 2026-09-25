import { describe, expect, test } from 'bun:test';
import { buildYahooWebDirectUrl, parseYahooWebHtml } from './yahoo.js';

describe('yahoo direct url builder', () => {
  test('encodes period condition', () => {
    const url = buildYahooWebDirectUrl('site:m.weibo.cn test', { updated: 'day' });
    expect(url).toContain('vd=d');
  });
  test('maps week and year periods', () => {
    expect(buildYahooWebDirectUrl('x', { updated: 'week' })).toContain('vd=w');
    expect(buildYahooWebDirectUrl('x', { updated: 'year' })).toContain('vd=y');
    expect(buildYahooWebDirectUrl('x', { updated: 'all' })).not.toContain('vd=');
    expect(buildYahooWebDirectUrl('x')).not.toContain('vd=');
  });
  test('adds a single includeDomain as site: condition', () => {
    const url = buildYahooWebDirectUrl('keyword', { includeDomains: ['m.weibo.cn'] });
    expect(decodeURIComponent(new URL(url).searchParams.get('p') ?? '')).toContain('site:m.weibo.cn');
  });
});

describe('yahoo direct result filter', () => {
  test('drops yahoo vertical navigation links', () => {
    const html = '<div id="web"><ul>'
      + '<li><a href="https://search.yahoo.co.jp/image/search?p=x">nav1</a></li>'
      + '<li><a href="https://search.yahoo.co.jp/video/search?p=x">nav2</a></li>'
      + '<li><a href="https://chiebukuro.yahoo.co.jp/search/?p=x">nav3</a></li>'
      + '<li><a href="https://m.weibo.cn/status/abc">post</a><div>text</div></li>'
      + '</ul></div>';
    const items = parseYahooWebHtml(html);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://m.weibo.cn/status/abc');
  });
  test('returns empty for unknown markup instead of random links', () => {
    const html = '<html><body><ul><li><a href="https://example.org/a">a</a></li></ul></body></html>';
    expect(parseYahooWebHtml(html)).toEqual([]);
  });
});
