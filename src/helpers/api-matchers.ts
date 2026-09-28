import { expect as baseExpect, type ExpectMatcherState } from '@playwright/test';
import { z } from 'zod';
import type { ApiResponse } from '../types/api.types';
import { maskSensitiveData } from '../utils/masking';

const BODY_PREVIEW_CHARS = 2_000;

function isApiResponse(value: unknown): value is ApiResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'method' in value &&
    'url' in value
  );
}

/** Short, masked description of a response for failure messages. */
function describe(response: ApiResponse): string {
  const body = JSON.stringify(maskSensitiveData(response.body), null, 2);
  const preview =
    body.length > BODY_PREVIEW_CHARS ? `${body.slice(0, BODY_PREVIEW_CHARS)}… (truncated)` : body;
  return `${response.method} ${response.url}\nStatus: ${response.status} ${response.statusText}\nBody: ${preview}`;
}

function result(
  state: ExpectMatcherState,
  name: string,
  pass: boolean,
  message: () => string,
  expected?: unknown,
  actual?: unknown,
) {
  return {
    name,
    pass,
    expected,
    actual,
    message: () => `${state.isNot ? '[negated] ' : ''}${message()}`,
  };
}

/**
 * API-focused matchers registered via Playwright's `expect.extend`.
 * Usage: `expect(response).toHaveStatus(201)`.
 */
export const expect = baseExpect.extend({
  toHaveStatus(received: ApiResponse, expected: number | readonly number[]) {
    const allowed = typeof expected === 'number' ? [expected] : [...expected];
    const pass = allowed.includes(received.status);
    return result(
      this,
      'toHaveStatus',
      pass,
      () =>
        `Expected HTTP status ${this.isNot ? 'not ' : ''}${allowed.join(' | ')} but received ${received.status}.\n${describe(received)}`,
      allowed,
      received.status,
    );
  },

  toMatchSchema(received: unknown, schema: z.ZodType) {
    const target = isApiResponse(received) ? received.body : received;
    const parsed = schema.safeParse(target);
    return result(this, 'toMatchSchema', parsed.success, () =>
      parsed.success
        ? 'Expected value not to match the schema, but it did.'
        : `Response body does not match schema:\n${z.prettifyError(parsed.error)}` +
          (isApiResponse(received) ? `\n\n${describe(received)}` : ''),
    );
  },

  toHaveHeader(received: ApiResponse, name: string, expected?: string | RegExp) {
    const actual = received.headers[name.toLowerCase()];
    const pass =
      actual !== undefined &&
      (expected === undefined ||
        (typeof expected === 'string' ? actual === expected : expected.test(actual)));
    return result(
      this,
      'toHaveHeader',
      pass,
      () =>
        `Expected header "${name}"${expected === undefined ? '' : ` = ${String(expected)}`} ` +
        `but received ${actual === undefined ? '(missing)' : `"${actual}"`}.\n${received.method} ${received.url}`,
      expected,
      actual,
    );
  },

  toRespondWithin(received: ApiResponse, maxMs: number) {
    const pass = received.durationMs <= maxMs;
    return result(
      this,
      'toRespondWithin',
      pass,
      () =>
        `Expected response within ${maxMs} ms but it took ${received.durationMs} ms.\n${received.method} ${received.url}`,
      maxMs,
      received.durationMs,
    );
  },
});
