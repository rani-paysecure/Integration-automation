import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  expectedRefundUpto,
  journalAdd,
  journalRemove,
  otherCurrency,
  otherScheme,
  readJournal,
  safeMessage,
  scalar,
} from '../../src/helpers/bank-config-flow';
import { categoryOf } from '../../src/reporters/report-classification';

test.describe('bank & MID configuration helpers', () => {
  test('refund window: paid + days − 1 h, 0 when not refundable', () => {
    expect(expectedRefundUpto(1_000_000, 180)).toBe(1_000_000 + 180 * 86_400 - 3_600);
    expect(expectedRefundUpto(1_000_000, 0)).toBe(0);
    expect(expectedRefundUpto(1_000_000, -1)).toBe(0);
  });

  test('other currency / scheme for the negative cases', () => {
    expect(otherCurrency('EUR')).toBe('USD');
    expect(otherCurrency('USD')).toBe('EUR');
    expect(otherCurrency('EUR', 'gbp')).toBe('GBP');
    expect(otherCurrency('EUR', 'EUR')).toBe('USD');
    expect(otherScheme('VISA')).toBe('MASTER');
    expect(otherScheme('MASTERCARD')).toBe('VISA');
  });

  test('refund errors never carry the MID auth key', () => {
    expect(
      safeMessage('PaymentBankMID does not allow partial refund with authkey = abc##def , mid=x'),
    ).toBe('PaymentBankMID does not allow partial refund with authkey = ***');
    expect(safeMessage('Refund can not be initiated')).toBe('Refund can not be initiated');
  });

  test('scalar text', () => {
    expect(scalar(1)).toBe('1');
    expect(scalar('')).toBe('');
    expect(scalar(null)).toBe('');
    expect(scalar({ a: 1 })).toBe('');
  });

  test('journal keeps the first original value per field and clears on restore', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bmj-')), 'journal.json');
    const at = new Date().toISOString();
    journalAdd({ kind: 'mid', bankId: 1, midId: 2, original: { onlyTwoD: 0 }, at }, file);
    journalAdd(
      { kind: 'mid', bankId: 1, midId: 2, original: { onlyTwoD: 1, allowed_curr: 'EUR' }, at },
      file,
    );
    journalAdd({ kind: 'merchant-conversion', merchantId: 9, original: 1, at }, file);
    const entries = readJournal(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'mid',
      original: { onlyTwoD: 0, allowed_curr: 'EUR' },
    });
    for (const entry of entries) journalRemove(entry, file);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('BM cases form their own report category', () => {
    expect(categoryOf('@BM-001')).toBe('bank-config');
  });
});
