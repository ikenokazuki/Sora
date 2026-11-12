import { describe, expect, spyOn, test } from 'bun:test';
import { deliverWebhook, webhookLabel } from './enrichment.js';

describe('webhookLabel（ログに出す webhook の宛先）', () => {
  test('ホスト名（とポート）だけを出す。パス・クエリ・認証情報のトークンは出さない', () => {
    expect(webhookLabel('https://hooks.slack.com/services/T000/B000/SECRETTOKEN')).toBe('hooks.slack.com');
    expect(webhookLabel('https://example.com:8443/hook?token=SECRETTOKEN#frag')).toBe('example.com:8443');
    expect(webhookLabel('https://user:SECRETPASS@example.com/hook')).toBe('example.com');
  });

  test('URL として読めないときは、元の文字列を出さない', () => {
    expect(webhookLabel('not a url SECRETTOKEN')).toBe('(不正な URL)');
  });
});

describe('deliverWebhook のログ', () => {
  test('内部の宛先を断るときも、URL のトークンをログに出さない', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await deliverWebhook('http://127.0.0.1:9/hook/SECRETTOKEN?key=SECRETKEY', { ok: true })).toBe(false);
      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('127.0.0.1:9');
      expect(logged).not.toContain('SECRETTOKEN');
      expect(logged).not.toContain('SECRETKEY');
    } finally {
      warn.mockRestore();
    }
  });
});
