import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { customerFieldLeaves, standardRule } from '@helpers/pgs-rules';
import {
  judgeRegexCase,
  regexCaseRequest,
  type RegexCaseInput,
  type RegexContext,
} from '@helpers/uploaded-case-checks';
import type { BankTransaction } from '@schemas/backoffice.schema';
import { loadUploadedRegexCases } from '@test-data/uploaded-cases/uploaded-cases';

interface Importer {
  previewObjects(
    category: string,
    rows: readonly Record<string, string>[],
  ): { cases: { data: Record<string, unknown>; issues: string[]; include: boolean }[] };
}
// The importer reads saved cases for duplicates – point it at an empty folder (never the repo's files).
process.env.UPLOADED_CASES_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'regex-standard-'));
const IMPORTER = path.resolve(__dirname, '../../tools/launcher/test-case-import.js');
const importer = createRequire(__filename)(IMPORTER) as Importer;

const NAME_REGEX = '^[A-Za-z]+(\\s[A-Za-z-]+)*$';
const CITY_REGEX = '^[A-Za-z-][A-Za-z\\s\\-]{1,}$';

/** PSP request with the customer block and a baseline stateCode "NA" elsewhere in the payload. */
const pspRequest = (customer: Record<string, unknown>): BankTransaction => ({
  bankName: 'paysafe_payfac',
  paymentInfo: {
    merchantRefNum: 'pid-1',
    billingDetails: { state: 'NA', country: 'US', city: 'London' },
    customer,
    merchant: { firstName: 'Shop', phone: '' },
    items: [{ name: 'QA item' }],
  },
});

const regexCase = (over: Partial<RegexCaseInput>): RegexCaseInput => ({
  id: 'RX-001',
  field: 'full_name',
  value: 'NA',
  expectation: 'auto',
  ...over,
});

const ctx = (
  bank: BankTransaction | undefined,
  rules: Record<string, string> = {},
): RegexContext => ({
  usedBank: 'paysafe_payfac',
  country: 'US',
  rules,
  bank,
});

test.describe('Regex validation – standard rule and field-scoped PSP check', () => {
  test('standard rule: blank values for every field, placeholders only for full_name', () => {
    expect(standardRule('full_name', 'value', 'n/a')).toContain('placeholder');
    expect(standardRule('full_name', 'empty', '')).toContain('empty');
    expect(standardRule('phone', 'null', '')).toContain('null');
    expect(standardRule('city', 'missing', '')).toContain('not sent');
    expect(standardRule('city', 'value', '   ')).toContain('empty');
    expect(standardRule('city', 'value', 'NA')).toBeUndefined();
    expect(standardRule('full_name', 'value', 'Maria Lopez')).toBeUndefined();
  });

  test('full_name NA without any bank regex is still invalid – replaced value passes', () => {
    const replaced = judgeRegexCase(
      regexCase({ value: 'na' }),
      ctx(pspRequest({ firstName: 'John', lastName: 'Doe' })),
    );
    expect(replaced).toMatchObject({ expectation: 'invalid', noRule: false, reached: false });

    const leaked = judgeRegexCase(
      regexCase({ value: 'na' }),
      ctx(pspRequest({ firstName: 'na', lastName: 'Doe' })),
    );
    expect(leaked.reached).toBe(true);
    expect(leaked.hits).toEqual(['paymentInfo.customer.firstName']);
  });

  test('NA elsewhere in the PSP request (baseline stateCode) is not mistaken for the name', () => {
    const judged = judgeRegexCase(
      regexCase({ value: 'NA' }),
      ctx(pspRequest({ firstName: 'John', lastName: 'Doe' })),
    );
    expect(judged.reached).toBe(false);
  });

  test('blank name: a DB value passes, an empty or placeholder value fails, empty middle name is fine', () => {
    const empty = regexCase({ value: '', send: 'empty' });
    expect(
      judgeRegexCase(empty, ctx(pspRequest({ firstName: 'John', middleName: '', lastName: 'Doe' })))
        .reached,
    ).toBe(false);
    expect(judgeRegexCase(empty, ctx(pspRequest({ firstName: '', lastName: 'Doe' }))).hits).toEqual(
      ['paymentInfo.customer.firstName=""'],
    );
    expect(
      judgeRegexCase(regexCase({ value: '', send: 'null' }), ctx(pspRequest({ fullName: 'N/A' })))
        .reached,
    ).toBe(true);
  });

  test('blank phone / city: merchant and other blocks are ignored', () => {
    const phone = judgeRegexCase(
      regexCase({ field: 'phone', value: '', send: 'missing' }),
      ctx(pspRequest({ phone: '+15550100200' })),
    );
    expect(phone).toMatchObject({ expectation: 'invalid', reached: false });
    const city = judgeRegexCase(
      regexCase({ field: 'city', value: '', send: 'null' }),
      ctx({ paymentInfo: { billingDetails: { city: null } } }),
    );
    expect(city.reached).toBe(true);
  });

  test('field the PSP does not receive → observed, not failed', () => {
    const judged = judgeRegexCase(
      regexCase({ value: 'NA' }),
      ctx({ allOtherRequest: [{ amount: 1000 }] }),
    );
    expect(judged.expectation).toBe('observe');
  });

  test('without the standard rule the bank regex decides; city NA follows the regex', () => {
    const valid = judgeRegexCase(
      regexCase({ field: 'city', value: 'New York' }),
      ctx({ paymentInfo: { billingDetails: { city: 'New York' } } }, { city: CITY_REGEX }),
    );
    expect(valid).toMatchObject({ expectation: 'valid', reached: true });
    const placeholder = judgeRegexCase(
      regexCase({ field: 'city', value: 'na' }),
      ctx({ paymentInfo: { billingDetails: { city: 'Springfield' } } }, { city: CITY_REGEX }),
    );
    expect(placeholder).toMatchObject({ expectation: 'invalid', reached: false });
    const noRegex = judgeRegexCase(
      regexCase({ field: 'city', value: 'na' }),
      ctx({ paymentInfo: { billingDetails: { city: 'Springfield' } } }),
    );
    expect(noRegex.noRule).toBe(true);
  });

  test('valid full name split over first / last name reaches the PSP unchanged', () => {
    const judged = judgeRegexCase(
      regexCase({ value: 'Maria Lopez' }),
      ctx(pspRequest({ firstName: 'Maria', lastName: 'Lopez' }), { full_name: NAME_REGEX }),
    );
    expect(judged).toMatchObject({ expectation: 'valid', reached: true });
  });

  test('customer field leaves skip merchant blocks and product names', () => {
    const leaves = customerFieldLeaves(pspRequest({ name: 'Maria Lopez' }), 'full_name');
    expect(leaves.map((l) => l.path)).toEqual(['paymentInfo.customer.name']);
  });

  test('request builder sends empty, null or leaves the field out', () => {
    const base = { client: { country: 'US', full_name: 'Charles Mtonga' } };
    const build = (send: RegexCaseInput['send']): Record<string, unknown> =>
      regexCaseRequest(base, { path: 'client.full_name', value: '', send }).request
        .client as Record<string, unknown>;
    expect(build('empty').full_name).toBe('');
    expect(build('null').full_name).toBeNull();
    expect('full_name' in build('missing')).toBe(false);
  });

  test('upload: "" / null / Field not sent become blank cases; "null" in quotes stays text', () => {
    const { cases } = importer.previewObjects('regex', [
      { bank: '', parameter: 'full_name', title: 'empty', data: '""', country: '', result: '' },
      { bank: '', parameter: 'full_name', title: 'null', data: 'null', country: '', result: '' },
      {
        bank: '',
        parameter: 'phone',
        title: 'missing',
        data: 'Field not sent',
        country: '',
        result: '',
      },
      { bank: '', parameter: 'full_name', title: 'text', data: '"null"', country: '', result: '' },
      { bank: '', parameter: 'phone', title: 'IN', data: '9876543210', country: 'IN', result: '' },
      { bank: '', parameter: 'phone', title: 'US', data: '9876543210', country: 'US', result: '' },
    ]);
    expect(cases.map((c) => [c.data.send, c.data.value])).toEqual([
      ['empty', ''],
      ['null', ''],
      ['missing', ''],
      [undefined, 'null'],
      [undefined, '9876543210'],
      [undefined, '9876543210'],
    ]);
    // Same value for two countries is two different tests.
    expect(cases.every((c) => c.include)).toBe(true);
  });

  test('launcher saves blank regex cases and the test loader reads them back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regex-save-'));
    const script = `
      const imp = require(${JSON.stringify(IMPORTER)});
      const { cases } = imp.previewObjects('regex', [
        { bank: '', parameter: 'full_name', title: 'null name', data: 'null', country: '', result: 'Invalid' },
        { bank: '', parameter: 'city', title: 'NA city', data: 'NA', country: '', result: '' },
      ]);
      imp.appendCases('regex', cases.map((c) => ({ data: c.data, rows: c.rows })), 'test');`;
    execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, UPLOADED_CASES_DIR: dir },
    });
    const saved = loadUploadedRegexCases(path.join(dir, 'regex-validation.json'));
    expect(saved.map((c) => [c.id, c.field, c.value, c.send, c.expectation])).toEqual([
      ['RX-001', 'full_name', '', 'null', 'invalid'],
      ['RX-002', 'city', 'NA', undefined, 'auto'],
    ]);
  });
});
