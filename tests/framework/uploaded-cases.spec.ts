import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { compileBankRule, findSentValue } from '@helpers/bank-regex';
import { evaluatePspFieldChecks, findFieldValues } from '@helpers/psp-field-checks';
import type { BankTransaction } from '@schemas/backoffice.schema';
import { maskSensitiveData } from '@utils/masking';
import {
  loadUploadedEdgeCases,
  loadUploadedFieldCases,
  loadUploadedPspCases,
  loadUploadedRegexCases,
} from '@test-data/uploaded-cases/uploaded-cases';

interface PreviewCase {
  rows: number[];
  data: Record<string, unknown>;
  duplicate: boolean;
  include: boolean;
  issues: string[];
  warnings: string[];
}
interface Importer {
  previewImport(
    category: string,
    buffer: Buffer,
    filename: string,
    cardIds?: string[],
  ): Promise<{ cases: PreviewCase[] }>;
  templateBuffer(category: string, cardIds?: string[]): Promise<ArrayBuffer>;
}
// The importer checks duplicates against saved cases – use an empty folder so saved cases don't matter.
process.env.UPLOADED_CASES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'uploaded-cases-dir-'));
const importer = createRequire(__filename)('../../tools/launcher/test-case-import.js') as Importer;
interface RegexCasesModule {
  casesForBank(
    bank: string,
    rules: Record<string, string>,
  ): {
    rules: { kind: string }[];
    cases: { data: { field: string; value: string; expectation: string } }[];
  };
  bankForMid(mid: string, banks: string[]): string;
}
const regexCases = createRequire(__filename)(
  '../../tools/launcher/regex-cases.js',
) as RegexCasesModule;

const csv = (rows: string[][]): Buffer =>
  Buffer.from(rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(',')).join('\n'));

function writeCases(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploaded-cases-'));
  const file = path.join(dir, 'cases.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test.describe('Uploaded test cases – import', () => {
  test('field validation: values, context and duplicates of built-in cases', async () => {
    const { cases } = await importer.previewImport(
      'field',
      csv([
        ['Parameter', 'Test Case', 'Test Data', 'Expected Result', 'Expectation', 'Context'],
        ['client.email', 'Invalid email format', 'test@', 'Validation error', '', ''],
        [
          'client.zip_code',
          'Letters in US ZIP',
          '12AB5',
          'Validation error',
          '',
          'client.country=US',
        ],
        ['purchase.products.price', 'Three decimals', '10.999', 'Validation error', '', ''],
        ['bogus param', 'x', 'x', 'Accepted', '', ''],
      ]),
      'cases.csv',
    );
    const [email, zip, price, bogus] = cases as [
      PreviewCase,
      PreviewCase,
      PreviewCase,
      PreviewCase,
    ];
    expect(email.duplicate).toBe(true);
    expect(zip.data).toMatchObject({
      path: 'client.zip_code',
      mutation: { type: 'set', value: '12AB5' },
      context: { 'client.country': 'US' },
      expectation: 'rejected',
    });
    expect(zip.include).toBe(true);
    expect(price.data).toMatchObject({ context: { 'purchase.total': 10.999 } });
    expect(bogus.include).toBe(false);
  });

  test('regex validation upload: bank, field, value and optional expectation', async () => {
    const { cases } = await importer.previewImport(
      'regex',
      csv([
        ['Bank', 'Field', 'Test Case', 'Test Data', 'Expected Result'],
        ['paysafe_payfac', 'full_name', 'Digits', 'John123', 'Invalid'],
        ['', 'client.city', 'Digits in city', 'Wien1', ''],
        ['', 'shoe_size', 'Unknown', '42', ''],
        ['', 'city', 'Bad expectation', 'Graz', 'maybe'],
      ]),
      'regex.csv',
    );
    expect(cases[0]?.data).toEqual({
      bank: 'paysafe_payfac',
      field: 'full_name',
      path: 'client.full_name',
      title: 'Digits',
      value: 'John123',
      expectation: 'invalid',
      origin: 'upload',
    });
    expect(cases[1]?.data).toMatchObject({
      field: 'city',
      path: 'client.city',
      expectation: 'auto',
    });
    expect(cases[2]?.issues.join()).toContain('Unknown field');
    expect(cases[3]?.issues.join()).toContain('Valid, Invalid or empty');
  });

  test('regex cases from dashboard rules: values classified by the bank regex', () => {
    const { rules, cases } = regexCases.casesForBank('paywise', {
      full_name: '^(?i)(?!n/?a$|null$).{2,120}$',
      phone: '["IN", "US", "default"]',
      loyalty_id: '^\\d+$',
    });
    expect(rules.map((r) => r.kind)).toEqual(['regex', 'country-list', 'regex']);
    const byValue = new Map(cases.map((c) => [c.data.value, c.data.expectation]));
    expect(byValue.get('John123')).toBe('valid');
    expect(byValue.get('N/A')).toBe('invalid');
    expect(byValue.get('null')).toBe('invalid');
    expect(byValue.get('A'.padEnd(1, 'A'))).toBe('invalid');
    expect([...byValue.values()].filter((v) => v === 'observe').length).toBeGreaterThan(0);
    expect(cases.every((c) => c.data.field !== 'loyalty_id')).toBe(true);
    expect(regexCases.bankForMid('paysafe_payfac_mid', ['paysafe', 'paysafe_payfac'])).toBe(
      'paysafe_payfac',
    );
  });

  test('PSP: rows with the same test case form one transaction', async () => {
    const { cases } = await importer.previewImport(
      'psp',
      csv([
        ['Test Case', 'Card', 'Source', 'PSP Field', 'Check', 'Expected Value'],
        ['Amounts', 'visa-ok', 'Request', 'amount', 'equals', '{amount}'],
        ['Amounts', 'visa-ok', 'Request', 'currencyCode', 'equals', '{currency}'],
        ['Status', '', 'Response', 'status', 'present', ''],
        ['Bad', '', 'Somewhere', 'x', 'bigger', ''],
      ]),
      'psp.csv',
      ['visa-ok'],
    );
    expect(cases).toHaveLength(3);
    expect(cases[0]?.rows).toEqual([2, 3]);
    expect(cases[0]?.data.checks as unknown[]).toHaveLength(2);
    expect(cases[1]?.include).toBe(true);
    expect(cases[2]?.issues.length).toBeGreaterThanOrEqual(2);
  });

  test('edge cases: request changes and expectations', async () => {
    const { cases } = await importer.previewImport(
      'edge',
      csv([
        [
          'Test Case',
          'Card',
          'Request Changes',
          'Expected Cashier Result',
          'Expected Status',
          'Expected Error Contains',
        ],
        [
          'Tiny amount',
          'visa-ok',
          'purchase.total=0.5; client.phone=Field not sent',
          'Failure redirect',
          'ERROR / CANCELLED',
          'declined',
        ],
        ['Nothing expected', '', '', '', '', ''],
      ]),
      'edge.csv',
      ['visa-ok'],
    );
    expect(cases[0]?.data).toEqual({
      title: 'Tiny amount',
      card: 'visa-ok',
      set: { 'purchase.total': 0.5 },
      remove: ['client.phone'],
      expected: {
        outcome: 'failure-redirect',
        statuses: ['ERROR', 'CANCELLED'],
        errorContains: 'declined',
      },
    });
    expect(cases[1]?.issues.join()).toContain('at least one expectation');
  });

  test('templates open again as valid uploads (examples parse cleanly)', async () => {
    for (const category of ['field', 'regex', 'psp', 'edge']) {
      const buffer = Buffer.from(await importer.templateBuffer(category, ['risk-rule-3ds-u']));
      const { cases } = await importer.previewImport(category, buffer, 'template.xlsx', [
        'risk-rule-3ds-u',
      ]);
      expect(cases.length, category).toBeGreaterThan(0);
      expect(
        cases.flatMap((c) => c.issues),
        category,
      ).toEqual([]);
    }
  });

  test('loaders validate the stored JSON', () => {
    expect(loadUploadedFieldCases(path.join(os.tmpdir(), 'missing.json'))).toEqual([]);
    const bad = writeCases({ cases: [{ id: 'FV-001', path: 'client.city' }] });
    expect(() => loadUploadedFieldCases(bad)).toThrow(/cases\.json is invalid/);
    const regex = writeCases({
      cases: [
        {
          id: 'RX-001',
          field: 'phone',
          path: 'client.phone',
          title: 't',
          value: 'abc',
          expectation: 'auto',
          origin: 'upload',
        },
      ],
    });
    expect(loadUploadedRegexCases(regex)[0]?.expectation).toBe('auto');
    const psp = writeCases({
      cases: [
        {
          id: 'PR-001',
          title: 't',
          checks: [{ source: 'request', field: 'amount', check: 'equals', value: '{amount}' }],
        },
      ],
    });
    expect(loadUploadedPspCases(psp)).toHaveLength(1);
    const edge = writeCases({
      cases: [{ id: 'EC-001', title: 't', expected: { outcome: 'nowhere' } }],
    });
    expect(() => loadUploadedEdgeCases(edge)).toThrow(/invalid/);
  });
});

test.describe('PSP field checks', () => {
  const bank = {
    orderId: 'p1',
    paymentInfo: [
      { banff_id: '18', banff_secret: 'bf_e5e0a' },
      { amount: '101.00', currencyCode: 'XOF', extraData: { beneficiaryCountryCode: 'SN' } },
    ],
    response: [{ results: [{ statusDescription: 'PENDING', statusCode: '01' }] }],
  } as BankTransaction;

  test('finds fields at any depth, by key or dotted path', () => {
    expect(findFieldValues(bank.paymentInfo, 'currencyCode')).toEqual(['XOF']);
    expect(findFieldValues(bank.paymentInfo, 'extraData.beneficiaryCountryCode')).toEqual(['SN']);
  });

  test('evaluates checks with placeholders and masks secrets in the report', () => {
    const results = evaluatePspFieldChecks(
      bank,
      [
        { source: 'request', field: 'amount', check: 'equals', value: '{amount}' },
        { source: 'request', field: 'currencyCode', check: 'equals', value: '{currency}' },
        {
          source: 'response',
          field: 'statusDescription',
          check: 'matches',
          value: '^(PENDING|SUCCESS)$',
        },
        { source: 'response', field: 'errorCode', check: 'absent', value: '' },
        { source: 'request', field: 'banff_secret', check: 'present', value: '' },
        { source: 'request', field: 'currencyCode', check: 'equals', value: 'EUR' },
      ],
      { amount: '101', currency: 'XOF' },
    );
    expect(results.map((r) => r.passed)).toEqual([true, true, true, true, true, false]);
    expect(results[4]?.actual).toBe('***');
    expect(results[5]?.actual).toBe('XOF');
  });

  test('PSP-specific credential keys are masked', () => {
    expect(
      maskSensitiveData({
        banff_secret: 'x',
        merchantApiKey: 'y',
        x_auth_token: 'z',
        msisdn: '778218863',
      }),
    ).toEqual({
      banff_secret: '***',
      merchantApiKey: '***',
      x_auth_token: '***',
      msisdn: '***8863',
    });
  });
});

test.describe('Bank field regexes', () => {
  test('Java patterns: inline flags and whole-value match', () => {
    const rule = compileBankRule('^(?i)(?!n/?a$|null$).{2,120}$');
    expect(rule.kind).toBe('regex');
    const re = (rule as { regex: RegExp }).regex;
    expect(re.test('NULL')).toBe(false);
    expect(re.test('John')).toBe(true);
    const partial = compileBankRule('[A-Z]{2}');
    expect(partial.kind === 'regex' && partial.regex.test('ATX')).toBe(false);
    expect(compileBankRule('["IN","US"]').kind).toBe('country-list');
    expect(compileBankRule('([').kind).toBe('invalid');
  });

  test('finds whether a value reached the PSP request', () => {
    const bank = {
      paymentInfo: {
        profile: { firstName: 'Maria', lastName: 'Lopez' },
        billingDetails: { nickName: 'Maria Lopez', city: 'London', phone: '6641112233' },
      },
    } as BankTransaction;
    expect(findSentValue(bank, 'Maria Lopez', 'full_name')).toEqual(['billingDetails.nickName']);
    expect(findSentValue(bank, 'Wien1', 'city')).toEqual([]);
    expect(findSentValue(bank, '+43 664 111 2233', 'phone')).toEqual(['billingDetails.phone']);
    expect(findSentValue(undefined, 'x', 'city')).toEqual([]);
  });
});
