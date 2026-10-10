import { describe, expect, test } from 'bun:test';
import {
  formatIntegratedSearchHostResponse,
  projectIntegratedSearchEvidenceItem,
  serializeIntegratedSearchMcpResponse,
} from './integrated_search_host_response.js';

function baseItem() {
  return {
    title: 'Fixture',
    url: 'https://example.com/article',
    source: 'web',
    snippet: 'search snippet',
    description: 'page description',
    markdown: '# Full source\n\n## Target\nAnswer evidence\n\n## Other\nNon-query detail',
    highlights: ['## Target\n\nAnswer evidence'],
    publishedTime: '2026-09-16T12:00:00Z',
    siteName: 'Fixture Site',
    pageType: 'article',
    cached: false,
  };
}

function response() {
  return {
    query: 'Target answer',
    source: 'integrated',
    count: 1,
    cached: false,
    results: [baseItem()],
    realtime: {
      source: 'x',
      sort: 'recent',
      count: 0,
      effectiveQuery: 'Target answer',
      isFallback: false,
      items: [],
    },
  };
}

describe('integrated search Host response', () => {
  test('full is exact legacy object by identity', () => {
    const input = response();
    expect(formatIntegratedSearchHostResponse(input)).toBe(input);
    expect(
      formatIntegratedSearchHostResponse(input, { responseMode: 'full' }),
    ).toBe(input);
  });

  test('verbose forces exact full object even if evidence is requested', () => {
    const input = response();
    expect(
      formatIntegratedSearchHostResponse(input, {
        responseMode: 'evidence',
        verbose: true,
      }),
    ).toBe(input);
  });

  test('evidence preserves JSON properties and highlights, removing only markdown', () => {
    const input = response();
    const before = structuredClone(input);
    const output = formatIntegratedSearchHostResponse(input, {
      responseMode: 'evidence',
    });

    expect(output.responseMode).toBe('evidence');
    expect(output.query).toBe(input.query);
    expect(output.source).toBe(input.source);
    expect(output.count).toBe(input.count);
    expect(output.cached).toBe(input.cached);
    expect(output.realtime).toEqual(input.realtime);

    const item = output.results[0];
    const source = input.results[0];
    expect(item.markdown).toBeUndefined();
    expect(item.highlights).toEqual(source.highlights);
    expect(item.title).toBe(source.title);
    expect(item.url).toBe(source.url);
    expect(item.snippet).toBe(source.snippet);
    expect(item.description).toBe(source.description);
    expect(item.publishedTime).toBe(source.publishedTime);
    expect(item.siteName).toBe(source.siteName);
    expect(item.pageType).toBe(source.pageType);
    expect(item.cached).toBe(source.cached);

    // Source object must never be mutated.
    expect(input).toEqual(before);
    expect(typeof input.results[0].markdown).toBe('string');
  });

  test('explicit formats:["markdown"] preserves markdown', () => {
    const item = baseItem();
    const output = projectIntegratedSearchEvidenceItem(item, {
      responseMode: 'evidence',
      explicitFormats: ['markdown'],
    });
    expect(output.markdown).toBe(item.markdown);
    expect(output.highlights).toEqual(item.highlights);
  });

  test('extractHighlights:false preserves markdown', () => {
    const item = baseItem();
    const output = projectIntegratedSearchEvidenceItem(item, {
      responseMode: 'evidence',
      extractHighlights: false,
    });
    expect(output.markdown).toBe(item.markdown);
  });

  test('no highlights preserves markdown', () => {
    const item = { ...baseItem(), highlights: [] };
    const output = projectIntegratedSearchEvidenceItem(item, {
      responseMode: 'evidence',
    });
    expect(output.markdown).toBe(item.markdown);
  });

  test('a duplicate pointing to the same highlights elsewhere drops markdown like a highlighted item', () => {
    const { highlights: _h, ...rest } = baseItem();
    const item = { ...rest, highlightsSameAs: 'https://example.com/original' };
    const output = projectIntegratedSearchEvidenceItem(item, { responseMode: 'evidence' });
    expect(output.markdown).toBeUndefined();
    expect(output.highlightsSameAs).toBe('https://example.com/original');
  });

  test('scrape error and snippet fallback preserve markdown', () => {
    const errorItem = { ...baseItem(), scrapeError: 'blocked' };
    const fallbackItem = { ...baseItem(), isSnippetFallback: true };

    expect(
      projectIntegratedSearchEvidenceItem(errorItem, {
        responseMode: 'evidence',
      }).markdown,
    ).toBe(errorItem.markdown);

    expect(
      projectIntegratedSearchEvidenceItem(fallbackItem, {
        responseMode: 'evidence',
      }).markdown,
    ).toBe(fallbackItem.markdown);
  });

  test('X items preserve markdown', () => {
    for (const item of [
      { ...baseItem(), source: 'x' },
      {
        ...baseItem(),
        source: 'web',
        url: 'https://x.com/example/status/123',
      },
      {
        ...baseItem(),
        source: 'web',
        url: 'https://twitter.com/example/status/123',
      },
    ]) {
      expect(
        projectIntegratedSearchEvidenceItem(item, {
          responseMode: 'evidence',
        }).markdown,
      ).toBe(item.markdown);
    }
  });

  test('markdown is never overwritten with highlight text', () => {
    const item = baseItem();
    const output = projectIntegratedSearchEvidenceItem(item, {
      responseMode: 'evidence',
      explicitFormats: ['markdown'],
    });
    expect(output.markdown).toBe(item.markdown);
    expect(output.markdown).not.toBe(item.highlights[0]);
  });

  test('MCP serialization is compact JSON; verbose stays pretty for debugging', () => {
    const input = response();
    const full = serializeIntegratedSearchMcpResponse(input, {
      responseMode: 'full',
    });
    const evidence = serializeIntegratedSearchMcpResponse(input, {
      responseMode: 'evidence',
    });
    const verbose = serializeIntegratedSearchMcpResponse(input, {
      responseMode: 'full',
      verbose: true,
    });

    expect(full).not.toContain('\n');
    expect(evidence).not.toContain('\n  "query"');
    expect(verbose).toContain('\n  "query"');
    expect(JSON.parse(full).results[0].markdown).toBeDefined();
    expect(JSON.parse(evidence).results[0].markdown).toBeUndefined();
    expect(JSON.parse(evidence).results[0].highlights).toEqual(
      input.results[0].highlights,
    );
  });

  test('known lossiness remains visible: evidence is not full-source equivalent', () => {
    const input = response();
    const output = formatIntegratedSearchHostResponse(input, {
      responseMode: 'evidence',
    });

    expect(input.results[0].markdown).toContain('Non-query detail');
    expect(JSON.stringify(output.results[0].highlights)).not.toContain(
      'Non-query detail',
    );
  });

  describe('maxTotalChars budget', () => {
    const page = (n: number) => ({ ...baseItem(), markdown: ('段落。'.repeat(20) + '\n\n').repeat(n) });
    const total = (r: Record<string, any>) =>
      r.results.reduce((a: number, it: any) => a + (it.markdown?.length ?? 0), 0);
    const mk = () => ({ ...response(), results: [page(100), page(100), page(100)] });

    test('no budget returns the original object by identity', () => {
      const input = mk();
      expect(formatIntegratedSearchHostResponse(input, {})).toBe(input);
    });

    test('keeps total markdown within budget, favors higher-ranked results, marks truncation', () => {
      const out = formatIntegratedSearchHostResponse(mk(), { maxTotalChars: 6000 });
      expect(total(out)).toBeLessThanOrEqual(6000);
      const [a, b, c] = out.results.map((it: any) => it.markdown.length);
      expect(a).toBeGreaterThan(b);
      expect(b).toBeGreaterThan(c);
      expect(out.results[0].markdownTruncated.totalChars).toBeGreaterThan(out.results[0].markdown.length);
      expect(out.results[0].highlights).toEqual(baseItem().highlights);
    });

    test('surplus from short pages flows to later pages; untouched items are not marked', () => {
      const short = { ...baseItem(), markdown: 'short' };
      const out = formatIntegratedSearchHostResponse(
        { ...response(), results: [short, page(100)] },
        { maxTotalChars: 4000 },
      );
      expect(out.results[0].markdown).toBe('short');
      expect(out.results[0].markdownTruncated).toBeUndefined();
      expect(out.results[1].markdown.length).toBeGreaterThan(3000);
    });

    test('nothing is truncated when the total already fits, regardless of order', () => {
      const short = { ...baseItem(), markdown: 'short page' };
      const input = { ...response(), results: [page(100), short, short] };
      const len = total(input as any);
      const out = formatIntegratedSearchHostResponse(input, { maxTotalChars: len });
      expect(total(out)).toBe(len);
      expect(out.results.some((it: any) => it.markdownTruncated)).toBe(false);
    });

    test('stays within the budget even when a code block has to be closed', () => {
      const code = { ...baseItem(), markdown: '```js\n' + 'const x = 1;\n'.repeat(400) + '```' };
      const out = formatIntegratedSearchHostResponse({ ...response(), results: [code] }, { maxTotalChars: 1000 });
      expect(out.results[0].markdown.length).toBeLessThanOrEqual(1000);
      expect((out.results[0].markdown.match(/```/g) ?? []).length % 2).toBe(0);
    });

    test('truncates at a paragraph boundary', () => {
      const out = formatIntegratedSearchHostResponse(mk(), { maxTotalChars: 3000 });
      for (const it of out.results) expect(it.markdown.endsWith('段落。')).toBe(true);
    });
  });
});

describe('schedule and the markdown budget', () => {
  test('maxTotalChars は schedule に影響しない', () => {
    const schedule = [{ name: '公演', startDate: '2026-10-15', sources: ['https://a.example/'] }];
    const out: any = formatIntegratedSearchHostResponse(
      { query: 'q', schedule, results: [{ url: 'https://a.example/', markdown: 'あ'.repeat(5000) }] },
      { maxTotalChars: 1000 },
    );
    expect(out.schedule).toEqual(schedule);
    expect(out.results[0].markdownTruncated).toBeDefined();
  });
});

describe('navigation blocks are cut first', () => {
  test('本文が空同然しか残らない場合は、従来どおり先頭側を残して切る（空の応答にしない）', () => {
    const banner = '-   [![バナー](https://a.example/bnr.jpg)](https://example.com/)';
    const tail = '本文の続きです。' + 'あいうえおかきくけこさしすせそたちつてとなにぬねの。'.repeat(10);
    const md = `---\nsiteName: "test"\n---\n\n${banner}\n\nあい\n\n${tail}`;
    const r = (formatIntegratedSearchHostResponse({ results: [{ url: 'https://a.example/', markdown: md }] }, { maxTotalChars: 150 }) as any).results[0];
    // 本文だけでは「あい」の2字しか残らないため、従来どおり先頭側を残して切る
    expect(r.markdown.startsWith('---')).toBe(true);
    expect(r.markdown).toContain('[![バナー]');
    expect(r.markdownTruncated.totalChars).toBe(md.length);
  });

  const nav = '-   [HOME](https://equal-love.jp/)\n-   [NEWS](https://equal-love.jp/news)\n-   [SCHEDULE](https://equal-love.jp/schedule)\n-   [PROFILE](https://equal-love.jp/feature/profile)';
  const front = '---\nsiteName: "＝LOVE（イコールラブ） オフィシャルサイト"\n---';
  const prose = Array.from({ length: 30 }, (_, i) => `10月${i + 1}日 ライブの予定です。開演は18時で、会場は東京の大きなホールです。`).join('\n\n');
  const run = (markdown: string, maxTotalChars: number) =>
    (formatIntegratedSearchHostResponse({ results: [{ url: 'https://a.example/', markdown }] }, { maxTotalChars }) as any).results[0];

  test('取り分が小さいとき、ナビではなく本文を残す', () => {
    const md = `${front}\n\n${nav}\n\n${prose}`;
    const r = run(md, 400);
    expect(r.markdown.startsWith(front)).toBe(true);
    expect(r.markdown).toContain('10月1日');
    expect(r.markdown).not.toContain('[HOME]');
    expect(r.markdownTruncated.totalChars).toBe(md.length);
  });

  test('全文が収まるときは並びを変えない', () => {
    const md = `${front}\n\n${nav}\n\nライブの予定です。`;
    const r = run(md, 5000);
    expect(r.markdown).toBe(md);
    expect(r.markdownTruncated).toBeUndefined();
  });

  test('ラベルが長いリンク一覧（ニュース・予定）は本文として動かさない', () => {
    const news = '-   [2026.10.15 ＝LOVE 9th ANNIVERSARY PREMIUM CONCERT 開催決定](https://a.example/1)\n-   [2026.10.10 新曲のミュージックビデオ公開のお知らせ](https://a.example/2)';
    const md = `${news}\n\n${prose}`;
    expect(run(md, 400).markdown.startsWith('-   [2026.10.15')).toBe(true);
  });

  test('ナビしかないページ、コードフェンスを含むページは変えない', () => {
    expect(run(`${front}\n\n${nav}`, 100).markdown.includes('[HOME]')).toBe(true);
    const fenced = `${nav}\n\n\`\`\`\ncode\n\n${nav}\n\`\`\`\n\n${prose}`;
    expect(run(fenced, 300).markdown.startsWith('-   [HOME]')).toBe(true);
  });

  test('実データ(equal-love.jp 相当): 空ラベルの行と画像リンクが混じったナビが先に落ちる', () => {
    const imageIcon = '-   [![x](https://equal-love.jp/static/x.svg)](https://twitter.com/equal_love_12)';
    const md = `${front}\n\n${nav}\n-\n${imageIcon}\n-\n\n${prose}`;
    const r = run(md, 400);
    // ナビの塊が切り詰めで先に落ち、本文が残る
    expect(r.markdown).toContain('ライブの予定です');
    expect(r.markdown).not.toContain('[HOME]');
    expect(r.markdownTruncated.totalChars).toBe(md.length);
  });
});

describe('includeMedia', () => {
  const response = () => ({
    query: 'q',
    results: [{
      url: 'https://a.example/',
      ogImage: 'https://a.example/og.png',
      media: { type: 'youtube', url: 'https://youtu.be/x' },
      images: [{ url: 'https://a.example/flyer.png' }],
      highlights: ['![画像](https://a.example/h.png) は触らない'],
      markdown: '# 見出し\n\n![ライブの写真](https://a.example/p.jpg)\n\n本文 ![](https://a.example/blank.png) 続き',
    }],
    realtime: { items: [{ id: '1', text: '投稿', media: ['https://pbs.example/1.jpg'] }] },
  });

  test('false のとき ogImage・media・本文の画像記法を省き、alt は残す', () => {
    const out: any = formatIntegratedSearchHostResponse(response(), { includeMedia: false });
    const r = out.results[0];
    expect(r.ogImage).toBeUndefined();
    expect(r.media).toBeUndefined();
    expect(r.markdown).toBe('# 見出し\n\n[画像: ライブの写真]\n\n本文  続き');
    expect(out.realtime.items[0].media).toBeUndefined();
    expect(out.realtime.items[0].text).toBe('投稿');
    // 明示要求の images・highlights は触らない
    expect(r.images).toEqual([{ url: 'https://a.example/flyer.png' }]);
    expect(r.highlights).toEqual(['![画像](https://a.example/h.png) は触らない']);
  });

  test('evidence でも verbose でも false なら省く', () => {
    expect((formatIntegratedSearchHostResponse(response(), { includeMedia: false, responseMode: 'evidence' }) as any).results[0].ogImage).toBeUndefined();
    expect((formatIntegratedSearchHostResponse(response(), { includeMedia: false, verbose: true }) as any).realtime.items[0].media).toBeUndefined();
  });

  test('未指定・true は従来どおり（full は同一オブジェクトのまま）', () => {
    const input = response();
    expect(formatIntegratedSearchHostResponse(input, {})).toBe(input);
    expect(formatIntegratedSearchHostResponse(input, { includeMedia: true })).toBe(input);
  });

  test('入力を書き換えない', () => {
    const input = response();
    const copy = JSON.parse(JSON.stringify(input));
    formatIntegratedSearchHostResponse(input, { includeMedia: false });
    expect(input).toEqual(copy);
  });

  test('maxTotalChars と併用すると、画像記法を除いた長さで配分される', () => {
    const md = `![写真](https://a.example/${'x'.repeat(900)}.jpg)\n\n本文`;
    const out: any = formatIntegratedSearchHostResponse({ results: [{ url: 'https://a.example/', markdown: md }] }, { includeMedia: false, maxTotalChars: 1000 });
    expect(out.results[0].markdownTruncated).toBeUndefined();
    expect(out.results[0].markdown).toBe('[画像: 写真]\n\n本文');
  });
});

describe('stripMedia and the markdown budget', () => {
  test('maxTotalChars と併用すると、画像記法を除いた長さで配分される', () => {
    const md = `![写真](https://a.example/${'x'.repeat(900)}.jpg)\n\n本文`;
    const out: any = formatIntegratedSearchHostResponse({ results: [{ url: 'https://a.example/', markdown: md }] }, { includeMedia: false, maxTotalChars: 1000 });
    expect(out.results[0].markdownTruncated).toBeUndefined();
    expect(out.results[0].markdown).toBe('[画像: 写真]\n\n本文');
  });
});
