import { expect, test } from 'bun:test';
import { stripTags } from './strip_tags.js';

test('/<[^>]*>/g と同じ結果（乱数の 20,000 通り）', () => {
  const pieces = ['<', '>', '<a', '</a>', ' ', 'x', '"', '/', '<br/>', '>>', '<<'];
  let seed = 26;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x1_0000_0000);
  for (let i = 0; i < 20_000; i++) {
    const s = Array.from({ length: 1 + Math.floor(random() * 16) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    for (const replacement of ['', ' ']) expect(stripTags(s, replacement)).toBe(s.replace(/<[^>]*>/g, replacement));
  }
});

test('閉じない < の長い並びでも、時間がかからない', () => {
  const started = performance.now();
  expect(stripTags(`<p>a</p>${'<'.repeat(200_000)}`, ' ')).toBe(` a ${'<'.repeat(200_000)}`);
  expect(performance.now() - started).toBeLessThan(500);
});
