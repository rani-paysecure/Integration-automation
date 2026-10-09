import { expect, test } from '@playwright/test';
import {
  CUSTOMER_DATA_RULE_TEXT,
  customerDataRule,
  customerDataVerdict,
  expectsReplacement,
  fieldPaymentVerdict,
  isPspCheckedCase,
  pspFullName,
  type FieldPaymentInput,
} from '@helpers/field-payment-checks';
import { FIELD_PSP_RULE_ANNOTATION, type FieldTestCase } from '@helpers/field-testing';
import { classify } from '../../src/reporters/report-classification';
import type { PspCheck, PspSummary } from '@helpers/psp-validation';
import type { BankTransaction } from '@schemas/backoffice.schema';

const PID = '6ac8cd01d21bd611c7c5f580';

const nameCase = (value: string, expectedResult = 'Accepted'): FieldTestCase => ({
  id: 'FT-026',
  parameter: 'cashier.full_name',
  path: 'client.full_name',
  title: 'Valid full name - 3 parts',
  mutation: { type: 'set', value },
  expectation: 'accepted',
  expectedResult,
});

const purchase = (fullName: string): Record<string, unknown> => ({
  client: { email: 'qa@example.com', country: 'US', full_name: fullName },
  purchase: { currency: 'EUR', total: 10, products: [{ name: 'QA', price: 10 }] },
});

const summary = (checks: PspCheck[], extra: Partial<PspSummary> = {}): PspSummary => ({
  purchaseId: PID,
  purchaseStatus: 'ERROR',
  merchant: 'Merchant',
  paymentMethod: 'VISA',
  attempted: true,
  txnId: PID,
  bankName: 'Bank',
  midName: 'MID',
  purchaseAmount: '10',
  purchaseCurrency: 'EUR',
  pspAmount: '10',
  pspCurrency: 'EUR',
  pspStatus: 'AUTHENTICATION_UNSUCCESSFUL',
  gatewayCode: '',
  gatewayMessage: '',
  errorMessage: 'DECLINED',
  checks,
  notes: [],
  ...extra,
});

const purchaseIdNotMapped: PspCheck = {
  name: 'Mapping: purchase ID sent to PSP',
  passed: false,
  expected: `a request field carries ${PID}`,
  actual: 'not found',
};

const input = (over: Partial<FieldPaymentInput>): FieldPaymentInput => ({
  testCase: nameCase('madika sharma testing'),
  request: purchase('madika sharma testing'),
  created: purchase('madika sharma testing'),
  stored: purchase('madika sharma testing'),
  psp: summary([purchaseIdNotMapped]),
  bank: { allOtherRequest: [{ amount: 1000, currency: 'EUR' }] },
  finalStatus: 'ERROR',
  cashierOutcome: 'failure-redirect',
  ...over,
});

test.describe('Field validation – verdict of a paid case', () => {
  test('FT-026: correct name passes although the payment was declined and the purchase ID was not mapped', () => {
    const verdict = fieldPaymentVerdict(input({}));
    expect(verdict.checks.map((c) => [c.name, c.passed])).toEqual([
      ['API response: client.full_name', true],
      ['Stored purchase: client.full_name', true],
    ]);
    expect(verdict.unverifiable).toBe(false);
    expect(verdict.info).toContain(
      'PSP request: no name field (this PSP does not take the customer name)',
    );
    expect(verdict.separate[0]).toContain('final status ERROR (AUTHENTICATION_UNSUCCESSFUL');
    expect(verdict.separate[1]).toContain('Mapping: purchase ID sent to PSP');
  });

  test('name sent to the PSP in parts must be complete', () => {
    const complete: BankTransaction = {
      paymentInfo: { billing: { firstName: 'madika', middleName: 'sharma', lastName: 'testing' } },
    };
    const ok = fieldPaymentVerdict(input({ bank: complete }));
    expect(ok.checks.find((c) => c.name === 'PSP request: full name')?.passed).toBe(true);

    const truncated: BankTransaction = {
      paymentInfo: { billing: { firstName: 'madika', lastName: 'testing' } },
    };
    const bad = fieldPaymentVerdict(input({ bank: truncated }));
    const check = bad.checks.find((c) => c.name === 'PSP request: full name');
    expect(check?.passed).toBe(false);
    expect(check?.actual).toContain('"madika testing"');
  });

  test('middle name carried inside the first-name field counts as complete', () => {
    const bank: BankTransaction = {
      paymentInfo: { customer: { firstName: 'madika sharma', lastName: 'testing' } },
    };
    expect(pspFullName(bank)?.value).toBe('madika sharma testing');
    const verdict = fieldPaymentVerdict(input({ bank }));
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  test('a changed name in the API response or stored purchase fails the case', () => {
    const verdict = fieldPaymentVerdict(input({ stored: purchase('madika sharma') }));
    expect(verdict.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      'Stored purchase: client.full_name',
    ]);
  });

  test('merchant name in the PSP request is not taken for the customer name', () => {
    const bank: BankTransaction = {
      paymentInfo: { merchant: { firstName: 'Shop' }, customer: { lastName: 'testing' } },
    };
    expect(pspFullName(bank)?.value).toBe('testing');
  });

  test('placeholders are expected to be replaced at the PSP', () => {
    for (const value of ['NA', 'na', 'Na', 'nA', 'n/a', 'N/A', ' NA ']) {
      expect(expectsReplacement(nameCase(value))).toBe(true);
    }
    expect(expectsReplacement(nameCase('madika'))).toBe(false);
    expect(
      expectsReplacement(nameCase('madika', 'Accepted; NA replaced with DB default value')),
    ).toBe(true);

    const replaced = fieldPaymentVerdict(
      input({
        testCase: nameCase('NA'),
        request: purchase('NA'),
        bank: { paymentInfo: { customer: { firstName: 'John', lastName: 'Doe' } } },
      }),
    );
    expect(replaced.checks.map((c) => [c.name, c.passed])).toEqual([
      ['PSP request: full_name not passed as "NA"', true],
    ]);

    const notReplaced = fieldPaymentVerdict(
      input({
        testCase: nameCase('n/a'),
        request: purchase('n/a'),
        bank: { paymentInfo: { customer: { firstName: 'n/a', lastName: 'Doe' } } },
      }),
    );
    expect(notReplaced.checks[0]).toMatchObject({
      passed: false,
      actual: 'paymentInfo.customer.firstName="n/a"',
    });
  });

  test('null / empty / not sent customer fields must not reach the PSP empty', () => {
    const phoneCase = (mutation: FieldTestCase['mutation']): FieldTestCase => ({
      ...nameCase(''),
      id: 'FV-100',
      parameter: 'client.phone',
      path: 'client.phone',
      mutation,
    });
    const filled = fieldPaymentVerdict(
      input({
        testCase: phoneCase({ type: 'set', value: null }),
        bank: { paymentInfo: { customer: { phone: '+15550100200' } } },
      }),
    );
    expect(filled.checks.map((c) => [c.name, c.passed])).toEqual([
      ['PSP request: phone not passed as null', true],
    ]);
    const leaked = fieldPaymentVerdict(
      input({
        testCase: phoneCase({ type: 'remove' }),
        bank: { paymentInfo: { customer: { phone: '' } } },
      }),
    );
    expect(leaked.checks[0]?.passed).toBe(false);
    const notTaken = fieldPaymentVerdict(
      input({ testCase: phoneCase({ type: 'set', value: '' }) }),
    );
    expect(notTaken.unverifiable).toBe(true);
    expect(notTaken.info).toContain('PSP request: no phone field (this PSP does not take it)');
  });

  test('PSP response is recorded as remarks with PASSED / FAILED', () => {
    expect(fieldPaymentVerdict(input({})).pspResponse).toBe(
      'PSP answered status AUTHENTICATION_UNSUCCESSFUL · PGS error DECLINED – final status ERROR, cashier failure-redirect → payment FAILED',
    );
    expect(
      fieldPaymentVerdict(
        input({
          finalStatus: 'PAID',
          cashierOutcome: 'success-redirect',
          psp: summary([], { pspStatus: 'COMPLETED', errorMessage: '' }),
        }),
      ).pspResponse,
    ).toBe(
      'PSP answered status COMPLETED – final status PAID, cashier success-redirect → payment PASSED',
    );
  });

  test('a customer field found nowhere is unverifiable (OBSERVED), not failed', () => {
    const verdict = fieldPaymentVerdict(input({ created: {}, stored: {} }));
    expect(verdict.checks).toEqual([]);
    expect(verdict.unverifiable).toBe(true);
  });

  test('amount fields use the amount checks; other failed checks are reported only', () => {
    const verdict = fieldPaymentVerdict(
      input({
        testCase: {
          id: 'FV-001',
          parameter: 'purchase.products.price',
          path: 'purchase.products.0.price',
          title: 'Price 10.23',
          mutation: { type: 'set', value: 10.23 },
          expectation: 'accepted',
          expectedResult: 'Accepted',
        },
        psp: summary([
          { name: 'Amount sent to PSP', passed: true, expected: '10.23', actual: '10.23' },
          purchaseIdNotMapped,
        ]),
      }),
    );
    expect(verdict.checks.map((c) => c.name)).toEqual(['Amount sent to PSP']);
    expect(verdict.info).toContain('PSP request: amount in PSP request not sent – not compared');
    expect(verdict.separate.some((s) => s.startsWith('Mapping: purchase ID'))).toBe(true);
    expect(verdict.unverifiable).toBe(false);
  });

  test('a paid case lists no payment problem', () => {
    const verdict = fieldPaymentVerdict(
      input({ finalStatus: 'PAID', cashierOutcome: 'success-redirect', psp: summary([]) }),
    );
    expect(verdict.separate).toEqual([]);
  });
});

test.describe('Field validation › customer data at the PSP', () => {
  const custom = (
    path: string,
    mutation: FieldTestCase['mutation'],
    expectation: FieldTestCase['expectation'],
    expectedResult = 'Validation error',
  ): FieldTestCase => ({
    id: 'FT-030',
    parameter: path,
    path,
    title: 't',
    mutation,
    expectation,
    expectedResult,
  });

  test('only customer fields the API does not validate are judged at the PSP', () => {
    for (const path of [
      'client.full_name',
      'client.city',
      'client.street_address',
      'client.phone',
    ]) {
      expect(isPspCheckedCase({ path }), path).toBe(true);
    }
    for (const path of ['client.email', 'client.country', 'purchase.currency', 'brand_id']) {
      expect(isPspCheckedCase({ path }), path).toBe(false);
    }
  });

  test('rule per case: FT-030 spaces must not pass, FT-036 digits are recorded', () => {
    const name = 'client.full_name';
    expect(customerDataRule(custom(name, { type: 'set', value: '     ' }, 'rejected'))).toBe(
      'not-passed',
    );
    expect(customerDataRule(custom(name, { type: 'set', value: '12345' }, 'rejected'))).toBe(
      'record',
    );
    expect(
      customerDataRule(
        custom(
          name,
          { type: 'set', value: 'NA' },
          'accepted',
          'Accepted; NA replaced with DB default value',
        ),
      ),
    ).toBe('not-passed');
    expect(customerDataRule(custom(name, { type: 'remove' }, 'observe'))).toBe('not-passed');
    expect(
      customerDataRule(custom(name, { type: 'set', value: 'madika' }, 'accepted', 'Accepted')),
    ).toBe('unchanged');
    expect(
      customerDataRule(
        custom(name, { type: 'set', value: '<script>alert(1)</script>' }, 'sanitized'),
      ),
    ).toBe('sanitized');
  });

  test('recorded case: what the PSP got and its answer, nothing asserted', () => {
    const verdict = customerDataVerdict(
      input({
        testCase: custom('client.full_name', { type: 'set', value: '12345' }, 'rejected'),
        request: purchase('12345'),
        bank: { paymentInfo: { customer: { firstName: '12345' } } },
      }),
    );
    expect(verdict).toMatchObject({ rule: 'record', recordOnly: true, checks: [] });
    expect(verdict.sentToPsp).toBe('paymentInfo.customer.firstName="12345"');
    expect(verdict.pspResponse).toContain('→ payment FAILED');
  });

  test('injection: raw input reaching the PSP fails, a cleaned value passes', () => {
    const script = '<script>alert(1)</script>';
    const testCase = custom('client.city', { type: 'set', value: script }, 'sanitized');
    const leaked = customerDataVerdict(
      input({ testCase, bank: { paymentInfo: { billing: { city: script } } } }),
    );
    expect(leaked.checks[0]?.passed).toBe(false);
    const cleaned = customerDataVerdict(
      input({ testCase, bank: { paymentInfo: { billing: { city: 'Springfield' } } } }),
    );
    expect(cleaned.checks[0]?.passed).toBe(true);
  });

  test('report shows the sub-category, its rule and polarity', () => {
    const fieldCase = {
      id: 'FT-030',
      parameter: 'cashier.full_name',
      title: 'Only spaces',
      testData: '"     "',
      expectation: 'rejected' as const,
      expectedResult: 'Validation error',
      note: '',
    };
    const report = (rule: string) =>
      classify({
        key: '@FT-030',
        values: { [FIELD_PSP_RULE_ANNOTATION]: rule },
        fieldCase,
        fieldResult: undefined,
        psp: undefined,
        pspFieldChecks: [],
      });
    const notPassed = report(CUSTOMER_DATA_RULE_TEXT['not-passed']);
    expect(notPassed.categoryLabel).toBe('Field validation › Customer data at PSP');
    expect(notPassed.polarity).toBe('negative');
    expect(notPassed.expectedItems.find((i) => i.label === 'Rule')?.value).toBe(
      CUSTOMER_DATA_RULE_TEXT['not-passed'],
    );
    expect(report(CUSTOMER_DATA_RULE_TEXT.unchanged).polarity).toBe('positive');
    expect(report(CUSTOMER_DATA_RULE_TEXT.record).polarity).toBe('neutral');
  });
});
