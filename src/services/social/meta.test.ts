import { describe, expect, test } from 'bun:test';
import { detectMetaPlatform, isOembedPlaceholder, parseInstagramDescription, parseMetaPage, selectPostTime } from './meta.js';

describe('meta url validation', () => {
  test('accepts post urls, rejects profiles and login pages', () => {
    expect(detectMetaPlatform('https://www.threads.com/@threads/post/DWjTI0cgH5O/')).toBe('threads');
    expect(detectMetaPlatform('https://www.threads.com/t/ABC123/')).toBe('threads');
    expect(detectMetaPlatform('https://www.threads.com/@threads/')).toBeNull();
    expect(detectMetaPlatform('https://www.instagram.com/p/Dc2OEAEI6-K/')).toBe('instagram');
    expect(detectMetaPlatform('https://www.instagram.com/starbucks_j/')).toBeNull();
    expect(detectMetaPlatform('https://www.facebook.com/NASA/posts/1420465106115528/')).toBe('facebook');
    expect(detectMetaPlatform('https://www.facebook.com/login/')).toBeNull();
    expect(detectMetaPlatform('https://example.org/p/abc/')).toBeNull();
  });
});

describe('meta time selection', () => {
  test('excludes comment datetimes from instagram pages', () => {
    const page = parseMetaPage('<html><head><meta property="og:description" content="3 likes - u on Sep 3: hi">'
      + '</head><body>'
      + '<time datetime="2026-09-04T01:36:14.000Z" title="2026\u5e749\u67083\u65e5">3\u9031\u9593\u524d</time>'
      + '<a href="/p/ABC/c/123/"><time datetime="2026-09-24T09:21:22.000Z">1\u65e5\u524d</time></a>'
      + '<a href="/starbucks_j/p/ABC/"><time datetime="2026-09-04T01:36:11.000Z">9\u67083\u65e5</time></a>'
      + '</body></html>');
    const r = selectPostTime(page.times, '/p/ABC/');
    expect(r.timeStatus).toBe('known');
    expect(r.publishedAt).toBe('2026-09-04T01:36:14.000Z');
  });
  test('threads permalink time resolves', () => {
    const page = parseMetaPage('<a href="/@threads/post/DWjTI0cgH5O"><time datetime="2026-03-31T14:06:01.000Z">2026/03/31</time></a>');
    const r = selectPostTime(page.times, '/@threads/post/DWjTI0cgH5O');
    expect(r.publishedAt).toBe('2026-03-31T14:06:01.000Z');
  });
  test('no usable time is unknown, not a guess', () => {
    expect(selectPostTime([], '/p/ABC/').timeStatus).toBe('unknown');
    expect(selectPostTime([{ href: '/p/ABC/c/1/' }], '/p/ABC/').timeStatus).toBe('unknown');
  });
});

describe('meta content helpers', () => {
  test('oembed placeholders are not post text', () => {
    expect(isOembedPlaceholder('View on Threads')).toBe(true);
    expect(isOembedPlaceholder('View this post on Instagram')).toBe(true);
    expect(isOembedPlaceholder('')).toBe(true);
    expect(isOembedPlaceholder('Real post body text here')).toBe(false);
  });
  test('instagram description splits author, caption, and counters', () => {
    const r = parseInstagramDescription('12K likes, 13 comments - starbucks_j on September 3, 2026: "hello world".');
    expect(r.username).toBe('starbucks_j');
    expect(r.caption).toBe('hello world');
    expect(r.likesDisplay).toBe('12K');
    expect(r.commentsDisplay).toBe('13');
  });
});
