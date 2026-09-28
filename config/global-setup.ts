/* eslint-disable no-console -- one-off run banner */
import type { FullConfig } from '@playwright/test';
import { getEnvironmentSettings, peekUrls, resolveEnvironment } from './test-config';
import { readEnv } from './env-loader';
import { maskUrl } from '../src/utils/masking';

/** Prints which environment the run targets so nobody is surprised. */
export default function globalSetup(_config: FullConfig): void {
  const env = resolveEnvironment();
  const settings = getEnvironmentSettings(env);
  const { apiBaseUrl, baseUrl } = peekUrls(env);
  console.log(
    [
      '',
      '──────────────────────────────────────────────',
      ` Target environment : ${settings.displayName}`,
      ` API base URL       : ${apiBaseUrl ? maskUrl(apiBaseUrl) : '(not set)'}`,
      ` Base URL           : ${baseUrl ? maskUrl(baseUrl) : '(not set)'}`,
      ` Tester profile     : ${readEnv('TEST_PROFILE') ?? '(none – using .env credentials)'}`,
      ` Payment method     : ${(readEnv('PAYMENT_METHOD') ?? 'profile default / VISA').toUpperCase()}`,
      ` Destructive tests  : ${settings.allowDestructiveTests ? 'enabled' : 'disabled'}`,
      '──────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}
