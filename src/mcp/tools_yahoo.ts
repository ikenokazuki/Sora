import { z } from 'zod';
import { createWebAnchorHints, fetchRealtimeTrends, getSuggestedKeywords, searchYahooChiebukuro, searchYahooImage, searchYahooNews, searchYahooRealtime, searchYahooVideo } from '../scraper.js';
import { formatCompactRealtimeResponse } from '../search_compact.js';
import { defaultXDetailProvider, fetchXPostDetail } from '../services/x_detail.js';
import { ChiebukuroStatusSchema } from '../types.js';
import { errorMessage } from '../errors.js';
import { attachVideoTranscripts } from '../services/youtube.js';
import { isModuleActive, registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🇯🇵 Category 3: Yahoo! JAPAN Services (モジュール: 'yahoo') */
export function registerYahooTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault, options } = context;
  // Tool 7: search_image (Yahoo 画像検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_image',
    'yahoo',
    '【Yahoo 画像検索】キーワードで画像を検索し、元画像の URL と寸法・サムネイル・掲載元ページを取得します。画像の中身を読むときは inspect_image を使ってください。返却: { query, count, items: [{ title, original: { url, width, height }, thumbnail, source_url, source_site }] }',
    {
      query: z.string().min(1).describe('画像検索キーワード (例: "富士山", "猫 写真")'),
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)').meta({ default: 20 }),
    },
    async ({ query, limit }) => {
      try {
        const result = await searchYahooImage({ query, limit });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Image search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['画像検索', '写真', 'イラスト', 'Yahoo'] },
  );

  // Tool 8: search_video (Yahoo 動画検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_video',
    'yahoo',
    '【Yahoo 動画検索】キーワードで YouTube 等の動画を検索し、動画 URL・タイトル・再生時間・サムネイル・投稿日・投稿者を取得します。transcripts に本数を指定すると、上位の YouTube 動画に、検索語に関係する字幕の部分（時刻つき）を付けます（全文は get_youtube_transcript）。返却: { query, count, items: [{ title, url, duration, thumbnail, upload_date, uploader, transcript }] }',
    {
      query: z.string().min(1).describe('動画検索キーワード (例: "料理 レシピ 動画")'),
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20, 最大: 50)').meta({ default: 20 }),
      transcripts: z.number().int().min(0).max(5).optional().describe('上位の YouTube 動画の何本に、検索語に関係する字幕の部分を付けるか (デフォルト: 0, 最大: 5)').meta({ default: 0 }),
      transcriptChars: z.number().int().min(500).max(10_000).optional().describe('字幕を付ける動画 1 本あたりの最大文字数 (デフォルト: 2000)').meta({ default: 2000 }),
    },
    async ({ query, limit, transcripts, transcriptChars }) => {
      try {
        let result = await searchYahooVideo({ query, limit });
        // ponytail: youtube モジュールが無効な設定では transcripts を無視する
        if (transcripts && isModuleActive('youtube', context.options?.modules)) {
          result = await attachVideoTranscripts(result, query, { count: transcripts, maxChars: transcriptChars ?? 2000 });
        }
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Video search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['動画検索', 'YouTube', 'Yahoo'] },
  );

  // Tool 9: search_news (Yahoo ニュース検索) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_news',
    'yahoo',
    '【ニュース速報直結】大手報道機関の最新ニュース記事（タイトル・サマリー・配信メディア・配信日時・記事 URL）をYahoo!ニュースから取得します。時事問題・公式発表の調査に最適です。返却: { source, query, count, items: [{ title, url, publisher, publishedTime, snippet }] }',
    {
      query: z.string().min(1).describe('ニュース検索キーワード (例: "選挙", "経済動向", "ノーベル賞")'),
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)').meta({ default: 20 }),
    },
    async ({ query, limit }) => {
      try {
        const result = await searchYahooNews({ query, limit });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `News search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['ニュース検索', '記事', '時事', 'Yahoo'] },
  );

  // Tool 10: search_chiebukuro (Yahoo 知恵袋検索) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_chiebukuro',
    'yahoo',
    '【必須・Web検索代替不可】Yahoo! 知恵袋の Q&A・人々の悩み・生活の知恵・利用者のリアルな体験談や口コミは、一般Web検索ではなく必ず本ツールで検索してください。質問タイトル・本文スニペット・回答数・解決ステータスを取得します。返却: { source, query, count, items: [{ title, url, status, bestAnswer, snippet }] }',
    {
      query: z.string().min(1).describe('知恵袋検索キーワード (例: "おすすめ プログラミング言語", "引越し 挨拶")'),
      limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 10)').meta({ default: 10 }),
      status: ChiebukuroStatusSchema.optional()
        .describe('回答状況: "all"(すべて, デフォルト), "open"(回答受付中), "vote"(投票受付中), "solved"(解決済み)')
        .meta({ default: 'all' }),
    },
    async ({ query, limit, status }) => {
      try {
        const result = await searchYahooChiebukuro({ query, limit, status });
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

  // Tool 11: suggest_keywords (サジェスト / キーワード補完) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'suggest_keywords',
    'yahoo',
    '【公式サジェスト直結】Yahoo! JAPAN のキーワード補完サジェストを取得し、指定語句の入力候補・よく一緒に検索される複合検索需要・関連語を返します。返却: { query, suggestions: [...] }',
    {
      query: z.string().min(1).describe('検索語句プレフィックス (例: "東京 観光")'),
      limit: z.number().int().min(1).max(20).optional().describe('取得件数 (デフォルト: 10, 上限: 20)').meta({ default: 10 }),
    },
    async ({ query, limit }) => {
      try {
        const result = await getSuggestedKeywords({ query, limit });
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Suggest error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['サジェスト', '関連キーワード', '予測', 'Yahoo'] },
  );

  // Tool 12: search_realtime (Yahoo リアルタイム検索) - CORE (defaultEnabled: true)
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_realtime',
    'yahoo',
    '【必須・Web検索代替不可】X上の最新ポスト・世論・特定アカウント告知調査用。Yahoo公式仕様で特定アカウント・宛先・ハッシュタグ・除外・OR検索に対応。物販タイテ・緊急告知・現地速報把握に最適。返却: { query, effectiveQuery, isFallback, sort, focus, count, items, missingTerms?, aliasTerms?, omittedCount? } (missingTerms=揃わなかった語、aliasTerms=代わりに検索した別名、omittedCount=省いた件数。一部失敗時はpartialとproviderErrors)',
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
        .describe('ページ番号 (1-based, デフォルト: 1, 上限: 100)').meta({ default: 1 }),
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
        const result = await searchYahooRealtime({
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
          ...(query ? { anchorHints: createWebAnchorHints(query) } : {}),
        });

        const responsePayload = formatCompactRealtimeResponse(
          {
            source: 'x',
            query: result.originalQuery,
            effectiveQuery: result.effectiveQuery,
            isFallback: result.isFallback,
            ...(result.partial === true
              ? { partial: true, providerErrors: result.providerErrors || [] }
              : {}),
            retrievalQueries: result.retrievalQueries || [],
            contributingQueries: result.contributingQueries || [],
            resultsMerged: result.resultsMerged || false,
            focus: result.focus,
            missingTerms: result.missingTerms,
            ...(result.aliasTerms ? { aliasTerms: result.aliasTerms } : {}),
            ...(result.omittedCount ? { omittedCount: result.omittedCount } : {}),
            ...(result.anchorTerm ? { anchorTerm: result.anchorTerm } : {}),
            ...(result.anchorFiltered !== undefined ? { anchorFiltered: result.anchorFiltered } : {}),
            sort: sort || 'recent',
            count: result.count,
            items: result.items,
          },
          { verbose },
        );

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

  // Tool 13: search_trend (Yahoo トレンド急上昇) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'search_trend',
    'yahoo',
    '【公式トレンド直結】いま日本国内で最も話題になっている急上昇トレンドキーワード上位 20 件（順位・キーワード・ポスト数・要約）は、必ず本ツールで取得してください。返却: { source, type, count, items: [{ rank, keyword, tweetCount, url }], timestamp }',
    {
      limit: z.number().int().min(1).max(50).optional().describe('取得するトレンド件数 (デフォルト: 20)').meta({ default: 20 }),
    },
    async ({ limit }) => {
      try {
        const result = await fetchRealtimeTrends(limit);
        return {
          content: [{ type: 'text', text: toolJson(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Trend search error: ${errorMessage(err) || err}` }],
        };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['急上昇トレンド', '話題', 'ランキング', 'リアルタイム'] },
  );

  // Tool 12b: fetch_x_post (X個別投稿の全文取得) - DEFERRED
  {
    const xDetail = options?.xDetailProvider ?? defaultXDetailProvider;
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'fetch_x_post',
      'yahoo',
      '【X個別投稿の全文取得】search_realtimeで見つけたX投稿のうち詳しく知りたい1件の全文・投稿日時・メディアをFxTwitter経由で取得します（ID突合検証済みのみ返却、未検証の推測は返しません）。返却: { found, statusId, detail: { text, isNoteTweet, author, createdAt, media } }',
      {
        statusId: z.string().optional().describe('X投稿の数値ステータスID (例: "2100871827090501852")'),
        url: z.string().optional().describe('X投稿URL (例: "https://x.com/xxx/status/123…")。statusIdの代わりに指定可'),
      },
      async (opts) => {
        try {
          const result = await fetchXPostDetail(opts, xDetail);
          if (!result.found) {
            return {
              isError: true,
              content: [{ type: 'text', text: `X post not found: ${result.reason}` }],
            };
          }
          return {
            content: [{ type: 'text', text: toolJson(result) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `X post fetch error: ${errorMessage(err) || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['X', 'ツイート', 'ポスト', '全文', 'ステータス', 'status'] },
    );
  }
}
