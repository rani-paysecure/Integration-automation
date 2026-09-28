import { test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { ContentType, Headers } from '../constants/http';
import type {
  ApiResponse,
  ExchangeListener,
  HttpExchange,
  HttpMethod,
  RequestOptions,
} from '../types/api.types';
import type { Logger } from '../utils/logger';
import { maskHeaders, maskSensitiveData, maskUrl } from '../utils/masking';
import { joinUrl } from '../utils/url';
import { ApiRequestError } from './api-error';

export type AuthHeaderProvider = () => Promise<Record<string, string>>;

export interface BaseApiClientOptions {
  readonly request: APIRequestContext;
  readonly baseUrl: string;
  readonly logger: Logger;
  readonly timeoutMs: number;
  readonly logBodies: boolean;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly authHeaders?: AuthHeaderProvider;
  /** Receives a masked copy of every request/response (used for report attachments). */
  readonly onExchange?: ExchangeListener;
}

const MAX_LOGGED_BODY_CHARS = 10_000;

/**
 * Shared HTTP layer for all API clients.
 *
 * Responsibilities: URL building, default + auth headers, JSON/form bodies,
 * response parsing, masked logging, report steps and transport-error wrapping.
 * Domain clients extend this class and expose intention-revealing methods.
 */
export abstract class BaseApiClient {
  protected readonly logger: Logger;

  protected constructor(protected readonly options: BaseApiClientOptions) {
    this.logger = options.logger;
  }

  /** Request context used for every call (overridable, e.g. to swap cookie jars). */
  protected requestContext(): APIRequestContext {
    return this.options.request;
  }

  protected get<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('GET', path, options);
  }

  protected post<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('POST', path, options);
  }

  protected put<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('PUT', path, options);
  }

  protected patch<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('PATCH', path, options);
  }

  protected delete<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('DELETE', path, options);
  }

  private async buildHeaders(options: RequestOptions): Promise<Record<string, string>> {
    const auth =
      options.skipAuth === true || !this.options.authHeaders
        ? {}
        : await this.options.authHeaders();
    const contentType = options.form ? ContentType.FORM : ContentType.JSON;
    return {
      [Headers.ACCEPT]: ContentType.JSON,
      ...(options.data !== undefined || options.form
        ? { [Headers.CONTENT_TYPE]: contentType }
        : {}),
      ...this.options.defaultHeaders,
      ...auth,
      ...options.headers,
    };
  }

  private async send<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = joinUrl(this.options.baseUrl, path);
    const stepTitle = `${method} ${maskUrl(url)}`;

    return test.step(
      stepTitle,
      async () => {
        const headers = await this.buildHeaders(options);
        const requestLog: HttpExchange['request'] = {
          method,
          url: maskUrl(url),
          headers: maskHeaders(headers),
          ...(this.options.logBodies && options.data !== undefined
            ? { body: maskSensitiveData(options.data) }
            : {}),
          ...(this.options.logBodies && options.form
            ? { body: maskSensitiveData(options.form) }
            : {}),
        };
        this.logger.debug(`→ ${stepTitle}`, requestLog);

        const started = Date.now();
        let raw: APIResponse;
        try {
          raw = await this.requestContext().fetch(url, {
            method,
            headers,
            failOnStatusCode: false,
            timeout: options.timeoutMs ?? this.options.timeoutMs,
            ...(options.params ? { params: { ...options.params } } : {}),
            ...(options.data !== undefined ? { data: options.data } : {}),
            ...(options.form ? { form: { ...options.form } } : {}),
          });
        } catch (error: unknown) {
          const wrapped = new ApiRequestError(method, maskUrl(url), error);
          this.logger.error(wrapped.message);
          this.options.onExchange?.({
            timestamp: new Date(started).toISOString(),
            request: requestLog,
            error: wrapped.message,
          });
          throw wrapped;
        }

        const response = await this.toApiResponse<T>(method, url, raw, Date.now() - started);
        this.record(requestLog, response, started);
        return response;
      },
      { box: true },
    );
  }

  private async toApiResponse<T>(
    method: HttpMethod,
    url: string,
    raw: APIResponse,
    durationMs: number,
  ): Promise<ApiResponse<T>> {
    const text = await raw.text();
    const headers = raw.headers();
    return {
      method,
      url,
      status: raw.status(),
      statusText: raw.statusText(),
      ok: raw.ok(),
      headers,
      body: parseBody(text, headers[Headers.CONTENT_TYPE]) as T,
      text,
      durationMs,
      raw,
    };
  }

  private record(request: HttpExchange['request'], response: ApiResponse, started: number): void {
    const maskedBody = this.options.logBodies
      ? truncate(maskSensitiveData(response.body))
      : undefined;
    const exchange: HttpExchange = {
      timestamp: new Date(started).toISOString(),
      request,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: maskHeaders(response.headers),
        durationMs: response.durationMs,
        ...(maskedBody === undefined ? {} : { body: maskedBody }),
      },
    };

    const summary = `${request.method} ${request.url} → ${response.status} (${response.durationMs} ms)`;
    const brief = maskedBody === undefined ? undefined : { body: maskedBody };
    if (response.status >= 500) {
      this.logger.error(summary, brief);
      this.logger.debug('← response', exchange.response);
    } else if (response.status >= 400) {
      this.logger.warn(summary, brief);
      this.logger.debug('← response', exchange.response);
    } else {
      this.logger.info(summary);
      this.logger.debug('← response', exchange.response);
    }
    this.options.onExchange?.(exchange);
  }
}

function parseBody(text: string, contentType: string | undefined): unknown {
  if (text === '') return undefined;
  const looksJson = contentType?.includes('json') ?? /^\s*[[{]/.test(text);
  if (!looksJson) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function truncate(body: unknown): unknown {
  if (typeof body !== 'string' || body.length <= MAX_LOGGED_BODY_CHARS) return body;
  return `${body.slice(0, MAX_LOGGED_BODY_CHARS)}… [truncated ${body.length - MAX_LOGGED_BODY_CHARS} chars]`;
}
