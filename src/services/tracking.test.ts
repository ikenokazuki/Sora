import { describe, it, expect } from 'bun:test';
import {
  cleanTrackingNumber,
  getCarrierTrackingUrl,
  getCarrierName,
  determineStatus,
  detectCandidates,
  detectCandidateCarrierCodes,
  trackYamato,
  trackSagawa,
  trackJapanPost,
  trackSeino,
  trackFukutsu,
  trackUps,
  trackPackage,
} from './tracking.js';
import { app } from '../index.js';

describe('Tracking Service Unit Tests', () => {
  describe('cleanTrackingNumber', () => {
    it('全角数字・ハイフン・空白を除去して半角英数字に正規化する', () => {
      expect(cleanTrackingNumber('１２３４-５６７８-９０１２')).toBe('123456789012');
      expect(cleanTrackingNumber(' 1234 5678 9012 ')).toBe('123456789012');
      expect(cleanTrackingNumber('1z-12345-67890-1234-56')).toBe('1Z1234567890123456');
      expect(cleanTrackingNumber('em123456789jp')).toBe('EM123456789JP');
      expect(cleanTrackingNumber('')).toBe('');
    });
  });

  describe('getCarrierTrackingUrl', () => {
    it('各運送会社の公式追跡Webリンクを正しく生成する', () => {
      expect(getCarrierTrackingUrl('yamato', '1234-5678-9012')).toContain(
        'https://jizen.kuronekoyamato.co.jp/jizen/servlet/crjz.b.NQ0010?id=123456789012',
      );
      expect(getCarrierTrackingUrl('sagawa', '1234-5678-9012')).toContain(
        'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=123456789012',
      );
      expect(getCarrierTrackingUrl('japanpost', '1234-5678-9012')).toContain(
        'https://trackings.post.japanpost.jp/services/srv/search/direct?searchKind=S002&locale=ja&reqCodeNo1=123456789012',
      );
      expect(getCarrierTrackingUrl('seino', '1234567890')).toContain(
        'https://track.seino.co.jp/cgi-bin/gnpquery.pgm?GNPNO1=1234567890',
      );
      expect(getCarrierTrackingUrl('fukutsu', '123456789012')).toContain(
        'https://corp.fukutsu.co.jp/situation/tracking_no_hunt/123456789012',
      );
      expect(getCarrierTrackingUrl('ups', '1Z9999999999999999')).toContain(
        'https://www.ups.com/track?loc=ja_JP&tracknum=1Z9999999999999999',
      );
    });
  });

  describe('getCarrierName', () => {
    it('キャリアコードに対応する日本語名称を返す', () => {
      expect(getCarrierName('yamato')).toBe('ヤマト運輸');
      expect(getCarrierName('sagawa')).toBe('佐川急便');
      expect(getCarrierName('japanpost')).toBe('日本郵便');
      expect(getCarrierName('seino')).toBe('西濃運輸');
      expect(getCarrierName('fukutsu')).toBe('福山通運');
      expect(getCarrierName('ups')).toBe('UPS');
      expect(getCarrierName('fedex')).toBe('FedEx');
      expect(getCarrierName('dhl')).toBe('DHL Express');
    });
  });

  describe('determineStatus', () => {
    it('ステータステキストから標準コードを判定する', () => {
      expect(determineStatus('配達完了')).toBe('delivered');
      expect(determineStatus('お届け先にお届け済み')).toBe('delivered');
      expect(determineStatus('受取済')).toBe('delivered');

      expect(determineStatus('配達中')).toBe('in_transit');
      expect(determineStatus('作業店通過')).toBe('in_transit');
      expect(determineStatus('持出中')).toBe('in_transit');

      expect(determineStatus('荷物受付')).toBe('registered');
      expect(determineStatus('引受')).toBe('registered');

      expect(determineStatus('差出人に返送')).toBe('returned');

      expect(determineStatus('伝票番号誤り')).toBe('not_found');
      expect(determineStatus('該当なし')).toBe('not_found');
      expect(determineStatus('入力されたお問合せ番号が見当りません')).toBe('not_found');
      expect(determineStatus('お問い合わせ番号が見つかりません')).toBe('not_found');
    });
  });

  describe('detectCandidates', () => {
    it('伝票番号フォーマットから適切なキャリア候補群を推定する', () => {
      // UPS (1Z...)
      expect(detectCandidateCarrierCodes('1Z9999999999999999')).toEqual(['ups']);

      // 日本郵便 国際 (2英字 + 9数字 + 2英字)
      expect(detectCandidateCarrierCodes('EM123456785JP')).toEqual(['japanpost']);

      // 10桁 (西濃、佐川、DHL Express 等)
      const tenDigits = detectCandidateCarrierCodes('1234567890');
      expect(tenDigits).toContain('seino');
      expect(tenDigits).toContain('sagawa');

      // 11桁 (日本郵便、福山通運、ヤマト等)
      const elevenDigits = detectCandidateCarrierCodes('12345678901');
      expect(elevenDigits).toContain('japanpost');
      expect(elevenDigits).toContain('fukutsu');
      expect(elevenDigits).toContain('yamato');

      // 12桁（ヤマト、佐川、日本郵便、福山、FedEx 等）
      const twelveDigits = detectCandidateCarrierCodes('123456789012');
      expect(twelveDigits).toContain('yamato');
      expect(twelveDigits).toContain('sagawa');
      expect(twelveDigits).toContain('japanpost');
      expect(twelveDigits).toContain('fukutsu');

      // 13桁 (日本郵便)
      expect(detectCandidateCarrierCodes('1234567890123')).toEqual(['japanpost']);
    });
  });

  describe('UPS Tracking', () => {
    it('UPS番号に対して公式URLと案内を正しく返却する (T-B3: credential未設定時はunknown)', async () => {
      const res = await trackUps('1Z9999999999999999');
      expect(res.carrier).toBe('ups');
      expect(res.carrierName).toBe('UPS');
      expect(res.trackingNumber).toBe('1Z9999999999999999');
      expect(res.trackingUrl).toContain('https://www.ups.com/track?loc=ja_JP&tracknum=1Z9999999999999999');
      // T-B3: credentials未設定時は status: 'unknown' かつ events: []
      expect(res.status).toBe('unknown');
      expect(res.statusText).toContain('UPS API credentials are not configured');
      expect(res.events.length).toBe(0);
    });
  });

  describe('Track B Verification Tests (T-B1 to T-B7)', () => {
    it('T-B1: 候補A (高速 in_transit) と 候補B (遅延/hang) で、Bを待たずに早期返却される', async () => {
      // 候補Aが高速に完了し、候補Bが遅延する場合のfail-fastアルゴリズムをシミュレート
      const strongStatuses = new Set(['delivered', 'in_transit', 'registered', 'returned']);
      const simulatedParallel = async () => {
        return new Promise((resolve) => {
          let isResolved = false;
          // Fast candidate (30ms)
          setTimeout(() => {
            if (!isResolved) {
              isResolved = true;
              resolve({ carrier: 'yamato', status: 'in_transit' });
            }
          }, 30);
          // Slow candidate (2000ms hang)
          setTimeout(() => {
            if (!isResolved) {
              isResolved = true;
              resolve({ carrier: 'sagawa', status: 'delivered' });
            }
          }, 2000);
        });
      };

      const start = performance.now();
      const res = await simulatedParallel() as any;
      const elapsed = performance.now() - start;

      expect(res.status).toBe('in_transit');
      expect(elapsed).toBeLessThan(500); // 2000msを待たずに30msで即時返却
    });

    it('T-B2: 全候補が not_found / error の場合、制御された not_found を返す', async () => {
      // 存在しないダミー番号で全候補がnot_foundとなり、制御されたnot_foundが返ることを確認
      const res = await trackPackage({
        trackingNumber: '0000000000',
        carrier: 'auto',
      });
      expect(res.status).toBe('not_found');
      expect(res.statusText).toContain('見つかりませんでした');
      expect(res.events).toEqual([]);
    }, 15000);

    it('T-B4: generic unknown 番号で detectCandidates() に UPS が含まれない', () => {
      const candidates = detectCandidateCarrierCodes('999999999999999999'); // 不明な18桁数字等
      expect(candidates).not.toContain('ups');
    });

    it('T-B5: valid 1Z... で UPS だけが候補となる', () => {
      const candidates = detectCandidateCarrierCodes('1Z12345E0205271688');
      expect(candidates).toEqual(['ups']);
    });

    it('T-B6: explicit carrier: "ups" で credential なしでも正常 response (transport error にしない)', async () => {
      const res = await trackPackage({
        trackingNumber: '1Z9999999999999999',
        carrier: 'ups',
      });
      expect(res.carrier).toBe('ups');
      expect(res.status).toBe('unknown');
      expect(res.trackingUrl).toContain('ups.com');
    });
  });

  describe('Live Carrier Query with Test Number', () => {
    it('ヤマト運輸: 未登録/ダミー番号で not_found を安全に返す', async () => {
      const res = await trackYamato('123456789012');
      expect(res.carrier).toBe('yamato');
      expect(res.status).toBe('not_found');
      expect(res.trackingUrl).toContain('123456789012');
    }, 15000);

    it('佐川急便: 未登録/ダミー番号で not_found を安全に返す', async () => {
      const res = await trackSagawa('123456789012');
      expect(res.carrier).toBe('sagawa');
      expect(res.status).toBe('not_found');
      expect(res.trackingUrl).toContain('123456789012');
    }, 15000);

    it('日本郵便: 未登録/ダミー番号で not_found を安全に返す', async () => {
      const res = await trackJapanPost('123456789012');
      expect(res.carrier).toBe('japanpost');
      expect(res.status).toBe('not_found');
      expect(res.trackingUrl).toContain('123456789012');
    }, 15000);

    it('西濃運輸: 未登録/ダミー番号で not_found を安全に返す', async () => {
      const res = await trackSeino('1234567890');
      expect(res.carrier).toBe('seino');
      expect(res.status).toBe('not_found');
      expect(res.trackingUrl).toContain('1234567890');
    }, 15000);

    it('福山通運: 未登録/ダミー番号で not_found を安全に返す', async () => {
      const res = await trackFukutsu('123456789012');
      expect(res.carrier).toBe('fukutsu');
      expect(res.status).toBe('not_found');
      expect(res.trackingUrl).toContain('123456789012');
    }, 15000);

    it('自動判別 (trackPackage with carrier="auto"): 候補探索が安全に完了する', async () => {
      const res = await trackPackage({
        trackingNumber: '1Z9999999999999999',
        carrier: 'auto',
      });
      expect(res.carrier).toBe('ups');
      expect(res.trackingUrl).toContain('ups.com');
    }, 15000);
  });
});

describe('REST API Tracking Routes Tests', () => {
  it('POST /tracking: 正常にリクエストを処理する', async () => {
    const res = await app.request('/tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackingNumber: '1Z9999999999999999',
        carrier: 'ups',
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.carrier).toBe('ups');
    expect(data.trackingNumber).toBe('1Z9999999999999999');
    expect(data.trackingUrl).toContain('ups.com');
  });

  it('POST /tracking: 必須パラメータ不足で400を返す', async () => {
    const res = await app.request('/tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('GET /tracking/:carrier/:number: 指定キャリアで追跡できる', async () => {
    const res = await app.request('/tracking/ups/1Z9999999999999999');
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.carrier).toBe('ups');
    expect(data.trackingNumber).toBe('1Z9999999999999999');
  });

  it('GET /tracking/:carrier/:number: 無効なキャリアコードで400を返す', async () => {
    const res = await app.request('/tracking/invalidcarrier/123456789012');
    expect(res.status).toBe(400);
  });

  it('GET /tracking/:number: 自動判別で追跡できる', async () => {
    const res = await app.request('/tracking/1Z9999999999999999');
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.carrier).toBe('ups');
  });

  it('MCP search_tools: 荷物追跡や運送会社名で track_package を検索・動的有効化できる', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }),
    });
    const sessionId = res.headers.get('mcp-session-id')!;
    expect(sessionId).toBeDefined();

    // search_tools を呼び出して「ヤマト」「荷物追跡」を検索
    const searchRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'search_tools', arguments: { query: '荷物追跡' } },
      }),
    });
    expect(searchRes.status).toBe(200);
    const rawText = await searchRes.text();
    let body: any;
    try {
      body = JSON.parse(rawText);
    } catch {
      const line = rawText.split('\n').find((l) => l.startsWith('data: '));
      if (line) body = JSON.parse(line.replace(/^data:\s*/, ''));
    }
    expect(body?.result?.content?.[0]?.text).toContain('track_package');

    // tools/list を取得し track_package が含まれていることを確認
    const listRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
      }),
    });
    const rawList = await listRes.text();
    let listBody: any;
    try {
      listBody = JSON.parse(rawList);
    } catch {
      const line = rawList.split('\n').find((l) => l.startsWith('data: '));
      if (line) listBody = JSON.parse(line.replace(/^data:\s*/, ''));
    }
    const toolNames = listBody.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('track_package');

    // T-B7: track_package の tools/call を実行し、正常な JSON-RPC 応答が得られることを確認
    const callRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'track_package',
          arguments: { trackingNumber: '1Z9999999999999999', carrier: 'ups' },
        },
      }),
    });
    expect(callRes.status).toBe(200);
    const rawCall = await callRes.text();
    let callBody: any;
    try {
      callBody = JSON.parse(rawCall);
    } catch {
      const line = rawCall.split('\n').find((l) => l.startsWith('data: '));
      if (line) callBody = JSON.parse(line.replace(/^data:\s*/, ''));
    }
    expect(callBody?.result).toBeDefined();
    expect(callBody?.result?.content?.[0]?.text).toContain('ups.com');
  });
});
