import type { EnvironmentTestData } from './environment-data.types';

/**
 * LOCAL test data. Values are NOT secrets; override via env vars where they
 * differ per tester/pipeline. Replace placeholders with real LOCAL values.
 */
export const localData: Omit<EnvironmentTestData, 'purchase' | 's2s'> = {
  merchant: {
    id: process.env.LOCAL_MERCHANT_ID ?? 'LOCAL-MERCHANT-PLACEHOLDER',
    defaultCurrency: 'USD',
    country: 'US',
  },
  cards: {
    // Public scheme test numbers – never use real cards.
    approved: {
      cardNumber: '4111111111111111',
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: '123',
      holderName: 'Local Approved',
    },
    declined: {
      cardNumber: '4000000000000002',
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: '123',
      holderName: 'Local Declined',
    },
  },
  limits: {
    minAmount: 1,
    maxAmount: 99_999_999,
  },
  callbackUrl: process.env.LOCAL_CALLBACK_URL,
};
