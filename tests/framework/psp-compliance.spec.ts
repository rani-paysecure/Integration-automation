import { expect, test } from '@playwright/test';
import {
  cancelInfoChecks,
  mappingChecks,
  DEFAULT_MASKING_RULES,
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
    expect(result.checks.map((c) => [c.name, c.actual])).toEqual([
      ['Masking · General – customer contact data · E-mail', 'masked at 1 place(s)'],
      [
        'Masking · General – customer contact data · Phone number',
        'masked at 1 place(s) (merchant / sub-merchant block) · no customer phone number sent to the PSP',
      ],
      [
        'Masking · Card payments – card details · Card number',
        'masked at 1 place(s) · sent value not readable anywhere',
      ],
      ['Masking · Card payments – card details · CVV', 'masked at 1 place(s)'],
      ['Masking · Card payments – card details · Expiry date', 'masked at 4 place(s)'],
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
      'Masking · General – customer contact data · E-mail',
      'Masking · General – customer contact data · Phone number',
      'Masking · Card payments – card details · Card number',
      'Masking · Card payments – card details · CVV',
      'Masking · Card payments – card details · Expiry date',
    ]);
    expect(failed.find((c) => c.name.endsWith('Card number'))?.actual).toBe(
      'NOT MASKED – Card number is readable at cancelInfo.card.number, allOtherRequest[0].note (by key and found by the value the test sent)',
    );
    expect(JSON.stringify(failed)).not.toContain(PAN);
    expect(JSON.stringify(failed)).not.toContain('maria@example.com');
  });

  test('masking rules apply by payment method: bank transfer, custom keys, disabled rules', () => {
    const record = bank({
      paymentInfo: {
        customer: { email: '***', phone: '***', dateOfBirth: '1990-01-01' },
        bankAccount: { accountNumber: '12345678', iban: 'AT611904300234573201', sort_code: '***' },
        upiId: 'maria@okbank',
      },
      response: [],
    });
    const rules = [
      ...DEFAULT_MASKING_RULES,
      {
        id: 'upi',
        name: 'UPI',
        scope: 'methods' as const,
        methods: ['UPI'],
        fields: [],
        customKeys: ['upi_id'],
        enabled: true,
      },
      {
        id: 'identity',
        name: 'Identity',
        scope: 'all' as const,
        methods: [],
        fields: ['dateOfBirth'],
        customKeys: [],
        enabled: false,
      },
    ];
    const transfer = maskingChecks(record, undefined, { paymentMethod: 'banktransfer', rules });
    expect(transfer.checks.map((c) => [c.name, c.passed])).toEqual([
      ['Masking · General – customer contact data · E-mail', true],
      ['Masking · General – customer contact data · Phone number', true],
      ['Masking · Bank transfer – bank details · Bank account number', false],
      ['Masking · Bank transfer – bank details · IBAN', false],
      ['Masking · Bank transfer – bank details · Routing number / sort code', true],
    ]);
    expect(JSON.stringify(transfer)).not.toContain('12345678');
    const upi = maskingChecks(record, undefined, { paymentMethod: 'UPI', rules });
    expect(upi.checks.map((c) => [c.name, c.actual])).toEqual([
      ['Masking · General – customer contact data · E-mail', 'masked at 1 place(s)'],
      ['Masking · General – customer contact data · Phone number', 'masked at 1 place(s)'],
      ['Masking · UPI · upi_id', 'NOT MASKED – upi_id is readable at paymentInfo.upiId'],
    ]);
    const none = maskingChecks(record, undefined, {
      paymentMethod: 'PAYID',
      rules: rules.slice(2),
    });
    expect(none.checks).toEqual([]);
    expect(none.notes).toEqual(['No masking rule applies to payment method PAYID']);
  });

  test('values the test sent are found under any key, in form-encoded and XML payloads', () => {
    const card = { number: PAN, cvv: '737', expiry: '12/30' };
    const request = {
      client: { email: 'maria@example.com', phone: '+43 660 1234567' },
      extraParam: { accountNumber: '9876543210' },
    };
    const leaky = bank({
      paymentInfo: {},
      // PSP-specific key names, form-encoded: sc = CVV, pan_no = PAN, ed = expiry, contact = e-mail
      allOtherRequest: [`pan_no=${PAN}&sc=737&ed=1230&contact=maria%40example.com&amount=737`],
      response: [
        '<resp><cust><tel>436601234567</tel></cust><acc_ref>9876543210</acc_ref><total>737</total></resp>',
      ],
    });
    const rules = [
      ...DEFAULT_MASKING_RULES,
      {
        id: 'bank',
        name: 'Bank',
        scope: 'all' as const,
        methods: [],
        fields: ['accountNumber'],
        customKeys: [],
        enabled: true,
      },
    ];
    const result = maskingChecks(leaky, { card, request }, { paymentMethod: 'VISA', rules });
    const actual: Record<string, string> = Object.fromEntries(
      result.checks.map((c): [string, string] => [c.name.split(' · ').at(-1) ?? c.name, c.actual]),
    );
    expect(actual).toEqual({
      'E-mail':
        'NOT MASKED – E-mail is readable at allOtherRequest[0].contact (found by the value the test sent)',
      'Phone number':
        'NOT MASKED – Phone number is readable at response[0].tel (found by the value the test sent)',
      'Card number':
        'NOT MASKED – Card number is readable at allOtherRequest[0].pan_no (found by the value the test sent)',
      // amount=737 and <total>737</total> are not taken for the CVV
      CVV: 'NOT MASKED – CVV is readable at allOtherRequest[0].sc (found by the value the test sent)',
      'Expiry date':
        'NOT MASKED – Expiry date is readable at allOtherRequest[0].ed (found by the value the test sent)',
      'Bank account number':
        'NOT MASKED – Bank account number is readable at response[0].acc_ref (found by the value the test sent)',
    });
    for (const secret of [PAN, '737', 'maria@example.com', '9876543210', '1234567'])
      expect(JSON.stringify(result)).not.toContain(secret);

    // Same payloads masked → passes, and the sent values are confirmed unreadable.
    const masked = bank({
      paymentInfo: {},
      allOtherRequest: ['pan_no=400000******2701&sc=***&ed=****&contact=m***%40example.com'],
      response: ['<resp><cust><tel>43660***567</tel></cust></resp>'],
    });
    const ok = maskingChecks(masked, { card, request }, { paymentMethod: 'VISA' });
    expect(ok.checks.filter((c) => !c.passed)).toEqual([]);
    expect(ok.checks.find((c) => c.name.endsWith('CVV'))?.actual).toBe(
      'not sent to the PSP (sent value searched in every request / response)',
    );
  });

  test('a field neither found by key nor by value is reported as "could not verify"', () => {
    const result = maskingChecks(bank({ paymentInfo: { x1: 'abc' }, response: [] }), undefined, {
      paymentMethod: 'VISA',
      isCard: false,
    });
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.checks.map((c) => c.actual)).toEqual([
      'could not verify – no field with a known key name, and the value is not known to the test',
      'could not verify – no field with a known key name, and the value is not known to the test',
    ]);
    expect(result.notes.join(' | ')).toContain(
      'Warning: masking could not be verified for E-mail, Phone number',
    );
  });

  test('paymentInfo empty: masking is checked in allOtherRequest (masked sub-merchant phone, session customer)', () => {
    const record = bank({
      paymentInfo: {},
      allOtherRequest: [
        {
          paymentFacilitator: { subMerchant: { name: 'Shop', phone: '***', email: '***' } },
          profile: { firstName: 'Nitendra', email: '***' },
        },
      ],
      response: [],
    });
    const noValues = maskingChecks(record, undefined, { paymentMethod: 'VISA', isCard: false });
    expect(noValues.checks.every((c) => c.passed)).toBe(true);
    expect(noValues.checks.map((c) => c.actual)).toEqual([
      'masked at 1 place(s)',
      'masked at 1 place(s) (merchant / sub-merchant block) · no customer phone number sent to the PSP',
    ]);
    expect(noValues.notes.join(' | ')).not.toContain('could not be verified');

    // The session customer's phone is known → searched by value in allOtherRequest as well.
    const leaked = bank({
      paymentInfo: {},
      allOtherRequest: [{ profile: { mobileNo: '+447700900123' } }],
      response: [],
    });
    const result = maskingChecks(
      leaked,
      { request: { customer: { phone: '+447700900123' } } },
      { paymentMethod: 'VISA', isCard: false },
    );
    const phone = result.checks.find((c) => c.name.endsWith('Phone number'));
    expect(phone?.passed).toBe(false);
    expect(phone?.actual).toContain('allOtherRequest[0].profile.mobileNo');
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

  test('payment request only in allOtherRequest: checked there, paymentInfo missing is a warning', () => {
    const otherOnly = bank({
      paymentInfo: {},
      allOtherRequest: [
        JSON.stringify({ orderId: 'pid-1', amount: '10.00', currency: 'EUR', email: '***' }),
        JSON.stringify({ action: 'status', orderId: 'pid-1' }),
      ],
    });
    const info = paymentInfoChecks(otherOnly, 10, 'EUR');
    expect(info.checks.map((c) => [c.name, c.passed])).toEqual([
      ['PSP request recorded (paymentInfo / allOtherRequest)', true],
      ['Mapping: amount in PSP request', true],
      ['Mapping: currency in PSP request', true],
    ]);
    expect(info.checks[0]?.actual).toBe('paymentInfo: missing · allOtherRequest: 6 field(s)');
    expect(info.notes[0]).toContain('Warning: paymentInfo is missing');
    const mapping = mappingChecks(request, otherOnly, 'pid-1');
    expect(mapping.checks.find((c) => c.name === 'Mapping: purchase ID sent to PSP')?.passed).toBe(
      true,
    );
    // Both present → both are used, no warning.
    expect(
      paymentInfoChecks(bank({ allOtherRequest: [JSON.stringify({ step: 2 })] }), 10, 'EUR').notes,
    ).toEqual([]);
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
    // Received is what counts – a webhook the redirect / sync answer made redundant stays unconsumed.
    const zombied = pspWebhookChecks([{ pspName: 'x', status: 'zombied', receiveTime: '' }]);
    expect(zombied.checks[0]?.passed).toBe(true);
    expect(zombied.notes[0]).toContain('Warning: no PSP webhook was consumed (x: zombied)');
    // One webhook per bank config on the PSP side: the bank of the purchase consumes, the other zombies.
    const twoConfigs = pspWebhookChecks([
      { pspName: 'trustpayment-json', status: 'zombied', receiveTime: '' },
      { pspName: 'trustpayments-card-json', status: 'consumed', receiveTime: '' },
    ]);
    expect(twoConfigs.checks.map((c) => [c.name, c.passed, c.actual])).toEqual([
      [
        'PSP webhook received (Webhook in)',
        true,
        'PSP webhook log: trustpayment-json: zombied, trustpayments-card-json: consumed',
      ],
      [
        'PSP webhook consumed by the matching bank config',
        true,
        'trustpayments-card-json: consumed',
      ],
    ]);
    expect(twoConfigs.notes).toHaveLength(1);
    expect(twoConfigs.notes[0]).toContain('Other PSP webhook config(s) zombied – expected');
    expect(twoConfigs.notes[0]).not.toMatch(/^warning/i);
    const fromLog = pspWebhookChecks([], 2);
    expect(fromLog.checks[0]).toMatchObject({ passed: true });
    expect(fromLog.checks[0]?.actual).toContain('2× webhook:IN');
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
