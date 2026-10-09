import type { TestInfo } from '@playwright/test';
import type { z } from 'zod';
import type { ApiResponse } from '../types/api.types';
import { omitPath, setPath } from '../utils/object';
import { expect } from './api-matchers';

/**
 * Generic engine for data-driven field validation tests.
 *
 * Expectation types
 * - accepted   → request must succeed (2xx)
 * - rejected   → request must fail with a 4xx validation error (401/403 = auth problem → fail)
 * - observe    → spec not fixed yet ("if mandatory", "according to specification"):
 *                any non-5xx result passes and the actual behaviour is recorded
 * - sanitized  → injection attempts: 4xx, or 2xx without the raw payload echoed back
 * A 5xx is always a failure – invalid input must never crash the API.
 */
export type FieldExpectation = 'accepted' | 'rejected' | 'observe' | 'sanitized';

export type FieldMutation =
  | { readonly type: 'set'; readonly value: unknown }
  | { readonly type: 'remove' }
  | { readonly type: 'none' };

export interface FieldTestCase {
  readonly id: string;
  /** Parameter name as written in the test-case sheet. */
  readonly parameter: string;
  /** Dotted path in the request body that is mutated (numeric segments = array index). */
  readonly path: string;
  readonly title: string;
  readonly mutation: FieldMutation;
  /** Additional fields set first for context (e.g. country for country-specific rules). */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly expectation: FieldExpectation;
  /** "Expected Result" text from the sheet. */
  readonly expectedResult: string;
  /** Present when the case cannot be fully verified via the API alone. */
  readonly apiNote?: string;
  /** Cases that only make sense in the cashier UI are skipped in the API run. */
  readonly cashierOnly?: boolean;
}

/** Annotation types read by `src/reporters/field-test-reporter.ts`. */
export const FIELD_CASE_ANNOTATION = 'field-case';
export const FIELD_RESULT_ANNOTATION = 'field-result';
/** PSP answer of a paid field case ("PSP answered … → payment PASSED / FAILED") – the case's remarks. */
export const FIELD_PSP_RESPONSE_ANNOTATION = 'psp response';
/** Rule of a "customer data at the PSP" case (Field validation sub-category). */
export const FIELD_PSP_RULE_ANNOTATION = 'psp rule';

export interface FieldCaseMeta {
  readonly id: string;
  readonly parameter: string;
  readonly title: string;
  readonly testData: string;
  readonly expectation: FieldExpectation;
  readonly expectedResult: string;
  readonly note: string;
}

export interface FieldResultMeta {
  readonly httpStatus: number;
  readonly errorCode: string;
  readonly message: string;
  readonly status: string;
  readonly resourceId: string;
  readonly durationMs: number;
}

const SUCCESS = [200, 201, 202] as const;
const AUTH_FAILURES = [401, 403];

export function describeTestData(testCase: FieldTestCase): string {
  const { mutation, context } = testCase;
  const value =
    mutation.type === 'remove'
      ? '(field not sent)'
      : mutation.type === 'none'
        ? '(baseline value)'
        : JSON.stringify(mutation.value);
  const contextText =
    context === undefined
      ? ''
      : ` | ${Object.entries(context)
          .map(([key, entry]) => `${key}=${JSON.stringify(entry)}`)
          .join(', ')}`;
  return `${value}${contextText}`;
}

/** Static metadata, attached when the test is declared (so skipped cases are reported too). */
export function fieldCaseAnnotation(testCase: FieldTestCase): {
  type: string;
  description: string;
} {
  const meta: FieldCaseMeta = {
    id: testCase.id,
    parameter: testCase.parameter,
    title: testCase.title,
    testData: describeTestData(testCase),
    expectation: testCase.expectation,
    expectedResult: testCase.expectedResult,
    note: testCase.apiNote ?? '',
  };
  return { type: FIELD_CASE_ANNOTATION, description: JSON.stringify(meta) };
}

/** Applies context fields, then the case mutation, to a clone of the baseline request. */
export function applyFieldCase(baseline: object, testCase: FieldTestCase): Record<string, unknown> {
  let request = { ...(structuredClone(baseline) as Record<string, unknown>) };
  for (const [path, value] of Object.entries(testCase.context ?? {})) {
    request = setPath(request, path, value);
  }
  switch (testCase.mutation.type) {
    case 'set':
      return setPath(request, testCase.path, testCase.mutation.value);
    case 'remove':
      return omitPath(request, testCase.path);
    case 'none':
      return request;
  }
}

function readErrorField(body: unknown, key: string): string {
  if (typeof body === 'object' && body !== null && key in body) {
    const value = (body as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return '';
}

/** Records the actual API behaviour on the test (shown in HTML report + field-test CSV). */
export function recordFieldResult(testInfo: TestInfo, response: ApiResponse): void {
  const meta: FieldResultMeta = {
    httpStatus: response.status,
    errorCode: readErrorField(response.body, 'code'),
    message: readErrorField(response.body, 'message'),
    status: readErrorField(response.body, 'status'),
    resourceId: readErrorField(response.body, 'purchaseId') || readErrorField(response.body, 'id'),
    durationMs: response.durationMs,
  };
  testInfo.annotations.push({ type: FIELD_RESULT_ANNOTATION, description: JSON.stringify(meta) });
}

export interface VerifyOptions {
  /** Schema every accepted (2xx) response must match. */
  readonly successSchema?: z.ZodType;
}

/** Asserts the response against the case expectation. */
export function verifyFieldExpectation(
  response: ApiResponse,
  testCase: FieldTestCase,
  options: VerifyOptions = {},
): void {
  const label = `${testCase.id} ${testCase.parameter} – ${testCase.title}`;
  expect(response.status, `${label}: server error on invalid input`).toBeLessThan(500);

  switch (testCase.expectation) {
    case 'accepted':
      expect(response).toHaveStatus(SUCCESS);
      if (options.successSchema) expect(response).toMatchSchema(options.successSchema);
      return;
    case 'rejected':
      expect(AUTH_FAILURES, `${label}: got an auth error, not a validation error`).not.toContain(
        response.status,
      );
      expect(response.status, `${label}: expected a 4xx validation error`).toBeGreaterThanOrEqual(
        400,
      );
      expect(readErrorField(response.body, 'message'), `${label}: error message`).not.toBe('');
      return;
    case 'sanitized':
      if (response.ok && testCase.mutation.type === 'set') {
        expect(response.text, `${label}: raw injection payload echoed back`).not.toContain(
          String(testCase.mutation.value),
        );
      }
      return;
    case 'observe':
      return;
  }
}

// ── payment-method fields (extraParam.*, upiId, invoiceNo, …) ─────────────────

/** Request fields every purchase has – anything else at the top level is payment-method specific. */
const STANDARD_TOP_LEVEL = new Set([
  'client',
  'purchase',
  'brand_id',
  'paymentMethod',
  'success_redirect',
  'pending_redirect',
  'failure_redirect',
  'success_callback',
  'failure_callback',
]);

/** extraParam (any key) or another payment-method-specific top-level field. */
export function isPaymentMethodField(path: string): boolean {
  const top = path.split('.')[0] ?? '';
  return top === 'extraParam' || (!path.includes('.') && !STANDARD_TOP_LEVEL.has(top));
}

/** Payment method a case runs with: `paymentMethod` in its context, else undefined (run's). */
export function casePaymentMethod(testCase: FieldTestCase): string | undefined {
  const value = testCase.context?.paymentMethod;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function valueAt(body: unknown, path: string): unknown {
  let node: unknown = body;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Accepted payment-method fields must be stored as sent: PGS echoes the purchase,
 * so the value at the same path in the answer must equal the request (numbers sent
 * for text fields like upiId come back as text – compared as text then).
 */
export function expectStoredAsSent(response: ApiResponse, testCase: FieldTestCase): void {
  if (!response.ok || testCase.mutation.type !== 'set' || !isPaymentMethodField(testCase.path))
    return;
  const sent = testCase.mutation.value;
  const stored = valueAt(response.body, testCase.path);
  const same =
    JSON.stringify(stored) === JSON.stringify(sent) ||
    (typeof sent === 'number' && stored === String(sent));
  expect
    .soft(
      same,
      `${testCase.path} stored as sent: sent ${JSON.stringify(sent)}, stored ${JSON.stringify(stored)}`,
    )
    .toBe(true);
}
