import { z } from 'zod';
import {
  SUPPORTED_ENVIRONMENTS,
  type EnvironmentSettings,
  type LogLevel,
  type TestConfig,
  type TestEnvironment,
} from '../src/types/config.types';
import { loadEnvFiles, readBooleanEnv, readEnv, readFirstEnv } from './env-loader';
import { ConfigurationError } from './errors';
import { resolveProfile } from './profiles';
import { localSettings } from './local/local.config';
import { uatSettings } from './uat/uat.config';

const SETTINGS: Readonly<Record<TestEnvironment, EnvironmentSettings>> = {
  local: localSettings,
  uat: uatSettings,
};

const DEFAULT_ENV: TestEnvironment = 'uat';
const DEFAULT_PAYMENT_METHOD = 'VISA';
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

/**
 * Host-name labels that indicate a live / production system.
 * Used as a safety net so a mis-pasted URL can never be targeted.
 */
const BLOCKED_HOST_LABELS = new Set(['prod', 'production', 'prd', 'live']);

export { ConfigurationError };

function isSupportedEnvironment(value: string): value is TestEnvironment {
  return (SUPPORTED_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Resolves the target environment from `TEST_ENV`.
 * Anything other than `local` or `uat` fails fast.
 */
export function resolveEnvironment(raw?: string): TestEnvironment {
  if (raw === undefined) loadEnvFiles();
  const value = (raw ?? process.env.TEST_ENV ?? '').trim().toLowerCase();
  if (value === '') return DEFAULT_ENV;
  if (!isSupportedEnvironment(value)) {
    throw new ConfigurationError(
      `Unsupported TEST_ENV "${value}". Allowed values: ${SUPPORTED_ENVIRONMENTS.join(', ')}.`,
    );
  }
  return value;
}

export function getEnvironmentSettings(
  env: TestEnvironment = resolveEnvironment(),
): EnvironmentSettings {
  return SETTINGS[env];
}

/**
 * Throws if the URL is not http(s) or looks like a production host.
 * Exported so it can be unit-tested and reused (e.g. for callback URLs).
 */
export function assertSafeTargetUrl(url: string, variableName: string): string {
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(url);
  if (!parsed.success) {
    throw new ConfigurationError(
      `${variableName} must be a valid http(s) URL. Received: "${url}".`,
    );
  }
  const hostname = new URL(url).hostname.toLowerCase();
  const labels = hostname.split(/[.-]/);
  const blocked = labels.find((label) => BLOCKED_HOST_LABELS.has(label));
  if (blocked !== undefined) {
    throw new ConfigurationError(
      `${variableName} (${hostname}) looks like a production host (contains "${blocked}"). ` +
        'This framework only targets LOCAL and UAT.',
    );
  }
  return url.replace(/\/+$/, '');
}

function envPrefix(env: TestEnvironment): string {
  return env.toUpperCase();
}

function resolveLogLevel(): LogLevel {
  const raw = readEnv('LOG_LEVEL')?.toLowerCase();
  return LOG_LEVELS.find((level) => level === raw) ?? 'info';
}

/**
 * Non-throwing lookup of the URLs for the selected environment.
 * Used by `playwright.config.ts`, which must load even when URLs are not set
 * (e.g. when only running the offline `framework` project).
 */
export function peekUrls(env: TestEnvironment = resolveEnvironment()): {
  baseUrl: string | undefined;
  apiBaseUrl: string | undefined;
} {
  loadEnvFiles();
  const prefix = envPrefix(env);
  return {
    baseUrl: readEnv(`${prefix}_BASE_URL`),
    apiBaseUrl: readEnv(`${prefix}_API_BASE_URL`),
  };
}

let cached: TestConfig | undefined;

/**
 * Builds and validates the full configuration for the selected environment.
 * Throws a `ConfigurationError` with an actionable message when required
 * variables are missing or invalid.
 */
export function getTestConfig(): TestConfig {
  if (cached) return cached;

  const env = resolveEnvironment();
  loadEnvFiles();
  const prefix = envPrefix(env);

  const apiBaseUrlVar = `${prefix}_API_BASE_URL`;
  const baseUrlVar = `${prefix}_BASE_URL`;
  const rawApiBaseUrl = readEnv(apiBaseUrlVar);
  if (rawApiBaseUrl === undefined) {
    throw new ConfigurationError(
      `${apiBaseUrlVar} is not set. Add it to your .env file (see .env.example) or export it in your shell/CI.`,
    );
  }
  const rawBaseUrl = readEnv(baseUrlVar);

  // Tester profile (brand ID + API key) takes precedence over .env credentials.
  const profileId = readEnv('TEST_PROFILE');
  const selected = profileId === undefined ? undefined : resolveProfile(profileId, env);
  const paymentMethod = (
    readEnv('PAYMENT_METHOD') ??
    selected?.profile.paymentMethod ??
    DEFAULT_PAYMENT_METHOD
  ).toUpperCase();

  cached = Object.freeze({
    env,
    settings: SETTINGS[env],
    apiBaseUrl: assertSafeTargetUrl(rawApiBaseUrl, apiBaseUrlVar),
    baseUrl: rawBaseUrl === undefined ? undefined : assertSafeTargetUrl(rawBaseUrl, baseUrlVar),
    auth: Object.freeze({
      apiKey: selected?.credentials.apiKey ?? readFirstEnv(`${prefix}_API_KEY`, 'API_KEY'),
      apiKeyHeader: readEnv('API_KEY_HEADER') ?? 'x-api-key',
      apiKeyPrefix: readEnv('API_KEY_PREFIX'),
      clientId: readFirstEnv(`${prefix}_CLIENT_ID`, 'CLIENT_ID'),
      clientSecret: readFirstEnv(`${prefix}_CLIENT_SECRET`, 'CLIENT_SECRET'),
      tokenPath: readEnv('AUTH_TOKEN_PATH'),
    }),
    logging: Object.freeze({
      level: resolveLogLevel(),
      logBodies: readBooleanEnv('LOG_HTTP_BODIES', true),
    }),
    merchant: Object.freeze({
      brandId: selected?.credentials.brandId ?? readFirstEnv(`${prefix}_BRAND_ID`, 'BRAND_ID'),
      paymentMethod,
      currency: readEnv('RUN_CURRENCY')?.toUpperCase(),
      expectedBank: readEnv('RUN_BANK'),
    }),
    transaction: Object.freeze({
      payCardId: readEnv('RUN_PAY_CARD'),
      headed: readBooleanEnv('RUN_HEADED', false),
    }),
    backoffice: Object.freeze({
      baseUrl: rawBaseUrl === undefined ? undefined : assertSafeTargetUrl(rawBaseUrl, baseUrlVar),
      username:
        selected?.credentials.dashboard?.username ?? readEnv(`${prefix}_DASHBOARD_USERNAME`),
      password:
        selected?.credentials.dashboard?.password ?? readEnv(`${prefix}_DASHBOARD_PASSWORD`),
    }),
    profile:
      selected === undefined
        ? undefined
        : Object.freeze({ id: selected.profile.id, name: selected.profile.name }),
  });
  return cached;
}

/** Test-only: clears the memoised configuration. */
export function resetTestConfigCache(): void {
  cached = undefined;
}
