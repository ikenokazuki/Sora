import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { app } from '../index.js';
import * as yahooService from './yahoo.js';
import { defaultXDetailProvider, type XPostDetail } from './x_detail.js';

describe('MCP & REST Deep / Realtime / Scrape / Tracking Multi-surface Integration Tests', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // 1. REST /search/realtime & /realtime parity and enrichment
  // =========================================================================
  describe('REST Realtime Endpoints (/search/realtime and /realtime)', () => {
    it('REST /search/realtime and /realtime both succeed and return enriched X detail', async () => {
      const longFesText = '【告知】サマーフェスティバルの詳細を発表します。今年のサマーフェスティバルは特別ステージを用意しており、アーティストの出演順や開演時間などの最新情報を順次ご案内いたします。当日は猛暑が予想されますので十分な熱中症対策をお願い申し上げます。チケットや整理券の詳細は公式サイトをご確認ください…'.padEnd(250, '。');

      // Mock callYahooMcp for yahoo_realtime_search
      // Realtime取得はJSON直取得へ移行したため、モック対象も新シームにする。
      const yahooSpy = spyOn(yahooService, 'callYahooRealtimeJson').mockImplementation(async (toolName, args) => {
        if (toolName === 'yahoo_realtime_search') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify([
                  {
                    id: '2000000000000000001',
                    text: longFesText,
                    author_name: '公式フェス運営',
                    author_handle: 'summer_fes',
                    created_at: Math.floor(Date.now() / 1000),
                  },
                ]),
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: '[]' }] };
      });

      // Mock defaultXDetailProvider.fetchStatus
      const fetchStatusSpy = spyOn(defaultXDetailProvider, 'fetchStatus').mockImplementation(async (id) => {
        if (id === '2000000000000000001') {
          return {
            statusId: id,
            text: '【告知】サマーフェスティバルの詳細を発表します！開場は10時、開演は12時、終演は20時を予定しております。チケットは公式HPよりお求めください。',
            isNoteTweet: true,
            author: { name: '公式フェス運営', screenName: 'summer_fes' },
            createdAt: '2026-09-18T10:00:00.000Z',
            provider: 'fxtwitter',
          };
        }
        return null;
      });

      try {
        // Test 1: POST /search/realtime
        const res1 = await app.request('/search/realtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'サマーフェスティバル 開演',
            noCache: true,
          }),
        });
        expect(res1.status).toBe(200);
        const data1 = (await res1.json()) as any;
        expect(data1.source).toBe('x');
        expect(data1.type).toBe('realtime');
        expect(data1.data.items.length).toBe(1);
        expect(data1.data.items[0].text).toContain('開場は10時、開演は12時');
        expect(data1.data.items[0].detailEnriched).toBe(true);
        expect(data1.data.items[0].isNoteTweet).toBe(true);
        expect(data1.data.items[0].snippet).toBeUndefined();
        expect(data1.data.items[0].markdown).toBeUndefined();
        expect(data1.data.items[0].originalText).toBeUndefined();
        expect(data1.data.items[0].author).toBeUndefined();
        expect(data1.data.items[0].author_name).toBe('公式フェス運営');
        expect(data1.data.items[0].author_handle).toBe('summer_fes');
        expect(data1.retrievalQueries).toBeUndefined();
        expect(data1.contributingQueries).toBeUndefined();
        expect(data1.stopReason).toBeUndefined();

        // Test 2: POST /realtime (alias parity)
        const res2 = await app.request('/realtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'サマーフェスティバル 開演',
            noCache: true,
          }),
        });
        expect(res2.status).toBe(200);
        const data2 = (await res2.json()) as any;
        expect(data2.source).toBe('x');
        expect(data2.type).toBe('realtime');
        expect(data2.data.items.length).toBe(1);
        expect(data2.data.items[0].text).toContain('開場は10時、開演は12時');
      } finally {
        yahooSpy.mockRestore();
        fetchStatusSpy.mockRestore();
      }
    });

    it('REST realtime exposes retrieval provenance only in verbose mode', async () => {
      const yahooSpy = spyOn(yahooService, 'callYahooRealtimeJson').mockImplementation(async (toolName) => {
        if (toolName === 'yahoo_realtime_search') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify([{ id: '2000000000000000002', text: 'SPARK 出演 辞退', author_handle: 'kimisora_JPN' }]),
            }],
          };
        }
        return { content: [{ type: 'text', text: '[]' }] };
      });
      const fetchStatusSpy = spyOn(defaultXDetailProvider, 'fetchStatus').mockResolvedValue(null);

      try {
        const compact = await app.request('/search/realtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'SPARK 出演 辞退 id:kimisora_JPN', noCache: true }),
        });
        const verbose = await app.request('/search/realtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'SPARK 出演 辞退 id:kimisora_JPN', verbose: true, noCache: true }),
        });
        const compactBody = (await compact.json()) as any;
        const verboseBody = (await verbose.json()) as any;

        expect(compact.status).toBe(200);
        expect(verbose.status).toBe(200);
        expect(compactBody.retrievalQueries).toBeUndefined();
        expect(compactBody.data.items[0].id).toBe('2000000000000000002');
        expect(verboseBody.retrievalQueries.length).toBeGreaterThan(0);
        expect(verboseBody.contributingQueries.length).toBeGreaterThan(0);
        expect(verboseBody.stopReason).toBe('full_coverage');
        expect(verboseBody.data.items[0].id).toBe(compactBody.data.items[0].id);
      } finally {
        yahooSpy.mockRestore();
        fetchStatusSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // 2. REST /search/deep & /deep-search Realtime X enrichment (Section 19)
  // =========================================================================
  describe('REST Deep Search Endpoints (/search/deep and /deep-search)', () => {
    it('REST /search/deep incorporates enriched X items after merge without pre-merge Fx calls', async () => {
      const longOfficialText = '【速報】サマーフェスティバル物販タイテ公開！今年のサマーフェスティバルでは公式グッズやアーティストコラボグッズなど多数の限定アイテムを販売いたします。整理券の取得方法や待機列の形成時間についてのご案内です。当日は大変混雑が予想されますので公共交通機関でお越しください…'.padEnd(250, '。');

      const yahooSpy = spyOn(yahooService, 'callYahooMcp').mockImplementation(async (toolName) => {
        if (toolName === 'yahoo_web_search') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  items: [
                    {
                      title: 'サマーフェスティバル2026 公式サイト',
                      link: 'https://example.com/summer-fes-2026',
                      snippet: 'サマーフェスティバル2026の公式案内ページです。',
                    },
                    {
                      title: 'サマーフェスティバル 公式X',
                      link: 'https://x.com/summer_fes',
                      snippet: 'サマーフェスティバル公式アカウントです。',
                    },
                  ],
                }),
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: '[]' }] };
      });
      // searchYahooWeb tries direct fetch first; keep this test hermetic.
      const yahooDirectSpy = spyOn(yahooService, 'fetchYahooWebDirect').mockImplementation(async () => {
        throw new Error('direct down (test)');
      });
      const yahooRealtimeSpy = spyOn(yahooService, 'callYahooRealtimeJson').mockImplementation(async (toolName, args) => {
        if (toolName === 'yahoo_realtime_search') {
          const isOfficial = typeof args?.query === 'string' && (args.query.includes('id:summer_fes') || args.query.includes('summer_fes'));
          if (isOfficial) {
            // Official realtime: long-form truncation suspect (length >= 240)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify([
                    {
                      id: '2000000000000000002',
                      text: longOfficialText,
                      author_name: '公式フェス運営',
                      author_handle: 'summer_fes',
                      created_at: Math.floor(Date.now() / 1000),
                    },
                  ]),
                },
              ],
            };
          } else {
            // Public realtime: short post (< 240 chars)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify([
                    {
                      id: '2000000000000000099',
                      text: 'サマーフェスティバルの物販って何時から並べばいいのかな？楽しみだな〜！',
                      author_name: '一般参加者',
                      author_handle: 'fes_fan',
                      created_at: Math.floor(Date.now() / 1000),
                    },
                  ]),
                },
              ],
            };
          }
        }
        return { content: [{ type: 'text', text: '[]' }] };
      });

      let fxCalls = 0;
      const fetchStatusSpy = spyOn(defaultXDetailProvider, 'fetchStatus').mockImplementation(async (id) => {
        fxCalls++;
        if (id === '2000000000000000002') {
          return {
            statusId: id,
            text: '【速報】サマーフェスティバル物販タイテ公開！先行物販は午前9時開始、一般物販は午前11時開始です。',
            isNoteTweet: true,
            provider: 'fxtwitter',
          };
        }
        return null;
      });

      try {
        const res = await app.request('/search/deep', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'サマーフェスティバル 物販',
            includeRealtime: true,
            scrapeContent: false, // focus on search and realtime merge
            noCache: true,
          }),
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.source).toBe('integrated');
        expect(data.realtime).toBeDefined();
        expect(data.realtime.source).toBe('x');
        expect(data.realtime.items.length).toBeGreaterThan(0);

        // Section 19: Only exactly 1 Fx call occurred post-merge for the official target
        expect(fxCalls).toBe(1);

        const targetItem = data.realtime.items.find((it: any) => it.id === '2000000000000000002');
        expect(targetItem).toBeDefined();
        expect(targetItem.text).toContain('先行物販は午前9時開始');
        expect(targetItem.detailEnriched).toBe(true);
        expect(targetItem.snippet).toBeUndefined();
        expect(targetItem.markdown).toBeUndefined();
        expect(targetItem.originalText).toBeUndefined();
        expect(targetItem.author).toBeUndefined();
        expect(targetItem.author_name).toBe('公式フェス運営');
        expect(targetItem.author_handle).toBe('summer_fes');

        const publicItem = data.realtime.items.find((it: any) => it.id === '2000000000000000099');
        expect(publicItem).toBeDefined();
        expect(publicItem.detailEnriched).toBeUndefined();
        expect(publicItem.snippet).toBeUndefined();
        expect(publicItem.markdown).toBeUndefined();
        expect(publicItem.originalText).toBeUndefined();
        expect(publicItem.author).toBeUndefined();
        expect(publicItem.author_name).toBe('一般参加者');
        expect(publicItem.author_handle).toBe('fes_fan');
      } finally {
        yahooSpy.mockRestore();
        yahooDirectSpy.mockRestore();
        yahooRealtimeSpy.mockRestore();
        fetchStatusSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // 3. REST /scrape with X status URL
  // =========================================================================
  describe('REST /scrape with X status URL', () => {
    it('REST /scrape extracts complete Note Tweet directly via FxTwitter detail', async () => {
      const fetchStatusSpy = spyOn(defaultXDetailProvider, 'fetchStatus').mockImplementation(async (id) => {
        if (id === '2000000000000000003') {
          return {
            statusId: id,
            text: '【重要なお知らせ】新曲「君と見るそら」のミュージックビデオを公開しました！作詞・作曲・編曲の完全版クレジットはこちらからご確認ください。',
            isNoteTweet: true,
            author: { name: 'Sora Official', screenName: 'sora_dev' },
            createdAt: '2026-09-18T12:00:00.000Z',
            provider: 'fxtwitter',
          };
        }
        return null;
      });

      try {
        const res = await app.request('/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://x.com/sora_dev/status/2000000000000000003',
            noCache: true,
          }),
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.content).toContain('新曲「君と見るそら」のミュージックビデオ');
        expect(data.author).toContain('Sora Official');
        expect(data.siteName).toBe('X (Twitter)');
      } finally {
        fetchStatusSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // 4. MCP Tools Call (search_realtime, search_deep, scrape, track_package)
  // =========================================================================
  describe('MCP Tools Call Multi-surface Verification', () => {
    it('MCP search_realtime and search_deep execute and return enriched data via JSON-RPC', async () => {
      // Step 1: Initialize MCP session
      const initRes = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0' },
          },
        }),
      });
      const sessionId = initRes.headers.get('mcp-session-id')!;
      expect(sessionId).toBeDefined();

      const longLiveText = '【ライブ速報】アンコール曲は「青空」でした。本日のツアー最終日、会場の熱気は最高潮に達し、観客の皆様の温かいご声援に応えてダブルアンコールまで実施される感動的な夜となりました。関わってくださった全ての皆様に心より感謝申し上げます。'.padEnd(250, '！');

      // Setup Mocks
      const yahooSpy = spyOn(yahooService, 'callYahooMcp').mockImplementation(async (toolName) => {
        if (toolName === 'yahoo_web_search') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  items: [
                    {
                      title: 'ライブレポート2026',
                      link: 'https://example.com/live-report',
                      snippet: '本日の公演レポートです。',
                    },
                  ],
                }),
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: '[]' }] };
      });
      const yahooRealtimeSpy = spyOn(yahooService, 'callYahooRealtimeJson').mockImplementation(async (toolName) => {
        if (toolName === 'yahoo_realtime_search') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify([
                  {
                    id: '2000000000000000004',
                    text: longLiveText,
                    author_name: 'ライブ実況BOT',
                    author_handle: 'live_jikkyo',
                    created_at: Math.floor(Date.now() / 1000),
                  },
                ]),
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: '[]' }] };
      });

      const fetchStatusSpy = spyOn(defaultXDetailProvider, 'fetchStatus').mockImplementation(async (id) => {
        if (id === '2000000000000000004') {
          return {
            statusId: id,
            text: '【ライブ速報】アンコール曲は「青空」でした！Wアンコールで新曲の初披露もあり、会場は大歓声に包まれました！',
            isNoteTweet: true,
            provider: 'fxtwitter',
          };
        }
        return null;
      });

      try {
        // Call MCP tool: search_realtime
        const realtimeCallRes = await app.request('/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2024-11-05',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/call',
            params: {
              name: 'search_realtime',
              arguments: {
                query: 'ライブ速報 アンコール',
              },
            },
          }),
        });
        expect(realtimeCallRes.status).toBe(200);
        const realtimeRaw = await realtimeCallRes.text();
        let realtimeBody: any;
        try {
          realtimeBody = JSON.parse(realtimeRaw);
        } catch {
          const line = realtimeRaw.split('\n').find((l) => l.startsWith('data: '));
          if (line) realtimeBody = JSON.parse(line.replace(/^data:\s*/, ''));
        }
        const realtimeText = realtimeBody.result.content[0].text;
        const realtimeParsed = JSON.parse(realtimeText);
        expect(realtimeParsed.source).toBe('x');
        expect(realtimeParsed.items.length).toBeGreaterThan(0);
        expect(realtimeParsed.items[0].text).toContain('アンコール曲は「青空」でした');
        expect(realtimeParsed.items[0].detailEnriched).toBe(true);
        expect(realtimeParsed.retrievalQueries).toBeUndefined();
        expect(realtimeParsed.contributingQueries).toBeUndefined();

        const verboseRealtimeCallRes = await app.request('/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2024-11-05',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 12,
            method: 'tools/call',
            params: {
              name: 'search_realtime',
              arguments: {
                query: 'ライブ速報 アンコール',
                verbose: true,
              },
            },
          }),
        });
        const verboseRealtimeRaw = await verboseRealtimeCallRes.text();
        let verboseRealtimeBody: any;
        try {
          verboseRealtimeBody = JSON.parse(verboseRealtimeRaw);
        } catch {
          const line = verboseRealtimeRaw.split('\n').find((l) => l.startsWith('data: '));
          if (line) verboseRealtimeBody = JSON.parse(line.replace(/^data:\s*/, ''));
        }
        const verboseRealtimeParsed = JSON.parse(verboseRealtimeBody.result.content[0].text);
        expect(verboseRealtimeCallRes.status).toBe(200);
        expect(verboseRealtimeParsed.retrievalQueries.length).toBeGreaterThan(0);
        expect(verboseRealtimeParsed.contributingQueries.length).toBeGreaterThan(0);
        expect(verboseRealtimeParsed.items[0].id).toBe(realtimeParsed.items[0].id);

        // Call MCP tool: search_deep
        const deepCallRes = await app.request('/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2024-11-05',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: {
              name: 'search_deep',
              arguments: {
                query: 'ライブ速報 アンコール',
                includeRealtime: true,
                scrapeContent: false,
              },
            },
          }),
        });
        expect(deepCallRes.status).toBe(200);
        const deepRaw = await deepCallRes.text();
        let deepBody: any;
        try {
          deepBody = JSON.parse(deepRaw);
        } catch {
          const line = deepRaw.split('\n').find((l) => l.startsWith('data: '));
          if (line) deepBody = JSON.parse(line.replace(/^data:\s*/, ''));
        }
        const deepText = deepBody.result.content[0].text;
        const deepParsed = JSON.parse(deepText);
        expect(deepParsed.source).toBe('integrated');
        expect(deepParsed.realtime).toBeDefined();
        expect(deepParsed.realtime.items[0].text).toContain('アンコール曲は「青空」でした');
      } finally {
        yahooSpy.mockRestore();
        yahooRealtimeSpy.mockRestore();
        fetchStatusSpy.mockRestore();
      }
    });

    it('MCP track_package and REST /tracking handle fail-fast and safe UPS fallback', async () => {
      // 1. REST /tracking with auto carrier on 1Z... (UPS fallback when uncredentialed)
      const restTrackingRes = await app.request('/tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackingNumber: '1Z9999999999999999',
          carrier: 'auto',
        }),
      });
      expect(restTrackingRes.status).toBe(200);
      const restTrackingData = (await restTrackingRes.json()) as any;
      expect(restTrackingData.carrier).toBe('ups');
      expect(restTrackingData.status).toBe('unknown');
      expect(restTrackingData.trackingUrl).toContain('ups.com');

      // 2. MCP track_package call
      const initRes = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 100,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        }),
      });
      const sessionId = initRes.headers.get('mcp-session-id')!;

      // Enable track_package dynamically via search_tools
      await app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: { name: 'search_tools', arguments: { query: '荷物追跡' } },
        }),
      });

      // Call track_package
      const mcpTrackingRes = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 102,
          method: 'tools/call',
          params: {
            name: 'track_package',
            arguments: {
              trackingNumber: '1Z9999999999999999',
              carrier: 'ups',
            },
          },
        }),
      });
      expect(mcpTrackingRes.status).toBe(200);
      const mcpRaw = await mcpTrackingRes.text();
      let mcpBody: any;
      try {
        mcpBody = JSON.parse(mcpRaw);
      } catch {
        const line = mcpRaw.split('\n').find((l) => l.startsWith('data: '));
        if (line) mcpBody = JSON.parse(line.replace(/^data:\s*/, ''));
      }
      expect(mcpBody.result.content[0].text).toContain('"carrier": "ups"');
      expect(mcpBody.result.content[0].text).toContain('"status": "unknown"');
    });
  });
});
