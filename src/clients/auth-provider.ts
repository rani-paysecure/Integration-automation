import type { APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { ContentType, Headers } from '../constants/http';
import type { AuthConfig } from '../types/config.types';
import type { Logger } from '../utils/logger';
import { joinUrl } from '../utils/url';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default('Bearer'),
  expires_in: z.number().positive().default(300),
});

/** Refresh the token this many ms before it actually expires. */
const EXPIRY_SKEW_MS = 30_000;

export type AuthMode = 'oauth-client-credentials' | 'api-key' | 'none';

/**
 * Supplies authentication headers for API clients.
 *
 * - OAuth2 client credentials when CLIENT_ID, CLIENT_SECRET and AUTH_TOKEN_PATH are set
 *   (token cached and refreshed per worker).
 * - Otherwise an API-key header when API_KEY is set.
 * - Otherwise no auth headers.
 */
export class AuthProvider {
  private token: { value: string; type: string; expiresAt: number } | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly request: APIRequestContext,
    private readonly apiBaseUrl: string,
    private readonly auth: AuthConfig,
    private readonly logger: Logger,
    private readonly timeoutMs: number,
  ) {}

  get mode(): AuthMode {
    if (this.auth.clientId && this.auth.clientSecret && this.auth.tokenPath) {
      return 'oauth-client-credentials';
    }
    if (this.auth.apiKey) return 'api-key';
    return 'none';
  }

  /** Headers to attach to an authenticated request. */
  async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (this.auth.apiKey) {
      const prefix = this.auth.apiKeyPrefix;
      headers[this.auth.apiKeyHeader] =
        prefix === undefined ? this.auth.apiKey : `${prefix} ${this.auth.apiKey}`;
    }
    if (this.mode === 'oauth-client-credentials') {
      headers[Headers.AUTHORIZATION] = await this.getBearerToken();
    }
    return headers;
  }

  private async getBearerToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - EXPIRY_SKEW_MS) {
      return `${this.token.type} ${this.token.value}`;
    }
    this.inFlight ??= this.fetchToken().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret, tokenPath } = this.auth;
    if (!clientId || !clientSecret || !tokenPath) {
      throw new Error('OAuth client credentials are not fully configured.');
    }
    const url = joinUrl(this.apiBaseUrl, tokenPath);
    this.logger.info(`Requesting access token (client credentials) from ${tokenPath}`);

    const response = await this.request.post(url, {
      headers: { [Headers.CONTENT_TYPE]: ContentType.FORM, [Headers.ACCEPT]: ContentType.JSON },
      form: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
      timeout: this.timeoutMs,
      failOnStatusCode: false,
    });

    if (!response.ok()) {
      // Never include the response body – it may echo credentials.
      throw new Error(
        `Token request failed with HTTP ${response.status()} ${response.statusText()}. ` +
          'Check CLIENT_ID / CLIENT_SECRET / AUTH_TOKEN_PATH for the selected environment.',
      );
    }

    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(
        `Token response did not match the expected shape: ${z.prettifyError(parsed.error)}`,
      );
    }

    const { access_token, token_type, expires_in } = parsed.data;
    const type = token_type.toLowerCase() === 'bearer' ? 'Bearer' : token_type;
    this.token = { value: access_token, type, expiresAt: Date.now() + expires_in * 1000 };
    this.logger.info(`Access token acquired (expires in ${expires_in}s)`);
    return `${type} ${access_token}`;
  }
}
