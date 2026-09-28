import type { CreatePaymentRequest } from '@app-types/payment.types';
import { uniqueReference } from '@utils/id-generator';
import { deepMerge, type DeepPartial } from '@utils/object';
import type { EnvironmentTestData } from '../environments';

/**
 * Builds a valid payment request for the current environment.
 * Every call gets a unique merchant reference so tests can run in parallel.
 */
export function buildPaymentRequest(
  envData: EnvironmentTestData,
  overrides?: DeepPartial<CreatePaymentRequest>,
): CreatePaymentRequest {
  const base: CreatePaymentRequest = {
    amount: 1_000,
    currency: envData.merchant.defaultCurrency,
    merchantId: envData.merchant.id,
    merchantReference: uniqueReference('AUTO'),
    description: 'Automated integration test payment',
    paymentMethod: {
      type: 'card',
      card: envData.cards.approved,
    },
    customer: {
      email: 'qa.automation@example.com',
      firstName: 'Automation',
      lastName: 'Tester',
      country: envData.merchant.country,
    },
    metadata: { source: 'integration-qa-automation' },
    ...(envData.callbackUrl === undefined ? {} : { callbackUrl: envData.callbackUrl }),
  };
  return deepMerge(base, overrides);
}
