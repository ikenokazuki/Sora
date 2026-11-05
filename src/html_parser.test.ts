import { describe, expect, it } from 'bun:test';
import { absolutizeContentUrls, convertHtmlToMarkdown, parseTimestampChapters, parseYouTubeChannelRef, parseYouTubeUrl } from './html_parser.js';

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
  it('keeps calendar event buttons when Readability retains only the date grid', () => {
    const days = Array.from({ length: 31 }, (_, i) => `<div role="gridcell"><div>${i + 1}</div></div>`).join('');
    const html = `<html><head><title>Public calendar</title></head><body>
      <main><div id="calendarOutline-mainUi"><div data-test-id="monthly-calendar">
        <div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div>${days}
        <div><button draggable="true"><span>『衛星とカラテアPresents「超 明星現象 2026」』</span></button></div>
        <div><button draggable="true"><span>『GIRLS FANTASIA vol.5』</span></button></div>
      </div></div></main><aside>Calendar details and follow instructions</aside>
    </body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/calendar', 30000, true);
    expect(result.contentStatus).toBe('body');
    expect(result.markdown).toContain('超 明星現象 2026');
    expect(result.markdown).toContain('GIRLS FANTASIA vol.5');
  });

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
  it('keeps Readability table content without pulling navigation and footer into pages without a main landmark', () => {
    const html = `<html><head><title>Service fees</title></head><body>
      <nav>NavigationNoise <a href="/account">Account settings and other pages</a></nav>
      <div><h1>Service fees</h1><p>${'Fee details for each plan and the services included. '.repeat(12)}</p>
      <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>3000</td></tr></table></div>
      <footer>FooterNoise Privacy policy and company information</footer>
    </body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/fees', 30000);
    expect(result.markdown).toContain('3000');
    expect(result.markdown).not.toContain('NavigationNoise');
    expect(result.markdown).not.toContain('FooterNoise');
  });

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

describe('multiple events in the markdown callout', () => {
  const pageWith = (events: Array<Record<string, unknown>>) => {
    const ld = events.map((e) => ({ '@context': 'https://schema.org', '@type': 'Event', ...e }));
    return `<html><head><title>Schedule</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>Schedule</h1><p>公演の一覧です。詳細は各ページをご覧ください。</p></body></html>`;
  };
  const calloutLines = (markdown: string) => markdown.split('\n').filter((l) => l.startsWith('> 📅 **イベント情報**:'));

  it('lists every event, nearest upcoming first and past events last', () => {
    const html = pageWith([
      { name: '過去公演', startDate: '1999-01-01T18:00:00+09:00' },
      { name: '遠い公演', startDate: '2999-12-01T18:00:00+09:00' },
      { name: '近い公演', startDate: '2999-01-01T18:00:00+09:00', location: { name: '会場A' } },
    ]);
    const result = convertHtmlToMarkdown(html, 'https://example.com/schedule', 30000);
    const lines = calloutLines(result.markdown);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('近い公演');
    expect(lines[0]).toContain('会場: 会場A');
    expect(lines[1]).toContain('遠い公演');
    expect(lines[2]).toContain('過去公演');
    // events は抽出順のまま全件
    expect(result.events!.map((e) => e.name)).toEqual(['過去公演', '遠い公演', '近い公演']);
  });

  it('caps the callout at ten events and counts the rest', () => {
    const events = Array.from({ length: 12 }, (_, i) => ({ name: `公演${i + 1}`, startDate: `2999-01-${String(i + 1).padStart(2, '0')}T18:00:00+09:00` }));
    const result = convertHtmlToMarkdown(pageWith(events), 'https://example.com/schedule', 30000);
    const lines = calloutLines(result.markdown);
    expect(lines.length).toBe(11);
    expect(lines[10]).toBe('> 📅 **イベント情報**: ほか 2 件');
    expect(result.events!.length).toBe(12);
  });

  it('keeps each callout line on one line even when a name contains line breaks', () => {
    const result = convertHtmlToMarkdown(pageWith([{ name: '公演\nDAY1', startDate: '2999-01-01T18:00:00+09:00' }]), 'https://example.com/schedule', 30000);
    expect(calloutLines(result.markdown)[0]).toContain('公演 DAY1');
  });
});

describe('parseYouTubeUrl', () => {
  it('reads the video id and the start time from the URL forms YouTube shares', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=5Jq35KcE8vI&t=367s')).toEqual({ videoId: '5Jq35KcE8vI', startSec: 367 });
    expect(parseYouTubeUrl('https://youtu.be/5Jq35KcE8vI?si=abc&t=6m7s')).toEqual({ videoId: '5Jq35KcE8vI', startSec: 367 });
    expect(parseYouTubeUrl('https://m.youtube.com/live/Ab-_0123456?t=1h2m3s')).toEqual({ videoId: 'Ab-_0123456', startSec: 3723 });
    expect(parseYouTubeUrl('https://www.youtube-nocookie.com/embed/Ab-_0123456?start=90')).toEqual({ videoId: 'Ab-_0123456', startSec: 90 });
    expect(parseYouTubeUrl('https://www.youtube.com/shorts/Ab-_0123456')).toEqual({ videoId: 'Ab-_0123456' });
    expect(parseYouTubeUrl('https://music.youtube.com/watch?v=Ab-_0123456&list=PL1')).toEqual({ videoId: 'Ab-_0123456' });
    expect(parseYouTubeUrl('www.youtube.com/watch?v=Ab-_0123456&t=0')).toEqual({ videoId: 'Ab-_0123456' });
    expect(parseYouTubeUrl(' Ab-_0123456 ')).toEqual({ videoId: 'Ab-_0123456' });
    // 読めない開始秒は捨てて、動画 ID だけを返す
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=Ab-_0123456&t=99999999999999999999999999999999999')).toEqual({ videoId: 'Ab-_0123456' });
  });

  it('rejects other hosts, malformed ids and pages that are not a video', () => {
    for (const input of [
      'https://notyoutube.com/watch?v=Ab-_0123456',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/channel/UCabcdefghij',
      'https://www.youtube.com/embed/videoseries?list=PL1234567890',
      'https://www.youtube.com/embed/live_stream?channel=UC1',
      'https://example.com/Ab-_0123456',
      'Ab-_012345',
      '',
    ]) {
      expect(parseYouTubeUrl(input)).toBeUndefined();
    }
  });
});

describe('parseYouTubeChannelRef', () => {
  const ID = 'UCBR8-60-B28hp2BmDPdntcQ';

  it('reads a channel id, and the page path of a handle or a legacy name', () => {
    expect(parseYouTubeChannelRef(ID)).toEqual({ channelId: ID });
    expect(parseYouTubeChannelRef(`https://www.youtube.com/channel/${ID}/videos`)).toEqual({ channelId: ID });
    expect(parseYouTubeChannelRef('https://www.youtube.com/@YouTube')).toEqual({ pagePath: '/@YouTube' });
    expect(parseYouTubeChannelRef('youtube.com/@You.Tube_-1?si=abc')).toEqual({ pagePath: '/@You.Tube_-1' });
    expect(parseYouTubeChannelRef(' @YouTube ')).toEqual({ pagePath: '/@YouTube' });
    expect(parseYouTubeChannelRef('https://m.youtube.com/@YouTube/videos')).toEqual({ pagePath: '/@YouTube' });
    expect(parseYouTubeChannelRef('https://www.youtube.com/c/YouTubeCreators')).toEqual({ pagePath: '/c/YouTubeCreators' });
    expect(parseYouTubeChannelRef('https://www.youtube.com/user/Google/featured')).toEqual({ pagePath: '/user/Google' });
  });

  it('accepts a Japanese handle written raw or percent-encoded, and builds the same encoded path', () => {
    const encoded = '/@%E3%81%8A%E3%81%AF%E3%82%88%E3%81%86';
    expect(parseYouTubeChannelRef('@おはよう')).toEqual({ pagePath: encoded });
    expect(parseYouTubeChannelRef('https://www.youtube.com/@おはよう')).toEqual({ pagePath: encoded });
    expect(parseYouTubeChannelRef('https://www.youtube.com/@%E3%81%8A%E3%81%AF%E3%82%88%E3%81%86')).toEqual({ pagePath: encoded });
  });

  it('rejects videos, other hosts, look-alike hosts, and names with characters that are not allowed', () => {
    for (const input of [
      '',
      '@',
      'jNQXAC9IVRw',
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      'https://youtu.be/jNQXAC9IVRw',
      'https://www.youtube.com/playlist?list=PL1234567890',
      'https://www.youtube.com/channel/UCshort',
      `https://www.youtube.com/channel/${ID}x`,
      'https://example.com/@YouTube',
      'https://www.youtube.com.evil.example/@YouTube',
      'https://www.youtube.com@evil.example/@YouTube',
      'https://music.youtube.com/@YouTube',
      'https://www.youtube.com/@bad name',
      'https://www.youtube.com/@a%2Fb',
      'https://www.youtube.com/@%E0%A4%A',
      `${ID}x`,
    ]) {
      expect(parseYouTubeChannelRef(input)).toBeUndefined();
    }
  });
});

describe('parseTimestampChapters', () => {
  it('reads chapter lines with separators and indented or bulleted sub-chapters', () => {
    const text = '【チャプター】\n0:00:00 | 待機画面\n0:00:42 | ♩「歌」\n◼️データ\n0:25:36 | データ | ベクトル\n　∟0:33:27 | 耳学問＞ 統計\n　　∟0:57:18 | 耳学問＞ 対角化\n- 1:02:54 - スペクトル定理\n• 1:05:17：直交';
    expect(parseTimestampChapters(text)).toEqual([
      { title: '待機画面', time: '0:00:00', seconds: 0 },
      { title: '♩「歌」', time: '0:00:42', seconds: 42 },
      { title: 'データ | ベクトル', time: '0:25:36', seconds: 1536 },
      { title: '耳学問＞ 統計', time: '0:33:27', seconds: 2007 },
      { title: '耳学問＞ 対角化', time: '0:57:18', seconds: 3438 },
      { title: 'スペクトル定理', time: '1:02:54', seconds: 3774 },
      { title: '直交', time: '1:05:17', seconds: 3917 },
    ]);
  });

  it('reads chapter lines in time order and skips repeated times and overlong titles', () => {
    const text = `概要です\n0:00 はじめに\n1:02:03 まとめ\n 2:30 本題\n2:30 同じ時刻\n10:15 ${'あ'.repeat(81)}`;
    expect(parseTimestampChapters(text)).toEqual([
      { title: 'はじめに', time: '0:00', seconds: 0 },
      { title: '本題', time: '2:30', seconds: 150 },
      { title: 'まとめ', time: '1:02:03', seconds: 3723 },
    ]);
  });
});

describe('main content of list pages', () => {
  // Readability はリンクの多い一覧を本文にせず、横の宣伝の段落を選ぶことがある（WCXB の一覧・まとめのページで多かった）。
  // 宣伝が 500 字（Readability が取り直さない長さ）を超え、一覧がその 3 倍ある形で確かめる
  const items = Array.from({ length: 36 }, (_, i) => `2026.10.${String((i % 28) + 1).padStart(2, '0')} 定期公演 第${100 - i}回の出演メンバー、開演時間と整理番号の入場順のお知らせ`);
  const promo = '会員になると、先行受付の抽選、限定の動画、メンバーからのメッセージ、誕生日のお祝いメール、会報の電子版など、たくさんの特典をご利用いただけます。'.repeat(7);
  const list = `<ul class="news">${items.map((t, i) => `<li class="news-item"><a href="/news/${i}">${t}</a></li>`).join('')}</ul>`;
  const html = `<html><head><title>NEWS</title></head><body><div id="wrap"><div class="side"><div class="promo"><p>${promo}</p></div></div><div class="list">${list}</div></div></body></html>`;

  it('takes the repeated news items instead of a promo paragraph that Readability picked', () => {
    const { markdown } = convertHtmlToMarkdown(html, 'https://example.com/news/', 100000);
    for (const t of items) expect(markdown).toContain(t);
  });
});

describe('main content of pages laid out with tables', () => {
  // 古いページは段組みに表を使う。レイアウト用の表を「表の本文」とみなしてページ全体に戻すと、ナビやフッターまで本文に入った
  const article = Array.from({ length: 6 }, (_, i) => `<p>第${i + 1}段落。市議会は本日、新しい図書館の建設計画について審議し、開館時間の延長と駐車場の拡張を含む修正案を賛成多数で可決しました。</p>`).join('');
  const html = `<html><head><title>市議会のニュース</title></head><body><table><tr><td class="side"><a href="/a">トップ</a><br><a href="/b">地域のお知らせと市内のイベントの一覧</a><br><a href="/c">お問い合わせ窓口のご案内</a></td><td><h1>図書館の建設計画を可決</h1>${article}</td></tr></table><div class="foot">このサイトに掲載の記事・写真の無断転載を禁じます。運営: 地域ニュース社</div></body></html>`;

  it('keeps the article that Readability found instead of falling back to the whole page', () => {
    const { markdown } = convertHtmlToMarkdown(html, 'https://example.com/news/1', 100000);
    expect(markdown).toContain('修正案を賛成多数で可決しました');
    expect(markdown).not.toContain('無断転載を禁じます');
  });
});

describe('main content chosen between rs-trafilatura and Readability', () => {
  // Readability の本文が 1,000 字（RS_ARTICLE_MIN_READ_CHARS）を超える記事
  const article = Array.from({ length: 20 }, (_, i) => `<p>第${i + 1}段落。市議会は本日、新しい図書館の建設計画について審議し、開館時間の延長と駐車場の拡張を含む修正案を賛成多数で可決しました。</p>`).join('');
  const html = `<html><head><title>ニュース</title></head><body><div class="side">会員登録はこちらから。</div><article><h1>図書館の建設計画を可決</h1>${article}</article></body></html>`;
  const rsHtml = '<div><h2>今月の予定</h2><ul><li>10月1日 定期公演</li><li>10月8日 握手会</li></ul></div>';
  const md = (rsMain?: Parameters<typeof convertHtmlToMarkdown>[10]) =>
    convertHtmlToMarkdown(html, 'https://example.com/news/1', 100000, false, true, undefined, undefined, undefined, undefined, false, rsMain).markdown;

  it('uses the rs-trafilatura content for pages it does not classify as articles', () => {
    const out = md({ pageType: 'listing', contentHtml: rsHtml });
    expect(out).toContain('10月8日 握手会');
    expect(out).not.toContain('修正案を賛成多数で可決しました');
  });

  it('keeps the Readability article when rs-trafilatura says article and Readability found a long body', () => {
    const out = md({ pageType: 'article', contentHtml: rsHtml });
    expect(out).toContain('修正案を賛成多数で可決しました');
    expect(out).not.toContain('10月8日 握手会');
  });

  it('uses the rs-trafilatura content when Readability found only a short body', () => {
    const short = `<html><head><title>x</title></head><body><article><p>短い本文です。</p></article></body></html>`;
    const out = convertHtmlToMarkdown(short, 'https://example.com/x', 100000, false, true, undefined, undefined, undefined, undefined, false, { pageType: 'article', contentHtml: rsHtml }).markdown;
    expect(out).toContain('10月1日 定期公演');
  });
});

describe('table rows', () => {
  it('does not repeat the text of a table nested in a layout table', () => {
    const html = '<html><head><title>t</title></head><body><table><tr><td>メニュー</td><td><p>本文の段落です。</p><table><tr><td>内側の表の文です</td><td>2 列目</td></tr></table></td></tr></table></body></html>';
    const result = convertHtmlToMarkdown(html, 'https://example.com/t', 100000);
    expect(result.markdown.split('内側の表の文です').length - 1).toBe(1);
    expect(result.tables?.[0]?.rows ?? []).toHaveLength(0);
  });

  it('does not throw when the first row has no cells', () => {
    const html = '<html><head><title>t</title></head><body><table><tr></tr><tr><th>項目</th><th>値</th></tr><tr><td>重量</td><td>199g</td></tr></table></body></html>';
    const result = convertHtmlToMarkdown(html, 'https://example.com/t', 100000);
    expect(result.tables?.[0]?.rows).toEqual([{ 項目: '重量', 値: '199g' }]);
  });
});

describe('本文の URL', () => {
  it('本文のリンクと画像を絶対 URL にし、# と javascript: のリンクを外す', () => {
    const html = '<html><head><title>t</title></head><body><p>Read <a href="/docs/a">docs</a>, <a href="#top">top</a>, <a href="javascript:void(0)">js</a> and <a href="mailto:a@example.com">mail</a>.</p><img src="img/b.png" alt="b"></body></html>';
    const result = convertHtmlToMarkdown(html, 'https://example.com/dir/page', 30000, false, false);
    expect(result.markdown).toContain('[docs](https://example.com/docs/a)');
    expect(result.markdown).toContain(' top,');
    expect(result.markdown).not.toContain('(#top)');
    expect(result.markdown).not.toContain('javascript:');
    expect(result.markdown).toContain('[mail](mailto:a@example.com)');
    expect(result.markdown).toContain('![b](https://example.com/dir/img/b.png)');
  });

  it('並んだ # と javascript: のリンクを外すとき、隣の要素の文字とくっつけない', () => {
    // 外すリンクは要素を動かさずに目印の名前にして、直列化のあとにタグだけを消す。出る HTML は、要素ごと外していた前と同じ
    const html = '<p>年: <a href="javascript:void(0)">1990</a><a href="javascript:void(0)">1991</a><a href="#x">1992</a><a href="/y">1993</a></p><p>見出し<a href="#">リンク</a>です</p><p><a href="/z">Z</a><a href="#">B</a></p>';
    expect(absolutizeContentUrls(html, 'https://example.com/dir/page')).toBe(
      '<p>年: 1990 1991 1992 <a href="https://example.com/y">1993</a></p><p>見出しリンクです</p><p><a href="https://example.com/z">Z</a> B</p>',
    );
    // Markdown にしたときの文字も前と同じ（くっつかない・リンクだけが残る）
    const md = convertHtmlToMarkdown(`<html><head><title>t</title></head><body>${html}</body></html>`, 'https://example.com/dir/page', 30000, false, false).markdown;
    expect(md).toContain('年: 1990 1991 1992 [1993](https://example.com/y)');
    expect(md).toContain('見出しリンクです');
    expect(md).toContain('[Z](https://example.com/z) B');
    expect(md).not.toContain('](#');
    expect(md).not.toContain('javascript:');
  });

  it('外したリンクの跡に、中身の無い見出し・リストの項目が出ず、数字と点の逃がし方も変わらない', () => {
    // href を外しただけの a を残すと、Turndown は a を「空でも意味のある要素」として扱い、中身が空の見出し（######）やリストの項目（-）を出した。
    // a の中の先頭に空白を足すと、「1.」の逃がし（1\.）も外れた
    const html = '<h2>見出し</h2><h6><a href="#"></a></h6><ul><li><a href="javascript:void(0)"> </a></li><li>項目</li></ul><dl><dt><a href="#c1">1.</a> 山田 - 2026年</dt></dl><p>本文です。<a href="#"></a></p>';
    const md = convertHtmlToMarkdown(`<html><head><title>t</title></head><body>${html}</body></html>`, 'https://example.com/', 30000, false, false).markdown;
    expect(md).toContain('## 見出し');
    expect(md).not.toMatch(/^#{3,6}\s*$/m);
    expect(md).not.toMatch(/^\s*-\s*$/m);
    expect(md).toContain('1\\. 山田 - 2026年');
  });

  it('文字参照で崩した javascript:（java&#9;script: など）のリンクも外す', () => {
    // cheerio は文字参照を字に戻し、new URL はタブ・改行・先頭の制御文字を取り除くので、そのままだと生きた javascript:alert(1) が残る
    const html = '<p><a href="java&#9;script:alert(1)">a</a> <a href="&#10;javascript:alert(2)">b</a> <a href="jav&Tab;ascript:alert(3)">c</a> <a href="&#1;JavaScript:alert(4)">d</a> <a href="/ok">e</a></p>';
    const out = absolutizeContentUrls(html, 'https://example.com/dir/page');
    expect(out).toBe('<p>a b c d <a href="https://example.com/ok">e</a></p>');
    expect(out).not.toContain('javascript:');
  });

  it('# だけのリンクは外し、#/route・#!/route のようなハッシュの経路のリンクは絶対 URL にして残す', () => {
    const html = '<p><a href="#">a</a><a href="#top">b</a><a href="#/route/1">c</a><a href="#!/route/2">d</a><a href="#!">e</a><a href="  #/route/3 ">f</a></p>';
    expect(absolutizeContentUrls(html, 'https://example.com/dir/page')).toBe(
      '<p>a b <a href="https://example.com/dir/page#/route/1">c</a><a href="https://example.com/dir/page#!/route/2">d</a> e <a href="https://example.com/dir/page#/route/3">f</a></p>',
    );
    const md = convertHtmlToMarkdown(`<html><head><title>t</title></head><body>${html}</body></html>`, 'https://example.com/dir/page', 30000, false, false).markdown;
    expect(md).toContain('[c](https://example.com/dir/page#/route/1)');
    expect(md).toContain('[d](https://example.com/dir/page#!/route/2)');
  });

  it('# のリンクが 12 万個並んでも、リンクを外す処理は線形の時間で終わる', () => {
    // 前は、外すたびに親の子の配列で探して切り貼りしたので、長さの二乗以上の時間だった（4 万個で 1.1〜1.7 秒、10 万個で 5.6〜9.2 秒、12 万個は 280 秒でも終わらなかった）。
    // 今の形は 12 万個で 1.1〜1.4 秒（Bun 1.4.2 と 1.3.3）。上限の 6 秒は、その 4 倍以上
    const html = `<p>${'<a href="#">x</a>'.repeat(120_000)}</p>`;
    const t0 = performance.now();
    const out = absolutizeContentUrls(html, 'https://example.com/dir/page');
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(6000);
    expect(out).toBe(`<p>${'x '.repeat(119_999)}x</p>`);
  });

  it('script・style・コメントの中に目印のタグに見える字を書いておいても、リンクを外したあとにその字が変わらない', () => {
    // 外すリンクの目印のタグは、直列化した文字列から消す。script・style・コメントの中の字は、直列化でエスケープされずにそのまま出るので、
    // 目印の名前が決まっていると、ページが `</scr<sora-unlinked>ipt>` のような字を書いておき、タグを消したあとに `</script>` ができて、
    // 要素が早く閉じ、隠れていた字が本文に出た（間接プロンプトインジェクション）。名前を呼び出しごとの乱数にして、ページが前もって書けないようにした
    const hidden = [
      '<script>var a = "</scr<sora-unlinked>ipt><p>隠れた字 1</p>"; var b = "<sora-unlinked>";</script>',
      '<style>.a::after { content: "</sty<sora-unlinked>le><p>隠れた字 2</p>"; }</style>',
      '<!-- --<sora-unlinked>> <p>隠れた字 3</p> -->',
    ].join('');
    const out = absolutizeContentUrls(`<p>前<a href="#">リンク</a>後</p>${hidden}`, 'https://example.com/');
    expect(out).toBe(`<p>前リンク後</p>${hidden}`);
    // 目印の名前は、呼び出しごとに違う（消したあとに残らない）
    expect(out).not.toMatch(/sora-unlinked-[0-9a-f]/);
    const mdOut = convertHtmlToMarkdown(`<html><head><title>t</title></head><body><p>前<a href="#">リンク</a>後</p>${hidden}</body></html>`, 'https://example.com/', 30000, false, false).markdown;
    expect(mdOut).not.toContain('隠れた字');
  });

  it('rs-trafilatura の本文のリンクも絶対 URL にする', () => {
    const result = convertHtmlToMarkdown(
      '<html><body><ul><li><a href="/e/1">公演 1</a></li></ul></body></html>', 'https://example.com/live', 30000, false, true,
      undefined, undefined, undefined, undefined, false, { pageType: 'listing', contentHtml: '<ul><li><a href="/e/1">公演 1</a></li></ul>' },
    );
    expect(result.markdown).toContain('[公演 1](https://example.com/e/1)');
  });

  it('formats の html は、ページ全体ではなく本文の HTML（URL は絶対）を返す', () => {
    const result = convertHtmlToMarkdown('<html><head><title>t</title><script>x()</script></head><body><p><a href="/a">a</a></p></body></html>', 'https://example.com/', 30000, false, false);
    expect(result.html).toContain('href="https://example.com/a"');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('<head');
  });

  it('本文のリンクと画像の URL は、日本語などの字をパーセントエンコードせずに書く', () => {
    const html = '<p><a href="/wiki/%E5%A4%A7%E9%98%AA%E5%BA%9C">大阪府</a> <a href="/wiki/東京都">東京都</a> <a href="/s?q=%93%8C%8B%9E">sjis</a> <a href="/a%20b%E3%80%80c">space</a> <a href="/z%E2%80%8Bw">zw</a> <a href="/p%25E5">pct</a></p><img src="/img/%E5%9B%B3.png" alt="図">';
    expect(absolutizeContentUrls(html, 'https://ja.wikipedia.org/wiki/x')).toBe(
      '<p><a href="https://ja.wikipedia.org/wiki/大阪府">大阪府</a> <a href="https://ja.wikipedia.org/wiki/東京都">東京都</a> <a href="https://ja.wikipedia.org/s?q=%93%8C%8B%9E">sjis</a> <a href="https://ja.wikipedia.org/a%20b%E3%80%80c">space</a> <a href="https://ja.wikipedia.org/z%E2%80%8Bw">zw</a> <a href="https://ja.wikipedia.org/p%25E5">pct</a></p><img src="https://ja.wikipedia.org/img/図.png" alt="図">',
    );
  });
});

describe('本文の URL: 見えない字', () => {
  it('見えない字（ハングルの空白字・結合解除字・異体字セレクタ）になる並びは、エンコードのまま残す', () => {
    // U+3164・U+FFA0（ハングルの空白字）、U+034F（CGJ）、U+FE0F（異体字セレクタ）、U+E0100（異体字セレクタ補助）は、字に戻すと見えないまま本文に出る
    const html = '<p><a href="/a%E3%85%A4b">1</a> <a href="/a%EF%BE%A0b">2</a> <a href="/a%CD%8Fb">3</a> <a href="/a%EF%B8%8Fb">4</a> <a href="/a%F3%A0%84%80b">5</a> <a href="/%E6%BC%A2%E3%85%A4">6</a></p>';
    expect(absolutizeContentUrls(html, 'https://ja.wikipedia.org/wiki/x')).toBe(
      '<p><a href="https://ja.wikipedia.org/a%E3%85%A4b">1</a> <a href="https://ja.wikipedia.org/a%EF%BE%A0b">2</a> <a href="https://ja.wikipedia.org/a%CD%8Fb">3</a> <a href="https://ja.wikipedia.org/a%EF%B8%8Fb">4</a> <a href="https://ja.wikipedia.org/a%F3%A0%84%80b">5</a> <a href="https://ja.wikipedia.org/%E6%BC%A2%E3%85%A4">6</a></p>',
    );
  });

  it('漢字・絵文字・全角の括弧は、今までどおり字に戻す', () => {
    const html = '<p><a href="/%E6%BC%A2%E5%AD%97">1</a> <a href="/%F0%9F%98%80">2</a> <a href="/%EF%BC%88%E7%AC%AC%EF%BC%89">3</a></p><img src="/%E5%9B%B3%EF%BC%88%E5%A4%A7%EF%BC%89.png">';
    expect(absolutizeContentUrls(html, 'https://ja.wikipedia.org/wiki/x')).toBe(
      '<p><a href="https://ja.wikipedia.org/漢字">1</a> <a href="https://ja.wikipedia.org/😀">2</a> <a href="https://ja.wikipedia.org/（第）">3</a></p><img src="https://ja.wikipedia.org/図（大）.png">',
    );
  });
});

describe('切る前の全文', () => {
  it('maxChars で切る前の全文を fullMarkdown で返す', () => {
    const tail = '最後の段落に答えがある。';
    const html = `<html><body><p>${'前の段落。'.repeat(200)}</p><p>${tail}</p></body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/', 100, false, false);
    expect(result.markdown).not.toContain(tail);
    expect(result.fullMarkdown).toContain(tail);
  });
});
