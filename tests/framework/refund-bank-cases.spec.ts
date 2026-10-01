import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  describeRefundAmount,
  resolveBankSettings,
  resolveCurrencyToken,
  resolveRefundAmount,
} from '@test-data/uploaded-cases/refund-bank-cases';
import {
  loadUploadedBankConfigCases,
  loadUploadedRefundCases,
} from '@test-data/uploaded-cases/uploaded-cases';

interface PreviewCase {
  data: Record<string, unknown>;
  include: boolean;
  issues: string[];
  warnings: string[];
}
interface Importer {
  previewObjects(category: string, rows: object[], cardIds?: string[]): { cases: PreviewCase[] };
  previewImport(
    category: string,
    buffer: Buffer,
    filename: string,
  ): Promise<{ cases: PreviewCase[] }>;
  templateBuffer(category: string, cardIds?: string[]): Promise<ArrayBuffer>;
  appendCases(category: string, chosen: PreviewCase[], source: string): { ids: string[] };
  /** Fixed when the module is first loaded (another self-test may load it first). */
  DATA_DIR: string;
}
process.env.UPLOADED_CASES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cases-dir-'));
const importer = createRequire(__filename)('../../tools/launcher/test-case-import.js') as Importer;

test.describe('Uploaded refund (RC) and bank & MID config (BC) cases', () => {
  test('refund rows: steps, reason, expectations and problems', () => {
    const { cases } = importer.previewObjects('refund', [
      {
        title: 'Steps',
        refunds: '20%; 2.5; rest+1',
        reason: 'not sent',
        http: '400',
        code: 'invalid_amount',
      },
      { title: 'Unpaid', purchase: 'Unpaid purchase', refunds: '"abc"', http: '400' },
      { title: 'Bad', purchase: 'later', refunds: '200000%' },
    ]);
    expect(cases[0]?.include).toBe(true);
    expect(cases[0]?.data).toMatchObject({
      purchase: 'new',
      steps: [
        { amount: { kind: 'percent', value: 20 } },
        { amount: { kind: 'fixed', value: 2.5 } },
        { amount: { kind: 'rest', delta: 1 } },
      ],
      reason: { kind: 'none' },
      expected: { http: 400, code: 'invalid_amount' },
    });
    expect(cases[1]?.data).toMatchObject({
      purchase: 'unpaid',
      steps: [{ amount: { kind: 'raw', value: 'abc' } }],
    });
    expect(cases[2]?.include).toBe(false);
    expect(cases[2]?.issues.join(' ')).toMatch(/Purchase must be one of/);
    expect(cases[2]?.issues.join(' ')).toMatch(/percentage/);
  });

  test('bank & MID rows: settings, tokens, action and expectations', () => {
    const { cases } = importer.previewObjects('bank-config', [
      {
        title: 'Skip',
        settings: 'Allowed cards={other}; 2D only=on',
        routing: 'Skips the MID',
        status: 'ERROR',
      },
      {
        title: 'Convert',
        settings: 'Convert to={other}; Merchant conversion=1',
        currency: '{other}',
      },
      {
        title: 'Refund',
        settings: 'Partial refund=0',
        action: 'Partial refund',
        code: 'payment_can_not_be_refunded',
      },
      { title: 'Bad', settings: 'colour=red; Allowed cards=PAYPALX' },
    ]);
    expect(cases[0]?.data).toMatchObject({
      settings: { allowed_card: '{other}', onlyTwoD: 1 },
      action: 'pay',
      expected: { routing: 'skips', statuses: ['ERROR'] },
    });
    expect(cases[1]?.data).toMatchObject({
      settings: { curr_convert_to: '{other}', merchant_conversion: 1 },
    });
    expect(cases[2]?.data).toMatchObject({
      action: 'partial-refund',
      settings: { partial_refund_allowed: 0 },
    });
    expect(cases[3]?.include).toBe(false);
    expect(cases[3]?.issues.join(' ')).toMatch(/Unknown setting "colour"/);
    expect(cases[3]?.issues.join(' ')).toMatch(/PAYPALX/);
  });

  test('templates read back cleanly and saved cases load in the runners', async () => {
    for (const id of ['refund', 'bank-config']) {
      const buffer = Buffer.from(await importer.templateBuffer(id, ['visa-3ds-frictionless']));
      const { cases } = await importer.previewImport(id, buffer, 'template.xlsx');
      expect(cases.length, id).toBeGreaterThan(0);
      expect(
        cases.every((c) => c.issues.length === 0),
        id,
      ).toBe(true);
      importer.appendCases(id, cases, `template-${id}.xlsx`);
    }
    const dir = importer.DATA_DIR;
    expect(loadUploadedRefundCases(path.join(dir, 'refund-cases.json')).map((c) => c.id)).toEqual([
      'RC-001',
      'RC-002',
      'RC-003',
    ]);
    expect(
      loadUploadedBankConfigCases(path.join(dir, 'bank-config.json')).map((c) => c.id),
    ).toEqual(['BC-001', 'BC-002', 'BC-003']);
  });

  test('refund amounts resolve against the purchase', () => {
    expect(resolveRefundAmount({ kind: 'percent', value: 30 }, 10, 0)).toBe(3);
    expect(resolveRefundAmount({ kind: 'rest' }, 10, 3)).toBe(7);
    expect(resolveRefundAmount({ kind: 'rest', delta: 0.01 }, 10, 3)).toBe(7.01);
    expect(resolveRefundAmount({ kind: 'total' }, 10, 3)).toBe(10);
    expect(resolveRefundAmount({ kind: 'none' }, 10, 0)).toBeUndefined();
    expect(resolveRefundAmount({ kind: 'raw', value: 'abc' }, 10, 0)).toBe('abc');
    expect(describeRefundAmount({ kind: 'rest', delta: -1 })).toBe('rest-1');
  });

  test('setting tokens resolve for the run', () => {
    const ctx = { purchaseCurrency: 'EUR', scheme: 'VISA' };
    expect(
      resolveBankSettings(
        {
          allowed_card: '{other}',
          allowed_curr: '{purchase},{other}',
          curr_convert_to: '{other}',
          merchant_conversion: 0,
        },
        ctx,
      ),
    ).toEqual({
      mid: { allowed_card: 'MASTER', allowed_curr: 'EUR,USD', curr_convert_to: 'USD' },
      merchantConversion: 0,
    });
    expect(resolveCurrencyToken('{other}', { ...ctx, preferredOther: 'GBP' })).toBe('GBP');
    expect(resolveBankSettings({ curr_convert_to: '' }, ctx).mid).toEqual({ curr_convert_to: '' });
  });
});
