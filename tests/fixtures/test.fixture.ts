import { test as base } from '@playwright/test';
import { getTestConfig } from '@config/test-config';
import { AuthProvider } from '@clients/auth-provider';
import type { BaseApiClientOptions } from '@clients/base-api-client';
import { expect } from '@helpers/api-matchers';
import type { HttpExchange } from '@app-types/api.types';
import type { TestConfig } from '@app-types/config.types';
import { createLogger, type Logger } from '@utils/logger';
import { getEnvironmentData, type EnvironmentTestData } from '@test-data/environments';
import type { MerchantContext } from '@test-data/purchase/purchase-request.factory';
import { ConfigurationError } from '@config/errors';

interface WorkerFixtures {
  /** Validated configuration for the selected environment (LOCAL or UAT). */
  testConfig: TestConfig;
  /** Environment-specific test data (merchant, test cards, limits). */
  envData: EnvironmentTestData;
  /** Auth header provider; tokens are cached per worker. */
  authProvider: AuthProvider;
  workerLogger: Logger;
  /** Brand ID + payment method for this run (tester profile or env vars). */
  merchant: MerchantContext;
}

interface TestFixtures {
  /** Logger scoped to the current test. */
  logger: Logger;
  /** Masked HTTP exchanges captured during the test (attached to the report on failure). */
  httpExchanges: HttpExchange[];
  /** Ready-made options for constructing any `BaseApiClient` subclass. */
  apiClientOptions: BaseApiClientOptions;
  /** Auto fixture: tags each test with the environment in the HTML report. */
  environmentAnnotation: undefined;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  testConfig: [
    async ({}, use) => {
      await use(getTestConfig());
    },
    { scope: 'worker' },
  ],

  envData: [
    async ({ testConfig }, use) => {
      await use(getEnvironmentData(testConfig.env));
    },
    { scope: 'worker' },
  ],

  merchant: [
    async ({ testConfig }, use) => {
      const { brandId, paymentMethod, currency, expectedBank, expectedMid } = testConfig.merchant;
      if (brandId === undefined) {
        const env = testConfig.env.toUpperCase();
        throw new ConfigurationError(
          `No brand ID for ${env}. Select a tester profile (TEST_PROFILE / launcher) or set ${env}_BRAND_ID in .env.`,
        );
      }
      await use({ brandId, paymentMethod, currency, expectedBank, expectedMid });
    },
    { scope: 'worker' },
  ],

  workerLogger: [
    async ({ testConfig }, use, workerInfo) => {
      await use(
        createLogger({
          level: testConfig.logging.level,
          context: testConfig.settings.displayName,
          scope: `worker-${workerInfo.workerIndex}`,
        }),
      );
    },
    { scope: 'worker' },
  ],

  authProvider: [
    async ({ playwright, testConfig, workerLogger }, use) => {
      const tokenContext = await playwright.request.newContext();
      const provider = new AuthProvider(
        tokenContext,
        testConfig.apiBaseUrl,
        testConfig.auth,
        workerLogger.child('auth'),
        testConfig.settings.timeouts.request,
      );
      if (provider.mode === 'none') {
        const env = testConfig.env.toUpperCase();
        workerLogger.warn(
          `No credentials configured for ${testConfig.settings.displayName} – requests are sent unauthenticated. ` +
            `Set ${env}_API_KEY (or API_KEY) in .env.`,
        );
      } else {
        workerLogger.debug(`Auth mode: ${provider.mode}`);
      }
      await use(provider);
      await tokenContext.dispose();
    },
    { scope: 'worker' },
  ],

  logger: async ({ testConfig }, use, testInfo) => {
    await use(
      createLogger({
        level: testConfig.logging.level,
        context: testConfig.settings.displayName,
        scope: testInfo.titlePath.slice(1).join(' › '),
      }),
    );
  },

  httpExchanges: async ({}, use, testInfo) => {
    const exchanges: HttpExchange[] = [];
    await use(exchanges);
    const failed = testInfo.status !== testInfo.expectedStatus;
    // The launcher report shows request/response for every test (ATTACH_HTTP_ALWAYS=1).
    const always = process.env.ATTACH_HTTP_ALWAYS === '1';
    if ((failed || always) && exchanges.length > 0) {
      await testInfo.attach('http-exchanges.json', {
        body: JSON.stringify(exchanges, null, 2),
        contentType: 'application/json',
      });
    }
  },

  // Uses Playwright's built-in `request` fixture so API calls appear in traces.
  apiClientOptions: async ({ request, testConfig, authProvider, logger, httpExchanges }, use) => {
    await use({
      request,
      baseUrl: testConfig.apiBaseUrl,
      logger,
      timeoutMs: testConfig.settings.timeouts.request,
      logBodies: testConfig.logging.logBodies,
      defaultHeaders: testConfig.settings.defaultHeaders,
      authHeaders: () => authProvider.getAuthHeaders(),
      onExchange: (exchange) => httpExchanges.push(exchange),
    });
  },

  environmentAnnotation: [
    async ({ testConfig }, use, testInfo) => {
      testInfo.annotations.push({
        type: 'environment',
        description: testConfig.settings.displayName,
      });
      if (testConfig.profile) {
        testInfo.annotations.push({ type: 'profile', description: testConfig.profile.name });
      }
      testInfo.annotations.push({
        type: 'payment method',
        description: testConfig.merchant.paymentMethod,
      });
      if (testConfig.merchant.currency !== undefined) {
        testInfo.annotations.push({ type: 'currency', description: testConfig.merchant.currency });
      }
      if (testConfig.merchant.expectedBank !== undefined) {
        testInfo.annotations.push({ type: 'bank', description: testConfig.merchant.expectedBank });
      }
      if (testConfig.merchant.expectedMid !== undefined) {
        testInfo.annotations.push({ type: 'mid', description: testConfig.merchant.expectedMid });
      }
      if (testConfig.merchant.brandId !== undefined) {
        testInfo.annotations.push({ type: 'brand id', description: testConfig.merchant.brandId });
      }
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };
