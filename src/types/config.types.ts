/**
 * The ONLY environments this framework may target.
 * There is deliberately no production entry – do not add one.
 */
export const SUPPORTED_ENVIRONMENTS = ['local', 'uat'] as const;

export type TestEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Non-secret, version-controlled settings that differ per environment. */
export interface EnvironmentSettings {
  readonly name: TestEnvironment;
  readonly displayName: string;
  readonly timeouts: {
    /** Max duration of a single test (ms). */
    readonly test: number;
    /** Max duration of a single `expect` with polling / auto-retry (ms). */
    readonly expect: number;
    /** Max duration of a single HTTP request (ms). */
    readonly request: number;
  };
  readonly retries: { readonly local: number; readonly ci: number };
  readonly workers: { readonly local: number | string; readonly ci: number | string };
  /**
   * Whether tests that create/alter data irreversibly (refunds, voids, etc.)
   * may run. Tests should `test.skip()` when this is false.
   */
  readonly allowDestructiveTests: boolean;
  /** Extra headers sent with every API request in this environment. */
  readonly defaultHeaders: Readonly<Record<string, string>>;
}

export interface AuthConfig {
  readonly apiKey: string | undefined;
  readonly apiKeyHeader: string;
  /** Optional scheme placed before the key, e.g. `Bearer` → `Authorization: Bearer <key>`. */
  readonly apiKeyPrefix: string | undefined;
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  /** Relative token endpoint path (OAuth2 client credentials). */
  readonly tokenPath: string | undefined;
}

/** Fully-resolved configuration consumed by fixtures and clients. */
export interface TestConfig {
  readonly env: TestEnvironment;
  readonly settings: EnvironmentSettings;
  readonly baseUrl: string | undefined;
  readonly apiBaseUrl: string;
  readonly auth: AuthConfig;
  readonly logging: {
    readonly level: LogLevel;
    readonly logBodies: boolean;
  };
  /** Merchant context for this run (from the tester profile or env vars). */
  readonly merchant: {
    readonly brandId: string | undefined;
    /** Card scheme sent as `paymentMethod`, e.g. `VISA`. */
    readonly paymentMethod: string;
    /** Currency for the run (RUN_CURRENCY); undefined = purchase template currency. */
    readonly currency: string | undefined;
    /** Bank / PSP the purchase is expected to be routed to (RUN_BANK); undefined = not checked. */
    readonly expectedBank: string | undefined;
  };
  /** Transaction options for the run. */
  readonly transaction: {
    /** Test-card id (settings) used to complete payments for accepted cases (RUN_PAY_CARD). */
    readonly payCardId: string | undefined;
    /** Show the cashier browser (RUN_HEADED=1). */
    readonly headed: boolean;
  };
  /** Back-office dashboard (transactions, PSP logs). Credentials from the tester profile or env. */
  readonly backoffice: {
    readonly baseUrl: string | undefined;
    readonly username: string | undefined;
    readonly password: string | undefined;
  };
  /** Selected tester profile (TEST_PROFILE), if any. */
  readonly profile: { readonly id: string; readonly name: string } | undefined;
}
