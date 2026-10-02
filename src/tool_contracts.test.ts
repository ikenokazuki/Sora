import { describe, expect, test } from 'bun:test';
import { app } from './index.js';
import { CANONICAL_TOOLS, REST_MAP } from '../scripts/tool-health/catalog.js';

describe('tool public-route contracts', () => {
  test('every canonical tool with a REST mapping is routed', () => {
    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
      .map((r) => r.method.toUpperCase() + ' ' + r.path);
    for (const name of CANONICAL_TOOLS) {
      const mapping = REST_MAP[name];
      if (!mapping) continue;
      const key = mapping.method.toUpperCase() + ' ' + mapping.path;
      expect(routes).toContain(key);
    }
  });
  test('stream aliases exist and no phantom /search/stream is assumed', () => {
    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
      .map((r) => r.method.toUpperCase() + ' ' + r.path);
    expect(routes).toContain('POST /scrape/stream');
    expect(routes).toContain('POST /crawl/stream');
    expect(routes).not.toContain('POST /search/stream');
  });
});
