import type { HttpMethod } from '../types/api.types';

/**
 * Thrown when a request could not complete at all (DNS, TLS, timeout,
 * connection refused). HTTP error statuses are NOT thrown – they are returned
 * so tests can assert on negative scenarios.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly method: HttpMethod,
    readonly url: string,
    override readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${method} ${url} failed before a response was received: ${reason}`);
    this.name = 'ApiRequestError';
  }
}
