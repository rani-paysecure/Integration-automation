import { defineConfig, devices } from '@playwright/test';
import { getEnvironmentSettings, peekUrls, resolveEnvironment } from './config/test-config';

/**
 * Environment is selected with TEST_ENV (local | uat). Default: uat.
 * Use `npm run test:local` / `npm run test:uat` (cross-platform via cross-env).
 */
const env = resolveEnvironment();
const settings = getEnvironmentSettings(env);
const { baseUrl } = peekUrls(env);
const isCI = Boolean(process.env.CI);

type TraceMode = 'on' | 'off' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries';
const TRACE_MODES: readonly TraceMode[] = [
  'on',
  'off',
  'retain-on-failure',
  'on-first-retry',
  'on-all-retries',
];

/**
 * Playwright traces store raw, UNMASKED request headers and bodies (API keys,
 * tokens, card data). They are therefore kept locally on failure but disabled
 * in CI, where artifacts are shared. The masked `http-exchanges.json`
 * attachment is always added to failed tests instead.
 * Override explicitly with PW_TRACE=<mode> when you really need a trace.
 */
const traceOverride = TRACE_MODES.find((mode) => mode === process.env.PW_TRACE);
const trace: TraceMode = traceOverride ?? (isCI ? 'off' : 'retain-on-failure');

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: './config/global-setup.ts',
  globalTeardown: './config/global-teardown.ts',

  timeout: settings.timeouts.test,
  expect: { timeout: settings.timeouts.expect },

  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? settings.retries.ci : settings.retries.local,
  workers: isCI ? settings.workers.ci : settings.workers.local,

  reporter: [
    [isCI ? 'dot' : 'list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['junit', { outputFile: 'reports/junit/results.xml' }],
    ['json', { outputFile: 'reports/json/results.json' }],
    ['./src/reporters/field-test-reporter.ts', { outputDir: 'reports/field-tests' }],
    ['./src/reporters/psp-report-reporter.ts', { outputDir: 'reports/psp-validation' }],
    ['./src/reporters/ui-report-reporter.ts', { outputDir: 'reports/ui' }],
  ],

  metadata: {
    environment: settings.displayName,
  },

  use: {
    // Used by browser-based tests (page.goto('/...')). API clients use API_BASE_URL.
    ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
    trace,
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: settings.timeouts.expect,
    navigationTimeout: settings.timeouts.request,
    ignoreHTTPSErrors: false,
  },

  projects: [
    {
      // Offline self-tests of the framework (config, masking, API client). No env URLs needed.
      name: 'framework',
      testDir: './tests/framework',
    },
    // One project per business flow. Stages inside a flow are numbered spec files
    // (01-api-field-validation, 02-regex-validation, 03-psp-validation, ...).
    {
      // API stages need no browser; the cashier payment stage opens Chrome.
      name: 'cashier-purchase',
      testDir: './tests/flows/cashier-purchase',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PW_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
          : {}),
      },
    },
    {
      // KYC module (/kyc/*): API cases need no browser; the hosted page and the
      // Sumsub WebSDK cases open Chrome. Provider calls are synchronous (Sumsub: up
      // to 3 hops at 60s read timeout), hence the longer test timeout.
      name: 'kyc',
      testDir: './tests/flows/kyc',
      // @slow waits minutes on the expiry poller, @sumsub drives the provider's UI: only when asked
      // (KYC_INCLUDE_SLOW=1 – set by the launcher, whose selection is explicit).
      ...(process.env.KYC_INCLUDE_SLOW === '1' ? {} : { grepInvert: /@slow|@sumsub/ }),
      timeout: Math.max(settings.timeouts.test, 90_000),
      use: {
        ...devices['Desktop Chrome'],
        extraHTTPHeaders: { Accept: 'application/json' },
        ...(process.env.PW_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
          : {}),
      },
    },
    {
      name: 's2s-purchase',
      testDir: './tests/flows/s2s-purchase',
    },
    {
      name: 'session',
      testDir: './tests/flows/session',
    },
    // Browser-based integration tests can be added later, e.g.:
    // {
    //   name: 'e2e-chromium',
    //   testDir: './tests/e2e',
    //   use: { ...devices['Desktop Chrome'] },
    // },
  ],
});
