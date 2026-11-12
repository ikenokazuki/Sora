import { describe, expect, test } from 'bun:test';
import { getBrowser } from './browser_engine.js';
import { withEnv } from './test_fixtures/env.js';

describe('getBrowser と出口のゲートウェイ', () => {
  test('SORA_EGRESS_GATEWAY=on のときは、ブラウザごとのプロキシの指定（引数）を、黙って無視せず、エラーにする（ゲートウェイを迂回できない）', async () => {
    // SORA_FETCH_ALLOW_PRIVATE_NETWORK=true（手元で全件を回すときに、全体に渡すことがある）では、ゲートウェイは使われないので、外す
    await withEnv({ SORA_EGRESS_GATEWAY: 'on', SORA_FETCH_ALLOW_PRIVATE_NETWORK: undefined }, async () => {
      await expect(getBrowser('http://other-proxy.example:8080')).rejects.toThrow('SORA_EGRESS_GATEWAY');
    });
  });
});
