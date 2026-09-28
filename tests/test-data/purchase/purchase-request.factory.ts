import type { CreatePurchaseRequest } from '@app-types/purchase.types';
import { deepMerge, type DeepPartial } from '@utils/object';
import type { EnvironmentTestData } from '../environments';

export interface MerchantContext {
  readonly brandId: string;
  readonly paymentMethod: string;
  /** Overrides the template currency when set (run selection). */
  readonly currency?: string | undefined;
  /** Bank / PSP the purchase should be routed to (checked after payment). */
  readonly expectedBank?: string | undefined;
}

/**
 * Baseline card purchase (the "known good" request every field test mutates).
 * The template (client, order, redirects, callbacks) comes from the settings –
 * config/defaults.json or the launcher's "Purchase data" tab; brand ID and
 * payment method from the selected tester profile (`merchant` fixture).
 */
export function buildPurchaseRequest(
  envData: EnvironmentTestData,
  merchant: MerchantContext,
  overrides?: DeepPartial<CreatePurchaseRequest>,
): CreatePurchaseRequest {
  const template = structuredClone(envData.purchase);
  if (merchant.currency !== undefined) {
    template.purchase = { ...template.purchase, currency: merchant.currency };
  }
  const base: CreatePurchaseRequest = {
    ...template,
    brand_id: merchant.brandId,
    paymentMethod: merchant.paymentMethod,
  };
  return deepMerge(base, overrides);
}
