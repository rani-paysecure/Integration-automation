/* eslint-disable no-console -- one-off run banner */
import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { getEnvironmentSettings, peekUrls, resolveEnvironment } from './test-config';
import { readEnv } from './env-loader';
import { maskUrl } from '../src/utils/masking';

/** Prints which environment the run targets so nobody is surprised. */
/** Per-run folder where workers share the back-office session (removed in teardown). */
export const SESSION_ROOT = path.resolve(__dirname, '..', 'playwright', '.auth', 'backoffice');

function prepareSessionDir(): void {
  // Drop sessions left behind by interrupted runs (they contain session cookies).
  if (fs.existsSync(SESSION_ROOT)) {
    for (const entry of fs.readdirSync(SESSION_ROOT)) {
      const full = path.join(SESSION_ROOT, entry);
      if (Date.now() - fs.statSync(full).mtimeMs > 6 * 3_600_000) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    }
  }
  const runDir = path.join(SESSION_ROOT, `run-${Date.now()}-${process.pid}`);
  fs.mkdirSync(runDir, { recursive: true });
  // Inherited by all workers.
  process.env.BACKOFFICE_SESSION_DIR = runDir;
}

export default function globalSetup(_config: FullConfig): void {
  prepareSessionDir();
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
