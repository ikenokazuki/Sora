import { afterAll, describe, expect, test } from 'bun:test';
import { closeSharedBrowser, getBrowser, resolveChromiumPath } from './browser_engine.js';
import { inlineShadowDomContent, waitForDomStable } from './browser_stealth.js';
import { scrapeUrl } from './scraper.js';

afterAll(closeSharedBrowser);

describe.skipIf(!resolveChromiumPath())('browser content readiness', () => {
  test('refreshes shadow content without duplicating it across captures', async () => {
    const { browser } = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"open"}).innerHTML = "<p>First schedule</p>"</script>');
      await inlineShadowDomContent(page);
      await page.evaluate(() => { document.querySelector('#host')!.shadowRoot!.innerHTML = '<p>Updated schedule</p>'; });
      await inlineShadowDomContent(page);
      expect(await page.evaluate(() => document.querySelectorAll('#host > [data-sora-shadow-copy]').length)).toBe(1);
      expect(await page.evaluate(() => document.querySelector('#host > [data-sora-shadow-copy]')?.textContent)).toBe('Updated schedule');
    } finally {
      await page.close();
    }
  });

  test('waits for a text-only loader without loading class names', async () => {
    const { browser } = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent('<main>Loading…</main><script>setTimeout(() => document.querySelector("main").textContent = "Concert 2026-10-07 15:00", 750)</script>');
      await waitForDomStable(page, 200, 2000);
      expect(await page.content()).toContain('<main>Concert 2026-10-07 15:00</main>');
    } finally {
      await page.close();
    }
  });

  test('waits for late SPA content on a single navigation', async () => {
    let navigations = 0;
    const server = Bun.serve({ port: 0, fetch(req) {
      if (new URL(req.url).pathname !== '/calendar') return new Response('', { status: 404 });
      navigations++;
      return new Response('<html><head><title>Calendar</title></head><body><main>Loading…</main><script>setTimeout(() => document.querySelector("main").innerHTML = "<h1>Concert schedule</h1><p>2026-10-07 Concert at 15:00. Meet and greet at 15:35.</p>", 3500)</script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }});
    const previous = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'true';
    try {
      const result = await scrapeUrl({ url: `http://127.0.0.1:${server.port}/calendar`, mode: 'browser', timeoutMs: 6500, noCache: true });
      expect(result.contentStatus).toBe('body');
      expect(result.content).toContain('2026-10-07');
      expect(result.content).toContain('15:35');
      expect(navigations).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_LOCAL_FETCH;
      else process.env.ALLOW_LOCAL_FETCH = previous;
      server.stop(true);
    }
  }, 16000);

  test('does not wait for networkidle when the page never goes idle', async () => {
    const server = Bun.serve({ port: 0, fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/hang') return new Promise<Response>(() => {});
      return new Response('<html><head><title>Event</title></head><body><main><h1>Live schedule</h1><p>2026-10-17 Doors 15:00. Meet and greet at 15:35.</p></main><script>for (let i = 0; i < 3; i++) fetch("/hang?" + i)</script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }});
    const previous = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'true';
    try {
      const started = Date.now();
      const result = await scrapeUrl({ url: `http://127.0.0.1:${server.port}/`, mode: 'browser', timeoutMs: 15000, noCache: true });
      expect(result.content).toContain('15:35');
      expect(Date.now() - started).toBeLessThan(9000);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_LOCAL_FETCH;
      else process.env.ALLOW_LOCAL_FETCH = previous;
      server.stop(true);
    }
  }, 20000);

  test('does not wait for attribute-only DOM churn once the visible text is stable', async () => {
    const server = Bun.serve({ port: 0, fetch() {
      return new Response('<html><head><title>Event</title></head><body><main><h1>Live schedule</h1><p>2026-10-17 Doors 15:00. Meet and greet at 15:35.</p><p>' + 'detail '.repeat(80) + '</p></main><img id="i" alt="a" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><script>let n = 0; setInterval(() => { n++; const i = document.getElementById("i"); i.setAttribute("alt", "a" + n); i.setAttribute("data-x", String(n)); }, 30)</script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }});
    const previous = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'true';
    try {
      const started = Date.now();
      const result = await scrapeUrl({ url: `http://127.0.0.1:${server.port}/`, mode: 'browser', timeoutMs: 15000, noCache: true });
      expect(result.content).toContain('15:35');
      expect(Date.now() - started).toBeLessThan(3500);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_LOCAL_FETCH;
      else process.env.ALLOW_LOCAL_FETCH = previous;
      server.stop(true);
    }
  }, 20000);

  test('waits for a transient challenge to clear on the same page', async () => {
    let navigations = 0;
    const server = Bun.serve({ port: 0, fetch(req) {
      if (new URL(req.url).pathname !== '/challenge') return new Response('', { status: 404 });
      navigations++;
      return new Response('<html><head><title>Challenge</title></head><body><main>Just a moment...</main><script>setTimeout(() => document.querySelector("main").innerHTML = "<h1>Concert schedule</h1><p>2026-10-07 Concert at 15:00. Meet and greet at 15:35.</p>", 2800)</script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }});
    const previous = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'true';
    try {
      const result = await scrapeUrl({ url: `http://127.0.0.1:${server.port}/challenge`, mode: 'browser', timeoutMs: 6500, noCache: true });
      expect(result.contentStatus).toBe('body');
      expect(result.content).toContain('15:35');
      expect(navigations).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_LOCAL_FETCH;
      else process.env.ALLOW_LOCAL_FETCH = previous;
      server.stop(true);
    }
  }, 16000);

  test('does not count content hidden by a CSS class as ready or destroy the live DOM while waiting', async () => {
    let navigations = 0;
    const server = Bun.serve({ port: 0, fetch(req) {
      if (new URL(req.url).pathname !== '/hidden') return new Response('', { status: 404 });
      navigations++;
      return new Response(`<html><head><title>Calendar</title><style>.hidden { display: none; }</style></head><body>
        <main class="hidden"><p>${'Hidden placeholder content with information that is not visible. '.repeat(8)}</p></main>
        <div id="schedule">Fetching calendar</div><script>setTimeout(() => {
          document.querySelector('main').className = '';
          document.querySelector('main').innerHTML = '<h1>Concert schedule</h1><p>Concert 2026-10-07 at 15:00. Meet and greet starts at 15:35.</p>';
          document.querySelector('#schedule').remove();
        }, 2800)</script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }});
    const previous = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'true';
    try {
      const result = await scrapeUrl({ url: `http://127.0.0.1:${server.port}/hidden`, mode: 'browser', timeoutMs: 6500, noCache: true });
      expect(result.content).toContain('15:35');
      expect(result.content).not.toContain('Hidden placeholder');
      expect(navigations).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_LOCAL_FETCH;
      else process.env.ALLOW_LOCAL_FETCH = previous;
      server.stop(true);
    }
  }, 16000);
});
