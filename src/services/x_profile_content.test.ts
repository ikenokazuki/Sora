import { describe, expect, test } from 'bun:test';
import { fetchTweetsForUrlOrUser } from './yahoo.js';

const post = (id: string, handle: string, name: string, text: string) => ({
  id, url: `https://x.com/${handle}/status/${id}`, text, author_name: name, author_handle: handle,
  created_at: 1760000000, reply_count: 0, repost_count: 0, like_count: 0,
});

function page(handler: (query: string) => any[], calls: string[]) {
  return async (opts: { query: string }) => {
    calls.push(opts.query);
    const items = handler(opts.query);
    return { items, count: items.length, page: 1 };
  };
}

// 「＝LOVE_official」は「LOVE off」と同じ語に見えるため、タイトルで検索すると無関係な投稿が返る
const unrelated = [post('1', 'dokidoki_syrup', 'どきどきシロップ剤', 'めっちゃ永遠ファンシ～LOVE off vocal #piapro')];
const official = [post('2', 'Equal_LOVE_12', '＝LOVE_official', '＝LOVE in TOKYO DOME 開催決定 チケット10月13日(火)17:00～予定')];

describe('fetchTweetsForUrlOrUser', () => {
  test('プロフィール URL はそのアカウント本人の投稿（id:）を使い、他人の投稿を本文にしない', async () => {
    const calls: string[] = [];
    const res = await fetchTweetsForUrlOrUser('https://x.com/Equal_LOVE_12', {
      contextTitle: '＝LOVE_official (@Equal_LOVE_12) / X',
      _searchPage: page((q) => (q === 'id:Equal_LOVE_12' ? official : unrelated), calls),
    } as any);
    expect(calls[0]).toBe('id:Equal_LOVE_12');
    expect(res?.content).toContain('TOKYO DOME');
    expect(res?.content).not.toContain('off vocal');
    expect(res?.author).toBe('＝LOVE_official');
  });

  test('本人の投稿が見つからなければ、他人の投稿ではなく検索スニペットを使う', async () => {
    const calls: string[] = [];
    const res = await fetchTweetsForUrlOrUser('https://x.com/Equal_LOVE_12', {
      contextTitle: '＝LOVE_official (@Equal_LOVE_12) / X',
      snippet: '＝LOVE in TOKYO DOME 開催決定',
      _searchPage: page((q) => (q.startsWith('id:') ? [] : unrelated), calls),
    } as any);
    expect(res?.content).toContain('TOKYO DOME');
    expect(res?.content).not.toContain('off vocal');
  });

  test('ハンドルが無いときのタイトル検索は、表示名を途中で切らない', async () => {
    const calls: string[] = [];
    await fetchTweetsForUrlOrUser('', {
      contextTitle: 'Snow Man official / X',
      _searchPage: page(() => [], calls),
    } as any);
    expect(calls).toEqual(['Snow Man official']);
  });
});
