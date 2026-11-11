import { z } from 'zod';
import { fetchRealtimeTrends } from '../scraper.js';
import { formatCompactRealtimeResponse } from '../search_compact.js';
import { ChiebukuroSearchRequestSchema, ChiebukuroStatusSchema, ImageSearchRequestSchema, VideoSearchRequestSchema } from '../types.js';
import { errorMessage } from '../errors.js';
import { searchChiebukuroCached, searchImageCached, searchNewsCached, searchRealtimeCached, searchVideoCached, suggestKeywordsCached } from '../yahoo_search_cache.js';
import { isModuleActive, registerTool, toolJson } from './registry.js';
import { onlyForMode, usageError } from './args.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🇯🇵 Category 3: Yahoo! JAPAN Services (モジュール: 'yahoo') */
export function registerYahooTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // Tool 7: search_media (Yahoo 画像・動画・ニュース検索。type で選ぶ) - DEFERRED
  const MEDIA_USAGE = '使い方: type で選ぶ（image: 画像、video: 動画、news: ニュース）。page は image・video のとき、transcripts・transcriptChars・updated・platform は video のときだけ。';
  // onlyForMode に渡す語句。エラーの文にそのまま出る
  const typeIs = (type: string) => `type が ${type} のとき`;
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_media',
    'yahoo',
    '【Yahoo ニュース・画像・動画検索】type で選ぶ。news: 今日の主要ニュース・最新ニュース速報の見出し（タイトル・サマリー・配信メディア・配信日時・記事 URL）。時事問題・公式発表の調査に。image: 画像の元 URL と寸法・サムネイル・掲載元ページ（画像の中身を読むときは inspect_image）。video: YouTube・TikTok 等の動画。transcripts で上位の YouTube 動画に検索語に関係する字幕の部分（時刻つき）を付ける（全文は get_youtube）。返却: { query, count, items }（items の欄は type の説明）',
    {
      type: z.enum(['image', 'video', 'news']).describe('検索の種類。image の items: [{ title, original: { url, width, height }, thumbnail, source_url, source_site }]。video: [{ title, url, duration, thumbnail, upload_date, uploader, platform, transcript }]。news: [{ title, url, publisher, publishedTime, snippet }]（応答に source も付く）'),
      query: z.string().min(1).describe('検索キーワード (例: "富士山", "料理 レシピ 動画", "経済動向")'),
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20, 最大: 50。image・video は大きい値を指定しても 20 件)').meta({ default: 20 }),
      page: ImageSearchRequestSchema.shape.page.describe('ページ番号 (1-based, 上限: 100)。limit によらず 20 件ずつ進む。漏れなく続けるには limit を省く。image・video のときだけ'),
      transcripts: VideoSearchRequestSchema.shape.transcripts.describe('上位の YouTube 動画の何本に、検索語に関係する字幕の部分を付けるか (デフォルト: 0, 最大: 5)。video のときだけ'),
      transcriptChars: VideoSearchRequestSchema.shape.transcriptChars.describe('字幕を付ける動画 1 本あたりの最大文字数 (デフォルト: 2000)。video のときだけ'),
      updated: VideoSearchRequestSchema.shape.updated.describe('投稿日の期間 (デフォルト: "all")。video のときだけ'),
      platform: VideoSearchRequestSchema.shape.platform.describe('動画サイト (デフォルト: "all")。video のときだけ'),
    },
    async (args) => {
      const mode = typeIs(args.type);
      // 既定値は、上のスキーマの .meta({ default }) と同じ値。page は既定値を出していないが、news には page が無いので、1 は省いたのと同じ
      const invalid = onlyForMode(mode, [typeIs('image'), typeIs('video')], args, ['page'], MEDIA_USAGE, { page: 1 })
        ?? onlyForMode(mode, [typeIs('video')], args, ['transcripts', 'transcriptChars', 'updated', 'platform'], MEDIA_USAGE, { transcripts: 0, transcriptChars: 2000, updated: 'all', platform: 'all' });
      if (invalid) return usageError(invalid);
      const { type, query, limit, page, transcripts, transcriptChars, updated, platform } = args;
      try {
        const result = type === 'image'
          ? await searchImageCached({ query, limit, page })
          : type === 'video'
            // ponytail: youtube モジュールが無効な設定では transcripts を無視する
            ? await searchVideoCached({ query, limit, page, updated, platform, transcriptChars, transcripts: isModuleActive('youtube', context.options?.modules) ? transcripts : 0 })
            : await searchNewsCached({ query, limit });
        return { content: [{ type: 'text', text: toolJson(result) }] };
      } catch (err) {
        const label = { image: 'Image', video: 'Video', news: 'News' }[type];
        return { isError: true, content: [{ type: 'text', text: `${label} search error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['画像検索', '写真', 'イラスト', '動画検索', 'YouTube', 'TikTok', 'ニュース検索', '記事', '時事', 'Yahoo', 'search_image', 'search_video', 'search_news'] },
  );

  // Tool 10: search_chiebukuro (Yahoo 知恵袋検索) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_chiebukuro',
    'yahoo',
    '【必須・Web検索代替不可】Yahoo! 知恵袋の Q&A・人々の悩み・生活の知恵・利用者のリアルな体験談や口コミは、一般Web検索ではなく必ず本ツールで検索してください。質問タイトル・本文スニペット・回答数・解決ステータスを返す。返却: { source, query, count, items: [{ title, url, status, bestAnswer, snippet }] }',
    {
      query: z.string().min(1).describe('知恵袋検索キーワード (例: "おすすめ プログラミング言語", "引越し 挨拶")'),
      limit: ChiebukuroSearchRequestSchema.shape.limit,
      page: ChiebukuroSearchRequestSchema.shape.page,
      status: ChiebukuroStatusSchema.optional()
        .describe('回答状況: "all"(すべて, デフォルト), "open"(回答受付中), "vote"(投票受付中), "solved"(解決済み)')
        .meta({ default: 'all' }),
    },
    async ({ query, limit, page, status }) => {
      try {
        const result = await searchChiebukuroCached({ query, limit, page, status });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Chiebukuro search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['知恵袋', 'Q&A', '質問回答', '悩み', 'Yahoo'] },
  );

  // Tool 11: search_keywords (query ありはサジェスト、なしは急上昇トレンド) - DEFERRED
  // サジェストの件数の上限（REST の /search/suggest と同じ）。スキーマはトレンドの上限（50）まで通す
  const SUGGEST_LIMIT_MAX = 20;
  const KEYWORDS_USAGE = `使い方: query を指定するとサジェスト（limit は ${SUGGEST_LIMIT_MAX} まで）、省くと急上昇トレンド（limit は 50 まで）。`;
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_keywords',
    'yahoo',
    '【公式サジェスト・トレンド直結】query を指定すると、Yahoo! JAPAN のキーワード補完サジェスト（入力候補・よく一緒に検索される複合検索需要・関連語）を返す。query を省くと、いま日本国内で最も話題の急上昇トレンドキーワード上位 20 件（順位・キーワード・ポスト数）を返す。急上昇トレンドは必ず本ツールで取得してください。返却: { query, suggestions: [...] }。query を省くと { source, type, count, items: [{ rank, keyword, tweetCount, url }], timestamp }',
    {
      query: z.string().optional().describe('サジェストを引く検索語句プレフィックス (例: "東京 観光")。省くと急上昇トレンド'),
      limit: z.number().int().min(1).max(50).optional().describe(`取得件数。省略時はサジェスト 10 件・トレンド 20 件。上限はサジェスト ${SUGGEST_LIMIT_MAX}・トレンド 50（トレンドはページに載っている件数まで）`),
    },
    async ({ query, limit }) => {
      if (query) {
        if ((limit ?? 0) > SUGGEST_LIMIT_MAX) return usageError(`query を指定したとき（サジェスト）の limit は ${SUGGEST_LIMIT_MAX} までです（いま: ${limit}）。${KEYWORDS_USAGE}`);
        try {
          return { content: [{ type: 'text', text: toolJson(await suggestKeywordsCached({ query, limit })) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `Suggest error: ${errorMessage(err) || err}` }] };
        }
      }
      try {
        return { content: [{ type: 'text', text: toolJson(await fetchRealtimeTrends(limit)) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Trend search error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['サジェスト', '関連キーワード', '予測', 'Yahoo', '急上昇トレンド', '話題', 'ランキング', 'リアルタイム', 'suggest_keywords', 'search_trend'] },
  );

  // Tool 12: search_realtime (Yahoo リアルタイム検索) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_realtime',
    'yahoo',
    '【必須・Web検索代替不可】X上の最新ポスト・世論・特定アカウントの告知の調査に。Yahoo公式仕様で特定アカウント・宛先・ハッシュタグ・除外・OR検索に対応。物販タイテ・緊急告知・現地速報に最適。返却: { query, effectiveQuery, isFallback, sort, focus, count, items, missingTerms?, aliasTerms?, omittedCount? } (missingTerms=揃わなかった語、aliasTerms=代わりに検索した別名、omittedCount=省いた件数。一部失敗時はpartialとproviderErrors)',
    {
      query: z
        .string()
        .optional()
        .describe('検索キーワード (例: "タイテ", "地震", "強化月間ライブ")。accountId や hashtags を指定する場合は省略可能。※クエリ内に "from:アカウント" を書いた場合も自動で "id:アカウント" に安全に正規化されます。'),
      accountId: z
        .string()
        .optional()
        .describe('【特定アカウントの発言絞り込み】Xアカウント名（例: "Yahoo_JAPAN_PR", "kimisora_JPN"）。@の有無問わず自動で id:xxx に変換します。'),
      fromUser: z.string().optional().describe('accountId のエイリアス (LLM 互換用)'),
      toAccount: z.string().optional().describe('【特定アカウント宛ての投稿】宛先アカウント名（@xxx に変換）'),
      hashtags: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('【特定ハッシュタグ絞り込み】ハッシュタグ（例: "#君と見るそら", "地震"）。#の有無問わず付与します。'),
      excludeWords: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('【除外キーワード】除外したい単語（-単語 に変換）'),
      orWords: z.array(z.string()).optional().describe('【OR検索】いずれかを含む単語の配列 (単語A 単語B) に変換'),
      url: z.string().optional().describe('【URL/ドメイン絞り込み】含まれるURLまたはドメイン名'),
      sort: z
        .enum(['recent', 'popular'])
        .optional()
        .describe('並び順: "recent" (新着順, デフォルト) または "popular" (話題・エンゲージメント順)').meta({ default: 'recent' }),
      limit: z
        .number()
        .int()
        .min(1)
        .max(40)
        .optional()
        .describe('取得件数 (デフォルト: 20, 最大: 40)').meta({ default: 20 }),
      page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('ページ番号 (1-based, デフォルト: 1, 上限: 100。limit 件ずつ進む)').meta({ default: 1 }),
      focus: z
        .enum(['official', 'public'])
        .optional()
        .describe('優先する発信者。official: 本人・公式（予定・告知・事実確認）、public: 本人以外（評判・感想・炎上・現地の様子）。省略時はクエリの語から判定（評判・炎上・口コミ などがあれば public）'),
      anchor: z.string().max(100).optional().describe('守る固有名詞（人名・グループ名・作品名・会場名など、クエリ中の語）。分かる場合は渡すと、緩和検索でこの語を落とさない。クエリの語に無ければ無視して推定する'),
      verbose: z
        .boolean()
        .optional()
        .describe('デバッグ用: retrievalQueries 等の検索診断を含めるか (デフォルト: false)').meta({ default: false }),
    },
    async ({ query, accountId, fromUser, toAccount, hashtags, excludeWords, orWords, url, sort, limit, page, focus, anchor, verbose }) => {
      try {
        // REST と同じ応答（同じキャッシュ）を使い、data を開いて count・items を最上位に置く
        const { data, type: _type, ...result } = await searchRealtimeCached({
          query,
          accountId,
          fromUser,
          toAccount,
          hashtags,
          excludeWords,
          orWords,
          url,
          sort: sort || 'recent',
          ...(limit ? { limit } : {}),
          ...(page ? { page } : {}),
          ...(verbose === true ? { verbose: true } : {}),
          ...(focus ? { focus } : {}),
          ...(anchor ? { anchor } : {}),
        });
        const responsePayload = formatCompactRealtimeResponse({ ...result, count: data.count, items: data.items }, { verbose });

        return {
          // 整形なしの JSON（verbose は人が読む診断用なので整形する）
          content: [{ type: 'text', text: toolJson(responsePayload, verbose) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Realtime search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: true, keywords: ['リアルタイム検索', 'X', 'Twitter', 'ツイート', 'トレンド', '速報'] },
  );
}
