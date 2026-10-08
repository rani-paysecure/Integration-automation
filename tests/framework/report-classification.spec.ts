import { expect, test } from '@playwright/test';
import {
  categoryOf,
  classify,
  expectedParts,
  outcomeLabel,
} from '../../src/reporters/report-classification';

test.describe('Report classification', () => {
  test('category from the case key', () => {
    expect(categoryOf('@FT-001a')).toBe('field');
    expect(categoryOf('@FV-002')).toBe('field');
    expect(categoryOf('@RX-010')).toBe('regex');
    expect(categoryOf('@PR-001')).toBe('psp');
    expect(categoryOf('@EC-003')).toBe('edge');
    expect(categoryOf('@card-visa')).toBe('card');
    expect(categoryOf('@psp-by-id')).toBe('psp-check');
  });

  test('positive / negative per category', () => {
    const base = { values: {}, fieldResult: undefined, psp: undefined, pspFieldChecks: [] };
    const field = (expectation: 'accepted' | 'rejected' | 'observe') =>
      classify({
        ...base,
        key: '@FT-001',
        fieldCase: {
          id: 'FT-001',
          parameter: 'p',
          title: 't',
          testData: 'x',
          expectation,
          expectedResult: 'r',
          note: '',
        },
      }).polarity;
    expect(field('accepted')).toBe('positive');
    expect(field('rejected')).toBe('negative');
    expect(field('observe')).toBe('neutral');
    const regex = (expected: string) =>
      classify({ ...base, key: '@RX-001', fieldCase: undefined, values: { expected } }).polarity;
    expect(regex('Valid → reaches the PSP unchanged')).toBe('positive');
    expect(regex('Invalid → does not reach the PSP')).toBe('negative');
    const edge = classify({
      ...base,
      key: '@EC-001',
      fieldCase: undefined,
      values: { expected: 'failure-redirect · ERROR' },
    });
    expect(edge.polarity).toBe('negative');
    expect(edge.expectedItems).toEqual([
      { label: 'Cashier', value: 'Failure redirect' },
      { label: 'Final status', value: 'ERROR' },
    ]);
  });

  test('S2S validation: the actual box shows the S2S answer and the purchase status', () => {
    const { actualItems } = classify({
      key: '@S2-003',
      fieldCase: undefined,
      fieldResult: undefined,
      psp: undefined,
      pspFieldChecks: [],
      values: {
        's2s response':
          'HTTP 400 · transaction_error: Invalid Card Expiry(Valid Format:MM/YY) must be greater than or equal to current month/year',
        'purchase status after': 'ERROR',
      },
    });
    expect(actualItems).toEqual([
      { label: 'HTTP', value: '400' },
      { label: 'Result', value: 'transaction_error' },
      {
        label: 'Message',
        value:
          'Invalid Card Expiry(Valid Format:MM/YY) must be greater than or equal to current month/year',
      },
      { label: 'Final status', value: 'ERROR' },
    ]);
  });

  test('PSP notes become named rows: webhook:out, webhook:in, other bank, not sent; warnings not repeated', () => {
    const psp = {
      purchaseId: 'p1',
      purchaseStatus: 'PAID',
      merchant: 'm',
      paymentMethod: 'VISA',
      attempted: true,
      txnId: 't',
      bankName: 'trustpayments-card-json',
      midName: 'mid',
      purchaseAmount: '10',
      purchaseCurrency: 'EUR',
      pspAmount: '10',
      pspCurrency: 'EUR',
      pspStatus: '',
      gatewayCode: '0',
      gatewayMessage: 'Ok',
      errorMessage: '',
      checks: [
        {
          name: 'Merchant webhook sent (paid)',
          passed: true,
          expected: '',
          actual: '1 sent to https://www.google.com/',
        },
        {
          name: 'PSP webhook received (Webhook in)',
          passed: true,
          expected: '',
          actual:
            '2× webhook:IN in Transaction Log · PSP webhook log: trustpayment-json: zombied, trustpayments-card-json: consumed',
        },
      ],
      notes: [
        'Warning: paymentInfo is missing – the payment request was taken from allOtherRequest (this PSP flow stores its API calls there)',
        'Customer fields not sent to the PSP (not in paymentInfo or allOtherRequest): first name, e-mail',
        'Merchant endpoint did not accept the "paid" webhook: Fail-405 (expected with a test callback URL that does not accept POST)',
        'Other PSP webhook config(s) zombied – expected: …',
      ],
    };
    const { actualItems } = classify({
      key: '@card-x',
      fieldCase: undefined,
      fieldResult: undefined,
      pspFieldChecks: [],
      values: {},
      psp,
    });
    expect(actualItems.slice(1)).toEqual([
      {
        label: 'Not sent to PSP',
        value:
          "first name, e-mail – not in paymentInfo or allOtherRequest (this PSP's request does not include them)",
      },
      {
        label: 'Merchant webhook (webhook:out)',
        value:
          'Sent – 1 sent to https://www.google.com/ · merchant URL answered Fail-405 (expected with a test callback URL that does not accept POST)',
      },
      {
        label: 'PSP webhook (webhook:in)',
        value: 'Passed – trustpayments-card-json: Consumed (bank of this transaction)',
      },
      {
        label: "Other bank's webhook",
        value:
          "trustpayment-json: Zombied – posted to another bank's webhook config; it does not belong to this transaction's bank (expected)",
      },
    ]);
  });

  test('readable expectations and outcomes', () => {
    expect(expectedParts('success-redirect, status PAID')).toEqual([
      { label: 'Cashier', value: 'Success redirect' },
      { label: 'Final status', value: 'PAID' },
    ]);
    expect(expectedParts('error contains "3DS"')).toEqual([
      { label: 'Message contains', value: '"3DS"' },
    ]);
    expect(outcomeLabel('failure-redirect (via hosted.test.paysafe.com)')).toBe('Failure redirect');
    expect(outcomeLabel('rejected: Invalid card details')).toBe(
      'Rejected by cashier: Invalid card details',
    );
  });
});
