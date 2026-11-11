import { describe, expect, test } from 'bun:test';
import { exactlyOne, onlyWith, usageError } from './args.js';

const USAGE = '使い方: 1 ページは url、複数は urls。';

describe('exactlyOne', () => {
  test('exactly one given key passes', () => {
    expect(exactlyOne({ url: 'https://example.com' }, ['url', 'urls'], USAGE)).toBeUndefined();
    expect(exactlyOne({ url: '', urls: ['https://example.com'] }, ['url', 'urls'], USAGE)).toBeUndefined();
  });

  test('none given: names the keys and adds the usage', () => {
    const message = exactlyOne({}, ['url', 'urls'], USAGE);
    expect(message).toContain('url');
    expect(message).toContain('urls');
    expect(message).toContain(USAGE);
  });

  test('undefined, null, empty string and empty array count as not given', () => {
    expect(exactlyOne({ url: undefined, urls: null }, ['url', 'urls'], USAGE)).toContain(USAGE);
    expect(exactlyOne({ url: '', urls: [] }, ['url', 'urls'], USAGE)).toContain(USAGE);
  });

  test('false and 0 are given values', () => {
    expect(exactlyOne({ a: false }, ['a', 'b'], USAGE)).toBeUndefined();
    expect(exactlyOne({ a: 0 }, ['a', 'b'], USAGE)).toBeUndefined();
  });

  test('several given: names the given keys and adds the usage', () => {
    const message = exactlyOne({ url: 'https://a.example', urls: ['https://b.example'] }, ['url', 'urls'], USAGE);
    expect(message).toContain('url, urls');
    expect(message).toContain(USAGE);
  });
});

describe('onlyWith', () => {
  test('passes when none of the keys is given', () => {
    expect(onlyWith({ action: 'list' }, 'action', 'register', ['title', 'selector'])).toBeUndefined();
    expect(onlyWith({ action: 'list', title: '', selector: [] }, 'action', 'register', ['title', 'selector'])).toBeUndefined();
  });

  test('passes when the condition holds', () => {
    expect(onlyWith({ action: 'register', title: 'x' }, 'action', 'register', ['title', 'selector'])).toBeUndefined();
  });

  test('a given key outside its condition names the key and the condition', () => {
    const message = onlyWith({ action: 'list', title: 'x' }, 'action', 'register', ['title', 'selector']);
    expect(message).toContain('title');
    expect(message).not.toContain('selector');
    expect(message).toContain('action');
    expect(message).toContain('register');
    expect(message).toContain('list');
  });

  test('the condition key missing is reported as 未指定', () => {
    expect(onlyWith({ limit: 5 }, 'part', 'evidence', ['limit'])).toContain('未指定');
  });
});

describe('usageError', () => {
  test('is an MCP error response that starts with 入力の誤り', () => {
    expect(usageError('url を指定してください。')).toEqual({
      isError: true,
      content: [{ type: 'text', text: '入力の誤り: url を指定してください。' }],
    });
  });
});
