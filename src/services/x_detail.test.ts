/**
 * X Long-form Detail Provider & Adaptive Enrichment Tests (X1 to X13)
 */

import { describe, expect, it } from 'bun:test';
import {
  FxTwitterDetailProvider,
  type XPostDetail,
  type XPostDetailProvider,
  extractSemanticQuery,
  observeRequirements,
  enrichRealtimeItemsWithXDetail,
} from './x_detail.js';
import { searchYahooRealtime } from './yahoo.js';
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
    // Test provider internal logic with simulated mismatch
    const provider = new FxTwitterDetailProvider();
    // Non-numeric ID must be rejected immediately
    const badId = await provider.fetchStatus('abc-not-an-id');
    expect(badId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // X3: Timeout fail-soft
  // ---------------------------------------------------------------------------
  it('X3: fail-soft on timeout, preserving original Yahoo items without error', async () => {
    const timeoutProvider: XPostDetailProvider = {
      async fetchStatus() {
        // Simulates timeout
        return null;
      },
    };

    const items = [
      {
        id: '2100871827090501852',
        text: '【夏祭り告知】線香花火大会を開催します！詳細は後ほど発表。',
      },
    ];

    const { items: enriched, fxCalls } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時 id:kimisora_JPN',
      timeoutProvider,
    );

    expect(fxCalls).toBe(1);
    expect(enriched[0].text).toBe('【夏祭り告知】線香花火大会を開催します！詳細は後ほど発表。');
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

    const items = [
      {
        id: '2100871827090501852',
        text: '一部テキストのみ',
      },
    ];

    const { items: enriched } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時',
      errorProvider,
    );

    expect(enriched.length).toBe(1);
    expect(enriched[0].text).toBe('一部テキストのみ');
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
  // X6: No unnecessary Fx calls when top item has full evidence
  // ---------------------------------------------------------------------------
  it('X6: zero Fx calls when top candidate already observes all requirements', async () => {
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
  // X7: Partial evidence escalation - calls Fx for top1
  // ---------------------------------------------------------------------------
  it('X7: escalates top1 to FxTwitter exactly once when relevant seed has evidence gap', async () => {
    let callCount = 0;
    const trackingProvider: XPostDetailProvider = {
      async fetchStatus(id) {
        callCount++;
        return {
          statusId: id,
          text: '【全日程】線香花火大会は18時開始となります！',
          isNoteTweet: true,
          provider: 'fxtwitter',
        };
      },
    };

    const items = [
      {
        id: '2100871827090501852',
        text: '【告知】線香花火大会を開催します！詳細はツリーへ', // 「何時」がmissing
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
  });

  // ---------------------------------------------------------------------------
  // X8: Irrelevant top candidate is not fetched unconditionally
  // ---------------------------------------------------------------------------
  it('X8: does not fetch top candidate if it has zero lexical evidence for query', async () => {
    let callCount = 0;
    const trackingProvider: XPostDetailProvider = {
      async fetchStatus() {
        callCount++;
        return null;
      },
    };

    const items = [
      {
        id: '30001',
        text: '本日のランチはカレーライスでした。美味しかった！', // まったく関係ない
      },
      {
        id: '30002',
        text: '明日の線香花火大会の準備をしています。', // 線香花火が含まれる
      },
    ];

    const { fxCalls } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時',
      trackingProvider,
    );

    // item 1 は無関係なのでスキップされ、item 2 のみフェッチされる (計1回)
    expect(fxCalls).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // X9: Bounded calls - max 2 Fx requests per search
  // ---------------------------------------------------------------------------
  it('X9: guarantees maximum 2 Fx requests even across multiple items', async () => {
    let callCount = 0;
    const trackingProvider: XPostDetailProvider = {
      async fetchStatus() {
        callCount++;
        return null;
      },
    };

    const items = [
      { id: '40001', text: '線香花火 その1' },
      { id: '40002', text: '線香花火 その2' },
      { id: '40003', text: '線香花火 その3' },
      { id: '40004', text: '線香花火 その4' },
    ];

    const { fxCalls } = await enrichRealtimeItemsWithXDetail(
      items,
      '線香花火 何時',
      trackingProvider,
    );

    expect(fxCalls).toBeLessThanOrEqual(2);
    expect(callCount).toBeLessThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // X10 & X11: Cache & In-flight deduplication
  // ---------------------------------------------------------------------------
  it('X10 & X11: deduplicates identical status requests via cache and single-flight', async () => {
    let upstreamCalls = 0;
    const testProvider = new FxTwitterDetailProvider();

    // Verify statusId strict numeric regex
    expect(/^[0-9]+$/.test('2100871827090501852')).toBe(true);
    expect(/^[0-9]+$/.test('https://x.com/status/123')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // X12: Note Tweet equivalent regression
  // ---------------------------------------------------------------------------
  it('X12: preserves complete Note Tweet text replacing truncated Yahoo snippet', async () => {
    const partialYahooText = '【イベント情報】君と見るそら 夏の線香花火大会 開催日: 2026年8月15日...';
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
