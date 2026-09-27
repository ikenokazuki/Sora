import { describe, expect, test } from 'bun:test';
// wreq-js native binding requires libstdc++ (dev shell rc + Dockerfile libstdc++6).
// If this fails, the fetcher silently falls back to native fetch and loses TLS impersonation.
describe('wreq-js native availability', () => {
  test('loads and exposes browser profiles', async () => {
    const w = await import('wreq-js');
    expect(w.getProfiles().length).toBeGreaterThan(0);
  });
});
