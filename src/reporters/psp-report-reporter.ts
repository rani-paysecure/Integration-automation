import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { PSP_RESULT_ANNOTATION, type PspSummary } from '../helpers/psp-validation';

type Verdict = 'PASS' | 'FAIL' | 'NOT ATTEMPTED' | 'ERROR';

interface Row {
  readonly environment: string;
  readonly tester: string;
  readonly cardScenario: string;
  readonly cashierOutcome: string;
  readonly summary: PspSummary;
  readonly verdict: Verdict;
}

const COLUMNS = [
  'Environment',
  'Tester Profile',
  'Card Scenario',
  'Cashier Outcome',
  'Purchase ID',
  'PSP Transaction ID',
  'Purchase Status',
  'Merchant',
  'Payment Method',
  'Bank / PSP',
  'MID',
  'Purchase Amount',
  'Purchase Currency',
  'Amount Sent to PSP',
  'Currency Sent to PSP',
  'PSP Status',
  'Gateway Code',
  'Gateway Message',
  'Error Message',
  'Checks Passed',
  'Failed Checks',
  'Verdict',
  'Notes',
] as const;

const csvCell = (value: string | number): string => {
  const cell = String(value);
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
};

/**
 * Purchase ID → PSP transaction ID report (reports/psp-validation/).
 * One row per validated purchase, plus a timestamped copy per run in history/.
 */
export default class PspReportReporter implements Reporter {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly options: { outputDir?: string } = {}) {}

  onTestEnd(test: TestCase, result: TestResult): void {
    const annotations = [...test.annotations, ...result.annotations];
    const raw = annotations.findLast((a) => a.type === PSP_RESULT_ANNOTATION)?.description;
    if (raw === undefined) return;
    let summary: PspSummary;
    try {
      summary = JSON.parse(raw) as PspSummary;
    } catch {
      return;
    }
    const valueOf = (type: string): string =>
      annotations.find((a) => a.type === type)?.description ?? '';
    let verdict: Verdict;
    if (!summary.attempted) verdict = 'NOT ATTEMPTED';
    else if (result.status === 'passed') verdict = 'PASS';
    else if (summary.checks.some((check) => !check.passed)) verdict = 'FAIL';
    else verdict = 'ERROR';
    this.rows.set(test.id, {
      environment: valueOf('environment'),
      tester: valueOf('profile'),
      cardScenario: valueOf('card scenario'),
      cashierOutcome: valueOf('cashier outcome'),
      summary,
      verdict,
    });
  }

  onEnd(): void {
    if (this.rows.size === 0) return;
    const dir = path.resolve(this.options.outputDir ?? 'reports/psp-validation');
    fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
    const rows = [...this.rows.values()];
    const lines = [
      COLUMNS.join(','),
      ...rows.map(({ environment, tester, cardScenario, cashierOutcome, summary: s, verdict }) =>
        [
          environment,
          tester,
          cardScenario,
          cashierOutcome,
          s.purchaseId,
          s.txnId,
          s.purchaseStatus,
          s.merchant,
          s.paymentMethod,
          s.bankName,
          s.midName,
          s.purchaseAmount,
          s.purchaseCurrency,
          s.pspAmount,
          s.pspCurrency,
          s.pspStatus,
          s.gatewayCode,
          s.gatewayMessage,
          s.errorMessage,
          `${s.checks.filter((c) => c.passed).length}/${s.checks.length}`,
          s.checks
            .filter((c) => !c.passed)
            .map((c) => `${c.name}: expected ${c.expected}, got ${c.actual || '(empty)'}`)
            .join(' | '),
          verdict,
          s.notes.join(' | '),
        ]
          .map(csvCell)
          .join(','),
      ),
    ];
    const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
    fs.writeFileSync(path.join(dir, 'psp-validation-results.csv'), csv);
    fs.writeFileSync(path.join(dir, 'psp-validation-results.json'), JSON.stringify(rows, null, 2));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const who = (rows[0]?.tester ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'no-profile';
    fs.writeFileSync(path.join(dir, 'history', `${stamp}_${who}.csv`), csv);

    const count = (v: Verdict): number => rows.filter((row) => row.verdict === v).length;
    process.stdout.write(
      `\nPSP validation: ${rows.length} purchases - PASS ${count('PASS')}, FAIL ${count('FAIL')}, ` +
        `NOT ATTEMPTED ${count('NOT ATTEMPTED')}, ERROR ${count('ERROR')}\n` +
        `Results: ${path.relative(process.cwd(), path.join(dir, 'psp-validation-results.csv'))}\n`,
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}
