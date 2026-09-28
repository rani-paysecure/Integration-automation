import { expect, test } from '@playwright/test';
import { maskSensitiveData, maskString, maskUrl } from '@utils/masking';

test.describe('Sensitive data masking', () => {
  test('masks credentials, payment data and PII in nested objects', () => {
    const input = {
      client_secret: 's3cr3t',
      headers: { Authorization: 'Bearer abc.def', 'x-api-key': 'key-123' },
      paymentMethod: {
        card: { cardNumber: '4111111111111111', cvv: '123', expiryYear: '2030', holderName: 'A B' },
      },
      customer: { email: 'jane.doe@example.com', phone: '+15555550100' },
      items: [{ password: 'pw' }],
      amount: 1000,
    };

    const masked = maskSensitiveData(input);

    expect(masked).toEqual({
      client_secret: '***',
      headers: { Authorization: '***', 'x-api-key': '***' },
      paymentMethod: {
        card: { cardNumber: '***1111', cvv: '***', expiryYear: '***', holderName: 'A B' },
      },
      customer: { email: 'j***@example.com', phone: '***0100' },
      items: [{ password: '***' }],
      amount: 1000,
    });
    // original untouched
    expect(input.client_secret).toBe('s3cr3t');
  });

  test('masks card numbers and bearer tokens inside free text', () => {
    expect(maskString('card 4111 1111 1111 1111 declined')).toBe('card ***1111 declined');
    expect(maskString('Authorization: Bearer eyJhbGciOi.xyz')).toBe('Authorization: Bearer ***');
  });

  test('does not mask ordinary long numbers that fail Luhn', () => {
    expect(maskString('order 1727500000001')).toBe('order 1727500000001');
  });

  test('masks sensitive query parameters', () => {
    expect(maskUrl('https://qa.example.com/x?api_key=abc&page=2')).toBe(
      'https://qa.example.com/x?api_key=***&page=2',
    );
  });
});
