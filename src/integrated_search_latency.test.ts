import { expect, spyOn, test } from 'bun:test';
import * as yahoo from './services/yahoo.js';
import { integratedSearch } from './scraper.js';

test('starts web page acquisition before the independent realtime search completes', async () => {
  let pageFetched!: () => void;
  const fetched = new Promise<void>(resolve => { pageFetched = resolve; });
  let finishRealtime!: (value: unknown) => void;
  const realtime = new Promise<any>(resolve => { finishRealtime = resolve; });
  const server = Bun.serve({ port: 0, fetch() {
    pageFetched();
    return new Response('<html><head><title>Concert schedule</title></head><body><main><h1>Concert schedule</h1><p>Concert on 2026-10-07 at 15:00. Meet and greet at 15:35. Venue details and ticket prices.</p></main></body></html>', { headers: { 'Content-Type': 'text/html' } });
  }});
  const webSpy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: [{ title: 'Concert schedule', url: `http://127.0.0.1:${server.port}/concert` }], count: 1 } as any);
  const realtimeSpy = spyOn(yahoo, 'searchYahooRealtime').mockImplementation(() => realtime);
  const previous = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
  const search = integratedSearch({ query: 'Concert schedule', limit: 1, includeRealtime: true, noCache: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const acquired = await Promise.race([
      fetched.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
    ]);
    expect(acquired).toBe(true);
    finishRealtime({ items: [{ text: 'Realtime concert evidence', url: 'https://example.com/realtime' }] });
    const result = await search;
    expect(result.results[0].markdown).toContain('15:35');
    expect(result.realtime.items[0].text).toBe('Realtime concert evidence');
  } finally {
    if (timer) clearTimeout(timer);
    finishRealtime({ items: [] });
    await search.catch(() => {});
    webSpy.mockRestore();
    realtimeSpy.mockRestore();
    if (previous === undefined) delete process.env.ALLOW_LOCAL_FETCH;
    else process.env.ALLOW_LOCAL_FETCH = previous;
    server.stop(true);
  }
});
