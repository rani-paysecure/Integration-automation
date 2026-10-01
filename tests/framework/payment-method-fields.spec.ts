import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import {
  casePaymentMethod,
  isPaymentMethodField,
  type FieldTestCase,
} from '@helpers/field-testing';
import { methodFieldsFor } from '@test-data/purchase/purchase-request.factory';

interface Importer {
  mapParameter(raw: string): { path?: string; error?: string; warning?: string; dynamic?: boolean };
  parseValue(
    raw: string,
    path: string,
  ): {
    mutation: { type: string; value?: unknown };
    context: Record<string, unknown>;
    warning?: string;
  };
  previewObjects(
    category: string,
    rows: object[],
  ): { cases: { include: boolean; data: Record<string, unknown>; issues: string[] }[] };
}
interface PaymentMethodCases {
  toMethod(row: Record<string, string>): {
    name: string;
    mandatory: string[];
    group1: string[];
    group2: string[];
  };
  rowsForMethod(method: ReturnType<PaymentMethodCases['toMethod']>): Record<string, string>[];
}
const load = createRequire(__filename);
const importer = load('../../tools/launcher/test-case-import.js') as Importer;
const pmCases = load('../../tools/launcher/payment-method-cases.js') as PaymentMethodCases;

test.describe('Payment-method fields (extraParam, upiId, invoiceNo …)', () => {
  test('any extraParam key and top-level method field is a parameter – nothing hardcoded', () => {
    expect(importer.mapParameter('extraParam.iban')).toMatchObject({
      path: 'extraParam.iban',
      dynamic: true,
    });
    expect(importer.mapParameter('extraParams.sort-code')).toMatchObject({
      path: 'extraParam.sort-code',
    });
    expect(importer.mapParameter('extraParam')).toMatchObject({
      path: 'extraParam',
      dynamic: true,
    });
    expect(importer.mapParameter('upiId')).toMatchObject({ path: 'upiId', dynamic: true });
    expect(importer.mapParameter('invoiceNo')).toMatchObject({ path: 'invoiceNo' });
    expect(importer.mapParameter('country')).toMatchObject({ path: 'client.country' });
    expect(importer.mapParameter('extraParam.a b').error).toMatch(/letters, digits/);
    // Removed fields are no longer standard request fields.
    expect(importer.mapParameter('platform')).toMatchObject({ path: 'platform', dynamic: true });
  });

  test('JSON objects / lists, typed literals and several context fields', () => {
    expect(
      importer.parseValue('{"iban":"AE07","accountNumber":"123"}', 'extraParam').mutation,
    ).toEqual({
      type: 'set',
      value: { iban: 'AE07', accountNumber: '123' },
    });
    expect(importer.parseValue('["x"]', 'extraParam').mutation.value).toEqual(['x']);
    expect(importer.parseValue('true (boolean)', 'extraParam.flag').mutation.value).toBe(true);
    expect(importer.parseValue('42 (no quotes)', 'extraParam.n').mutation.value).toBe(42);
    expect(importer.parseValue('{bad', 'extraParam').warning).toMatch(/not valid JSON/);
    expect(
      importer.parseValue(
        'AE07 with paymentMethod=UPI; extraParam.name="QA Test"',
        'extraParam.iban',
      ),
    ).toMatchObject({
      mutation: { type: 'set', value: 'AE07' },
      context: { paymentMethod: 'UPI', 'extraParam.name': 'QA Test' },
    });
  });

  test('purchase data: extraParam for all methods + fields of the run payment method', () => {
    const template = {
      extraParam: { channel: 'web' },
      methodFields: {
        '*': { invoiceNo: 'INV-1' },
        UPI: { upiId: 'pending@testbank', extraParam: { vpa: 'qa@upi', channel: 'app' } },
      },
    };
    expect(methodFieldsFor(template, 'upi')).toEqual({
      invoiceNo: 'INV-1',
      upiId: 'pending@testbank',
      extraParam: { channel: 'app', vpa: 'qa@upi' },
    });
    expect(methodFieldsFor(template, 'VISA')).toEqual({
      invoiceNo: 'INV-1',
      extraParam: { channel: 'web' },
    });
    expect(methodFieldsFor({}, 'VISA')).toEqual({});
  });

  test('runner helpers: payment-method fields and the case payment method', () => {
    expect(isPaymentMethodField('extraParam.iban')).toBe(true);
    expect(isPaymentMethodField('extraParam')).toBe(true);
    expect(isPaymentMethodField('upiId')).toBe(true);
    expect(isPaymentMethodField('client.email')).toBe(false);
    expect(isPaymentMethodField('success_redirect')).toBe(false);
    const fieldCase = { context: { paymentMethod: ' UPI ' } } as unknown as FieldTestCase;
    expect(casePaymentMethod(fieldCase)).toBe('UPI');
  });

  test('dashboard payment-method config → cases for every key, all valid uploads', () => {
    const method = pmCases.toMethod({
      name: 'QA-METHOD',
      is_Card: '0',
      user_input_required: '0',
      mandatoryParams: 'full_name,upi',
      extraMandatoryParams: 'iban,accountNumber',
      extraMandatoryParams2: 'payId',
    });
    expect(method).toMatchObject({
      mandatory: ['full_name', 'upi'],
      group1: ['iban', 'accountNumber'],
      group2: ['payId'],
    });
    const { cases } = importer.previewObjects('field', pmCases.rowsForMethod(method));
    expect(cases.every((c) => c.issues.length === 0)).toBe(true);
    const paths = cases.map((c) => String(c.data.path));
    for (const key of ['iban', 'accountNumber', 'payId'])
      expect(paths).toContain(`extraParam.${key}`);
    const both = cases.find((c) => String(c.data.title).includes('BOTH groups'));
    expect(both?.data.expectation).toBe('rejected');
    expect(
      cases.every((c) => (c.data.context as Record<string, unknown>).paymentMethod === 'QA-METHOD'),
    ).toBe(true);
  });
});
