import type { CreatePurchaseRequest } from '@app-types/purchase.types';
import type { PurchaseTemplate } from '@config/settings';
import { deepMerge, type DeepPartial } from '@utils/object';
import type { EnvironmentTestData } from '../environments';

export interface MerchantContext {
  readonly brandId: string;
  readonly paymentMethod: string;
  /** Overrides the template currency when set (run selection). */
  readonly currency?: string | undefined;
  /** Bank / PSP the purchase should be routed to (checked after payment). */
  readonly expectedBank?: string | undefined;
  /** MID the purchase should be routed to (checked after payment). */
  readonly expectedMid?: string | undefined;
}

type MethodTemplate = Pick<PurchaseTemplate, 'extraParam' | 'methodFields'>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Request fields for one payment method from the Purchase data template: the template's
 * own `extraParam` (all methods), `methodFields['*']` (all methods) and `methodFields[<method>]`
 * (that method only, matched case-insensitively). Keys are free-form – nothing is hardcoded per method.
 */
export function methodFieldsFor(
  template: MethodTemplate,
  paymentMethod: string,
): Record<string, unknown> {
  const wanted = paymentMethod.trim().toUpperCase();
  const entries = Object.entries(template.methodFields ?? {});
  // "*" = every payment method, then the method's own entry (wins on the same key).
  const all = entries.find(([method]) => method.trim() === '*')?.[1] ?? {};
  const own = entries.find(([method]) => method.trim().toUpperCase() === wanted)?.[1] ?? {};
  const { extraParam: allExtra, ...allTop } = all;
  const { extraParam: ownExtra, ...ownTop } = own;
  const extraParam = {
    ...(template.extraParam ?? {}),
    ...(isObject(allExtra) ? allExtra : {}),
    ...(isObject(ownExtra) ? ownExtra : {}),
  };
  return { ...allTop, ...ownTop, ...(Object.keys(extraParam).length > 0 ? { extraParam } : {}) };
}

/**
 * Baseline purchase (the "known good" request every field test mutates).
 * The template (client, order, redirects, callbacks, optional extraParam and
 * payment-method fields) comes from the settings – config/defaults.json or the
 * launcher's "Purchase data" tab; brand ID and payment method from the selected
 * tester profile (`merchant` fixture) or the case.
 */
export function buildPurchaseRequest(
  envData: EnvironmentTestData,
  merchant: MerchantContext,
  overrides?: DeepPartial<CreatePurchaseRequest>,
): CreatePurchaseRequest {
  const source = structuredClone(envData.purchase);
  // Template-only settings – their content is merged below for the payment method used.
  const { methodFields, extraParam, ...template } = source;
  const purchase =
    merchant.currency === undefined
      ? source.purchase
      : { ...source.purchase, currency: merchant.currency };
  const base = {
    ...template,
    purchase,
    ...methodFieldsFor({ methodFields, extraParam }, merchant.paymentMethod),
    brand_id: merchant.brandId,
    paymentMethod: merchant.paymentMethod,
  } satisfies CreatePurchaseRequest;
  return deepMerge<CreatePurchaseRequest>(base, overrides);
}
