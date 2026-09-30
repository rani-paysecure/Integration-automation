import os from 'node:os';
import type { Browser, Page } from '@playwright/test';
import path from 'node:path';
import { FileSessionStore, type StorageState } from '@clients/backoffice-session';
import { BackofficeClient } from '@clients/backoffice-client';
import { HealthApiClient } from '@clients/health-api-client';
import { PaymentApiClient } from '@clients/payment-api-client';
import { PurchaseApiClient } from '@clients/purchase-api-client';
import { currentDevice, deviceContextOptions } from '@pages/devices';
import { expect, test as baseTest } from './test.fixture';

interface ApiClientFixtures {
  /** Opens a cashier page; the browser starts only when a payment is actually made. */
  openCashierPage: () => Promise<Page>;
  paymentApi: PaymentApiClient;
  healthApi: HealthApiClient;
  purchaseApi: PurchaseApiClient;
}

interface WorkerClientFixtures {
  /** Logged-in back-office (dashboard) session – one per worker, read-only. */
  backoffice: BackofficeClient;
}

/** Host serving Reports → Transaction Log per environment (shares the DB with test4). */
const DEFAULT_TRANSLOG_URL: Record<string, string | undefined> = {
  uat: 'https://staging.paysecure.net',
};

/**
 * Test object with ready-to-use API clients.
 * Register new clients here – tests should never build HTTP calls themselves.
 */
export const test = baseTest.extend<ApiClientFixtures, WorkerClientFixtures>({
  openCashierPage: async ({ playwright, testConfig }, use) => {
    let browser: Browser | undefined;
    await use(async () => {
      browser ??= await playwright.chromium.launch({
        headless: !testConfig.transaction.headed,
        ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
      });
      // Device chosen on the launcher's Run tab (RUN_DEVICE) – desktop by default.
      const context = await browser.newContext(deviceContextOptions(currentDevice()));
      return context.newPage();
    });
    await browser?.close();
  },
  paymentApi: async ({ apiClientOptions }, use) => {
    await use(new PaymentApiClient(apiClientOptions));
  },
  healthApi: async ({ apiClientOptions }, use) => {
    await use(new HealthApiClient(apiClientOptions));
  },
  purchaseApi: async ({ apiClientOptions }, use) => {
    await use(new PurchaseApiClient(apiClientOptions));
  },

  backoffice: [
    async ({ playwright, testConfig, workerLogger }, use) => {
      const { baseUrl, username, password } = testConfig.backoffice;
      const env = testConfig.env.toUpperCase();
      // Missing settings only fail tests that actually use the back-office.
      const missing =
        baseUrl === undefined
          ? `${env}_BASE_URL (dashboard URL) is not set.`
          : username === undefined || password === undefined
            ? `No dashboard login for ${env}. Add dashboard username/password to your tester profile ` +
              `(launcher) or set ${env}_DASHBOARD_USERNAME / ${env}_DASHBOARD_PASSWORD.`
            : undefined;
      // One login per run, shared by all workers (the dashboard allows one session per user).
      const sessionDir =
        process.env.BACKOFFICE_SESSION_DIR ?? path.join(os.tmpdir(), 'backoffice-sessions');
      const userSlug = (username ?? 'none').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const store = new FileSessionStore(
        path.join(sessionDir, `${testConfig.env}-${userSlug}.json`),
      );
      const newContext = (storageState?: StorageState) =>
        // Own context = own cookie jar for the dashboard session.
        playwright.request.newContext(storageState === undefined ? {} : { storageState });
      // Reports → Transaction Log lives on the React dashboard's host (staging for UAT);
      // same login, own session. <ENV>_TRANSLOG_BASE_URL overrides, empty = do not use it.
      const logUrl =
        process.env[`${env}_TRANSLOG_BASE_URL`] ?? DEFAULT_TRANSLOG_URL[testConfig.env];
      const logSource =
        logUrl === undefined || logUrl === ''
          ? undefined
          : new BackofficeClient(
              {
                baseUrl: logUrl,
                logger: workerLogger,
                timeoutMs: testConfig.settings.timeouts.request,
                logBodies: false,
              },
              { username: username ?? '', password: password ?? '' },
              newContext,
              new FileSessionStore(
                path.join(sessionDir, `${testConfig.env}-translog-${userSlug}.json`),
              ),
              missing,
            );
      const client = new BackofficeClient(
        {
          baseUrl: baseUrl ?? 'http://invalid.local',
          logger: workerLogger,
          timeoutMs: testConfig.settings.timeouts.request,
          logBodies: false,
        },
        { username: username ?? '', password: password ?? '' },
        newContext,
        store,
        missing,
        logSource,
      );
      await use(client);
      await client.dispose();
      await logSource?.dispose();
    },
    { scope: 'worker' },
  ],
});

export { expect };
