import { expect, test } from '@playwright/test';
import {
  cancelInfoChecks,
  mappingChecks,
  maskingChecks,
  merchantWebhookChecks,
  paymentInfoChecks,
  pspWebhookChecks,
} from '@helpers/psp-compliance';
import { evaluatePspFieldChecks } from '@helpers/psp-field-checks';
import type { BankTransaction } from '@schemas/backoffice.schema';

const PAN = '4000000000002701';

/** Shape of a Paysafe payfac record as stored by PGS (values invented). */
const bank = (overrides: Partial<BankTransaction> = {}): BankTransaction => ({
  orderId: 'pid-1',
  paymentTransId: 'txn-1',
  paymentInfo: {
    merchantRefNum: 'pid-1',
    amount: 1000,
    currencyCode: 'EUR',
    profile: { firstName: 'Maria', lastName: 'Lopez', email: '***' },
    billingDetails: {
      zip: '1010',
      country: 'AT',
      city: 'Vienna',
      street: 'Main Street 1',
      state: 'NA',
    },
    paymentFacilitator: { subMerchant: { email: 'shop@example.com', phone: '***' } },
    card: {
      cardNum: '***',
      cvv: '***',
      holderName: 'Maria Lopez',
      cardExpiry: { month: '***', year: '***' },
    },
  },
  response: [
    {
      status: 'COMPLETED',
      card: { lastDigits: '2701', cardExpiry: { month: '***', year: '***' } },
    },
  ],
  ...overrides,
});

const request = {
  client: {
    full_name: 'Maria Lopez',
    email: 'maria@example.com',
    street_address: 'Main Street 1',
    city: 'Vienna',
    zip_code: '1010',
    country: 'AT',
  },
};

test.describe('PSP compliance checks', () => {
  test('masked Paysafe record passes; merchant e-mail and holder name become notes', () => {
    const result = maskingChecks(bank(), { number: PAN });
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.checks.map((c) => c.actual)).toEqual([
      'masked at 1 place(s)',
      'masked at 1 place(s)',
      'masked at 4 place(s)',
      'masked at 1 place(s)',
      'not sent to the PSP',
    ]);
    expect(result.notes.join(' | ')).toContain('Merchant e-mail stored in clear');
    expect(result.notes.join(' | ')).toContain(
      'Cardholder name stored in clear at paymentInfo.card.holderName',
    );
  });

  test('clear card data is reported by path, never by value', () => {
    const leaky = bank({
      cancelInfo: {
        card: { number: PAN, cvv: '123', expiry_month: '12', expiry_year: '2030' },
        customer: { email: 'maria@example.com', phone: '+43 660 1234567' },
      },
      allOtherRequest: [JSON.stringify({ note: `retry for ${PAN}` })],
    });
    const failed = maskingChecks(leaky, { number: PAN }).checks.filter((c) => !c.passed);
    expect(failed.map((c) => c.name)).toEqual([
      'Card number masked in PSP logs',
      'CVV masked in PSP logs',
      'Card expiry masked in PSP logs',
      'E-mail masked in PSP logs',
      'Phone masked in PSP logs',
    ]);
    expect(failed[0]?.actual).toBe('IN CLEAR at cancelInfo.card.number, allOtherRequest[0].note');
    expect(JSON.stringify(failed)).not.toContain(PAN);
    expect(JSON.stringify(failed)).not.toContain('maria@example.com');
  });

  test('purchase fields are mapped to the PSP request', () => {
    const ok = mappingChecks(request, bank(), 'pid-1');
    expect(ok.checks.filter((c) => !c.passed)).toEqual([]);
    expect(ok.checks.map((c) => c.name)).toEqual([
      'Mapping: purchase ID sent to PSP',
      'Mapping: First name',
      'Mapping: Last name',
      'Mapping: E-mail',
      'Mapping: Street',
      'Mapping: City',
      'Mapping: Zip code',
      'Mapping: Country',
    ]);
    const wrong = mappingChecks({ client: { ...request.client, city: 'Graz' } }, bank(), 'pid-1');
    expect(wrong.checks.find((c) => c.name === 'Mapping: City')).toMatchObject({
      passed: false,
      actual: 'paymentInfo.billingDetails.city="Vienna"',
    });
  });

  test('paymentInfo amount (minor units) and currency; empty paymentInfo fails', () => {
    expect(paymentInfoChecks(bank(), 10, 'EUR').checks.every((c) => c.passed)).toBe(true);
    expect(
      paymentInfoChecks(bank(), 12, 'EUR').checks.find(
        (c) => c.name === 'Mapping: amount in PSP request',
      )?.passed,
    ).toBe(false);
    expect(paymentInfoChecks(bank({ paymentInfo: {} }), 10, 'EUR').checks[0]?.passed).toBe(false);
  });

  test('refund request must be in cancelInfo', () => {
    expect(cancelInfoChecks(bank(), 3).checks[0]?.passed).toBe(false);
    const refund = cancelInfoChecks(
      bank({ cancelInfo: { amount: 300, merchantRefNum: 'pid-1' } }),
      3,
    );
    expect(refund.checks.map((c) => c.passed)).toEqual([true, true]);
  });

  test('merchant webhook out and PSP webhook in', () => {
    const out = merchantWebhookChecks(
      [
        {
          transactionStatus: 'paid',
          callback_url: 'https://cb.example.com/',
          callStatus: 'Fail-405',
        },
      ],
      { status: 'PAID', callbackUrl: 'https://cb.example.com/' },
    );
    expect(out.checks.map((c) => c.passed)).toEqual([true, true]);
    expect(out.notes[0]).toContain('Fail-405');
    expect(merchantWebhookChecks([], { status: 'partial_refunded' }).checks[0]).toMatchObject({
      passed: false,
      actual: 'no webhook sent',
    });
    expect(pspWebhookChecks([]).checks).toEqual([]);
    expect(
      pspWebhookChecks([{ pspName: 'x', status: 'zombied', receiveTime: '' }]).checks[0]?.passed,
    ).toBe(false);
  });

  test('sheet check "masked"', () => {
    const results = evaluatePspFieldChecks(
      bank(),
      [
        { source: 'request', field: 'card.cvv', check: 'masked', value: '' },
        { source: 'request', field: 'card.holderName', check: 'masked', value: '' },
        { source: 'request', field: 'card.pin', check: 'masked', value: '' },
      ],
      {},
    );
    expect(results.map((r) => r.passed)).toEqual([true, false, false]);
  });
});
