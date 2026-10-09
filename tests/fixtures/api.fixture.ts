import os from 'node:os';
import type { Browser, Page } from '@playwright/test';
import path from 'node:path';
import { FileSessionStore, type StorageState } from '@clients/backoffice-session';
import { BackofficeClient } from '@clients/backoffice-client';
import { PurchaseApiClient } from '@clients/purchase-api-client';
import { SessionApiClient } from '@clients/session-api-client';
import { currentDevice, deviceContextOptions } from '@pages/devices';
import { expect, test as baseTest } from './test.fixture';

interface ApiClientFixtures {
  /** Opens a cashier page; the browser starts only when a payment is actually made. */
  openCashierPage: () => Promise<Page>;
  purchaseApi: PurchaseApiClient;
  sessionApi: SessionApiClient;
}

interface WorkerClientFixtures {
  /** Logged-in back-office (dashboard) session – one per worker, read-only. */
  backoffice: BackofficeClient;
}

/** Host serving Reports → Transaction Log per environment (shares the DB with test4). */
const DEFAULT_TRANSLOG_URL: Record<string, string | undefined> = {
  // Reports → Transaction Log and Monitoring → PSP Webhook log are React pages served by
  // staging; test4 cannot open them. Same dashboard login.
  uat: 'https://staging.paysecure.net',
  local: 'https://staging.paysecure.net',
};

/**
 * Test object with ready-to-use API clients.
 * Register new clients here – tests should never build HTTP calls themselves.
 */
export const test = baseTest.extend<ApiClientFixtures, WorkerClientFixtures>({
  openCashierPage: async ({ playwright, testConfig }, use, testInfo) => {
    let browser: Browser | undefined;
    // Run tab → "Record payment video": the cashier → 3DS → redirect is recorded and offered
    // once in the report (test-results/ only – deleted after the download / next run).
    const record = process.env.RUN_RECORD_VIDEO === '1';
    const pages: Page[] = [];
    await use(async () => {
      browser ??= await playwright.chromium.launch({
        headless: !testConfig.transaction.headed,
        ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
      });
      // Device chosen on the launcher's Run tab (RUN_DEVICE) – desktop by default.
      const device = deviceContextOptions(currentDevice());
      const context = await browser.newContext({
        ...device,
        ...(record
          ? {
              recordVideo: {
                dir: testInfo.outputPath('video'),
                size: device.viewport ?? { width: 1280, height: 720 },
              },
            }
          : {}),
      });
      const page = await context.newPage();
      pages.push(page);
      return page;
    });
    if (record) {
      for (const [i, page] of pages.entries()) {
        const video = page.video();
        if (video === null) continue;
        await page
          .context()
          .close()
          .catch(() => undefined); // finishes the file
        const file = await video.path().catch(() => '');
        if (file !== '') {
          await testInfo.attach(
            pages.length > 1 ? `payment-video-${String(i + 1)}.webm` : 'payment-video.webm',
            {
              path: file,
              contentType: 'video/webm',
            },
          );
        }
      }
    }
    await browser?.close();
  },
  purchaseApi: async ({ apiClientOptions }, use) => {
    await use(new PurchaseApiClient(apiClientOptions));
  },
  sessionApi: async ({ apiClientOptions }, use) => {
    await use(new SessionApiClient(apiClientOptions));
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
      // Transaction Log + PSP Webhook log live on the React dashboard's host (staging);
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
