import { describe, expect, test } from 'bun:test';
import { enrichTimeTreeHtml, waitForTimeTreeResponses } from './timetree.js';
import { convertHtmlToMarkdown } from './html_parser.js';

describe('TimeTree public calendar data', () => {
  test('collects a second response body that arrives while waiting for the first', async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    let secondCollected = false;
    const first = new Promise<void>(resolve => { finishFirst = resolve; });
    const second = new Promise<void>(resolve => { finishSecond = resolve; }).then(() => { secondCollected = true; });
    const pending = [first];
    const waiting = waitForTimeTreeResponses(pending, Date.now() + 500);
    pending.push(second);
    finishFirst();
    const timer = setTimeout(finishSecond, 20);
    try {
      await waiting;
      expect(secondCollected).toBe(true);
    } finally {
      clearTimeout(timer);
      finishSecond();
      await second;
    }
  });

  test('stops waiting for an unfinished response body at the overall deadline', async () => {
    await waitForTimeTreeResponses([new Promise(() => {})], Date.now() + 20);
  }, 500);

  const event = {
    id: '3025540411106379996', title: '『超 明星現象 2026』',
    note: '🗓️10/7(水)\n📍Spotify O-Crest\nライブ 15:00〜15:20\n特典会 15:35〜16:35(ATOM5F)',
    start_at: 1791331200000, end_at: 1791331200000, all_day: true,
    start_timezone: 'UTC', end_timezone: 'UTC', location_name: 'Spotify O-Crest',
    url: 'https://timetr.ee/p/kimisora/3025540411106379996',
    images: { cover: [{ url: 'https://attachments.timetreeapp.com/flyer.jpg' }] },
  };
  const html = '<html><head><title>Calendar</title></head><body><main><div role="grid">Mon Tue Wed 1 2 3</div></main></body></html>';

  test('retains every event with its date, description, venue and source link in full markdown', () => {
    const second = { ...event, id: 'second', title: 'Second concert', all_day: false,
      start_at: Date.parse('2026-10-11T06:00:00Z'), end_at: Date.parse('2026-10-11T08:00:00Z'),
      url: 'https://timetr.ee/p/kimisora/second', note: 'Second concert details 15:00〜17:00' };
    const enriched = enrichTimeTreeHtml(html, [{ public_events: [event, second] }, { public_events: [event] }]);
    const result = convertHtmlToMarkdown(enriched, 'https://timetreeapp.com/public_calendars/kimisora', 30000, true);
    expect(result.contentStatus).toBe('body');
    expect(result.markdown).toContain('2026-10-07');
    expect(result.markdown).toContain('15:00〜15:20');
    expect(result.markdown).toContain('15:35〜16:35');
    expect(result.markdown).toContain('Second concert details');
    expect(result.markdown).toContain(second.url);
    expect(result.events).toHaveLength(2);
    expect(result.events?.[0]).toMatchObject({ name: event.title, startDate: '2026-10-07', location: 'Spotify O-Crest', url: event.url });
    expect(result.events?.[1]).toMatchObject({ startDate: '2026-10-11T06:00:00.000Z', endDate: '2026-10-11T08:00:00.000Z' });
    expect(result.images?.some(image => image.url.endsWith('/flyer.jpg'))).toBe(true);
  });

  test('treats event text as text and rejects unsafe links', () => {
    const enriched = enrichTimeTreeHtml(html, [{ public_events: [{ ...event,
      title: '<script>alert(1)</script>', note: '<img src=x onerror=alert(1)>',
      url: 'javascript:alert(1)', images: { cover: [{ url: 'javascript:alert(1)' }] },
    }] }]);
    expect(enriched).toContain('&lt;script&gt;');
    expect(enriched).not.toContain('javascript:');
    expect(enriched).not.toContain('<img src="x"');
  });

  test('leaves the page intact for missing or malformed public data', () => {
    expect(enrichTimeTreeHtml(html, [null, {}, { public_events: 'wrong' }, { public_events: [null, {}] }])).toBe(html);
  });
});
