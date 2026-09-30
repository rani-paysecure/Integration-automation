import { test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { ExchangeListener, HttpMethod } from '../types/api.types';
import { maskHeaders, maskSensitiveData, maskUrl } from '../utils/masking';
import type { Logger } from '../utils/logger';

export interface KycRequestOptions {
  /** JSON body – or a Buffer, sent byte for byte (signed webhooks). */
  readonly data?: unknown;
  /** Extra headers for this request; `null` removes a default header. */
  readonly headers?: Readonly<Record<string, string | null>>;
  /** 0 = do not follow redirects (redirect / return endpoints). */
  readonly maxRedirects?: number;
}

/**
 * HTTP client for the KYC module (`/kyc/*`, `/api/v1/customer…`) on the environment's
 * base URL (not API_BASE_URL – KYC lives at the root).
 *
 * Returns Playwright's own `APIResponse` so the KYC specs can assert status,
 * headers and body exactly; every call is still logged and recorded (masked)
 * for the report like the other API clients.
 */
export class KycHttp {
  constructor(
    private readonly context: APIRequestContext,
    private readonly options: {
      readonly baseUrl: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly logger: Logger;
      readonly timeoutMs: number;
      readonly onExchange?: ExchangeListener | undefined;
      /** Label in the log / report, e.g. "merchant" or "anonymous". */
      readonly label: string;
    },
  ) {}

  /** The raw header values of this client (e.g. to derive a variant for a negative case). */
  get defaultHeaders(): Readonly<Record<string, string>> {
    return this.options.headers;
  }

  get(path: string, options: KycRequestOptions = {}): Promise<APIResponse> {
    return this.send('GET', path, options);
  }

  post(path: string, options: KycRequestOptions = {}): Promise<APIResponse> {
    return this.send('POST', path, options);
  }

  private async send(
    method: HttpMethod,
    path: string,
    options: KycRequestOptions,
  ): Promise<APIResponse> {
    const url = /^https?:\/\//.test(path)
      ? path
      : `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    for (const [k, v] of Object.entries({ ...this.options.headers, ...options.headers })) {
      if (v !== null) headers[k] = v;
    }
    const title = `${method} ${maskUrl(url)} (${this.options.label})`;
    return test.step(
      title,
      async () => {
        const started = Date.now();
        const requestLog = {
          method,
          url: maskUrl(url),
          headers: maskHeaders(headers),
          ...(options.data === undefined
            ? {}
            : {
                body: maskSensitiveData(
                  Buffer.isBuffer(options.data)
                    ? parseJson(options.data.toString('utf8'))
                    : options.data,
                ),
              }),
        };
        let response: APIResponse;
        try {
          response = await this.context.fetch(url, {
            method,
            headers,
            failOnStatusCode: false,
            timeout: this.options.timeoutMs,
            ...(options.data === undefined ? {} : { data: options.data as string | Buffer }),
            ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.options.onExchange?.({
            timestamp: new Date(started).toISOString(),
            request: requestLog,
            error: message,
          });
          throw error;
        }
        const durationMs = Date.now() - started;
        const text = await response.text();
        const summary = `${title} → ${String(response.status())} (${String(durationMs)} ms)`;
        if (response.status() >= 500) this.options.logger.error(summary);
        else if (response.status() >= 400) this.options.logger.warn(summary);
        else this.options.logger.info(summary);
        this.options.onExchange?.({
          timestamp: new Date(started).toISOString(),
          request: requestLog,
          response: {
            status: response.status(),
            statusText: response.statusText(),
            headers: maskHeaders(response.headers()),
            durationMs,
            body: maskSensitiveData(parseJson(text)),
          },
        });
        return response;
      },
      { box: true },
    );
  }
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length > 2000 ? `${text.slice(0, 2000)}… [truncated]` : text;
  }
}
