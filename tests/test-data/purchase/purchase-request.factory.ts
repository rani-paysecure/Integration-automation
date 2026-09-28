import type { CreatePurchaseRequest } from '@app-types/purchase.types';
import { deepMerge, type DeepPartial } from '@utils/object';
import type { EnvironmentTestData } from '../environments';

export interface MerchantContext {
  readonly brandId: string;
  readonly paymentMethod: string;
}

/**
 * Baseline card purchase (the "known good" request every field test mutates).
 * Environment values come from `envData.purchase`; brand ID and payment method
 * from the selected tester profile / env vars (`merchant` fixture).
 */
export function buildPurchaseRequest(
  envData: EnvironmentTestData,
  merchant: MerchantContext,
  overrides?: DeepPartial<CreatePurchaseRequest>,
): CreatePurchaseRequest {
  const { purchase } = envData;
  const base: CreatePurchaseRequest = {
    client: {
      email: 'ashishm.11@gmail.com',
      country: 'AT',
      city: 'jaipur',
      stateCode: 'WI',
      street_address: 'Kärntner Straße 10',
      zip_code: '1010',
      date_of_birth: '2011-04-25',
      phone: '+436601234567',
      full_name: 'dummy User',
    },
    purchase: {
      currency: 'EUR',
      products: [{ name: 'Gaming Cards', price: 2 }],
      total: 2,
    },
    platform: purchase.platform,
    brand_id: merchant.brandId,
    send_receipt: false,
    skip_capture: false,
    success_redirect: purchase.successRedirect,
    pending_redirect: purchase.pendingRedirect,
    failure_redirect: purchase.failureRedirect,
    success_callback: purchase.successCallback,
    failure_callback: purchase.failureCallback,
    paymentMethod: merchant.paymentMethod,
  };
  return deepMerge(base, overrides);
}
