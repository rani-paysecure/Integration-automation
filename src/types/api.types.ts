import type { APIResponse } from '@playwright/test';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type QueryParams = Readonly<Record<string, string | number | boolean>>;

export interface RequestOptions {
  /** Query-string parameters. */
  readonly params?: QueryParams;
  /** Extra headers for this request only (override defaults). */
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON body (serialised automatically). */
  readonly data?: unknown;
  /** URL-encoded form body. Mutually exclusive with `data`. */
  readonly form?: Readonly<Record<string, string | number | boolean>>;
  /** Per-request timeout override (ms). */
  readonly timeoutMs?: number;
  /** Send the request without authentication headers (negative auth tests). */
  readonly skipAuth?: boolean;
}

/** Normalised response returned by every API client call. */
export interface ApiResponse<TBody = unknown> {
  readonly method: HttpMethod;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body (or raw text when the body is not JSON). Not validated – use `toMatchSchema`. */
  readonly body: TBody;
  readonly text: string;
  readonly durationMs: number;
  /** Underlying Playwright response for advanced use. */
  readonly raw: APIResponse;
}

/** A masked request/response pair, safe to log or attach to reports. */
export interface HttpExchange {
  readonly timestamp: string;
  readonly request: {
    readonly method: HttpMethod;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
  };
  readonly response?: {
    readonly status: number;
    readonly statusText: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly durationMs: number;
  };
  readonly error?: string;
}

export type ExchangeListener = (exchange: HttpExchange) => void;
