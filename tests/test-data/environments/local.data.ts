import type { EnvironmentTestData } from './environment-data.types';

/**
 * LOCAL test data. Values are NOT secrets; override via env vars where they
 * differ per tester/pipeline. Replace placeholders with real LOCAL values.
 */
export const localData: EnvironmentTestData = {
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
  purchase: {
    platform: 'woocommerce',
    successRedirect: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif',
    pendingRedirect: 'https://media.giphy.com/media/QBd2kLB5qDmysEXre9/giphy.gif',
    failureRedirect: 'https://media.giphy.com/media/OPU6wzx8JrHna/giphy.gif',
    successCallback: 'https://www.google.com/',
    failureCallback: 'https://staging.paysecure.net/merchant',
  },
};
