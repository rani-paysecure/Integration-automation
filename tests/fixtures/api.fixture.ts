import { HealthApiClient } from '@clients/health-api-client';
import { PaymentApiClient } from '@clients/payment-api-client';
import { PurchaseApiClient } from '@clients/purchase-api-client';
import { expect, test as baseTest } from './test.fixture';

interface ApiClientFixtures {
  paymentApi: PaymentApiClient;
  healthApi: HealthApiClient;
  purchaseApi: PurchaseApiClient;
}

/**
 * Test object with ready-to-use API clients.
 * Register new clients here – tests should never build HTTP calls themselves.
 */
export const test = baseTest.extend<ApiClientFixtures>({
  paymentApi: async ({ apiClientOptions }, use) => {
    await use(new PaymentApiClient(apiClientOptions));
  },
  healthApi: async ({ apiClientOptions }, use) => {
    await use(new HealthApiClient(apiClientOptions));
  },
  purchaseApi: async ({ apiClientOptions }, use) => {
    await use(new PurchaseApiClient(apiClientOptions));
  },
});

export { expect };
