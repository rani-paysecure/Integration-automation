import { Endpoints } from '../constants/endpoints';
import type { PurchaseCreated } from '../schemas/purchase.schema';
import type { ApiResponse } from '../types/api.types';
import type { CreatePurchaseRequest } from '../types/purchase.types';
import { BaseApiClient, type BaseApiClientOptions } from './base-api-client';
import type { CallOptions } from './payment-api-client';

/** Purchase (hosted checkout) API – POST /v1/purchases/. */
export class PurchaseApiClient extends BaseApiClient {
  constructor(options: BaseApiClientOptions) {
    super({ ...options, logger: options.logger.child('purchase-api') });
  }

  /**
   * Creates a purchase. Accepts any object so field tests can send
   * deliberately invalid payloads.
   */
  createPurchase(
    purchase: CreatePurchaseRequest | Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<ApiResponse<PurchaseCreated>> {
    return this.post<PurchaseCreated>(Endpoints.purchases.collection, {
      ...options,
      data: purchase,
    });
  }

  /**
   * Partial (or full, when amount = total) refund – POST {amount, reason}.
   * Both fields are mandatory for PGS; the body is sent as given so negative
   * cases can leave one out. Makes a REAL refund.
   */
  refundPurchase(
    purchaseId: string,
    body: { readonly amount?: number | string; readonly reason?: string },
    options: CallOptions = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.post<Record<string, unknown>>(Endpoints.purchases.refund(purchaseId), {
      ...options,
      data: body,
    });
  }

  /** Full refund – GET /v1/purchases/{pid}/refund. Makes a REAL refund. */
  fullRefundPurchase(
    purchaseId: string,
    options: CallOptions = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.get<Record<string, unknown>>(Endpoints.purchases.refund(purchaseId), options);
  }

  getPurchase(
    purchaseId: string,
    options: CallOptions = {},
  ): Promise<ApiResponse<PurchaseCreated>> {
    return this.get<PurchaseCreated>(Endpoints.purchases.byId(purchaseId), options);
  }

  /**
   * S2S card payment – POST /v1/p/{purchaseId}/?s2s=true with card and browser data.
   * Answers 202 `{status: "pending", callback_url}` (open it in the customer's browser) or,
   * for a 2D merchant, the purchase after the payment. Makes a REAL payment.
   */
  s2sPay(
    purchaseId: string,
    /** JSON body; a string is sent as it is (malformed-body cases). */
    body: Record<string, unknown> | string,
    options: CallOptions = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.post<Record<string, unknown>>(Endpoints.purchases.s2s(purchaseId), {
      ...options,
      params: { s2s: 'true' },
      data: body,
    });
  }
}
