import { afterEach, describe, expect, test } from 'bun:test';
import { getBrowser } from './browser_engine.js';

describe('getBrowser と出口のゲートウェイ', () => {
  const previous = process.env.SORA_EGRESS_GATEWAY;
  afterEach(() => {
    if (previous === undefined) delete process.env.SORA_EGRESS_GATEWAY;
    else process.env.SORA_EGRESS_GATEWAY = previous;
  });

  test('SORA_EGRESS_GATEWAY=on のときは、ブラウザごとのプロキシの指定（引数）を、黙って無視せず、エラーにする（ゲートウェイを迂回できない）', async () => {
    process.env.SORA_EGRESS_GATEWAY = 'on';
    await expect(getBrowser('http://other-proxy.example:8080')).rejects.toThrow('SORA_EGRESS_GATEWAY');
  });
});
