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
