import { describe, expect, test } from 'bun:test';
import { AddressDisabledError, AddressInputError, AddressPendingError, AddressUnavailableError, addressErrorMessage } from './address_errors.js';

describe('addressErrorMessage', () => {
  test('待ち時間切れには、構築が裏で続いているので再実行すればよいことを添える', () => {
    const message = addressErrorMessage(new AddressPendingError('postal'));
    expect(message).toContain('address data pending: postal');
    expect(message).toContain('再実行');
  });

  test('それ以外の例外は、メッセージをそのまま返す', () => {
    expect(addressErrorMessage(new AddressInputError('郵便番号は 7 桁'))).toBe('郵便番号は 7 桁');
    expect(addressErrorMessage(new AddressUnavailableError('HTTP 403', true, 'master'))).toBe('HTTP 403');
    expect(addressErrorMessage(new AddressDisabledError())).toContain('SORA_ADDRESS=off');
    expect(addressErrorMessage('boom')).toBe('boom');
  });
});
