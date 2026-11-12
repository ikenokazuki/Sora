import { describe, expect, test } from 'bun:test';
import { parseXDiscoverySeed } from './x_source_isolation.js';

describe('parseXDiscoverySeed', () => {
  test('supports profile, status, i/web/status, and i/status URL shapes', () => {
    expect(parseXDiscoverySeed('https://x.com/kimisora_JPN')?.kind).toBe('profile');
    expect(
      parseXDiscoverySeed(
        'https://x.com/kimisora_JPN/status/2099058849554829468',
      )?.statusId,
    ).toBe('2099058849554829468');
    expect(
      parseXDiscoverySeed(
        'https://x.com/i/web/status/2099058849554829468',
      )?.statusId,
    ).toBe('2099058849554829468');
    expect(
      parseXDiscoverySeed(
        'https://x.com/i/status/2099058849554829468',
      )?.statusId,
    ).toBe('2099058849554829468');
  });
});
