import { expect, test } from '@playwright/test';
import { extractLoginCsrf, extractMetaCsrf, isLoginFailure } from '@clients/backoffice-client';
import { findFirstValue, summarizePsp } from '@helpers/psp-validation';
import type { BackofficeTransaction, BankTransaction } from '@schemas/backoffice.schema';

const trx: BackofficeTransaction = {
  purchaseId: 'pid-1',
  status: 'PAID',
  merchantName: 'Merchant',
  paymentMethod: 'VISA',
  fx_Currency: 'GBP',
  fx_Amount: 89.48,
  purchase: { currency: 'EUR', total: 100.99 },
  transaction_data: { attempts: [{ type: 'execute', successful: true }] },
};

const bank: BankTransaction = {
  orderId: 'pid-1',
  paymentTransId: 'txn-123',
  bankName: 'Bank',
  midName: 'MID-1',
  currency: 'GBP',
  amt: 89.48,
  paymentInfo: { amount: 8948 },
  response: [{ status: 'COMPLETED', gatewayResponse: { responseCode: '00' } }],
};

test.describe('Back-office / PSP validation helpers', () => {
  test('extracts CSRF tokens and detects failed logins', () => {
    expect(extractLoginCsrf('<input type="hidden" name="_csrf" value="abc"/>')).toBe('abc');
    expect(extractMetaCsrf('<meta name="_csrf" content="xyz"/>')).toBe('xyz');
    expect(isLoginFailure('https://test4.example.net/admin')).toBe(false);
    expect(isLoginFailure('https://test4.example.net/?error')).toBe(true);
    expect(isLoginFailure('https://test4.example.net/')).toBe(true);
  });

  test('finds nested PSP values', () => {
    expect(findFirstValue(bank.response, ['responseCode'])).toBe('00');
    expect(findFirstValue({ a: [{ b: { status: 'X' } }] }, ['status'])).toBe('X');
  });

  test('paid purchase with consistent PSP data passes every check', () => {
    const summary = summarizePsp('pid-1', trx, bank);
    expect(summary.txnId).toBe('txn-123');
    expect(summary.pspStatus).toBe('COMPLETED');
    expect(summary.checks.filter((c) => !c.passed)).toEqual([]);
  });

  test('flags amount/currency/reference mismatches', () => {
    const summary = summarizePsp('pid-1', trx, {
      ...bank,
      orderId: 'other',
      amt: 10,
      currency: 'EUR',
    });
    expect(summary.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      'Order reference = purchase ID',
      'Currency sent to PSP',
      'Amount sent to PSP',
    ]);
  });

  test('error purchase: attempt error counts as failure, odd success flag becomes a note', () => {
    const errorTrx: BackofficeTransaction = {
      ...trx,
      status: 'ERROR',
      transaction_data: {
        attempts: [{ type: 'execute', successful: true, error: { message: 'Risk rule failed' } }],
      },
    };
    // pspChecks off: this test is about the attempt flags, not masking.
    const summary = summarizePsp('pid-1', errorTrx, bank, { pspChecks: false });
    expect(summary.checks.find((c) => c.name === 'Error ⇒ last attempt failed')?.passed).toBe(true);
    expect(summary.notes).toEqual([
      'Attempt is flagged successful=true although it failed ("Risk rule failed")',
    ]);
  });

  test('PSP error text comes from the newest answer, also from form-encoded payloads', () => {
    const declined = summarizePsp(
      'pid-1',
      { ...trx, status: 'ERROR' },
      {
        ...bank,
        response: [
          'requesttypedescription=THREEDQUERY&errorcode=0&errormessage=Ok',
          'requesttypedescription=AUTH&errorcode=70000&errormessage=Decline',
        ],
      },
    );
    expect([declined.gatewayCode, declined.gatewayMessage]).toEqual(['70000', 'Decline']);
    const json = summarizePsp(
      'pid-1',
      { ...trx, status: 'ERROR' },
      {
        ...bank,
        response: [
          { status: 'FAILED', error: { code: '3022', message: 'The card has been declined' } },
        ],
      },
    );
    expect([json.gatewayCode, json.gatewayMessage]).toEqual(['3022', 'The card has been declined']);
  });

  test('unpaid purchase without PSP record is "not attempted"', () => {
    const summary = summarizePsp('pid-1', { ...trx, status: 'CREATED' }, undefined);
    expect(summary.attempted).toBe(false);
    expect(summary.checks).toEqual([]);
  });
});
