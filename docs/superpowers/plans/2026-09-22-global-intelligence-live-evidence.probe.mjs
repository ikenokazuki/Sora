// Investigation only: read public sources, retain metadata rather than article bodies.
const sources = [
  ['usgs', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson'],
  ['gdelt_updates', 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt'],
  ['gdacs_rss', 'https://www.gdacs.org/xml/rss.xml'],
  ['eonet', 'https://eonet.gsfc.nasa.gov/api/v3/events?limit=5&days=30'],
  ['bbc_world', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['un_news', 'https://news.un.org/feed/subscribe/en/news/all/rss.xml'],
  ['who_news', 'https://www.who.int/rss-feeds/news-english.xml'],
  ['ecb_press', 'https://www.ecb.europa.eu/rss/press.html'],
  ['gdelt_doc', 'https://api.gdeltproject.org/api/v2/doc/doc?query=China&mode=ArtList&format=json&maxrecords=10&timespan=24h'],
];
function date(value) {
  if (value === undefined || value === null) return undefined;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
}
async function probe([name, url]) {
  const startedAt = new Date().toISOString(), t = performance.now();
  try {
    const res = await fetch(url, {signal: AbortSignal.timeout(20000)});
    const body = await res.text();
    const output = {name, url, startedAt, finishedAt: new Date().toISOString(), status: res.status, latencyMs: Math.round(performance.now()-t), bytes: new TextEncoder().encode(body).length, contentType: res.headers.get('content-type'), lastModified: res.headers.get('last-modified'), retryAfter: res.headers.get('retry-after')};
    if (!res.ok) return {...output, errorExcerpt: body.replace(/<[^>]*>/g, ' ').trim().slice(0, 240)};
    if (name === 'gdelt_updates') {
      const line = body.split('\n').find(x => x.includes('.export.CSV.zip'));
      const stamp = line?.match(/\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.export/);
      output.latestRecordAt = stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z` : undefined;
      output.exportUrl = line?.trim().split(/\s+/).at(-1);
    } else if (['usgs','eonet','gdelt_doc'].includes(name)) {
      const data = JSON.parse(body);
      const items = data.features ?? data.events ?? data.articles ?? [];
      output.itemCount = items.length;
      output.providerGeneratedAt = date(data.metadata?.generated);
      const dates = items.flatMap(item => name === 'usgs' ? [date(item.properties?.updated)] : name === 'eonet' ? (item.geometry ?? []).map(g=>date(g.date)) : [date(item.seendate?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))]).filter(Boolean).sort();
      output.latestRecordAt = dates.at(-1);
      output.timestampMeaning = name === 'usgs' ? 'record updated' : name === 'eonet' ? 'geometry observation; not publication time' : 'GDELT seen time; not publisher publication time';
    } else {
      output.itemCount = (body.match(/<(?:item|entry)(?:\s|>)/g) ?? []).length;
      const tags = [...body.matchAll(/<(?:pubDate|updated|dc:date|gdacs:datemodified)\b[^>]*>([\s\S]*?)<\//g)];
      const dates = tags.map(m=>date(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim())).filter(Boolean).sort();
      output.latestRecordAt = dates.at(-1);
      output.timestampMeaning = 'latest parseable feed publication/update tag; provider semantics require adapter validation';
      output.validFeed = /<(rss|feed|rdf:RDF)(\s|>)/.test(body);
    }
    return output;
  } catch (e) { return {name, url, startedAt, finishedAt:new Date().toISOString(),latencyMs:Math.round(performance.now()-t),error:String(e)}; }
}
const results = [];
for (let i = 0; i < sources.length; i += 3) {
  const batch = await Promise.all(sources.slice(i,i+3).map(probe));
  results.push(...batch);
}
console.log(JSON.stringify({environment:process.argv[2] ?? 'host',checkedAt:new Date().toISOString(),timeoutMs:20000,concurrency:3,results}, null, 2));
