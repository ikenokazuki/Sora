/** Research only: replay URLs observed in Rakuten's public navigation. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'cheerio';
import puppeteer from 'puppeteer-core';

type ObservedCase = { id: string; label: string; url: string };
type DatedState = {
  isDated: boolean;
  conditions: Record<string, string[]>;
  totalResults: number[];
  displayedHotels: number[];
  hotels: Record<string, unknown>;
};

const CONDITION_KEYS = new Set([
  'f_dai', 'f_chu', 'f_shou', 'f_sai', 'f_cok', 'f_latitude', 'f_longitude', 'f_km',
  'f_nen1', 'f_tuki1', 'f_hi1', 'f_nen2', 'f_tuki2', 'f_hi2', 'f_otona_su', 'f_heya_su',
  'f_sort', 'f_page', 'f_hyoji', 'f_tab',
]);
const CHARGE_KEYS = ['sumTotalChargeTaxExclusive', 'sumTotalChargeTaxInclusive', 'taxType'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function savedState(value: unknown): DatedState {
  if (!isRecord(value) || typeof value.isDated !== 'boolean' || !isRecord(value.conditions)
    || !isRecord(value.hotels) || !Array.isArray(value.displayedHotels)
    || !Array.isArray(value.totalResults)
    || !value.displayedHotels.every(id => typeof id === 'number' && Number.isSafeInteger(id))
    || !value.totalResults.every(count => typeof count === 'number' && Number.isSafeInteger(count))) {
    throw new Error('Unexpected ds structure; not an empty search');
  }
  const conditions: Record<string, string[]> = {};
  for (const [key, condition] of Object.entries(value.conditions)) {
    if (!CONDITION_KEYS.has(key)) continue;
    if (!Array.isArray(condition) || !condition.every(item => typeof item === 'string')) {
      throw new Error('Unexpected condition structure');
    }
    conditions[key] = condition;
  }
  const hotels: Record<string, unknown> = {};
  for (const [hotelId, hotel] of Object.entries(value.hotels)) {
    if (!/^\d+$/.test(hotelId)) continue;
    if (!isRecord(hotel) || !isRecord(hotel.plans)) throw new Error('Unexpected hotel structure');
    const plans: Record<string, unknown> = {};
    for (const [planId, plan] of Object.entries(hotel.plans)) {
      if (!/^\d+$/.test(planId)) continue;
      if (!isRecord(plan) || !isRecord(plan.rooms)) throw new Error('Unexpected plan structure');
      const rooms: Record<string, unknown> = {};
      for (const [roomId, charge] of Object.entries(plan.rooms)) {
        if (!isRecord(charge)) throw new Error('Unexpected room structure');
        rooms[roomId] = Object.fromEntries(CHARGE_KEYS.filter(key => key in charge).map(key => {
          const amount = charge[key];
          if (key === 'taxType' ? !['inclusive', 'exclusive'].includes(String(amount))
            : typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
            throw new Error('Unexpected charge structure');
          }
          return [key, amount];
        }));
      }
      plans[planId] = { rooms };
    }
    hotels[hotelId] = { plans, rooms: {} };
  }
  return { isDated: value.isDated, conditions, totalResults: value.totalResults,
    displayedHotels: value.displayedHotels, hotels };
}

// The value after `var ds =` is JSON in the observed responses; never eval it.
export function extractDatedState(html: string): DatedState | null {
  const $ = load(html);
  for (const script of $('script:not([src])').toArray()) {
    const source = $(script).text();
    const match = /\bvar\s+ds\s*=\s*(?=\{)/.exec(source);
    if (!match) continue;
    const start = match.index + match[0].length;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        return savedState(JSON.parse(source.slice(start, i + 1)));
      }
    }
    throw new Error('Unterminated ds JSON');
  }
  return null;
}

// Persist public search inputs only; omit cookies, tokens, and tracking URLs.
function publicUrl(raw: string): string {
  const url = new URL(raw);
  const safe = new URL(url.origin + url.pathname.replace(/[a-f0-9]{32,}/gi, '[redacted]'));
  for (const [key, value] of url.searchParams) {
    if (/^f_/.test(key) && !/token|session|auth|csrf/i.test(key)) safe.searchParams.set(key, value);
  }
  return safe.toString();
}

function snapshot(html: string) {
  const $ = load(html);
  const state = extractDatedState(html);
  const jsonLdTypes = $('script[type="application/ld+json"]').map((_, script) => {
    try { return JSON.parse($(script).text())['@type']; } catch { return 'invalid-json'; }
  }).get();
  return { title: $('title').text(), chars: html.length, state, jsonLdTypes };
}

function withConditions(observed: ObservedCase, checkIn: string, checkOut: string, adults: number) {
  const url = new URL(observed.url);
  if (url.origin !== 'https://search.travel.rakuten.co.jp'
    || !/^\/ds\/(hotellist\/|vacant\/searchOnsen$)/.test(url.pathname)) {
    throw new Error('Unexpected observed search route');
  }
  for (const [date, side] of [[checkIn, '1'], [checkOut, '2']]) {
    const [year, month, day] = date.split('-');
    url.searchParams.set('f_nen' + side, year);
    url.searchParams.set('f_tuki' + side, String(Number(month)));
    url.searchParams.set('f_hi' + side, String(Number(day)));
  }
  url.searchParams.set('f_otona_su', String(adults));
  url.searchParams.set('f_heya_su', '1');
  return url;
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!['capture', 'replay', 'verify'].includes(mode)) throw new Error('Mode: capture | replay | verify');
  const options: Record<string, string> = {};
  const allowed = new Set(['--out-dir', '--case', '--check-in', '--check-out', '--adults', '--device']);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1]) throw new Error('Invalid probe option: ' + args[i]);
    options[args[i]] = args[i + 1];
  }
  if (!options['--out-dir']) throw new Error('--out-dir required');
  if (process.env.SORA_LIVE_TESTS !== '1') throw new Error('SORA_LIVE_TESTS=1 required; no requests sent');
  const device = options['--device'] ?? 'pc';
  if (!['pc', 'mobile'].includes(device)) throw new Error('--device: pc | mobile');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const date = new Date(Date.parse(today + 'T00:00:00Z') + 14 * 86400000);
  date.setUTCDate(date.getUTCDate() + (2 - date.getUTCDay() + 7) % 7);
  const checkIn = options['--check-in'] ?? date.toISOString().slice(0, 10);
  const checkOut = options['--check-out'] ?? new Date(Date.parse(checkIn) + 86400000).toISOString().slice(0, 10);
  const adults = Number(options['--adults'] ?? '2');
  if (!validDate(checkIn) || !validDate(checkOut) || checkOut <= checkIn || ![1, 2].includes(adults)) {
    throw new Error('Probe requires real ordered dates and 1 or 2 adults');
  }
  const manifest = JSON.parse(readFileSync(new URL('../docs/evaluations/rakuten-travel/observed-cases.json', import.meta.url), 'utf8')) as { cases: ObservedCase[] };
  const selected = options['--case'] ?? 'tokyo';
  const cases = manifest.cases.filter(item => selected === 'all' || item.id === selected);
  if (!cases.length) throw new Error('--case: tokyo | kyoto | kusatsu | all');
  const outDir = resolve(options['--out-dir']);
  mkdirSync(outDir, { recursive: true });
  let lastStarted = 0;
  let upstreamRequests = 0;
  for (const item of cases) {
    const url = withConditions(item, checkIn, checkOut, adults);
    const report: Record<string, unknown> = {
      caseId: item.id, location: item.label, query: { checkIn, checkOut, adults, rooms: 1 },
      retrievedAt: new Date().toISOString(), requestedUrl: publicUrl(url.toString()),
    };
    try {
      if (mode !== 'capture') {
        if (upstreamRequests >= 24) throw new Error('Request budget exhausted');
        upstreamRequests++;
        await Bun.sleep(Math.max(0, 3000 - (Date.now() - lastStarted)));
        lastStarted = Date.now();
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
        if ([403, 429].includes(response.status)) throw new Error('Stop: HTTP ' + response.status);
        const html = await response.text();
        report.http = {
          status: response.status, contentType: response.headers.get('content-type'),
          elapsedMs: Date.now() - lastStarted, ...snapshot(html),
          redirect: response.headers.get('location') ? publicUrl(new URL(response.headers.get('location')!, url).toString()) : null,
        };
      }
      if (mode !== 'replay') {
        const executablePath = [process.env.CHROME_PATH, process.env.CHROME_BIN,
          process.env.PUPPETEER_EXECUTABLE_PATH, '/usr/bin/chromium'].find(path => path && existsSync(path));
        if (!executablePath) throw new Error('Set CHROME_PATH to a working Chromium executable');
        const started = Date.now();
        const browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 15000,
          args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        const watchdog = setTimeout(() => browser.process()?.kill('SIGTERM'), 45000);
        const pending: Promise<void>[] = [];
        const records: unknown[] = [];
        let denied: number | undefined;
        let budgetExhausted = false;
        try {
          const context = await browser.createBrowserContext();
          const page = await context.newPage();
          await page.setViewport(device === 'mobile' ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1440, height: 1000 });
          if (device === 'mobile') await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
          await page.setRequestInterception(true);
          page.on('request', request => {
            const host = new URL(request.url()).hostname;
            const counted = ['document', 'xhr', 'fetch'].includes(request.resourceType())
              && /(^|\.)rakuten\.(co\.jp|com)$/.test(host)
              && !request.url().includes('/travel/getHotelPics?');
            if (denied || budgetExhausted || ['image', 'font', 'media'].includes(request.resourceType())
              || request.url().includes('/travel/getHotelPics?')) {
              void request.abort().catch(() => {});
              return;
            }
            if (counted && upstreamRequests >= 24) {
              budgetExhausted = true;
              void request.abort().catch(() => {});
              return;
            }
            if (counted) upstreamRequests++;
            void request.continue().catch(() => {});
          });
          page.on('response', response => {
            const request = response.request();
            const responseUrl = new URL(response.url());
            if (!['document', 'xhr', 'fetch'].includes(request.resourceType())
              || !/(^|\.)rakuten\.(co\.jp|com)$/.test(responseUrl.hostname)) return;
            if ([403, 429].includes(response.status())) denied = response.status();
            pending.push((async () => {
              const row: Record<string, unknown> = { url: publicUrl(response.url()), method: request.method(),
                status: response.status(), resourceType: request.resourceType(), contentType: response.headers()['content-type'] };
              if (String(row.contentType).includes('json')) {
                try {
                  const body = await response.text();
                  row.chars = body.length;
                  row.topKeys = Object.keys(JSON.parse(body)).slice(0, 20);
                } catch { row.parseFailed = true; }
              }
              records.push(row);
            })());
          });
          const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
          await Bun.sleep(3000);
          if (denied) throw new Error('Stop: HTTP ' + denied);
          if (budgetExhausted) throw new Error('Request budget exhausted');
          report.browser = { device, status: response?.status(), elapsedMs: Date.now() - started,
            finalUrl: publicUrl(page.url()), ...snapshot(await page.content()) };
          await context.close();
        } finally {
          await browser.close().catch(() => browser.process()?.kill('SIGTERM'));
          clearTimeout(watchdog);
          await Promise.allSettled(pending);
          report.responses = records;
        }
      }
      // This probe does not assign production readiness or invent missing metadata.
      report.adoption = 'not-assessed';
    } catch (error) {
      report.error = error instanceof Error ? error.message : 'Probe failed';
      throw error;
    } finally {
      report.upstreamRequests = upstreamRequests;
      const filename = join(outDir, item.id + '-' + mode + '-' + device + '.json');
      writeFileSync(filename, JSON.stringify(report, null, 2) + '\n');
      console.log(filename);
    }
  }
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Probe failed');
  process.exitCode = 1;
});
