import { describe, it, expect } from 'bun:test';
import type {
  TrackingCarrierAdapter,
  TrackingResult,
} from './types.js';
import { trackByCarrier, trackPackageAuto } from './index.js';
import type { RankedCandidate } from './detector.js';

describe('Tracking v2 Auto Engine & Verification Rules', () => {
  it('Fastest Is Not Winner: 最速の weak 応答ではなく、80ms 後に返った strong 応答が勝者となる', async () => {
    // Fake キャリア A: 高速（20ms）だが weak (events: [])
    const fakeCarrierA: TrackingCarrierAdapter = {
      code: 'yamato',
      name: 'Fake Fast Yamato',
      trackingUrl: () => 'https://example.com/a',
      detect: () => ({ candidate: true, score: 80, strength: 'strong', reasons: [] }),
      track: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return {
          carrier: 'yamato',
          carrierName: 'Fake Fast Yamato',
          trackingNumber: '123456789012',
          status: 'registered',
          statusText: '荷物受付 (イベント詳細なし)',
          events: [],
          trackingUrl: 'https://example.com/a',
        };
      },
      verify: (res) => ({ level: 'weak', reasons: ['No events or details'] }),
    };

    // Fake キャリア B: 低速（60ms）だが strong (events あり)
    const fakeCarrierB: TrackingCarrierAdapter = {
      code: 'sagawa',
      name: 'Fake Slower Sagawa',
      trackingUrl: () => 'https://example.com/b',
      detect: () => ({ candidate: true, score: 75, strength: 'strong', reasons: [] }),
      track: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return {
          carrier: 'sagawa',
          carrierName: 'Fake Slower Sagawa',
          trackingNumber: '123456789012',
          status: 'delivered',
          statusText: '配達完了',
          events: [{ date: '2026-09-19', status: '配達完了', location: '東京' }],
          trackingUrl: 'https://example.com/b',
        };
      },
      verify: (res) => ({ level: 'strong', reasons: ['Verified delivered event'] }),
    };

    const candidatesOverride: RankedCandidate[] = [
      { carrier: 'yamato', adapter: fakeCarrierA, score: 80, strength: 'strong', reasons: [] },
      { carrier: 'sagawa', adapter: fakeCarrierB, score: 75, strength: 'strong', reasons: [] },
    ];

    const result = await trackPackageAuto('123456789012', { noCache: true, candidatesOverride });
    expect(result.carrier).toBe('sagawa');
    expect(result.carrierName).toBe('Fake Slower Sagawa');
    expect(result.status).toBe('delivered');
    expect(result.verification?.level).toBe('strong');
    expect(result.resolvedCarrier?.method).toBe('network_verified');
  });

  it('Bounded Verification: 候補が多数あってもネットワーク検証は最大 4 回に制限される', async () => {
    let callCount = 0;
    const makeAdapter = (code: any, name: string): TrackingCarrierAdapter => ({
      code,
      name,
      trackingUrl: () => 'https://example.com',
      detect: () => ({ candidate: true, score: 70, strength: 'strong', reasons: [] }),
      track: async () => {
        callCount++;
        return {
          carrier: code,
          carrierName: name,
          trackingNumber: '123456789012',
          status: 'not_found',
          statusText: '見つかりません',
          events: [],
          trackingUrl: 'https://example.com',
        };
      },
      verify: () => ({ level: 'none', reasons: ['not_found'] }),
    });

    const candidatesOverride: RankedCandidate[] = [
      { carrier: 'yamato', adapter: makeAdapter('yamato', 'Y'), score: 90, strength: 'strong', reasons: [] },
      { carrier: 'sagawa', adapter: makeAdapter('sagawa', 'S'), score: 85, strength: 'strong', reasons: [] },
      { carrier: 'japanpost', adapter: makeAdapter('japanpost', 'J'), score: 80, strength: 'strong', reasons: [] },
      { carrier: 'fukutsu', adapter: makeAdapter('fukutsu', 'F'), score: 75, strength: 'strong', reasons: [] },
      { carrier: 'seino', adapter: makeAdapter('seino', 'SE'), score: 70, strength: 'strong', reasons: [] },
      { carrier: 'fedex', adapter: makeAdapter('fedex', 'FE'), score: 65, strength: 'strong', reasons: [] },
    ];

    const result = await trackPackageAuto('123456789012', { noCache: true, candidatesOverride });
    expect(callCount).toBe(4); // 最大4回（Wave 1: 2回, Wave 2: 2回）
    expect(result.status).toBe('not_found');
    expect(result.verification?.level).toBe('none');
  });

  it('URL-only Cannot Win: API クレデンシャル未設定等の URL のみ応答は auto winner になれない', async () => {
    const fakeUrlOnlyAdapter: TrackingCarrierAdapter = {
      code: 'fedex',
      name: 'FedEx URL Only',
      trackingUrl: () => 'https://fedex.com/track',
      detect: () => ({ candidate: true, score: 90, strength: 'strong', reasons: [] }),
      track: async () => ({
        carrier: 'fedex',
        carrierName: 'FedEx URL Only',
        trackingNumber: '123456789012',
        status: 'unknown',
        statusText: 'Credentials not configured; verify on web',
        events: [],
        trackingUrl: 'https://fedex.com/track',
      }),
      verify: () => ({ level: 'none', reasons: ['URL only, no shipment verification'] }),
    };

    const candidatesOverride: RankedCandidate[] = [
      { carrier: 'fedex', adapter: fakeUrlOnlyAdapter, score: 90, strength: 'strong', reasons: [] },
    ];

    const result = await trackPackageAuto('123456789012', { noCache: true, candidatesOverride });
    // URL-only は auto winner 禁止のため not_found / unverified_fallback
    expect(result.status).toBe('not_found');
    expect(result.verification?.level).toBe('none');
    expect(result.resolvedCarrier?.method).toBe('unverified_fallback');
  });

  it('Multiple Strong Conflict: 同一番号で2社とも strong な場合は ambiguous: true で競合を通知する', async () => {
    const fakeYamato: TrackingCarrierAdapter = {
      code: 'yamato',
      name: 'ヤマト運輸',
      trackingUrl: () => 'https://yamato.com',
      detect: () => ({ candidate: true, score: 80, strength: 'strong', reasons: [] }),
      track: async () => ({
        carrier: 'yamato',
        carrierName: 'ヤマト運輸',
        trackingNumber: '123456789012',
        status: 'delivered',
        statusText: '配達完了',
        events: [{ date: '2026-09-19', status: '配達完了' }],
        trackingUrl: 'https://yamato.com',
      }),
      verify: () => ({ level: 'strong', reasons: ['Active shipment verified'] }),
    };

    const fakeSagawa: TrackingCarrierAdapter = {
      code: 'sagawa',
      name: '佐川急便',
      trackingUrl: () => 'https://sagawa.com',
      detect: () => ({ candidate: true, score: 80, strength: 'strong', reasons: [] }),
      track: async () => ({
        carrier: 'sagawa',
        carrierName: '佐川急便',
        trackingNumber: '123456789012',
        status: 'delivered',
        statusText: '配達完了',
        events: [{ date: '2026-09-19', status: '配達完了' }],
        trackingUrl: 'https://sagawa.com',
      }),
      verify: () => ({ level: 'strong', reasons: ['Active shipment verified'] }),
    };

    const candidatesOverride: RankedCandidate[] = [
      { carrier: 'yamato', adapter: fakeYamato, score: 80, strength: 'strong', reasons: [] },
      { carrier: 'sagawa', adapter: fakeSagawa, score: 80, strength: 'strong', reasons: [] },
    ];

    const result = await trackPackageAuto('123456789012', { noCache: true, candidatesOverride });
    expect(result.carrier).toBe('unknown');
    expect(result.status).toBe('unknown');
    expect(result.statusText).toContain('複数の配送会社');
    expect(result.resolvedCarrier?.method).toBe('ambiguous_conflict');
  });

  it('Explicit Carrier: 指定キャリア照会時は他社へのネットワーク投機を一切行わない', async () => {
    let otherCarrierCalled = false;
    const fakeSagawa: TrackingCarrierAdapter = {
      code: 'sagawa',
      name: '佐川急便',
      trackingUrl: () => 'https://sagawa.com',
      detect: () => ({ candidate: true, score: 80, strength: 'strong', reasons: [] }),
      track: async () => {
        otherCarrierCalled = true;
        return {
          carrier: 'sagawa',
          carrierName: '佐川急便',
          trackingNumber: '123456789012',
          status: 'delivered',
          statusText: '配達完了',
          events: [],
          trackingUrl: 'https://sagawa.com',
        };
      },
      verify: () => ({ level: 'strong', reasons: [] }),
    };

    const result = await trackByCarrier('yamato', '123456789012', { noCache: true });
    expect(result.carrier).toBe('yamato');
    expect(result.resolvedCarrier?.method).toBe('explicit');
    expect(otherCarrierCalled).toBe(false);
  });
});
