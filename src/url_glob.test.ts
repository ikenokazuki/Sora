import { describe, expect, test } from 'bun:test';
import { GlobBudgetError, globMatch } from './url_glob.js';
import { matchUrlPattern } from './html_parser.js';

/**
 * crawl の includePatterns / excludePatterns の照合（設計 6。穴 21）。`**` は任意の文字列、`*` は `/` を除く任意の文字列、
 * ほかの文字はそのまま。正規表現にしない（`*a*a*a*a*b` のようなパターンで、メインのスレッドが止まらない）。
 */

/** 以前の実装（正規表現）。同じ入力で同じ答えになることを、小さな文字の集まりのすべての組で確かめる */
function oldRegex(pattern: string): RegExp {
  let esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  esc = esc.replace(/\*\*/g, '___DOUBLE_STAR___');
  esc = esc.replace(/\*/g, '[^/]*');
  esc = esc.replace(/___DOUBLE_STAR___/g, '.*');
  return new RegExp(`^${esc}$`);
}
const oldGlob = (pattern: string, text: string): boolean => oldRegex(pattern).test(text);

function* strings(alphabet: string, maxLength: number): Generator<string> {
  yield '';
  let layer = [''];
  for (let length = 1; length <= maxLength; length++) {
    const next: string[] = [];
    for (const prefix of layer) for (const ch of alphabet) next.push(prefix + ch);
    yield* next;
    layer = next;
  }
}

describe('globMatch', () => {
  test('* は / を越えない。** は越える。ほかの文字はそのまま（大文字小文字を区別する）', () => {
    expect(globMatch('/guide/*', '/guide/intro')).toBe(true);
    expect(globMatch('/guide/*', '/guide/intro/more')).toBe(false);
    expect(globMatch('/docs/**', '/docs/a/b/c')).toBe(true);
    expect(globMatch('/docs/**', '/docs/')).toBe(true);
    expect(globMatch('/docs/**', '/doc/a')).toBe(false);
    expect(globMatch('*.pdf', 'report.pdf')).toBe(true);
    expect(globMatch('*.pdf', 'report.pdfx')).toBe(false);
    expect(globMatch('/A', '/a')).toBe(false);
    expect(globMatch('', '')).toBe(true);
    expect(globMatch('', 'x')).toBe(false);
    expect(globMatch('**', '')).toBe(true);
    expect(globMatch('*', '')).toBe(true);
  });

  test('正規表現の特別な文字は、そのままの文字（. + ^ $ { } ( ) | [ ] \\ ?）', () => {
    expect(globMatch('/a.b', '/a.b')).toBe(true);
    expect(globMatch('/a.b', '/axb')).toBe(false);
    expect(globMatch('/s(1)[2]{3}|4+5^6$', '/s(1)[2]{3}|4+5^6$')).toBe(true);
    expect(globMatch('/search?q=*', '/search?q=abc')).toBe(true);
    expect(globMatch('/search?q=*', '/searq=abc')).toBe(false);
    expect(globMatch('a\\b', 'a\\b')).toBe(true);
  });

  test('3 つ以上の * も ** と同じ（以前の実装と同じ）', () => {
    expect(globMatch('/a***b', '/a/x/yb')).toBe(true);
    expect(globMatch('/a****b', '/a/x/yb')).toBe(true);
  });

  test('以前の実装（正規表現）と、同じ答え: パターンの * を含む文字 4 種・6 文字までと、文字 3 種・7 文字までの文字列のすべての組', () => {
    const texts = [...strings('ab/', 7)];
    let compared = 0;
    for (const pattern of strings('ab/*', 6)) {
      const regex = oldRegex(pattern);
      for (const text of texts) {
        if (globMatch(pattern, text) !== regex.test(text)) throw new Error(`食い違い: pattern=${JSON.stringify(pattern)} text=${JSON.stringify(text)} new=${globMatch(pattern, text)}`);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(17_000_000);
  }, 60_000);

  test('以前の実装と、同じ答え（ランダムな長めの組。** と * と / と文字が混ざる）', () => {
    // 乱数は固定（再現できる）
    let seed = 20261113;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = (alphabet: string, length: number) => Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    for (let i = 0; i < 40_000; i++) {
      const pattern = pick('ab/**', 1 + Math.floor(random() * 12));
      const text = pick('ab/', Math.floor(random() * 20));
      if (globMatch(pattern, text) !== oldGlob(pattern, text)) throw new Error(`食い違い: pattern=${JSON.stringify(pattern)} text=${JSON.stringify(text)}`);
    }
  });

  test('予算（steps）を超えたら GlobBudgetError。予算が足りていれば、答えは同じで、使った分だけ減る', () => {
    const budget = { steps: 1_000_000 };
    expect(globMatch('/docs/**', '/docs/a/b', budget)).toBe(true);
    expect(budget.steps).toBeLessThan(1_000_000);
    expect(() => globMatch('*a*a*a*a*a*a*b', 'a'.repeat(5000), { steps: 1000 })).toThrow(GlobBudgetError);
    // 予算が無ければ、数えない
    expect(globMatch('/docs/**', '/docs/a/b')).toBe(true);
  });

  test('星が多いパターンでも、時間が爆発しない（以前の実装は、止まった）', () => {
    const started = performance.now();
    expect(globMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false);
    expect(globMatch('*a*a*a*a*a*a*a*a*b', `${'a'.repeat(5000)}b`)).toBe(true);
    expect(globMatch('/**/*a*a*a*a*a*a*b', `/${'a/'.repeat(1500)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('matchUrlPattern（pathname・URL 全体・ファイル名のどれかに当たれば true）', () => {
  test('パターンが無ければ true。当たれば true', () => {
    expect(matchUrlPattern('https://example.com/docs/a', undefined)).toBe(true);
    expect(matchUrlPattern('https://example.com/docs/a', [])).toBe(true);
    expect(matchUrlPattern('https://example.com/docs/a/b', ['/docs/**'])).toBe(true);
    expect(matchUrlPattern('https://example.com/docs/a/b', ['/guide/*'])).toBe(false);
    expect(matchUrlPattern('https://example.com/files/report.pdf', ['*.pdf'])).toBe(true);
    expect(matchUrlPattern('https://example.com/docs/a', ['https://example.com/docs/*'])).toBe(true);
  });

  test('星が多いパターンと長い URL でも、止まらない', () => {
    const started = performance.now();
    matchUrlPattern(`https://example.com/${'a'.repeat(4000)}`, ['*a*a*a*a*a*a*a*b']);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
