import * as cheerio from 'cheerio';

export async function waitForTimeTreeResponses(pending: Promise<unknown>[], deadline: number): Promise<void> {
  let collected = 0;
  while (collected < pending.length && Date.now() < deadline) {
    const batch = pending.slice(collected);
    collected += batch.length;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = await Promise.race([
        Promise.all(batch).then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), deadline - Date.now()); }),
      ]);
      if (!finished) return;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {}
}

function eventDate(value: unknown, allDay: boolean, timezone: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return;
  if (!allDay) return date.toISOString();
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: typeof timezone === 'string' ? timezone : 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** 公開ページ自身が取得した予定だけを本文と構造化データに保持する。追加通信は行わない。 */
export function enrichTimeTreeHtml(html: string, responses: unknown[]): string {
  const events = new Map<string, Record<string, unknown>>();
  for (const response of responses) {
    const rows = (response as { public_events?: unknown } | null)?.public_events;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row.title !== 'string' || !row.title.trim() || typeof row.id !== 'string') continue;
      const images = [row.images?.cover, row.images?.overview].flatMap(items =>
        Array.isArray(items) ? items.map(image => httpUrl(image?.url)).filter((url): url is string => Boolean(url)) : []);
      events.set(row.id, {
        '@type': 'Event', name: row.title,
        startDate: eventDate(row.start_at, row.all_day === true, row.start_timezone),
        endDate: eventDate(row.end_at, row.all_day === true, row.end_timezone),
        description: [row.headline, row.note, row.overview, row.location_note].filter(value => typeof value === 'string' && value).join('\n\n'),
        location: typeof row.location_name === 'string' && row.location_name ? row.location_name : undefined,
        url: httpUrl(row.url), image: [...new Set(images)],
      });
    }
  }
  if (events.size === 0) return html;

  const $ = cheerio.load(html);
  const section = $('<section data-sora-timetree-events></section>');
  for (const event of events.values()) {
    const article = $('<article></article>');
    article.append($('<h2></h2>').text(event.name as string));
    for (const key of ['startDate', 'endDate', 'location'] as const) {
      if (typeof event[key] === 'string') article.append($('<p></p>').text(`${key}: ${event[key]}`));
    }
    const description = $('<p></p>');
    for (const [index, line] of (event.description as string).split('\n').entries()) {
      if (index > 0) description.append('<br>');
      description.append($('<span></span>').text(line));
    }
    article.append(description);
    if (event.url) article.append($('<a></a>').attr('href', event.url as string).text(event.url as string));
    for (const image of event.image as string[]) article.append($('<img>').attr('src', image).attr('alt', event.name as string));
    section.append(article);
  }
  $('main, [role="main"]').first().length
    ? $('main, [role="main"]').first().append(section)
    : $('body').append(section);
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@graph': [...events.values()] }).replace(/</g, '\\u003c');
  $('head').append($('<script type="application/ld+json"></script>').text(jsonLd));
  return $.html();
}
