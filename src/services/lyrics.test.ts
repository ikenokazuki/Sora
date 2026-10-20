import { describe, expect, test } from 'bun:test';
import { parseLyricsCandidates, parseLyricsPage } from './lyrics.js';

describe('lyrics parser', () => {
  test('candidates: song links only, artist from row', () => {
    const html = `<table><tr><td><a href="/song/1/"><span class="songlist-title">曲A</span></a></td><td><a href="/artist/9/">グループX</a></td></tr>
      <tr><td><a href="/song/1/">dup</a></td></tr><tr><td><a href="/other/">x</a></td></tr></table>`;
    expect(parseLyricsCandidates(html)).toEqual([{ title: '曲A', artist: 'グループX', url: 'https://www.uta-net.com/song/1/' }]);
  });

  test('page: br → newline, throws without body', () => {
    const html = `<h2>曲A</h2><div id="kashi_area">一行目<br />二行目<br /><br /><br /><br />三行目</div>`;
    expect(parseLyricsPage(html).lyrics).toBe('一行目\n二行目\n\n三行目');
    expect(() => parseLyricsPage('<h2>x</h2>')).toThrow('lyrics not found');
  });
});
