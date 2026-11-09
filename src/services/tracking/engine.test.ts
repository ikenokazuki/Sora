import { describe, it, expect, spyOn } from 'bun:test';
import type {
  TrackingCarrierAdapter,
} from './types.js';
import { trackByCarrier, trackPackage, trackPackageAuto } from './index.js';
import type { RankedCandidate } from './detector.js';
import { getCarrierAdapter } from './registry.js';
import { evaluateTrackingVerification } from './verification.js';
import { clearCache } from '../../cache.js';
import type { TrackingResult } from './types.js';

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
    // 登録済みアダプタの照会を差し替え、ヤマトは固定応答、他社は呼ばれたら記録する（実ネットワークに出ない）
    const yamatoTrack = spyOn(getCarrierAdapter('yamato')!, 'track').mockImplementation(async (num: string) => ({
      carrier: 'yamato',
      carrierName: 'ヤマト運輸',
      trackingNumber: num,
      status: 'delivered',
      statusText: '配達完了',
      events: [{ date: '2026/09/09 14:30', status: '配達完了', location: '渋谷センター' }],
      trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko',
    }));
    const otherTracks = (['sagawa', 'japanpost', 'seino', 'fukutsu'] as const).map((code) =>
      spyOn(getCarrierAdapter(code)!, 'track').mockImplementation(async () => {
        throw new Error(`${code} must not be called`);
      }));
    try {
      const result = await trackByCarrier('yamato', '123456789012', { noCache: true });
      expect(result.carrier).toBe('yamato');
      expect(result.resolvedCarrier?.method).toBe('explicit');
      expect(yamatoTrack).toHaveBeenCalledTimes(1);
      for (const spy of otherTracks) expect(spy).not.toHaveBeenCalled();
    } finally {
      yamatoTrack.mockRestore();
      for (const spy of otherTracks) spy.mockRestore();
    }
  });
});

describe('自動判別: 照会に失敗した会社があるとき、「見つからなかった」と言わない', () => {
  const NUM = '123456789012';
  const reply = (code: string, name: string, status: TrackingResult['status'], extra: Partial<TrackingResult> = {}): TrackingResult => ({
    carrier: code as TrackingResult['carrier'], carrierName: name, trackingNumber: NUM, status, statusText: `${name}: ${status}`, events: [], trackingUrl: `https://example.com/${code}`, ...extra,
  });
  const found = (code: string, name: string) => reply(code, name, 'in_transit', { events: [{ date: '2026-09-19', status: '輸送中', location: '東京' }] });
  const candidate = (code: string, name: string, track: () => Promise<TrackingResult>): RankedCandidate => ({
    carrier: code as RankedCandidate['carrier'],
    adapter: {
      code: code as TrackingCarrierAdapter['code'], name,
      trackingUrl: () => `https://example.com/${code}`,
      detect: () => ({ candidate: true, score: 70, strength: 'strong', reasons: [] }),
      track,
      verify: (res, num) => evaluateTrackingVerification(res, num),
    },
    score: 70, strength: 'strong', reasons: [],
  });
  const timeout = () => Promise.reject(new Error('The operation timed out.'));
  const run = (candidatesOverride: RankedCandidate[]) => trackPackageAuto(NUM, { noCache: true, candidatesOverride });

  it('全社が失敗（例外・error の返却・時間切れ）したら、status は error。失敗した会社の名前を挙げ、見つからなかったとは言わない', async () => {
    const res = await run([
      candidate('yamato', 'ヤマト運輸', timeout),
      candidate('sagawa', '佐川急便', async () => reply('sagawa', '佐川急便', 'error', { error: 'HTTP 503' })),
    ]);
    expect(res.status).toBe('error');
    expect(res.statusText).toContain('ヤマト運輸');
    expect(res.statusText).toContain('佐川急便');
    expect(res.statusText).not.toContain('見つかりませんでした');
    expect(res.error).toContain('The operation timed out.');
    expect(res.verification?.level).toBe('none');
  });

  it('1 社が失敗し、もう 1 社が「該当なし」と答えたら、status は error。失敗した会社だけを挙げる', async () => {
    const res = await run([
      candidate('yamato', 'ヤマト運輸', timeout),
      candidate('sagawa', '佐川急便', async () => reply('sagawa', '佐川急便', 'not_found')),
    ]);
    expect(res.status).toBe('error');
    expect(res.statusText).toContain('ヤマト運輸');
    expect(res.statusText).not.toContain('佐川急便');
    expect(res.statusText).not.toContain('見つかりませんでした');
  });

  it('失敗した会社が後の波にいても、前の波が全部「該当なし」なら error', async () => {
    const nf = (code: string, name: string) => candidate(code, name, async () => reply(code, name, 'not_found'));
    const res = await run([nf('yamato', 'ヤマト運輸'), nf('sagawa', '佐川急便'), candidate('japanpost', '日本郵便', timeout), nf('fukutsu', '福山通運')]);
    expect(res.status).toBe('error');
    expect(res.statusText).toContain('日本郵便');
    expect(res.statusText).not.toContain('福山通運');
  });

  it('1 社が荷物を見つけ、もう 1 社が失敗したら、見つけた会社が勝つ（失敗に引きずられない）', async () => {
    const res = await run([
      candidate('yamato', 'ヤマト運輸', timeout),
      candidate('sagawa', '佐川急便', async () => found('sagawa', '佐川急便')),
    ]);
    expect(res.status).toBe('in_transit');
    expect(res.carrier).toBe('sagawa');
    expect(res.resolvedCarrier?.method).toBe('network_verified');
  });

  it('全社が「該当なし」と答えたときだけ not_found（今まで通り）', async () => {
    const res = await run([
      candidate('yamato', 'ヤマト運輸', async () => reply('yamato', 'ヤマト運輸', 'not_found')),
      candidate('sagawa', '佐川急便', async () => reply('sagawa', '佐川急便', 'not_found')),
    ]);
    expect(res.status).toBe('not_found');
    expect(res.statusText).toContain('見つかりませんでした');
    expect(res.statusText).toContain('ヤマト運輸');
    expect(res.statusText).toContain('佐川急便');
  });

  it('error はキャッシュしない: 失敗のあとに同じ番号で尋ねると、もう一度照会する', async () => {
    clearCache();
    const adapters = (['yamato', 'sagawa', 'japanpost', 'fukutsu'] as const).map((code) => getCarrierAdapter(code)!);
    let yamatoFails = true;
    const spies = adapters.map((a) => spyOn(a, 'track').mockImplementation(async (num: string) => {
      if (a.code === 'yamato' && yamatoFails) throw new Error('timeout');
      return reply(a.code, a.name, 'not_found', { trackingNumber: num });
    }));
    try {
      const first = await trackPackage({ trackingNumber: NUM, carrier: 'auto' });
      expect(first.status).toBe('error');
      yamatoFails = false;
      const second = await trackPackage({ trackingNumber: NUM, carrier: 'auto' });
      expect(second.status).toBe('not_found');
      expect(second.cached).not.toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
      clearCache();
    }
  });
});
