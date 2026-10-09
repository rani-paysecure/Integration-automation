import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import {
  FIELD_CASE_ANNOTATION,
  FIELD_PSP_RESPONSE_ANNOTATION,
  FIELD_RESULT_ANNOTATION,
  type FieldCaseMeta,
  type FieldResultMeta,
} from '../helpers/field-testing';
import { maskString } from '../utils/masking';

interface RunContext {
  readonly environment: string;
  readonly profile: string;
  readonly paymentMethod: string;
  readonly brandId: string;
}

interface Row {
  readonly run: RunContext;
  readonly case: FieldCaseMeta;
  readonly result: FieldResultMeta | undefined;
  readonly verdict: 'PASS' | 'FAIL' | 'OBSERVED' | 'SKIPPED';
  readonly failure: string;
  /** PSP answer when the case was paid ("… → payment PASSED / FAILED"). */
  readonly pspResponse: string;
}

const COLUMNS = [
  'Environment',
  'Tester Profile',
  'Payment Method',
  'Brand ID',
  'ID',
  'Parameter',
  'Test Case',
  'Test Data',
  'Expected Result',
  'Expectation Type',
  'HTTP Status',
  'Error Code',
  'API Message',
  'Purchase Status',
  'Purchase ID',
  'Verdict',
  'Failure Reason',
  'Notes',
  'PSP Response (Remarks)',
] as const;

function parse(description: string | undefined): unknown {
  if (description === undefined) return undefined;
  try {
    return JSON.parse(description) as unknown;
  } catch {
    return undefined;
  }
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing terminal colour codes
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Collects field-test annotations into a spreadsheet-friendly CSV (UTF-8 BOM
 * so Excel shows accented characters) plus JSON, in reports/field-tests/.
 */
export default class FieldTestReporter implements Reporter {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly options: { outputDir?: string } = {}) {}

  onTestEnd(test: TestCase, result: TestResult): void {
    const annotations = [...test.annotations, ...result.annotations];
    const meta = parse(annotations.find((a) => a.type === FIELD_CASE_ANNOTATION)?.description) as
      FieldCaseMeta | undefined;
    if (!meta) return;
    const outcome = parse(
      annotations.findLast((a) => a.type === FIELD_RESULT_ANNOTATION)?.description,
    ) as FieldResultMeta | undefined;

    let verdict: Row['verdict'];
    if (result.status === 'skipped') verdict = 'SKIPPED';
    else if (result.status !== 'passed') verdict = 'FAIL';
    else
      verdict =
        meta.expectation === 'observe' ||
        annotations.some((a) => a.type === 'verdict' && a.description === 'observe')
          ? 'OBSERVED'
          : 'PASS';

    const failure = stripAnsi(result.errors[0]?.message ?? '')
      .split('\n')
      .slice(0, 3)
      .join(' ')
      .trim();

    const valueOf = (type: string): string =>
      annotations.find((a) => a.type === type)?.description ?? '';
    const run: RunContext = {
      environment: valueOf('environment'),
      profile: valueOf('profile'),
      paymentMethod: valueOf('payment method'),
      brandId: valueOf('brand id'),
    };

    // Retries overwrite earlier attempts – the last result wins.
    this.rows.set(test.id, {
      run,
      case: meta,
      result: outcome,
      verdict,
      failure: maskString(failure),
      pspResponse: maskString(valueOf(FIELD_PSP_RESPONSE_ANNOTATION)),
    });
  }

  onEnd(): void {
    if (this.rows.size === 0) return;
    const dir = path.resolve(this.options.outputDir ?? 'reports/field-tests');
    fs.mkdirSync(dir, { recursive: true });

    const rows = [...this.rows.values()].sort((a, b) =>
      a.case.id.localeCompare(b.case.id, 'en', { numeric: true }),
    );
    const lines = [
      COLUMNS.join(','),
      ...rows.map((row) =>
        [
          row.run.environment,
          row.run.profile,
          row.run.paymentMethod,
          row.run.brandId,
          row.case.id,
          row.case.parameter,
          row.case.title,
          row.case.testData,
          row.case.expectedResult,
          row.case.expectation,
          row.result?.httpStatus ?? '',
          row.result?.errorCode ?? '',
          row.result?.message ?? '',
          row.result?.status ?? '',
          row.result?.resourceId ?? '',
          row.verdict,
          row.failure,
          row.case.note,
          row.pspResponse,
        ]
          .map(csvCell)
          .join(','),
      ),
    ];
    const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
    const json = JSON.stringify(rows, null, 2);
    // Latest run (stable name, used by the launcher) …
    fs.writeFileSync(path.join(dir, 'field-test-results.csv'), csv);
    fs.writeFileSync(path.join(dir, 'field-test-results.json'), json);
    // … plus a per-run copy so each tester keeps a history.
    const first = rows[0]?.run;
    const slug = (value: string | undefined, fallback: string): string =>
      (value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || fallback;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const historyDir = path.join(dir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });
    const historyName = [
      stamp,
      slug(first?.environment, 'env'),
      slug(first?.profile, 'no-profile'),
      slug(first?.paymentMethod, 'method'),
    ].join('_');
    fs.writeFileSync(path.join(historyDir, `${historyName}.csv`), csv);

    const count = (verdict: Row['verdict']): number =>
      rows.filter((row) => row.verdict === verdict).length;
    process.stdout.write(
      `\nField tests: ${rows.length} cases - PASS ${count('PASS')}, FAIL ${count('FAIL')}, ` +
        `OBSERVED ${count('OBSERVED')}, SKIPPED ${count('SKIPPED')}\n` +
        `Results: ${path.relative(process.cwd(), path.join(dir, 'field-test-results.csv'))}\n`,
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}
