import { describe, expect, setSystemTime, test } from 'bun:test';
import { SEARCH_WEB_INPUT_SHAPE, SearchWebRequestSchema, buildSearchWebCacheKey, isTransientWebSearch, searchWebForRest, searchWebWithFormats } from './search_web_formats.js';
describe('search_web formats orchestration',()=>{
  test('legacy no-format path preserves provider values without scraping',async()=>{ const provider={items:[{title:'A',url:'https://e/a',snippet:'s'}],count:1,source:'web'}; let calls=0; const r=await searchWebWithFormats({query:'x'},{searchYahooWeb:async()=>provider,scrapeUrl:async()=>{calls++; throw new Error('no');}} as any); expect(r).toEqual(provider); expect(calls).toBe(0); });
  test('formats activates scraping and defaults to top five',async()=>{ const provider={items:Array.from({length:7},(_,i)=>({title:`R${i}`,url:`https://e/${i}`,snippet:`s${i}`})),count:7,source:'web'}; let calls=0; const r=await searchWebWithFormats({query:'x',formats:['markdown']},{searchYahooWeb:async()=>provider,scrapeUrl:async({url}:any)=>{calls++; return {content:`# ${url}\n\nfull body with enough characters 123456789012345678901234567890`};}} as any); expect(r.items).toHaveLength(5); expect(calls).toBe(5); expect(r.items[0].markdown).toContain('full body'); expect(r.items[0].html).toBeUndefined(); });
  test('requested structured formats do not leak unrelated payloads',async()=>{ const r=await searchWebWithFormats({query:'t',formats:['tables','images'],limit:1},{searchYahooWeb:async()=>({items:[{title:'T',url:'https://e/t'}],count:1,source:'web'}),scrapeUrl:async()=>({content:'# hidden',html:'<p>x</p>',tables:[{headers:['A'],rows:[{A:'1'}]}],images:[{url:'x'}]})} as any); expect(r.items[0].tables).toHaveLength(1); expect(r.items[0].images).toHaveLength(1); expect(r.items[0].markdown).toBeUndefined(); expect(r.items[0].html).toBeUndefined(); });
  test('one scrape failure preserves sibling search results',async()=>{ const r=await searchWebWithFormats({query:'x',formats:['markdown'],limit:2},{searchYahooWeb:async()=>({items:[{title:'A',url:'https://e/a',snippet:'a'},{title:'B',url:'https://e/b',snippet:'b'}],count:2,source:'web'}),scrapeUrl:async({url}:any)=>{if(url.endsWith('/a')) throw new Error('blocked'); return {content:'# B\n\nusable body with enough characters 123456789012345678901234567890'};}} as any); expect(r.items[0].scrapeError).toContain('blocked'); expect(r.items[1].markdown).toContain('usable body'); });
  test('shared schema/cache key partition formats',()=>{ expect(SearchWebRequestSchema.safeParse({query:'x',formats:['markdown','tables']}).success).toBe(true); expect(SearchWebRequestSchema.safeParse({query:'x',formats:['bogus']}).success).toBe(false); expect(SEARCH_WEB_INPUT_SHAPE.formats).toBeDefined(); expect(buildSearchWebCacheKey({query:'x'})).not.toBe(buildSearchWebCacheKey({query:'x',formats:['markdown']})); });
  test('default response compacts union provenance without changing provider calls',async()=>{ const calls:string[]=[]; const provider={items:[{title:'A',url:'https://e/a',snippet:'s',highlights:['evidence'],retrievalQuery:'x',retrievalQueryIndex:0}],count:1,source:'web',originalQuery:'x',bindingQuery:'x',retrievalQueries:['x']}; const r=await searchWebWithFormats({query:'x'},{searchYahooWeb:async({query}:any)=>{calls.push(query); return provider;},scrapeUrl:async()=>{throw new Error('no');}} as any); expect(calls).toEqual(['x']); expect(r.items).toEqual([{title:'A',url:'https://e/a',snippet:'s',highlights:['evidence']}]); expect(r.bindingQuery).toBeUndefined(); expect(r.retrievalQueries).toBeUndefined(); });
  test('verbose response preserves union provenance without changing provider calls',async()=>{ const calls:string[]=[]; const provider={items:[{title:'A',url:'https://e/a',retrievalQuery:'x',retrievalQueryIndex:0}],count:1,source:'web',originalQuery:'x',bindingQuery:'x',retrievalQueries:['x']}; const r=await searchWebWithFormats({query:'x',verbose:true},{searchYahooWeb:async({query}:any)=>{calls.push(query); return provider;},scrapeUrl:async()=>{throw new Error('no');}} as any); expect(calls).toEqual(['x']); expect(r).toBe(provider); expect(r.items[0].retrievalQuery).toBe('x'); expect(r.retrievalQueries).toEqual(['x']); });
});

describe('REST /search/web cache: an answer that came from a throttled source is not kept', () => {
  let n = 0;
  const newQuery = () => `cache-test-${Date.now()}-${++n}`;
  const source = (answer: () => unknown) => {
    let calls = 0;
    return { calls: () => calls, deps: { searchYahooWeb: (async () => { calls++; return answer(); }) as never, scrapeUrl: (async () => ({})) as never } };
  };
  const healthy = { items: [{ title: 'A', url: 'https://e/a', snippet: 's' }], count: 1, source: 'web' };
  const throttled = { items: [], count: 0, source: 'web', throttled: true, partial: true, stopReason: 'provider_rate_limited' };

  test('only throttled or stale answers are transient', () => {
    expect(isTransientWebSearch(throttled)).toBe(true);
    expect(isTransientWebSearch({ ...healthy, stale: true })).toBe(true);
    expect(isTransientWebSearch(healthy)).toBe(false);
    expect(isTransientWebSearch({ items: [], count: 0, source: 'web' })).toBe(false); // 0 件の検索は一時的とは限らないので、短くキャッシュする（下のテスト）
    expect(isTransientWebSearch(null)).toBe(false);
  });

  test('a zero-result answer is kept only briefly: served within a minute, asked again after it', async () => {
    const query = newQuery();
    const empty = { items: [], count: 0, source: 'web' };
    const first = source(() => empty);
    await searchWebForRest({ query }, first.deps);
    const within = source(() => healthy);
    expect((await searchWebForRest({ query }, within.deps)).data.items).toHaveLength(0);
    expect(within.calls()).toBe(0);
    setSystemTime(new Date(Date.now() + 61_000));
    try {
      const after = source(() => healthy);
      expect((await searchWebForRest({ query }, after.deps)).data.items).toHaveLength(1);
      expect(after.calls()).toBe(1);
    } finally {
      setSystemTime();
    }
  });

  test('a throttled answer is returned, but the next call asks the source again', async () => {
    const query = newQuery();
    const first = await searchWebForRest({ query }, source(() => throttled).deps);
    expect(first.data.throttled).toBe(true);
    const recovered = source(() => healthy);
    const second = await searchWebForRest({ query }, recovered.deps);
    expect(recovered.calls()).toBe(1);
    expect(second.data.items).toHaveLength(1);
    expect(second.data.throttled).toBeUndefined();
  });

  test('a stale answer is not kept either', async () => {
    const query = newQuery();
    await searchWebForRest({ query }, source(() => ({ ...healthy, stale: true })).deps);
    const fresh = source(() => healthy);
    await searchWebForRest({ query }, fresh.deps);
    expect(fresh.calls()).toBe(1);
  });

  test('a normal answer is kept, and the second call is served from the cache', async () => {
    const query = newQuery();
    await searchWebForRest({ query }, source(() => healthy).deps);
    const second = source(() => { throw new Error('should not be asked'); });
    const again = await searchWebForRest({ query }, second.deps);
    expect(second.calls()).toBe(0);
    expect(again.data.items).toHaveLength(1);
    expect(again.cached).toBe(true);
  });

  test('noCache neither reads nor writes the cache', async () => {
    const query = newQuery();
    await searchWebForRest({ query }, source(() => healthy).deps);
    const bypass = source(() => healthy);
    await searchWebForRest({ query, noCache: true }, bypass.deps);
    expect(bypass.calls()).toBe(1);
  });
});
