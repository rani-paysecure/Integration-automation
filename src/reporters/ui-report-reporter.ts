import fs from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { FIELD_CASE_ANNOTATION, FIELD_RESULT_ANNOTATION } from '../helpers/field-testing';
import type { FieldCaseMeta, FieldResultMeta } from '../helpers/field-testing';
import { PSP_RESULT_ANNOTATION, type PspSummary } from '../helpers/psp-validation';
import { PSP_FIELD_CHECKS_ANNOTATION, type PspFieldCheckResult } from '../helpers/psp-field-checks';
import type { HttpExchange } from '../types/api.types';
import { maskSensitiveData, maskString } from '../utils/masking';
import { classify, type CategoryId, type Polarity, type ReportItem } from './report-classification';

/** Run configuration as chosen in the launcher (API key already masked there). */
export interface RunMeta {
  readonly environment?: string;
  readonly tester?: string;
  readonly brandId?: string;
  readonly apiKey?: string;
  readonly currency?: string;
  readonly bank?: string;
  readonly mid?: string;
  readonly paymentMethod?: string;
  readonly payWithCard?: string;
  readonly selection?: string;
}

export interface UiTestRow {
  readonly key: string;
  readonly title: string;
  readonly group: string;
  readonly status: string;
  /** PASS / FAIL / OBSERVED / SKIPPED */
  readonly verdict: string;
  readonly durationMs: number;
  readonly expected: string;
  readonly actual: string;
  readonly category: CategoryId;
  readonly categoryLabel: string;
  /** positive = the happy path is expected, negative = a rejection / failure is expected. */
  readonly polarity: Polarity;
  readonly expectedItems: readonly ReportItem[];
  readonly actualItems: readonly ReportItem[];
  readonly purchaseId: string;
  readonly pspTransactionId: string;
  readonly cashierOutcome: string;
  readonly psp: PspSummary | undefined;
  /** Checks of an uploaded PSP case (PR-xxx). */
  readonly pspFieldChecks: readonly PspFieldCheckResult[];
  readonly pspRequest: unknown;
  readonly pspResponse: unknown;
  readonly exchanges: readonly HttpExchange[];
  readonly errors: readonly string[];
  readonly annotations: Readonly<Record<string, string>>;
}

export interface UiReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: string;
  readonly config: RunMeta;
  readonly summary: Readonly<Record<string, number>>;
  readonly tests: readonly UiTestRow[];
}

// eslint-disable-next-line no-control-regex -- strip terminal colour codes
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function attachmentText(result: TestResult, name: string): string | undefined {
  const attachment = result.attachments.find((a) => a.name === name);
  if (attachment === undefined) return undefined;
  if (attachment.body !== undefined) return attachment.body.toString('utf8');
  if (attachment.path !== undefined && fs.existsSync(attachment.path)) {
    return fs.readFileSync(attachment.path, 'utf8');
  }
  return undefined;
}

function readRunMeta(): RunMeta {
  const parsed = parseJson(process.env.RUN_META);
  return typeof parsed === 'object' && parsed !== null ? parsed : {};
}

/**
 * Writes the execution report shown in the launcher (reports/ui/latest.json +
 * a timestamped copy): configuration, every executed test with request /
 * response, expected vs actual, PSP response and IDs. Everything is masked.
 */
export default class UiReportReporter implements Reporter {
  private readonly rows = new Map<string, UiTestRow>();
  private startedAt = new Date();

  constructor(private readonly options: { outputDir?: string } = {}) {}

  onBegin(_config: unknown, _suite: Suite): void {
    this.startedAt = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const annotations = [...test.annotations, ...result.annotations];
    const values: Record<string, string> = {};
    for (const a of annotations) if (a.description !== undefined) values[a.type] = a.description;

    const fieldCase = parseJson(values[FIELD_CASE_ANNOTATION]) as FieldCaseMeta | undefined;
    const fieldResult = parseJson(values[FIELD_RESULT_ANNOTATION]) as FieldResultMeta | undefined;
    const psp = parseJson(values[PSP_RESULT_ANNOTATION]) as PspSummary | undefined;
    const exchanges = (parseJson(attachmentText(result, 'http-exchanges.json')) ??
      []) as HttpExchange[];

    const key =
      test.tags.find((tag) =>
        /^@(FT-|FV-|RX-|PR-|EC-|card-|psp-by-id|backoffice-smoke)/.test(tag),
      ) ?? test.id;
    const pspFieldChecks = (parseJson(values[PSP_FIELD_CHECKS_ANNOTATION]) ??
      []) as PspFieldCheckResult[];
    const errors = result.errors.map((e) =>
      maskString(stripAnsi(e.message ?? e.value ?? '')).slice(0, 4000),
    );

    let verdict = 'PASS';
    if (result.status === 'skipped') verdict = 'SKIPPED';
    else if (result.status !== 'passed') verdict = 'FAIL';
    else if (fieldCase?.expectation === 'observe' || values.verdict === 'observe')
      verdict = 'OBSERVED';

    const actualParts: string[] = [];
    if (fieldResult) {
      actualParts.push(`HTTP ${fieldResult.httpStatus}`);
      if (fieldResult.errorCode) actualParts.push(fieldResult.errorCode);
      if (fieldResult.message) actualParts.push(`"${fieldResult.message}"`);
      if (fieldResult.status) actualParts.push(`status ${fieldResult.status}`);
    }
    if (values['regex result']) actualParts.push(values['regex result']);
    if (values['sent to PSP']) actualParts.push(`PSP: ${values['sent to PSP']}`);
    if (values['cashier outcome']) {
      // The hosts passed through stay in the detail view; the summary keeps just the outcome.
      actualParts.push(`cashier: ${values['cashier outcome'].replace(/\s*\(via .*\)$/, '')}`);
    }
    if (values['final status']) actualParts.push(`final: ${values['final status']}`);
    if (pspFieldChecks.length > 0) {
      actualParts.push(
        `field checks ${pspFieldChecks.filter((c) => c.passed).length}/${pspFieldChecks.length} passed`,
      );
    }
    if (values['error message']) actualParts.push(`message: ${values['error message']}`);
    if (psp)
      actualParts.push(
        `PSP: ${psp.pspStatus || '–'} (${psp.checks.filter((c) => c.passed).length}/${psp.checks.length} checks)`,
      );

    const hidden = new Set([
      FIELD_CASE_ANNOTATION,
      FIELD_RESULT_ANNOTATION,
      PSP_RESULT_ANNOTATION,
      PSP_FIELD_CHECKS_ANNOTATION,
    ]);
    const rest = Object.fromEntries(Object.entries(values).filter(([type]) => !hidden.has(type)));

    const classification = classify({ key, values, fieldCase, fieldResult, psp, pspFieldChecks });

    this.rows.set(test.id, {
      ...classification,
      key,
      title: test.title,
      group: test.parent.title,
      status: result.status,
      verdict,
      durationMs: result.duration,
      expected: fieldCase
        ? `${fieldCase.expectedResult} (${fieldCase.expectation})`
        : (values.expected ?? ''),
      actual: actualParts.join(' · '),
      purchaseId: values['purchase id'] ?? fieldResult?.resourceId ?? psp?.purchaseId ?? '',
      pspTransactionId: psp?.txnId ?? '',
      cashierOutcome: values['cashier outcome'] ?? '',
      psp,
      pspFieldChecks,
      pspRequest: maskSensitiveData(parseJson(attachmentText(result, 'psp-request.json'))),
      pspResponse: maskSensitiveData(parseJson(attachmentText(result, 'psp-response.json'))),
      exchanges,
      errors,
      annotations: { ...rest, ...(fieldCase ? { 'test data': fieldCase.testData } : {}) },
    });
  }

  onEnd(result: FullResult): void {
    if (this.rows.size === 0) return;
    const tests = [...this.rows.values()];
    const count = (verdict: string): number => tests.filter((t) => t.verdict === verdict).length;
    const finished = new Date();
    const report: UiReport = {
      startedAt: this.startedAt.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - this.startedAt.getTime(),
      status: result.status,
      config: readRunMeta(),
      summary: {
        total: tests.length,
        passed: count('PASS'),
        failed: count('FAIL'),
        observed: count('OBSERVED'),
        skipped: count('SKIPPED'),
      },
      tests,
    };
    const dir = path.resolve(this.options.outputDir ?? 'reports/ui');
    fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
    const json = JSON.stringify(report, null, 2);
    fs.writeFileSync(path.join(dir, 'latest.json'), json);
    const stamp = finished.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(dir, 'history', `${stamp}.json`), json);
  }

  printsToStdio(): boolean {
    return false;
  }
}
