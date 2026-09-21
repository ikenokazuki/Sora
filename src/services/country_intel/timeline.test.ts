import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGdeltTimelineUrl, parseGdeltTimeline } from './providers/gdelt.js';

const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'gdelt_timeline_kr.json'), 'utf8'));

test('parses historical media observations into comparable buckets', () => {
  expect(buildGdeltTimelineUrl('South Korea')).toContain('TimelineVol');
  const series = parseGdeltTimeline(fixture);
  expect(series.length).toBeGreaterThan(7);
  expect(series.every((x) => x.origin === 'provider_historical')).toBe(true);
  expect(series[0]).toMatchObject({ date: '2026-09-01', value: 42 });
});
