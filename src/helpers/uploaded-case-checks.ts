import { expect, type TestInfo } from '@playwright/test';
import type { BankTransaction } from '../schemas/backoffice.schema';
import { maskSensitiveData } from '../utils/masking';
import { compileBankRule, findSentValue } from './bank-regex';
import type { TransactionResult } from './transaction-flow';

/**
 * Assertions for uploaded cases (regex / edge cases). Kept out of the specs so
 * optional sheet columns don't turn into conditionals inside the tests.
 */

export interface RegexCaseInput {
  readonly id: string;
  readonly bank?: string | undefined;
  readonly field: string;
  readonly value: string;
  readonly expectation: 'valid' | 'invalid' | 'observe' | 'auto';
  readonly regex?: string | undefined;
}

/**
 * Judges a regex case after the payment: the bank's live rule decides whether
 * the value must reach the PSP unchanged (matches) or must not (does not match).
 */
export function expectRegexOutcome(
  regexCase: RegexCaseInput,
  context: {
    readonly usedBank: string;
    readonly rules: Readonly<Record<string, string>>;
    readonly bank: BankTransaction | undefined;
  },
  testInfo: TestInfo,
): void {
  const note = (type: string, description: string): void => {
    testInfo.annotations.push({ type, description });
  };
  const shownValue = String(
    (maskSensitiveData({ [regexCase.field]: regexCase.value }) as Record<string, unknown>)[
      regexCase.field
    ],
  );
  note('test value', `${regexCase.field} = ${shownValue}`);
  note('bank', context.usedBank || '(no PSP request)');

  if (
    regexCase.bank &&
    context.usedBank &&
    regexCase.bank.toLowerCase() !== context.usedBank.toLowerCase()
  ) {
    expect
      .soft(
        context.usedBank,
        `Payment was routed to ${context.usedBank}, the case is for ${regexCase.bank} – check Limits/Charges routing`,
      )
      .toBe(regexCase.bank);
  }

  const pattern = context.rules[regexCase.field];
  const rule = pattern === undefined ? undefined : compileBankRule(pattern);
  note('regex', pattern ?? `(no regex for ${regexCase.field} on this bank)`);
  if (regexCase.regex !== undefined && pattern !== undefined && regexCase.regex !== pattern) {
    note('rule changed', 'The regex changed since this case was created – the live rule is used');
  }
  const matches = rule?.kind === 'regex' ? rule.regex.test(regexCase.value) : undefined;
  if (matches !== undefined)
    note('regex result', matches ? 'value matches the regex' : 'value does not match the regex');
  if (rule?.kind === 'country-list')
    note('regex result', `country rule (${rule.countries.join(', ')}) – not judged`);

  let expectation = regexCase.expectation;
  if (expectation === 'auto') {
    expectation = matches === undefined ? 'observe' : matches ? 'valid' : 'invalid';
  }
  if (
    matches !== undefined &&
    regexCase.expectation !== 'auto' &&
    expectation !== 'observe' &&
    (expectation === 'valid') !== matches
  ) {
    note(
      'sheet vs regex',
      `Sheet says ${expectation} but the value ${matches ? 'matches' : 'does not match'} the regex`,
    );
  }

  const hits = findSentValue(context.bank, regexCase.value, regexCase.field);
  const sent = hits.length > 0;
  note(
    'sent to PSP',
    context.bank === undefined
      ? 'no PSP request recorded'
      : sent
        ? `unchanged (${hits.slice(0, 3).join(', ')})`
        : 'not sent – replaced or dropped',
  );
  note(
    'expected',
    expectation === 'valid'
      ? 'Valid → reaches the PSP unchanged'
      : expectation === 'invalid'
        ? 'Invalid → does not reach the PSP'
        : 'Observe – recorded only',
  );

  if (rule === undefined && regexCase.expectation === 'auto') {
    expect
      .soft(
        pattern,
        `No regex configured for ${regexCase.field} on ${context.usedBank || 'the bank'}`,
      )
      .toBeDefined();
    return;
  }
  if (expectation === 'observe') {
    note('verdict', 'observe');
    return;
  }
  if (expectation === 'valid') {
    expect.soft(context.bank, 'Valid value, but no PSP request was recorded').toBeDefined();
    expect
      .soft(sent, `Valid ${regexCase.field} "${shownValue}" should reach the PSP unchanged`)
      .toBe(true);
  } else {
    expect
      .soft(sent, `Invalid ${regexCase.field} "${shownValue}" should not reach the PSP`)
      .toBe(false);
  }
}

export interface EdgeExpectation {
  readonly outcome?: string | undefined;
  readonly statuses?: readonly string[] | undefined;
  readonly errorContains?: string | undefined;
}

export const describeEdgeExpectation = (e: EdgeExpectation): string =>
  [e.outcome, e.statuses?.join(' / '), e.errorContains ? `error contains "${e.errorContains}"` : '']
    .filter(Boolean)
    .join(' · ');

/** Compares the transaction with every expectation given in the sheet (soft, all reported). */
export function expectEdgeOutcome(
  result: TransactionResult,
  expected: EdgeExpectation,
  testInfo: TestInfo,
): void {
  if (expected.outcome !== undefined) {
    expect
      .soft(result.cashier.outcome, `cashier result (${result.cashier.finalUrl})`)
      .toBe(expected.outcome);
  }
  if (expected.statuses !== undefined && expected.statuses.length > 0) {
    expect
      .soft(expected.statuses, `final status ${result.finalStatus}`)
      .toContain(result.finalStatus);
  }
  if (expected.errorContains !== undefined) {
    const needle = expected.errorContains.toLowerCase();
    const messages = [
      result.psp.errorMessage,
      result.cashier.apiMessage,
      result.psp.gatewayMessage,
    ].filter(Boolean);
    const shown = messages.join(' | ') || '(none)';
    testInfo.annotations.push({ type: 'error message', description: shown });
    expect
      .soft(
        messages.some((m) => m.toLowerCase().includes(needle)),
        `error / PSP message should contain "${expected.errorContains}" – got: ${shown}`,
      )
      .toBe(true);
  }
}
