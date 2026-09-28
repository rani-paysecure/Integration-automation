import type { EnvironmentTestData } from './environment-data.types';

/**
 * UAT test data. Values are NOT secrets; override via env vars where they
 * differ per tester/pipeline. Replace placeholders with real UAT values.
 */
export const uatData: Omit<EnvironmentTestData, 'purchase'> = {
  merchant: {
    id: process.env.UAT_MERCHANT_ID ?? 'UAT-MERCHANT-PLACEHOLDER',
    defaultCurrency: 'USD',
    country: 'US',
  },
  cards: {
    // Public scheme test numbers – never use real cards.
    approved: {
      cardNumber: '5555555555554444',
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: '123',
      holderName: 'UAT Approved',
    },
    declined: {
      cardNumber: '4000000000000002',
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: '123',
      holderName: 'UAT Declined',
    },
  },
  limits: {
    minAmount: 1,
    maxAmount: 50_000_000,
  },
  callbackUrl: process.env.UAT_CALLBACK_URL,
};
