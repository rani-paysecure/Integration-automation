import { errorResponseSchema } from '../schemas/common.schema';
import type { ApiResponse } from '../types/api.types';
import { expect } from './api-matchers';

/**
 * Asserts that every dotted path exists on the body (e.g. `paymentMethod.type`).
 * Uses soft assertions so all missing fields are reported at once.
 */
export function expectRequiredFields(body: unknown, fields: readonly string[]): void {
  for (const field of fields) {
    expect.soft(body, `Missing required field "${field}"`).toHaveProperty(field);
  }
}

export interface ExpectedApiError {
  readonly status: number | readonly number[];
  readonly code?: string;
  /** Substring or pattern the error message must contain. */
  readonly message?: string | RegExp;
  /** Field that must be reported in `details`. */
  readonly field?: string;
}

/** Validates a standard error response: status, envelope schema, code, message and field. */
export function expectApiError(response: ApiResponse, expected: ExpectedApiError): void {
  expect(response).toHaveStatus(expected.status);
  expect(response).toMatchSchema(errorResponseSchema);

  const body = errorResponseSchema.parse(response.body);
  if (expected.code !== undefined) {
    expect(body.code, 'error code').toBe(expected.code);
  }
  if (expected.message !== undefined) {
    if (typeof expected.message === 'string') {
      expect(body.message, 'error message').toContain(expected.message);
    } else {
      expect(body.message, 'error message').toMatch(expected.message);
    }
  }
  if (expected.field !== undefined) {
    const fields = (body.details ?? []).map((detail) => detail.field);
    expect(fields, 'fields reported in error details').toContain(expected.field);
  }
}
