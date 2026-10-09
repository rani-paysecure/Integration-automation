import { expect, test } from '@playwright/test';
import { parseKeyList } from '@clients/backoffice-client';
import { serviceConfigMaskingChecks } from '@helpers/psp-compliance';
import { summarizePsp } from '@helpers/psp-validation';
import type { BackofficeTransaction, BankTransaction } from '@schemas/backoffice.schema';

/** Excerpt of COMMON_GATEWAY_BLACKLISTED_LOGGING_KEYS as the dashboard returns it. */
const KEYS = ['cvv', 'expiry_month', 'email', 'ipAddress', 'cardNumber', 'phoneNo', 'merchantCode'];

const bank = {
  bankName: 'paysafe_payfac',
  paymentInfo: {},
  allOtherRequest: [
    {
      card: { cardNumber: '***', cvv: '***', expiry_month: '12' },
      profile: { email: '***', Email: 'n@example.com' },
      customerIp: '110.235.229.154',
      ipAddress: '110.235.229.154',
    },
  ],
  response: [{ card: { cardNumber: '4111********1111' } }],
} as unknown as BankTransaction;

test.describe('service config masking keys (COMMON_GATEWAY_BLACKLISTED_LOGGING_KEYS)', () => {
  test('the value is read as a list, stray commas tolerated like PGS', () => {
    expect(parseKeyList(['cvv', 'email', 'cvv', ' '])).toEqual(['cvv', 'email']);
    expect(parseKeyList('[,"cvv","expMonth",]')).toEqual(['cvv', 'expMonth']);
    expect(() => parseKeyList("Config not approved or doesn't exist")).toThrow(
      /Config not approved/,
    );
  });

  test('every listed field in the PSP record must be masked – exact, case-sensitive names', () => {
    const { checks } = serviceConfigMaskingChecks(bank, KEYS);
    expect(checks.map((c) => [c.name, c.passed, c.actual])).toEqual([
      ['Masking · Service config · cardNumber', true, 'masked at 2 place(s)'],
      ['Masking · Service config · cvv', true, 'masked at 1 place(s)'],
      ['Masking · Service config · email', true, 'masked at 1 place(s)'],
      [
        'Masking · Service config · expiry_month',
        false,
        'NOT MASKED – expiry_month is readable at allOtherRequest[0].card.expiry_month',
      ],
      [
        'Masking · Service config · ipAddress',
        false,
        'NOT MASKED – ipAddress is readable at allOtherRequest[0].ipAddress',
      ],
    ]);
    // "Email" (other case) and "customerIp" are not listed → not checked, as in PGS.
    expect(serviceConfigMaskingChecks(bank, ['notThere']).checks[0]?.actual).toBe(
      "none of the 1 listed names is in this PSP's requests / responses",
    );
  });

  test('PSP checks: unreadable config becomes a warning, not a failure', () => {
    const trx = {
      status: 'PAID',
      purchase: { currency: 'EUR', total: 10 },
      transaction_data: { attempts: [] },
    } as unknown as BackofficeTransaction;
    const summary = summarizePsp('pid-1', trx, bank, {
      pspChecks: true,
      serviceMaskingKeys: new Error('HTTP 403'),
    });
    expect(summary.notes.join(' | ')).toContain(
      'Warning: service config COMMON_GATEWAY_BLACKLISTED_LOGGING_KEYS could not be read (HTTP 403)',
    );
  });
});
