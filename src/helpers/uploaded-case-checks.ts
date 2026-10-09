import { expect, type TestInfo } from '@playwright/test';
import type { BankTransaction } from '../schemas/backoffice.schema';
import { maskSensitiveData } from '../utils/masking';
import type { ApiResponse } from '../types/api.types';
import { omitPath, setPath } from '../utils/object';
import {
  customerFieldLeaves,
  describePgsRule,
  evaluatePgsRule,
  isPlaceholder,
  standardRule,
  type RegexSend,
} from './pgs-rules';
import {
  markChallengeReshown,
  challengeReshownObserved,
  type TransactionResult,
} from './transaction-flow';

/**
 * Assertions for uploaded cases (regex / edge cases). Kept out of the specs so
 * optional sheet columns don't turn into conditionals inside the tests.
 */

export interface RegexCaseInput {
  readonly id: string;
  readonly bank?: string | undefined;
  readonly field: string;
  readonly value: string;
  /** How the value is sent – text (default), empty string, JSON null or the field left out. */
  readonly send?: RegexSend | undefined;
  readonly expectation: 'valid' | 'invalid' | 'observe' | 'auto';
  readonly country?: string | undefined;
  readonly regex?: string | undefined;
}

export interface RegexContext {
  readonly usedBank: string;
  /** Customer country of the request (per-country rules). */
  readonly country: string;
  readonly rules: Readonly<Record<string, string>>;
  readonly bank: BankTransaction | undefined;
}

export interface RegexJudgement {
  /** What the case must show: reaches the PSP unchanged / does not reach it / record only. */
  readonly expectation: 'valid' | 'invalid' | 'observe';
  /** valid / invalid could not be decided: no bank regex and no standard rule applies. */
  readonly noRule: boolean;
  /** The tested value (for blank cases: an empty / null value) reached the PSP. */
  readonly reached: boolean;
  /** Where it was found in the PSP request. */
  readonly hits: readonly string[];
  /** Annotations for the report, in order. */
  readonly notes: readonly (readonly [string, string])[];
}

const sendOf = (c: Pick<RegexCaseInput, 'send'>): RegexSend => c.send ?? 'value';

/** Test value as the report shows it. */
export function describeRegexValue(c: Pick<RegexCaseInput, 'send' | 'value' | 'field'>): string {
  switch (sendOf(c)) {
    case 'empty':
      return '"" (empty)';
    case 'null':
      return 'null';
    case 'missing':
      return '(field not sent)';
    case 'value':
      return String(
        (maskSensitiveData({ [c.field]: c.value }) as Record<string, unknown>)[c.field],
      );
  }
}

const normalise = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
const digits = (s: string): string => s.replace(/\D/g, '');
const isBlankText = (s: string): boolean => s.trim() === '' || /^null$/i.test(s.trim());
const MIDDLE_NAME = /^m(iddle)?_?name$/i;

/**
 * Decides a regex case after the payment, from the PSP request only (pure – no assertions):
 * 1. the product standard (`standardRule`): blank values, and placeholders in full_name,
 *    must never reach the PSP – with or without a bank regex;
 * 2. otherwise the bank's live Field Regex (PGS port): a matching value must reach the PSP
 *    unchanged, a non-matching one must not;
 * 3. an explicit Valid / Invalid in the sheet wins over both (a conflict is noted).
 * Only the field's own keys in the PSP request are looked at (not the whole payload).
 */
export function judgeRegexCase(regexCase: RegexCaseInput, context: RegexContext): RegexJudgement {
  const notes: [string, string][] = [];
  const send = sendOf(regexCase);
  const shown = describeRegexValue(regexCase);
  notes.push(['test value', `${regexCase.field} = ${shown}`]);
  notes.push(['bank', context.usedBank || '(no PSP request)']);

  const pattern = context.rules[regexCase.field];
  const country = regexCase.country ?? context.country;
  const sentText = send === 'value' ? regexCase.value : send === 'empty' ? '' : null;
  const pgs =
    pattern === undefined
      ? undefined
      : evaluatePgsRule(regexCase.field, sentText, pattern, country);
  notes.push([
    'regex',
    pattern === undefined
      ? `(no regex for ${regexCase.field} on this bank)`
      : describePgsRule(pattern, country, regexCase.field),
  ]);
  if (regexCase.regex !== undefined && pattern !== undefined && regexCase.regex !== pattern) {
    notes.push([
      'rule changed',
      'The regex changed since this case was created – the live rule is used',
    ]);
  }
  if (pgs) {
    notes.push([
      'regex result',
      `${pgs.verdict === 'valid' ? 'value matches the rule' : 'value does not match the rule'}${pgs.note ? ` · ${pgs.note}` : ''}`,
    ]);
  }
  const standard = standardRule(regexCase.field, send, regexCase.value);
  if (standard !== undefined) notes.push(['standard rule', standard]);

  let expectation: 'valid' | 'invalid' | 'observe';
  let noRule = false;
  if (regexCase.expectation === 'auto') {
    if (standard !== undefined) expectation = 'invalid';
    else if (pgs !== undefined) expectation = pgs.verdict;
    else {
      expectation = 'observe';
      noRule = true;
    }
  } else {
    expectation = regexCase.expectation;
    const ruled = standard !== undefined ? 'invalid' : pgs?.verdict;
    if (expectation !== 'observe' && ruled !== undefined && ruled !== expectation) {
      notes.push(['sheet vs rule', `Sheet says ${expectation} but the rule says ${ruled}`]);
    }
  }

  const leaves = customerFieldLeaves(context.bank, regexCase.field);
  if (expectation !== 'observe' && context.bank !== undefined && leaves.length === 0) {
    notes.push([
      'not sent to this PSP',
      `The PSP request has no ${regexCase.field} field – the rule cannot be seen from the PSP side`,
    ]);
    expectation = 'observe';
  }

  const blank = send !== 'value' || regexCase.value.trim() === '';
  let hits: string[];
  if (blank) {
    // Blank input: did an empty / null value (or a name placeholder) reach the PSP?
    hits = leaves
      .filter((l) => !(regexCase.field === 'full_name' && MIDDLE_NAME.test(l.key)))
      .filter(
        (l) => isBlankText(l.value) || (regexCase.field === 'full_name' && isPlaceholder(l.value)),
      )
      .map((l) => `${l.path}="${l.value}"`);
  } else {
    const wanted =
      pgs?.verdict === 'valid' && pgs.sentValue !== null ? pgs.sentValue : regexCase.value;
    const isPhone = regexCase.field === 'phone';
    const same = (text: string): boolean =>
      isPhone
        ? digits(wanted).length >= 7 &&
          digits(text).length >= 7 &&
          (digits(wanted).endsWith(digits(text)) || digits(text).endsWith(digits(wanted)))
        : normalise(text) === normalise(wanted);
    hits = leaves.filter((l) => same(l.value)).map((l) => l.path);
    if (regexCase.field === 'full_name' && hits.length === 0) {
      // A full name split over first / middle / last name fields.
      const parts = leaves.filter((l) =>
        /^(f(irst)?|given|m(iddle)?|l(ast)?|sur|family)_?name$/i.test(l.key),
      );
      const joined = parts.map((l) => l.value).join(' ');
      if (parts.length > 1 && same(joined)) hits = parts.map((l) => l.path);
    }
  }
  const reached = hits.length > 0;
  const uniqueHits = [...new Set(hits)];
  notes.push([
    'sent to PSP',
    context.bank === undefined
      ? 'no PSP request recorded'
      : blank
        ? reached
          ? `empty / placeholder value sent (${uniqueHits.slice(0, 3).join(', ')})`
          : leaves.length > 0
            ? `a value was filled in (${leaves
                .slice(0, 3)
                .map((l) => l.path)
                .join(', ')})`
            : 'field not in the PSP request'
        : reached
          ? `unchanged (${uniqueHits.slice(0, 3).join(', ')})`
          : 'not sent – replaced or dropped',
  ]);
  notes.push([
    'expected',
    expectation === 'valid'
      ? 'Valid → reaches the PSP unchanged'
      : expectation === 'invalid'
        ? blank
          ? 'Must not reach the PSP empty – rejected at create or replaced by a DB value'
          : 'Invalid → does not reach the PSP (replaced by a DB value)'
        : 'Observe – recorded only',
  ]);
  return { expectation, noRule, reached, hits: uniqueHits, notes };
}

/**
 * Judges a regex case after the payment (see `judgeRegexCase`) and asserts it softly.
 */
export function expectRegexOutcome(
  regexCase: RegexCaseInput,
  context: RegexContext,
  testInfo: TestInfo,
): void {
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
  const judged = judgeRegexCase(regexCase, context);
  for (const [type, description] of judged.notes) testInfo.annotations.push({ type, description });
  const shown = describeRegexValue(regexCase);

  if (judged.noRule) {
    expect
      .soft(
        undefined,
        `No regex configured for ${regexCase.field} on ${context.usedBank || 'the bank'}`,
      )
      .toBeDefined();
    return;
  }
  if (judged.expectation === 'observe') {
    testInfo.annotations.push({ type: 'verdict', description: 'observe' });
    return;
  }
  if (judged.expectation === 'valid') {
    expect.soft(context.bank, 'Valid value, but no PSP request was recorded').toBeDefined();
    expect
      .soft(judged.reached, `Valid ${regexCase.field} ${shown} should reach the PSP unchanged`)
      .toBe(true);
  } else {
    expect
      .soft(
        judged.reached,
        `${regexCase.field} ${shown} should not reach the PSP – got ${judged.hits.join(', ')}`,
      )
      .toBe(false);
  }
}

/**
 * A blank value covered by the standard rule may be refused when the purchase is created
 * (street / city / zip / e-mail …) – then it can never reach the PSP and the case passes.
 * Records why and returns true; false when the purchase must have been created.
 */
export function rejectedBeforePsp(
  regexCase: Pick<RegexCaseInput, 'field' | 'value' | 'send'>,
  created: Pick<ApiResponse, 'ok' | 'status' | 'text'>,
  testInfo: TestInfo,
): boolean {
  if (created.ok || created.status < 400 || created.status >= 500) return false;
  if ([401, 403].includes(created.status)) return false;
  const send = sendOf(regexCase);
  const blank = send !== 'value' || regexCase.value.trim() === '';
  const standard = standardRule(regexCase.field, send, regexCase.value);
  if (!blank || standard === undefined) return false;
  testInfo.annotations.push(
    { type: 'standard rule', description: standard },
    {
      type: 'sent to PSP',
      description: `never – the purchase was rejected at create (HTTP ${String(created.status)}: ${created.text.slice(0, 200)})`,
    },
  );
  return true;
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
  if (challengeReshownObserved(result, expected)) {
    markChallengeReshown(result, testInfo);
  } else if (expected.outcome !== undefined) {
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

/** Purchase request for a regex case: the case's customer country (per-country rules) and value. */
export function regexCaseRequest(
  base: Record<string, unknown>,
  regexCase: {
    readonly path: string;
    readonly value: string;
    readonly send?: RegexSend | undefined;
    readonly country?: string | undefined;
  },
): { request: Record<string, unknown>; country: string } {
  const client = (base.client ?? {}) as Record<string, unknown>;
  const country = regexCase.country ?? (typeof client.country === 'string' ? client.country : 'AT');
  const withCountry = setPath(base, 'client.country', country);
  switch (regexCase.send ?? 'value') {
    case 'missing':
      return { request: omitPath(withCountry, regexCase.path), country };
    case 'null':
      return { request: setPath(withCountry, regexCase.path, null), country };
    case 'empty':
      return { request: setPath(withCountry, regexCase.path, ''), country };
    case 'value':
      return { request: setPath(withCountry, regexCase.path, regexCase.value), country };
  }
}
