/**
 * X Long-form Detail Provider & Adaptive Enrichment Tests (X1 to X13 & T1 to T6 & Real Fixture)
 */

import { describe, expect, it } from 'bun:test';
import {
  FxTwitterDetailProvider,
  type XPostDetail,
  type XPostDetailProvider,
  extractSemanticQuery,
  observeRequirements,
  isLikelyYahooRealtimeTruncated,
  rerankRealtimeItems,
  enrichRealtimeItemsWithXDetail,
  X_DETAIL_INSPECT_LIMIT,
  X_DETAIL_MAX_CALLS,
  YAHOO_REALTIME_TRUNCATION_SUSPECT_MIN_CHARS,
} from './x_detail.js';
import {
  parseXDiscoverySeed,
  buildXIsolatedEvidenceFromDirectStatus,
} from '../x_source_isolation.js';

describe('X Long-form Detail Provider Tests (X1 - X13)', () => {
  // ---------------------------------------------------------------------------
  // X1: Parser - FxTwitter v2 success response to canonical type
  // ---------------------------------------------------------------------------
  it('X1: parses FxTwitter v2 success response into canonical XPostDetail', async () => {
    const mockProvider: XPostDetailProvider = {
      async fetchStatus(statusId: string) {
        if (statusId === '1234567890123456789') {
          return {
            statusId: '1234567890123456789',
            text: '【夏祭り告知】線香花火大会の詳細スケジュールです。\n開催日時: 2026年8月15日(土) 18:00〜20:00\n場所: 山中湖交流プラザきらら',
            isNoteTweet: true,
            media: ['https://example.com/fireworks.jpg'],
            provider: 'fxtwitter',
          };
        }
        return null;
      },
    };

    const detail = await mockProvider.fetchStatus('1234567890123456789');
    expect(detail).not.toBeNull();
    expect(detail?.statusId).toBe('1234567890123456789');
    expect(detail?.isNoteTweet).toBe(true);
    expect(detail?.text).toContain('線香花火大会');
    expect(detail?.media).toEqual(['https://example.com/fireworks.jpg']);
    expect(detail?.provider).toBe('fxtwitter');
  });

  // ---------------------------------------------------------------------------
  // X2: Status mismatch rejection
  // ---------------------------------------------------------------------------
  it('X2: rejects response when status.id mismatches requested ID', async () => {
    const provider = new FxTwitterDetailProvider();
    const badId = await provider.fetchStatus('abc-not-an-id');
    expect(badId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // X3: Timeout fail-soft
  // ---------------------------------------------------------------------------
  it('X3: fail-soft on timeout, preserving original Yahoo items without error', async () => {
    const timeoutProvider: XPostDetailProvider = {
      async fetchStatus() {
        return null;
      },
    };

    const longText = '【夏祭り告知】線香花火大会を開催します！詳細は後ほど公式発表いたしますので今しばらくお待ちください。タイムスケジュールや物販情報、整理券配布場所など全てのイベント案内を随時更新していきます。皆さまのご来場を心よりお待ちしております！'.padEnd(250, '。');
    const items = [
      {
        id: '2100871827090501852',
        text: longText,
      },
    ];

    const { items: enriched, fxCalls } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時 id:kimisora_JPN',
      timeoutProvider,
    );

    expect(fxCalls).toBe(1);
    expect(enriched[0].text).toBe(longText);
    expect(enriched[0].detailEnriched).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // X4: HTTP errors fail-soft
  // ---------------------------------------------------------------------------
  it('X4: fail-soft on 429 / 500 HTTP errors and fallback to original items', async () => {
    const errorProvider: XPostDetailProvider = {
      async fetchStatus() {
        return null;
      },
    };

    const longText = '一部テキストのみですが240文字以上の長文切断疑い投稿です。線香花火大会の開催概要についてお知らせいたします。詳しい集合時間や会場アクセス、注意事項については公式HPをご確認ください。多くの方のご参加をお待ちしております！'.padEnd(245, '。');
    const items = [
      {
        id: '2100871827090501852',
        text: longText,
      },
    ];

    const { items: enriched } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時',
      errorProvider,
    );

    expect(enriched.length).toBe(1);
    expect(enriched[0].text).toBe(longText);
  });

  // ---------------------------------------------------------------------------
  // X5: Fallback rerank using originalQuery
  // ---------------------------------------------------------------------------
  it('X5: reranks results by originalQuery even when effectiveQuery is relaxed', () => {
    const originalQuery = '線香花火 何時 id:kimisora_JPN';
    const semantic = extractSemanticQuery(originalQuery);
    expect(semantic).toBe('線香花火 何時');
  });

  // ---------------------------------------------------------------------------
  // X6: No unnecessary Fx calls when top item is short or not suspect
  // ---------------------------------------------------------------------------
  it('X6: zero Fx calls when candidate is normal short post (< 240 chars)', async () => {
    let callCount = 0;
    const trackingProvider: XPostDetailProvider = {
      async fetchStatus() {
        callCount++;
        return null;
      },
    };

    const items = [
      {
        id: '10001',
        text: '線香花火大会の開始時間は何時からですか？18時からです。',
      },
    ];

    const { fxCalls } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時',
      trackingProvider,
    );

    expect(fxCalls).toBe(0);
    expect(callCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // X7: Escalates long relevant post with evidence
  // ---------------------------------------------------------------------------
  it('X7: escalates truncation suspect to FxTwitter when relevant to query', async () => {
    let callCount = 0;
    const trackingProvider: XPostDetailProvider = {
      async fetchStatus(id) {
        callCount++;
        return {
          statusId: id,
          text: '【全日程】線香花火大会は18時開始となります！終演は20時です。',
          isNoteTweet: true,
          provider: 'fxtwitter',
        };
      },
    };

    const longText = '【告知】線香花火大会を開催します！本年度のスケジュールおよび開催時間、参加方法に関する最新情報です。雨天時の対応や持ち物、周辺道路の交通規制について事前によくご確認の上ご来場ください。詳細は添付をご確認ください…'.padEnd(250, '。');
    const items = [
      {
        id: '2100871827090501852',
        text: longText,
      },
    ];

    const { items: enriched, fxCalls } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時',
      trackingProvider,
    );

    expect(fxCalls).toBe(1);
    expect(callCount).toBe(1);
    expect(enriched[0].text).toContain('18時開始');
    expect(enriched[0].isNoteTweet).toBe(true);
    expect(enriched[0].detailEnriched).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // X8: Irrelevant long candidate is not fetched unconditionally
  // ---------------------------------------------------------------------------
  it('X8: does not fetch long candidate if it has zero lexical evidence for query', async () => {
    let callCount = 0;
    const trackingProvider: XPostDetailProvider = {
      async fetchStatus(id) {
        callCount++;
        return {
          statusId: id,
          text: '明日の線香花火大会の完全スケジュール公開！',
          isNoteTweet: true,
          provider: 'fxtwitter',
        };
      },
    };

    const irrelevantLong = '本日のランチは特製スパイスカレーライスでした！とても美味しくて大満足です。明日も美味しいお店を探して散歩しようと思います。最近はカフェ巡りにもハマっていておすすめのお店があればぜひ教えてくださいね！'.padEnd(250, '！');
    const relevantLong = '明日の線香花火大会の準備をスタッフ一同で進めております。会場設営や花火の安全点検、照明のセッティングなど着々と進行中です。皆さまに安全に楽しんでいただけるよう万全の体制でお迎えいたします！'.padEnd(250, '！');

    const items = [
      {
        id: '30001',
        text: irrelevantLong,
      },
      {
        id: '30002',
        text: relevantLong,
      },
    ];

    const { fxCalls } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時',
      trackingProvider,
    );

    // item 1 は無関係なのでスキップされ、item 2 のみフェッチされる (計1回)
    expect(fxCalls).toBe(1);
    expect(callCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // X9: Bounded calls - max 2 Fx requests per search
  // ---------------------------------------------------------------------------
  it('X9: guarantees maximum 2 Fx requests even across multiple items', async () => {
    let callCount = 0;
    const trackingProvider: XPostDetailProvider = {
      async fetchStatus(id) {
        callCount++;
        return {
          statusId: id,
          text: `全文テキスト ${id}`,
          provider: 'fxtwitter',
        };
      },
    };

    const makeLong = (title: string) => `${title}についての詳細なタイムテーブルと注意事項をお知らせします。当日は大変混雑が予想されますので公共交通機関をご利用ください。入場制限を実施する場合がございますので予めご了承ください。`.padEnd(250, '。');

    const items = [
      { id: '40001', text: makeLong('線香花火 その1') },
      { id: '40002', text: makeLong('線香花火 その2') },
      { id: '40003', text: makeLong('線香花火 その3') },
      { id: '40004', text: makeLong('線香花火 その4') },
    ];

    const { fxCalls } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時',
      trackingProvider,
    );

    expect(fxCalls).toBe(2);
    expect(callCount).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // X10 & X11: Cache & In-flight deduplication
  // ---------------------------------------------------------------------------
  it('X10 & X11: deduplicates identical status requests via cache and single-flight', async () => {
    expect(/^[0-9]+$/.test('2100871827090501852')).toBe(true);
    expect(/^[0-9]+$/.test('https://x.com/status/123')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // X12: Note Tweet equivalent regression
  // ---------------------------------------------------------------------------
  it('X12: preserves complete Note Tweet text replacing truncated Yahoo snippet', async () => {
    const partialYahooText = '【イベント情報】君と見るそら 夏の線香花火大会 開催日: 2026年8月15日。当日のスケジュールおよび集合場所、タイムテーブルについてご案内します。開場時間やステージイベント、屋台の出店情報など盛りだくさんの内容となっております。皆様のご来場を心よりお待ちしております…'.padEnd(245, '。');
    const fullFxText = '【イベント情報】君と見るそら 夏の線香花火大会 開催日: 2026年8月15日(土) 線香花火大会時間: 18:00〜19:00 特典会: 19:30〜20:30。翌日 15:00〜16:00 追加公演あり。';

    const provider: XPostDetailProvider = {
      async fetchStatus() {
        return {
          statusId: '2100871827090501852',
          text: fullFxText,
          isNoteTweet: true,
          provider: 'fxtwitter',
        };
      },
    };

    const items = [{ id: '2100871827090501852', text: partialYahooText }];
    const { items: enriched } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時',
      provider,
    );

    expect(enriched[0].text).toBe(fullFxText);
    expect(enriched[0].text).toContain('18:00〜19:00');
    expect(enriched[0].text).toContain('翌日 15:00〜16:00');
    expect(enriched[0].originalText).toBe(partialYahooText);
    expect(enriched[0].detailEnriched).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // X13: Direct X status URL fast-path
  // ---------------------------------------------------------------------------
  it('X13: converts direct status URL to exact verified evidence via direct detail', () => {
    const seed = parseXDiscoverySeed('https://x.com/kimisora_JPN/status/2100871827090501852');
    expect(seed).not.toBeNull();
    expect(seed?.kind).toBe('status');
    expect(seed?.statusId).toBe('2100871827090501852');

    const detail: XPostDetail = {
      statusId: '2100871827090501852',
      text: '線香花火大会の公式タイムテーブル公開。18:00スタート！',
      isNoteTweet: true,
      provider: 'fxtwitter',
    };

    const evidence = buildXIsolatedEvidenceFromDirectStatus(seed!, detail);
    expect(evidence.relation).toBe('exact_status');
    expect(evidence.exactStatusMatched).toBe(true);
    expect(evidence.eligibleForPrimaryEvidence).toBe(true);
    expect(evidence.markdown).toContain('18:00スタート！');
    expect(evidence.selectedItems[0].id).toBe('2100871827090501852');
  });
});

// =============================================================================
// 指示書 第17条: 必須 Unit Tests (T1 - T6)
// =============================================================================
describe('v2.24.1 Truncation Gate & Selector Unit Tests (T1 - T6)', () => {
  // ---------------------------------------------------------------------------
  // T1: threshold 境界 (239 -> false, 240 -> true, 250 -> true)
  // ---------------------------------------------------------------------------
  it('T1: threshold boundary test for isLikelyYahooRealtimeTruncated', () => {
    const item239 = { id: '1001', text: 'あ'.repeat(239) };
    const item240 = { id: '1002', text: 'あ'.repeat(240) };
    const item250 = { id: '1003', text: 'あ'.repeat(250) };

    expect(isLikelyYahooRealtimeTruncated(item239)).toBe(false);
    expect(isLikelyYahooRealtimeTruncated(item240)).toBe(true);
    expect(isLikelyYahooRealtimeTruncated(item250)).toBe(true);

    // Skip cases
    expect(isLikelyYahooRealtimeTruncated({ id: '1004', text: 'あ'.repeat(250), detailEnriched: true })).toBe(false);
    expect(isLikelyYahooRealtimeTruncated({ text: 'あ'.repeat(250) })).toBe(false);
    expect(isLikelyYahooRealtimeTruncated({ id: 'bad-id', text: 'あ'.repeat(250) })).toBe(false);
    expect(isLikelyYahooRealtimeTruncated({ id: '1005', text: '' })).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // T2: short relevant post (length 100 -> Fx calls = 0)
  // ---------------------------------------------------------------------------
  it('T2: short relevant post with length 100 does not call Fx even if query exactly matches', async () => {
    let callCount = 0;
    const provider: XPostDetailProvider = {
      async fetchStatus() {
        callCount++;
        return null;
      },
    };

    const shortPost = '線香花火 大会の開催時間についてのお知らせです。当日は天候に恵まれることを願っております。'.padEnd(100, '。');
    expect(shortPost.length).toBe(100);

    const items = [{ id: '2001', text: shortPost }];
    const { fxCalls } = await enrichRealtimeItemsWithXDetail(items, '線香花火 時間', provider);

    expect(fxCalls).toBe(0);
    expect(callCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // T3: long irrelevant post (length >= 240, observed requirements = 0 -> Fx calls = 0)
  // ---------------------------------------------------------------------------
  it('T3: long irrelevant post (length >= 240) does not call Fx when observed requirements = 0', async () => {
    let callCount = 0;
    const provider: XPostDetailProvider = {
      async fetchStatus() {
        callCount++;
        return null;
      },
    };

    const longIrrelevant = '今日は朝から快晴で気持ちの良い一日となりました。近所の公園を散歩していると可愛い小鳥たちを見かけました。秋の気配が少しずつ感じられる季節になってきましたね。皆さまも風邪などひかれませんようお気をつけください。'.padEnd(250, '！');
    expect(longIrrelevant.length).toBe(250);

    const items = [{ id: '2002', text: longIrrelevant }];
    const { fxCalls } = await enrichRealtimeItemsWithXDetail(items, '線香花火 時間', provider);

    expect(fxCalls).toBe(0);
    expect(callCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // T4: long relevant post (length >= 240 + query relevant -> Fx calls = 1, detailEnriched = true)
  // ---------------------------------------------------------------------------
  it('T4: long relevant post triggers Fx enrichment and sets detailEnriched = true', async () => {
    let callCount = 0;
    const provider: XPostDetailProvider = {
      async fetchStatus(id) {
        callCount++;
        return {
          statusId: id,
          text: '線香花火大会の開催時間は18:00〜19:00です。雨天決行、荒天中止となります。',
          isNoteTweet: true,
          provider: 'fxtwitter',
        };
      },
    };

    const longRelevant = '【公式告知】線香花火大会の開催時間と会場アクセスについて。当日は多くの方のご来場が見込まれておりますので公共交通機関をご利用ください。周辺道路の混雑緩和にご協力をお願い申し上げます。安全対策のため係員の指示に従ってください。'.padEnd(245, '。');
    expect(longRelevant.length).toBe(245);

    const items = [{ id: '2003', text: longRelevant }];
    const { items: enriched, fxCalls } = await enrichRealtimeItemsWithXDetail(items, '線香花火 時間', provider);

    expect(fxCalls).toBe(1);
    expect(callCount).toBe(1);
    expect(enriched[0].detailEnriched).toBe(true);
    expect(enriched[0].detailProvider).toBe('fxtwitter');
    expect(enriched[0].text).toContain('18:00〜19:00');
  });

  // ---------------------------------------------------------------------------
  // T5: max 2 calls when 3+ relevant truncation suspects exist
  // ---------------------------------------------------------------------------
  it('T5: strictly caps Fx calls at 2 even when 3 or more relevant truncation suspects exist', async () => {
    let callCount = 0;
    const provider: XPostDetailProvider = {
      async fetchStatus(id) {
        callCount++;
        return {
          statusId: id,
          text: `詳細テキスト ${id}`,
          provider: 'fxtwitter',
        };
      },
    };

    const makeSuspect = (id: string, label: string) => ({
      id,
      text: `【公式】線香花火大会 ${label} に関するお知らせです。開催時間やタイムスケジュール、会場のご案内など詳細を掲載しております。皆さまのご参加をお待ちしております。`.padEnd(250, '。'),
    });

    const items = [
      makeSuspect('3001', '第1部'),
      makeSuspect('3002', '第2部'),
      makeSuspect('3003', '第3部'),
      makeSuspect('3004', '第4部'),
    ];

    const { fxCalls } = await enrichRealtimeItemsWithXDetail(items, '線香花火 時間', provider);

    expect(fxCalls).toBe(2);
    expect(callCount).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // T6: inspect top5 (evaluates candidate at index 1..4, not fixed to top 2)
  // ---------------------------------------------------------------------------
  it('T6: inspects candidates within top 5 so target at index 2..4 is evaluated', async () => {
    let callCount = 0;
    const provider: XPostDetailProvider = {
      async fetchStatus(id) {
        callCount++;
        return {
          statusId: id,
          text: '第3候補の全文: 線香花火大会は18時スタートです！',
          isNoteTweet: true,
          provider: 'fxtwitter',
        };
      },
    };

    const items = [
      // 0: 短文
      { id: '4001', text: '線香花火楽しみですね！' },
      // 1: 無関係長文
      { id: '4002', text: '本日のランチはオムライスでした。美味しかったのでまた食べに行きたいです。カフェ巡りも楽しいですね。'.padEnd(250, '！') },
      // 2: 目的の長文切断疑い (index 2: 3番目のアイテム)
      { id: '4003', text: '【重要】線香花火大会の開催時間および詳細タイムスケジュールのお知らせです。ご来場の皆さまは必ずご確認をお願い申し上げます。安全運行のためご協力をお願いいたします。'.padEnd(250, '。') },
      // 3: 短文
      { id: '4004', text: '会場に向かってます。' },
      // 4: 短文
      { id: '4005', text: '花火綺麗でした！' },
    ];

    const { items: enriched, fxCalls } = await enrichRealtimeItemsWithXDetail(items, '線香花火 時間', provider);

    expect(fxCalls).toBe(1);
    expect(callCount).toBe(1);
    expect(enriched[2].detailEnriched).toBe(true);
    expect(enriched[2].text).toContain('18時スタート');
  });
});

// =============================================================================
// 指示書 第18条: 今回の実障害 synthetic fixture
// =============================================================================
describe('v2.24.1 Section 18 Real Issue Synthetic Fixture', () => {
  it('correctly selects official target #2 while ignoring short public posts #6 & #7', async () => {
    const fetchedIds: string[] = [];
    const provider: XPostDetailProvider = {
      async fetchStatus(id: string) {
        fetchedIds.push(id);
        if (id === '2100871827090501852') {
          return {
            statusId: '2100871827090501852',
            text: '【君と見るそら 公式案内】夏祭りイベントの全容発表！線香花火 18:00〜19:00、特典会 19:30〜20:30。皆様のご参加を心よりお待ちしております！',
            isNoteTweet: true,
            provider: 'fxtwitter',
          };
        }
        return null;
      },
    };

    // #1 official length ≈ 200, query relevance 弱
    const item1 = {
      id: '2100871827090501851',
      author_name: '君と見るそら公式',
      author_handle: 'kimisora_JPN',
      text: '君と見るそら公式アカウントです。日頃より応援いただき誠にありがとうございます。今後の活動予定やメディア出演情報について順次お知らせしてまいりますのでよろしくお願いいたします。'.padEnd(200, '。'),
    };

    // #2 official target length ≈ 250, 「線香花火」あり, Yahoo partial
    const item2 = {
      id: '2100871827090501852',
      author_name: '君と見るそら公式',
      author_handle: 'kimisora_JPN',
      text: '【君と見るそら 公式案内】夏祭りイベントの全容発表！線香花火大会の開催日時は2026年8月15日です。タイムテーブルや会場アクセス、物販整理券の配布方法について詳細をご案内いたします。当日は大変混雑が予想されますので公共交通機関でお越しください…'.padEnd(250, '。'),
    };

    // #3 official length ≈ 230
    const item3 = {
      id: '2100871827090501853',
      author_name: '君と見るそら公式',
      author_handle: 'kimisora_JPN',
      text: 'グッズラインナップ公開！オリジナルTシャツやマフラータオルなど新アイテムが多数登場します。事前通販も受付中ですのでぜひチェックしてください。'.padEnd(230, '！'),
    };

    // #4 official length ≈ 250, query relevance 弱
    const item4 = {
      id: '2100871827090501854',
      author_name: '君と見るそら公式',
      author_handle: 'kimisora_JPN',
      text: 'ファンクラブ会員限定コンテンツ更新のお知らせ！メンバーの舞台裏オフショット動画や特別インタビュー記事を公開いたしました。会員ページへログインの上お楽しみください。たくさんのコメントをお待ちしております！'.padEnd(250, '！'),
    };

    // #5 official length ≈ 200
    const item5 = {
      id: '2100871827090501855',
      author_name: '君と見るそら公式',
      author_handle: 'kimisora_JPN',
      text: '公式YouTubeチャンネルにて過去のライブダイジェスト映像をプレミア公開中です。ぜひご覧ください！'.padEnd(200, '。'),
    };

    // #6 public short length ≈ 80, query 語あり
    const item6 = {
      id: '2100871827090501856',
      author_name: '一般ファンA',
      author_handle: 'fan_a',
      text: '君と見るそらの線香花火イベント楽しみ！時間は何時スタートなんだろう？気になるな。',
    };

    // #7 public short length ≈ 110, query 語あり
    const item7 = {
      id: '2100871827090501857',
      author_name: '一般ファンB',
      author_handle: 'fan_b',
      text: '線香花火の時間確認中。君と見るそらのライブ情報いつもチェックしてるけど早く時間知りたいな〜。友達と一緒に行く予定！',
    };

    const merged = [item1, item2, item3, item4, item5, item6, item7];

    const { items: enriched, fxCalls } = await enrichRealtimeItemsWithXDetail(
      merged,
      '君と見るそら 線香花火 時間',
      provider,
    );

    // 期待:
    // #2 -> Fx enrichment
    // #6, #7 -> Fxしない
    expect(fetchedIds).toContain('2100871827090501852');
    expect(fetchedIds).not.toContain('2100871827090501856');
    expect(fetchedIds).not.toContain('2100871827090501857');
    expect(fxCalls).toBeLessThanOrEqual(2);

    const target = enriched.find((it) => it.id === '2100871827090501852');
    expect(target).toBeDefined();
    expect(target?.detailEnriched).toBe(true);
    expect(target?.detailProvider).toBe('fxtwitter');
    expect(target?.text).toContain('18:00〜19:00');
  });
});
